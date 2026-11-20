import {
  StateSnapshot,
  StreamEvent,
  reduceOfficeEvent,
  type BotSnapshot,
  type Handoff,
} from "@grokbot-office/shared";
import { create } from "zustand";

import { openMessageStream } from "../api/stream";
import { invalidateScene } from "../scene/invalidateScene";

export const SESSION_PATH = "/api/session";
export const SESSION_LOGOUT_PATH = "/api/session/logout";
export const STATE_PATH = "/api/state";
export const EVENTS_PATH = "/api/events";

/** The HUD feed shows the newest events only; older ones fall off the back. */
export const FEED_LIMIT = 20;

/** Merge by seq, keep order, cap the HUD feed. Replay and live frames share this. */
function capFeed(events: StreamEvent[]): StreamEvent[] {
  const merged = new Map(events.map((event) => [event.seq, event]));
  return [...merged.values()].toSorted((a, b) => a.seq - b.seq).slice(-FEED_LIMIT);
}

function replayEvents(getState: () => OfficeStore, batches: StreamEvent[][]): void {
  const merged = new Map<number, StreamEvent>();
  for (const batch of batches) {
    for (const event of batch) merged.set(event.seq, event);
  }
  for (const event of [...merged.values()].toSorted((a, b) => a.seq - b.seq)) {
    getState().applyEvent(event);
  }
}
/** A failed snapshot refetch is retried from 1s, doubling up to 30s. */
const SNAPSHOT_RETRY_BASE_MS = 1_000;
const SNAPSHOT_RETRY_MAX_MS = 30_000;
/** Unknown-bot events wait here during a snapshot refetch; overflow drops the queue. */
const PENDING_EVENT_CAP = 500;

/** How long the stream may stay broken before "reconnecting" becomes "office closed". */
export const CLOSED_AFTER_MS = 45_000;

export const UNREACHABLE_MESSAGE = "Can't reach the office. Check that the server is running.";
export const BAD_RESPONSE_MESSAGE = "The office sent an unexpected response.";
export const BAD_TOKEN_MESSAGE = "That viewer token was not accepted.";
export const NOT_VIEWER_MESSAGE = "That token cannot sign in here. Use a viewer token.";

export type Phase = "checking" | "login" | "ready";
/** `live`: stream open and frames flowing. `reconnecting`: stream errored, EventSource retries. */
export type Connection = "live" | "reconnecting" | "closed";

type OfficeData = {
  bots: Record<string, BotSnapshot>;
  openHandoffs: Handoff[];
  lastEventSeq: number;
  /** Newest last, capped at `FEED_LIMIT`. */
  events: StreamEvent[];
  /** Set by a live handoff_sent, cleared by the scene after its flash. */
  handoffFlash: { seq: number; from: string; to: string } | null;
};

export type OfficeStore = OfficeData & {
  phase: Phase;
  connection: Connection;
  pending: boolean;
  error: string | null;
  checkSession: () => Promise<void>;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  applySnapshot: (snapshot: StateSnapshot) => void;
  applyEvent: (event: StreamEvent) => void;
  seedEvents: (events: StreamEvent[]) => void;
  clearHandoffFlash: () => void;
  expire: () => void;
  startStream: () => () => void;
  pageUnloading: boolean;
  setPageUnloading: (value: boolean) => void;
  onPageHide: () => void;
  onPageShow: (persisted: boolean) => Promise<void>;
};

const EMPTY_DATA: OfficeData = {
  bots: {},
  openHandoffs: [],
  lastEventSeq: 0,
  events: [],
  handoffFlash: null,
};

let closedTimer: ReturnType<typeof setTimeout> | undefined;
let stopStream: (() => void) | undefined;

function clearClosedTimer(): void {
  if (closedTimer !== undefined) {
    clearTimeout(closedTimer);
    closedTimer = undefined;
  }
}

async function postSession(path: string): Promise<Response> {
  return fetch(path, { method: "POST", credentials: "same-origin" });
}

