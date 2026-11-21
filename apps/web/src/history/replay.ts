import {
  reduceOfficeEvent,
  type BotSnapshot,
  type Handoff,
  type OfficeReduceState,
  type StreamEvent,
} from "@grokbot-office/shared";

/** Matches the live HUD feed: history shows the same recent-events window. */
export const REPLAY_FEED_LIMIT = 20;

export type ReplayState = {
  bots: Record<string, BotSnapshot>;
  openHandoffs: Handoff[];
  events: StreamEvent[];
  lastEventSeq: number;
};

/**
 * At the day's start every known bot is idle: no live label, task or handoff
 * leaks into history. `bot_registered` cannot help here, because registration
 * happened before the day being replayed.
 *
 * Replay never derives `away` either: presence aging reads the wall clock and only
 * the live snapshot applies it, so a quiet stretch in history keeps the last
 * activity instead of fading every desk that paused.
 */
export function replayRoster(
  roster: readonly BotSnapshot[],
  dayStart: string,
): Record<string, BotSnapshot> {
  return Object.fromEntries(
    roster.map((bot) => [
      bot.id,
      {
        ...bot,
        status: "idle" as const,
        label: undefined,
        taskId: undefined,
        handoffId: undefined,
        since: dayStart,
        lastHeartbeatAt: dayStart,
        lastEventSeq: 0,
      },
    ]),
  );
}

/**
 * Rebuilds the office as it looked after `events[playhead]`. `playhead` is an
 * index into the day's events, so `-1` is the moment before the first event.
 */
export function replayState({
  roster,
  events,
  playhead,
  dayStart,
}: {
  roster: readonly BotSnapshot[];
  events: readonly StreamEvent[];
  playhead: number;
  dayStart: string;
}): ReplayState {
  let data: OfficeReduceState = {
    bots: replayRoster(roster, dayStart),
    openHandoffs: [],
    lastEventSeq: 0,
    events: [],
    handoffFlash: null,
  };
  const end = Math.min(Math.max(playhead + 1, 0), events.length);
  for (let index = 0; index < end; index += 1) {
    data = reduceOfficeEvent(data, events[index]);
  }
  return {
    bots: data.bots,
    openHandoffs: data.openHandoffs,
    events: data.events.slice(-REPLAY_FEED_LIMIT),
    lastEventSeq: data.lastEventSeq,
  };
}
