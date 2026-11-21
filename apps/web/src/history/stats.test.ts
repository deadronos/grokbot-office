import { describe, expect, it } from "vitest";

import type { BotSnapshot, StreamEvent } from "@grokbot-office/shared";

import { computeStats, formatDuration } from "./stats";

const at = (day: number, hour: number) => new Date(2026, 0, day, hour).toISOString();

function event(seq: number, rest: Partial<StreamEvent>): StreamEvent {
  return { seq, botId: "data", type: "status_changed", receivedAt: at(15, 9), ...rest };
}

const bots: Record<string, BotSnapshot> = {
  data: {
    id: "data",
    name: "Data",
    role: "dev",
    avatar: "spock",
    pod: "dev",
    status: "idle",
    since: at(15, 0),
    lastHeartbeatAt: at(15, 0),
    lastEventSeq: 0,
  },
  wesley: {
    id: "wesley",
    name: "Wesley",
    role: "dev",
    avatar: "spock",
    pod: "dev",
    status: "idle",
    since: at(15, 0),
    lastHeartbeatAt: at(15, 0),
    lastEventSeq: 0,
  },
};

const DAYS = ["2026-01-15", "2026-01-16"];

describe("history stats", () => {
  it("counts started tasks per requested local day, including zero days", () => {
    const stats = computeStats({
      events: [
        event(1, { type: "task_started", taskId: "a", receivedAt: at(15, 9) }),
        event(2, { type: "task_started", taskId: "b", receivedAt: at(15, 22) }),
        event(3, { type: "task_started", taskId: "c", receivedAt: at(16, 1) }),
        event(4, { type: "status_changed", receivedAt: at(16, 2) }),
      ],
      dayKeys: DAYS,
      bots,
    });
    expect(stats.days).toEqual([
      { day: "2026-01-15", count: 2 },
      { day: "2026-01-16", count: 1 },
    ]);
  });

  it("computes the median and average handoff latency and counts open handoffs", () => {
    const stats = computeStats({
      events: [
        event(1, {
          type: "handoff_sent",
          botId: "data",
          to: "wesley",
          handoffId: "h1",
          receivedAt: at(15, 8),
        }),
        event(2, {
          type: "handoff_accepted",
          botId: "wesley",
          handoffId: "h1",
          receivedAt: new Date(2026, 0, 15, 8, 0, 20).toISOString(),
        }),
        event(3, {
          type: "handoff_sent",
          botId: "data",
          to: "wesley",
          handoffId: "h2",
          receivedAt: at(15, 10),
        }),
        // h2 accepted 30s later at 10:00:30.
        event(4, {
          type: "handoff_accepted",
          botId: "wesley",
          handoffId: "h2",
          receivedAt: new Date(2026, 0, 15, 10, 0, 30).toISOString(),
        }),
        event(5, {
          type: "handoff_sent",
          botId: "data",
          to: "wesley",
          handoffId: "h3",
          receivedAt: at(15, 11),
        }),
        // Negative durations are clock noise and are ignored.
        event(6, {
          type: "handoff_accepted",
          botId: "wesley",
          handoffId: "h4",
          receivedAt: at(15, 12),
        }),
        event(7, {
          type: "handoff_sent",
          botId: "data",
          to: "wesley",
          handoffId: "h4",
          receivedAt: at(15, 13),
        }),
      ],
      dayKeys: DAYS,
      bots,
    });
    expect(stats.latency).toEqual({
      count: 2,
      medianMs: 25_000,
      averageMs: 25_000,
      open: 1,
    });
  });

  it("names the busiest bot by started tasks, breaking ties by id", () => {
    const busiest = computeStats({
      events: [
        event(1, { type: "task_started", botId: "wesley", taskId: "a" }),
        event(2, { type: "task_started", botId: "data", taskId: "b" }),
        event(3, { type: "task_started", botId: "data", taskId: "c" }),
      ],
      dayKeys: DAYS,
      bots,
    }).busiest;
    expect(busiest).toEqual({ botId: "data", name: "Data", count: 2 });

    const tie = computeStats({
      events: [
        event(1, { type: "task_started", botId: "wesley", taskId: "a" }),
        event(2, { type: "task_started", botId: "data", taskId: "b" }),
      ],
      dayKeys: DAYS,
      bots,
    }).busiest;
    expect(tie?.botId).toBe("data");
    expect(computeStats({ events: [], dayKeys: DAYS, bots }).busiest).toBeNull();
  });

  it("formats latencies compactly", () => {
    expect(formatDuration(950)).toBe("950ms");
    expect(formatDuration(20_000)).toBe("20s");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(95_000)).toBe("1m 35s");
    expect(formatDuration(120_000)).toBe("2m");
  });
});