let refreshInFlight = false;
let refreshAgain = false;
let pendingOverflowed = false;
let pendingSnapshotEvents: StreamEvent[] = [];
/** Known-bot events applied live during a refetch, replayed after the snapshot lands. */
let pendingLiveEvents: StreamEvent[] = [];

/** Bumped whenever the session ends, so a late snapshot cannot land in the next one. */
let snapshotGeneration = 0;
let snapshotRetryTimer: ReturnType<typeof setTimeout> | undefined;
let snapshotRetries = 0;

/** Cancel an in-flight or queued snapshot refresh; the caller's data is already gone. */
function resetSnapshotRefresh(): void {
  snapshotGeneration += 1;
  if (snapshotRetryTimer !== undefined) clearTimeout(snapshotRetryTimer);
  snapshotRetryTimer = undefined;
  pendingSnapshotEvents = [];
  pendingLiveEvents = [];
  refreshInFlight = false;
  refreshAgain = false;
  pendingOverflowed = false;
  snapshotRetries = 0;
}

/** Test hook: drop in-flight snapshot state so cases cannot leak into the next one. */
export function resetOfficeStoreInternals(): void {
  resetSnapshotRefresh();
}

async function fetchSnapshot(): Promise<StateSnapshot | "unauthorized" | "failed"> {
  try {
    const response = await fetch(STATE_PATH, { credentials: "same-origin" });
    if (response.status === 401) return "unauthorized";
    if (!response.ok) return "failed";
    const parsed = StateSnapshot.safeParse(await response.json());
    return parsed.success ? parsed.data : "failed";
  } catch {
    return "failed";
  }
}

/** Reloads the snapshot so a newly registered bot can join the store. */
async function refreshOfficeSnapshot(getState: () => OfficeStore): Promise<void> {
  if (refreshInFlight) {
    refreshAgain = true;
    return;
  }
  refreshInFlight = true;
  const startedAt = snapshotGeneration;
  const result = await fetchSnapshot();
  // Logout or expiry while the fetch was out: the queue is gone and this data is stale.
  if (snapshotGeneration !== startedAt) return;

  if (result === "failed") {
    // Unknown-bot events wait in the queue; the retry doubles from 1s up to 30s.
    const delay = Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_BASE_MS * 2 ** snapshotRetries);
    snapshotRetries += 1;
    snapshotRetryTimer = setTimeout(() => {
      snapshotRetryTimer = undefined;
      refreshInFlight = false;
      if (snapshotGeneration !== startedAt) return;
      void refreshOfficeSnapshot(getState);
    }, delay);
    return;
  }

  snapshotRetries = 0;
  if (result === "unauthorized") {
    pendingSnapshotEvents = [];
    refreshInFlight = false;
    refreshAgain = false;
    getState().expire();
    return;
  }

  getState().applySnapshot(result);
  const live = pendingLiveEvents;
  const queued = pendingOverflowed ? [] : pendingSnapshotEvents;
  pendingLiveEvents = [];
  pendingSnapshotEvents = [];
  pendingOverflowed = false;
  refreshInFlight = false;
  const again = refreshAgain;
  refreshAgain = false;
  // Sorted by seq so a live known-bot event cannot bump lastEventSeq past a
  // queued unknown-bot event that happened earlier. capFeed/applyEvent merge
  // by seq so a live frame is not appended twice.
  replayEvents(getState, [live, queued]);
  if (again && snapshotGeneration === startedAt) void refreshOfficeSnapshot(getState);
}

