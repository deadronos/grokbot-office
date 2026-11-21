import type { BotSnapshot, StreamEvent } from "@grokbot-office/shared";

import { eventDayKey } from "./time";

export type DayCount = { day: string; count: number };
export type LatencyStats = { count: number; medianMs: number; averageMs: number; open: number };
export type BusiestBot = { botId: string; name: string; count: number };
export type HistoryStats = { days: DayCount[]; latency: LatencyStats; busiest: BusiestBot | null };

function eventTime(event: StreamEvent): number {
  return Date.parse(event.receivedAt ?? event.at);
}

function median(values: readonly number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Stats over the events the client actually loaded (the recent window plus any
 * selected day), so a busy day is never summarized from a partial page.
 */
export function computeStats({
  events,
  dayKeys,
  bots,
}: {
  events: readonly StreamEvent[];
  dayKeys: readonly string[];
  bots: Record<string, BotSnapshot>;
}): HistoryStats {
  const allowedDays = new Set(dayKeys);
  const perDay = new Map(dayKeys.map((day) => [day, 0]));
  const started = new Map<string, number>();
  const sent = new Map<string, number>();
  const accepted = new Map<string, number>();

  for (const event of events) {
    if (event.type === "task_started") {
      const day = eventDayKey(event);
      if (allowedDays.has(day)) perDay.set(day, (perDay.get(day) ?? 0) + 1);
      started.set(event.botId, (started.get(event.botId) ?? 0) + 1);
    } else if (event.type === "handoff_sent" && event.handoffId) {
      if (!sent.has(event.handoffId)) sent.set(event.handoffId, eventTime(event));
    } else if (event.type === "handoff_accepted" && event.handoffId) {
      if (!accepted.has(event.handoffId)) accepted.set(event.handoffId, eventTime(event));
    }
  }

  const durations: number[] = [];
  let open = 0;
  for (const [handoffId, sentAt] of sent) {
    const acceptedAt = accepted.get(handoffId);
    if (acceptedAt === undefined) {
      open += 1;
    } else if (acceptedAt >= sentAt) {
      durations.push(acceptedAt - sentAt);
    }
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  const latency: LatencyStats = {
    count: durations.length,
    medianMs: durations.length === 0 ? 0 : Math.round(median(durations)),
    averageMs: durations.length === 0 ? 0 : Math.round(total / durations.length),
    open,
  };

  let busiest: BusiestBot | null = null;
  for (const [botId, count] of started) {
    if (!busiest || count > busiest.count || (count === busiest.count && botId < busiest.botId)) {
      busiest = { botId, name: bots[botId]?.name ?? botId, count };
    }
  }

  return {
    days: dayKeys.map((day) => ({ day, count: perDay.get(day) ?? 0 })),
    latency,
    busiest,
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
