import type { BotSnapshot, Handoff, StreamEvent } from "@grokbot-office/shared";

/** The panel reads the newest slice of the already-visible feed, never a new request. */
export const DETAIL_EVENT_LIMIT = 10;

export type BotDetails = {
  handoffsIn: Handoff[];
  handoffsOut: Handoff[];
  /** Newest first, this bot only, at most `DETAIL_EVENT_LIMIT`. */
  events: StreamEvent[];
};

/**
 * Narrows the viewer store's already-filtered handoffs and feed to one bot. A
 * handoff stays visible only when both ends are in the snapshot too: a stale
 * one naming a hidden peer must not leak that id into the panel.
 */
export function botDetails(
  bot: BotSnapshot,
  openHandoffs: Handoff[],
  events: StreamEvent[],
  bots: Record<string, BotSnapshot>,
): BotDetails {
  const visible = openHandoffs.filter(
    (handoff) => bots[handoff.fromBotId] !== undefined && bots[handoff.toBotId] !== undefined,
  );
  return {
    handoffsIn: visible.filter((handoff) => handoff.toBotId === bot.id),
    handoffsOut: visible.filter((handoff) => handoff.fromBotId === bot.id),
    events: events
      .filter((event) => event.botId === bot.id)
      .toReversed()
      .slice(0, DETAIL_EVENT_LIMIT),
  };
}
