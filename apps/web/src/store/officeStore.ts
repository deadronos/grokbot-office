import { StateSnapshot, StreamEvent, type BotSnapshot, type Handoff } from "@grokbot-office/shared";
import { create } from "zustand";

import { openMessageStream } from "../api/stream";
import { invalidateScene } from "../scene/invalidateScene";

export const SESSION_PATH = "/api/session";
export const SESSION_LOGOUT_PATH = "/api/session/logout";
export const STATE_PATH = "/api/state";

/** How long the stream may stay broken before "reconnecting" becomes "office closed". */
export const CLOSED_AFTER_MS = 45_000;

export const UNREACHABLE_MESSAGE = "Can't reach the office. Check that the server is running.";
export const BAD_RESPONSE_MESSAGE = "The office sent an unexpected response.";
export const BAD_TOKEN_MESSAGE = "That viewer token was not accepted.";

export type Phase = "checking" | "login" | "ready";
/** `live`: stream open and frames flowing. `reconnecting`: stream errored, EventSource retries. */
export type Connection = "live" | "reconnecting" | "closed";

type OfficeData = {
  bots: Record<string, BotSnapshot>;
  openHandoffs: Handoff[];
  lastEventSeq: number;
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
  startStream: () => () => void;
};

const EMPTY_DATA: OfficeData = { bots: {}, openHandoffs: [], lastEventSeq: 0 };

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

  const update = (patch: Partial<BotSnapshot>) => {
    bots = patchBot(bots, botId, { ...patch, lastEventSeq: event.seq });
  };

  switch (event.type) {
    case "status_changed": {
      if (!bot) break;
      const status = event.status ?? bot.status;
      const resting = status === "idle" || status === "offline";
      update({ status, label: event.label, since: at, taskId: resting ? undefined : bot.taskId });
      break;
    }
    case "task_started": {
      if (!bot) break;
      update({
        status: "working",
        label: event.label ?? bot.label,
        taskId: event.taskId,
        since: at,
      });
      break;
    }
    case "task_finished": {
      if (!bot) break;
      update({ status: "idle", label: undefined, taskId: undefined, since: at });
      break;
    }
    case "handoff_sent": {
      if (!bot) break;
      update({ status: "waiting", label: event.label ?? bot.label, since: at });
      if (event.handoffId && event.to) {
        const handoff: Handoff = {
          id: event.handoffId,
          fromBotId: botId,
          toBotId: event.to,
          label: event.label,
          state: "sent",
          sentAt: at,
        };
        openHandoffs = [...openHandoffs.filter((entry) => entry.id !== handoff.id), handoff];
      }
      break;
    }
    case "handoff_accepted": {
      const handoff = openHandoffs.find((entry) => entry.id === event.handoffId);
      openHandoffs = openHandoffs.filter((entry) => entry.id !== event.handoffId);
      if (bot) {
        update({
          status: "working",
          label: event.label ?? bot.label,
          taskId: event.taskId ?? bot.taskId,
          since: at,
        });
      }
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
      update({ status: "offline", label: undefined, taskId: undefined, since: at });
      break;
    }
    case "bot_registered": {
      // The snapshot already carries the registration fields; only the sequence moves.
      if (bot) update({});
      break;
    }
  }

  return { bots, openHandoffs, lastEventSeq: event.seq };
}

async function postSession(path: string): Promise<Response> {
  return fetch(path, { method: "POST", credentials: "same-origin" });
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

  applyEvent: (event) => {
    const state = get();
    // Frames can repeat after a reconnect; the sequence makes replay idempotent.
    if (event.seq <= state.lastEventSeq) return;
    set(reduceEvent(state, event));
    invalidateScene();
  },

  checkSession: async () => {
    try {
      const response = await fetch(STATE_PATH, { credentials: "same-origin" });
      if (response.status === 401) {
        set({ phase: "login", connection: "reconnecting", pending: false, error: null });
        return;
      }
      if (!response.ok) {
        set({ phase: "login", connection: "closed", pending: false, error: UNREACHABLE_MESSAGE });
        return;
      }
      const parsed = StateSnapshot.safeParse(await response.json());
      if (!parsed.success) {
        set({ phase: "login", connection: "closed", pending: false, error: BAD_RESPONSE_MESSAGE });
        return;
      }
      get().applySnapshot(parsed.data);
      set({ phase: "ready", connection: "reconnecting", pending: false, error: null });
    } catch {
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
      if (!response.ok) {
        set({ pending: false, error: `Sign in failed (${response.status}).` });
        return;
      }
      // The cookie carries the session from here on; the token is never kept.
      await get().checkSession();
    } catch {
      set({ pending: false, error: UNREACHABLE_MESSAGE });
    }
  },

  logout: async () => {
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
    const close = openMessageStream({
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
      },
    });
    const stop = () => {
      close();
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