/** Seeds the HUD feed from the viewer API; a missing feed never blocks the office. */
async function seedEventFeed(getState: () => OfficeStore): Promise<void> {
  const startedAt = snapshotGeneration;
  // Only the newest window matters; `lastEventSeq` already counts hidden events.
  const since = Math.max(0, getState().lastEventSeq - FEED_LIMIT);
  try {
    const response = await fetch(`${EVENTS_PATH}?since=${since}&limit=${FEED_LIMIT}`, {
      credentials: "same-origin",
    });
    if (!response.ok || snapshotGeneration !== startedAt) return;
    const body = (await response.json()) as { events?: unknown };
    if (!Array.isArray(body.events)) return;
    getState().seedEvents(
      body.events.flatMap((raw) => {
        const parsed = StreamEvent.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      }),
    );
  } catch {
    // A missing feed is only a missing panel; it does not block the office.
  }
}
export const useOfficeStore = create<OfficeStore>()((set, get) => ({
  ...EMPTY_DATA,
  phase: "checking",
  connection: "reconnecting",
  pending: false,
  error: null,

  applySnapshot: (snapshot) => {
    const visible = new Set(snapshot.bots.map((bot) => bot.id));
    set((state) => ({
      bots: Object.fromEntries(snapshot.bots.map((bot) => [bot.id, bot])),
      openHandoffs: snapshot.openHandoffs,
      lastEventSeq: snapshot.lastEventSeq,
      // Hidden bots must leave the feed, not just the list, for open viewers.
      events: capFeed(state.events.filter((event) => visible.has(event.botId))),
    }));
    invalidateScene();
  },

  seedEvents: (events) => {
    set((state) => {
      // Merge by seq so a reseed never duplicates or rewinds live frames.
      return { events: capFeed([...state.events, ...events]) };
    });
    invalidateScene();
  },

  clearHandoffFlash: () => set({ handoffFlash: null }),

  applyEvent: (event) => {
    const state = get();
    // Frames can repeat after a reconnect; the sequence makes replay idempotent.
    if (event.seq <= state.lastEventSeq) return;
    const known = Boolean(state.bots[event.botId]);
    // During a snapshot refetch, keep applying events for bots already in the
    // store so the UI stays live. Queue only events for unknown bots, and cap
    // that queue: on overflow drop it and let the snapshot (and its lastEventSeq)
    // be the authority so nothing double-applies.
    if (refreshInFlight) {
      if (known) {
        const next = reduceOfficeEvent(state, event);
        next.events = capFeed(next.events);
        set(next);
        invalidateScene();
        pendingLiveEvents.push(event);
        return;
      }
      if (pendingOverflowed) return;
      if (pendingSnapshotEvents.length >= PENDING_EVENT_CAP) {
        pendingSnapshotEvents = [];
        pendingOverflowed = true;
        // The in-flight snapshot may be stale; refetch once it lands.
        refreshAgain = true;
        return;
      }
      pendingSnapshotEvents.push(event);
      return;
    }
    if (event.type === "bot_registered" && !known) {
      // Keep the registration on the queue so the feed (and lastEventSeq) stay in sync.
      pendingSnapshotEvents.push(event);
      void refreshOfficeSnapshot(get);
      return;
    }
    const next = reduceOfficeEvent(state, event);
    next.events = capFeed(next.events);
    set(next);
    invalidateScene();
  },

  checkSession: async () => {
    try {
      const response = await fetch(STATE_PATH, { credentials: "same-origin" });
      if (response.status === 401) {
        resetSnapshotRefresh();
        set({ phase: "login", connection: "reconnecting", pending: false, error: null });
        return;
      }
      if (!response.ok) {
        resetSnapshotRefresh();
        set({ phase: "login", connection: "closed", pending: false, error: UNREACHABLE_MESSAGE });
        return;
      }
      const parsed = StateSnapshot.safeParse(await response.json());
      if (!parsed.success) {
        resetSnapshotRefresh();
        set({ phase: "login", connection: "closed", pending: false, error: BAD_RESPONSE_MESSAGE });
        return;
      }
      get().applySnapshot(parsed.data);
      set({ phase: "ready", connection: "reconnecting", pending: false, error: null });
      void seedEventFeed(get);
    } catch {
      resetSnapshotRefresh();
      set({ phase: "login", connection: "closed", pending: false, error: UNREACHABLE_MESSAGE });
    }
  },

  login: async (token) => {
    set({ pending: true, error: null });
    try {
      const response = await fetch(SESSION_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        set({ pending: false, error: BAD_TOKEN_MESSAGE });
        return;
      }
      if (response.status === 403) {
        set({ pending: false, error: NOT_VIEWER_MESSAGE });
        return;
      }
      // Only 201 creates a session; any other answer (even another 2xx) is a failure.
      if (response.status !== 201) {
        set({ pending: false, error: `Sign in failed (${response.status}).` });
        return;
      }
      // The `__Secure-bo_session` cookie carries the session from here on; the token is never kept.
      await get().checkSession();
    } catch {
      set({ pending: false, error: UNREACHABLE_MESSAGE });
    }
  },

  pageUnloading: false,

  setPageUnloading: (value) => set({ pageUnloading: value }),

  onPageHide: () => set({ pageUnloading: true }),

  // pageshow always clears the flag so a later error can probe again. A bfcache
  // restore (`event.persisted`) also re-probes: the session may have been revoked
  // while the page was frozen, and the existing stream will not reconnect itself.
  onPageShow: async (persisted) => {
    set({ pageUnloading: false });
    if (!persisted) return;
    await get().checkSession();
    if (get().phase === "ready") get().startStream();
  },

  logout: async () => {
    resetSnapshotRefresh();
    stopStream?.();
    stopStream = undefined;
    clearClosedTimer();
    try {
      await postSession(SESSION_LOGOUT_PATH);
    } catch {
      // The local session state is dropped either way; the cookie expires on its own.
    }
    set({ ...EMPTY_DATA, phase: "login", connection: "reconnecting", pending: false, error: null });
    invalidateScene();
  },

  expire: () => {
    resetSnapshotRefresh();
    stopStream?.();
    stopStream = undefined;
    clearClosedTimer();
    set({
      ...EMPTY_DATA,
      phase: "login",
      connection: "reconnecting",
      pending: false,
      error: null,
    });
    invalidateScene();
  },

  startStream: () => {
    stopStream?.();
    let probing = false;
    let close: (() => void) | undefined;

    /** A 401 probe means the cookie is gone: stop retrying and ask for a token. */
    const expire = () => get().expire();

    /** EventSource hides the HTTP status, so the store asks `/api/state` instead. */
    async function probeSession(): Promise<void> {
      // pagehide/unload fires EventSource.onerror; a probe would rotate the cookie
      // and the browser would drop the Set-Cookie, leaving the next page with the old one.
      if (probing || get().pageUnloading) return;
      probing = true;
      try {
        const response = await fetch(STATE_PATH, { credentials: "same-origin" });
        if (response.status === 401) expire();
      } catch {
        // Unreachable probe: keep the "office closed" timer running.
      } finally {
        probing = false;
      }
    }

    close = openMessageStream(
      {
        onOpen: () => {
          clearClosedTimer();
          set({ connection: "live" });
        },
        onPing: () => {
          clearClosedTimer();
          set({ connection: "live" });
        },
        onEvent: (event) => get().applyEvent(event),
        onRefresh: () => {
          void refreshOfficeSnapshot(get);
        },
        onError: () => {
          set({ connection: "reconnecting" });
          // EventSource retries; if it is still down after the grace period, the office is gone.
          closedTimer ??= setTimeout(() => set({ connection: "closed" }), CLOSED_AFTER_MS);
          void probeSession();
        },
      },
      get().lastEventSeq,
    );
    const stop = () => {
      close?.();
      close = undefined;
      stopStream = undefined;
      clearClosedTimer();
    };
    stopStream = stop;
    return stop;
  },
}));

/** One desk's data; zustand re-renders only subscribers of that bot. */
export const selectBot =
  (botId: string) =>
  (state: OfficeStore): BotSnapshot | undefined =>
    state.bots[botId];

export const useBot = (botId: string): BotSnapshot | undefined => useOfficeStore(selectBot(botId));
