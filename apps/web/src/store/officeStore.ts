import {
  StateSnapshot,
  StreamEvent,
  applyLabelRule,
  type BotSnapshot,
  type Handoff,
  type LabelEvent,
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
/** A failed snapshot refetch is retried from 1s, doubling up to 30s. */
const SNAPSHOT_RETRY_BASE_MS = 1_000;
const SNAPSHOT_RETRY_MAX_MS = 30_000;

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

function patchBot(
  bots: Record<string, BotSnapshot>,
  botId: string,
  patch: Partial<BotSnapshot>,
): Record<string, BotSnapshot> {
  const bot = bots[botId];
  if (!bot) return bots;
  return { ...bots, [botId]: { ...bot, ...patch } };
}

/** Applies one stream event immutably; mirrors the server's status derivation. */
function reduceEvent(data: OfficeData, event: StreamEvent): OfficeData {
  const { botId } = event;
  const bot = data.bots[botId];
  const at = event.at ?? event.receivedAt;
  let bots = data.bots;
  let openHandoffs = data.openHandoffs;
  let handoffFlash = data.handoffFlash;

  const update = (patch: Partial<BotSnapshot>) => {
    bots = patchBot(bots, botId, { ...patch, lastEventSeq: event.seq });
  };

  /** The shared table owns status/label/task, so web and server cannot drift. */
  const rule = (input: LabelEvent) => {
    if (!bot) return undefined;
    const next = applyLabelRule(
      { status: bot.status, label: bot.label ?? null, taskId: bot.taskId ?? null },
      input,
    );
    return {
      status: next.status,
      label: next.label ?? undefined,
      taskId: next.taskId ?? undefined,
    };
  };

  switch (event.type) {
    case "status_changed": {
      // A missing label keeps the current one on a busy status and clears it when
      // resting; the server omits null labels on the wire, so a clear never arrives.
      const next = rule({
        type: "status_changed",
        status: event.status ?? bot?.status ?? "idle",
        label: event.label,
      });
      if (next) update({ ...next, since: at });
      break;
    }
    case "task_started": {
      const next = rule({ type: "task_started", label: event.label, taskId: event.taskId });
      if (next) update({ ...next, since: at });
      break;
    }
    case "task_finished": {
      const next = rule({ type: "task_finished" });
      if (next) update({ ...next, since: at });
      break;
    }
    case "handoff_sent": {
      const next = rule({ type: "handoff_sent", label: event.label });
      if (next) update({ ...next, since: at });
      if (bot && event.handoffId && event.to) {
        const handoff: Handoff = {
          id: event.handoffId,
          fromBotId: botId,
          toBotId: event.to,
          label: event.label,
          state: "sent",
          sentAt: at,
        };
        openHandoffs = [...openHandoffs.filter((entry) => entry.id !== handoff.id), handoff];
        // The scene flashes a line from this desk to the receiver's and clears it.
        handoffFlash = { seq: event.seq, from: botId, to: event.to };
      }
      break;
    }
    case "handoff_accepted": {
      const handoff = openHandoffs.find((entry) => entry.id === event.handoffId);
      openHandoffs = openHandoffs.filter((entry) => entry.id !== event.handoffId);
      const next = rule({
        type: "handoff_accepted",
        label: event.label,
        taskId: event.taskId,
        handoffLabel: handoff?.label ?? null,
      });
      if (next) update({ ...next, since: at });
      // The sender only rests if it was still waiting on this handoff.
      if (handoff && handoff.fromBotId !== botId) {
        const sender = bots[handoff.fromBotId];
        if (sender && sender.status === "waiting") {
          bots = patchBot(bots, sender.id, {
            status: "idle",
            label: undefined,
            taskId: undefined,
            since: at,
          });
        }
      }
      break;
    }
    case "offline": {
      const next = rule({ type: "offline" });
      if (next) update({ ...next, since: at });
      break;
    }
    case "bot_registered": {
      // The snapshot already carries the registration fields; only the sequence moves.
      if (bot) update({});
      break;
    }
    case "bot_hidden": {
      // Display-only event: drop the bot and any handoff that names it.
      bots = Object.fromEntries(Object.entries(bots).filter(([id]) => id !== botId));
      openHandoffs = openHandoffs.filter(
        (handoff) => handoff.fromBotId !== botId && handoff.toBotId !== botId,
      );
      break;
    }
  }

  return {
    bots,
    openHandoffs,
    lastEventSeq: event.seq,
    events: [...data.events, event].slice(-FEED_LIMIT),
    handoffFlash,
  };
}

async function postSession(path: string): Promise<Response> {
  return fetch(path, { method: "POST", credentials: "same-origin" });
}

let refreshInFlight = false;
let pendingSnapshotEvents: StreamEvent[] = [];

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
  refreshInFlight = false;
  snapshotRetries = 0;
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
  if (refreshInFlight) return;
  refreshInFlight = true;
  const startedAt = snapshotGeneration;
  const result = await fetchSnapshot();
  // Logout or expiry while the fetch was out: the queue is gone and this data is stale.
  if (snapshotGeneration !== startedAt) return;

  if (result === "failed") {
    // Events wait in the queue; the retry doubles from 1s up to 30s.
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
    return;
  }

  getState().applySnapshot(result);
  const queued = pendingSnapshotEvents;
  pendingSnapshotEvents = [];
  refreshInFlight = false;
  for (const event of queued) getState().applyEvent(event);
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
    set({
      bots: Object.fromEntries(snapshot.bots.map((bot) => [bot.id, bot])),
      openHandoffs: snapshot.openHandoffs,
      lastEventSeq: snapshot.lastEventSeq,
    });
    invalidateScene();
  },

  seedEvents: (events) => {
    set((state) => {
      // Merge by seq so a reseed never duplicates or rewinds live frames.
      const merged = new Map(state.events.map((event) => [event.seq, event]));
      for (const event of events) merged.set(event.seq, event);
      return {
        events: [...merged.values()].toSorted((a, b) => a.seq - b.seq).slice(-FEED_LIMIT),
      };
    });
    invalidateScene();
  },

  clearHandoffFlash: () => set({ handoffFlash: null }),

  applyEvent: (event) => {
    const state = get();
    // Frames can repeat after a reconnect; the sequence makes replay idempotent.
    if (event.seq <= state.lastEventSeq) return;
    // bot_registered does not carry name/role/avatar/pod, so a bot that was
    // not in the snapshot has to come from a fresh GET /api/state. Events
    // that arrive during that fetch are applied once the snapshot lands.
    if (refreshInFlight) {
      pendingSnapshotEvents.push(event);
      return;
    }
    if (event.type === "bot_registered" && !state.bots[event.botId]) {
      // Keep the registration on the queue so the feed (and lastEventSeq) stay in sync.
      pendingSnapshotEvents.push(event);
      void refreshOfficeSnapshot(get);
      return;
    }
    set(reduceEvent(state, event));
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

  startStream: () => {
    stopStream?.();
    let probing = false;
    let close: (() => void) | undefined;

    /** A 401 probe means the cookie is gone: stop retrying and ask for a token. */
    function expire() {
      resetSnapshotRefresh();
      close?.();
      close = undefined;
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
    }

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
