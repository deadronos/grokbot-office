import type { BotSnapshot, Handoff, StreamEvent } from "@grokbot-office/shared";

import { useOfficeStore } from "../store/officeStore";
import { useHistoryStore, type HistoryStore } from "./historyStore";
import { localDayBounds } from "./time";

// Stable empties: during history the live store is intentionally ignored, so a
// re-render with no replay yet should not create a new object each time.
const EMPTY_BOTS: Record<string, BotSnapshot> = {};
const EMPTY_HANDOFFS: Handoff[] = [];
const EMPTY_EVENTS: StreamEvent[] = [];

/**
 * The office as the scene should draw it: the replayed snapshot while history is
 * open, the live store otherwise. Live frames keep applying underneath, so
 * closing history lands on the present without a refetch.
 */
export function useViewedBots(): Record<string, BotSnapshot> {
  const active = useHistoryStore((state) => state.active);
  const replay = useHistoryStore((state) => (state.active ? state.replay.bots : null));
  const live = useOfficeStore((state) => (active ? null : state.bots));
  return replay ?? live ?? EMPTY_BOTS;
}

export function useViewedBot(botId: string): BotSnapshot | undefined {
  const active = useHistoryStore((state) => state.active);
  const replay = useHistoryStore((state) => (state.active ? state.replay.bots[botId] : undefined));
  const live = useOfficeStore((state) => (active ? undefined : state.bots[botId]));
  return replay ?? live;
}

export function useViewedOpenHandoffs(): Handoff[] {
  const active = useHistoryStore((state) => state.active);
  const replay = useHistoryStore((state) => (state.active ? state.replay.openHandoffs : null));
  const live = useOfficeStore((state) => (active ? null : state.openHandoffs));
  return replay ?? live ?? EMPTY_HANDOFFS;
}

export function useViewedEvents(): StreamEvent[] {
  const active = useHistoryStore((state) => state.active);
  const replay = useHistoryStore((state) => (state.active ? state.replay.events : null));
  const live = useOfficeStore((state) => (active ? null : state.events));
  return replay ?? live ?? EMPTY_EVENTS;
}

/** HUD ages should read relative to the playhead, not to today's wall clock. */
export function selectHistoryNow(state: HistoryStore): number {
  if (!state.active) return 0;
  const current = state.dayEvents[state.playhead];
  return current ? Date.parse(current.receivedAt) : Date.parse(localDayBounds(state.day).from);
}
