import { describe, expect, it } from "vitest";

import type { BotSnapshot, StreamEvent } from "@grokbot-office/shared";

import { replayRoster, replayState, REPLAY_FEED_LIMIT } from "./replay";

const DAY_START = "2026-01-15T05:00:00.000Z";

function bot(id: string, name = id): BotSnapshot {
  return {
    id,
    name,
    role: "dev",
    avatar: "spock",
    pod: "dev",
    status: "working",
    label: "LIVE TASK",
    taskId: "live-task",
    handoffId: "live-handoff",
    since: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    lastEventSeq: 42,
  };
}

const roster = [bot("data", "Data"), bot("wesley", "Wesley")];

function event(seq: number, rest: Omit<StreamEvent, "seq" | "receivedAt">): StreamEvent {
  return { seq, receivedAt: `2026-01-15T0${8 + seq}:00:00.000Z`, ...rest };
}

const dayEvents: StreamEvent[] = [
  event(1, { botId: "data", type: "task_started", taskId: "t1", label: "Build" }),
  event(2, {
    botId: "data",
    type: "handoff_sent",
    to: "wesley",
    handoffId: "h1",
    taskId: "t1",
    label: "Review",
  }),
  event(3, { botId: "wesley", type: "handoff_accepted", handoffId: "h1" }),
  event(4, { botId: "wesley", type: "task_started", taskId: "t2", label: "Review" }),
  event(5, { botId: "wesley", type: "task_finished", taskId: "t2", result: "done" }),
];

describe("history replay", () => {
  it("starts every known bot idle, with no live label or handoff", () => {
    const bots = replayRoster(roster, DAY_START);
    const data = bots.data;
    expect(data.status).toBe("idle");
    expect(data.since).toBe(DAY_START);
    expect(data.lastEventSeq).toBe(0);
    expect(data.label).toBeUndefined();
    expect(data.taskId).toBeUndefined();
    expect(data.handoffId).toBeUndefined();
    expect(bots.wesley.name).toBe("Wesley");
  });

  it("applies only the events up to the playhead", () => {
    const start = replayState({ roster, events: dayEvents, playhead: -1, dayStart: DAY_START });
    expect(start.bots.data.status).toBe("idle");
    expect(start.events).toHaveLength(0);
    expect(start.openHandoffs).toEqual([]);

    const afterTask = replayState({ roster, events: dayEvents, playhead: 0, dayStart: DAY_START });
    expect(afterTask.bots.data).toMatchObject({ status: "working", label: "Build", taskId: "t1" });
    expect(afterTask.bots.wesley.status).toBe("idle");
    expect(afterTask.events.map((entry) => entry.seq)).toEqual([1]);

    const waiting = replayState({ roster, events: dayEvents, playhead: 1, dayStart: DAY_START });
    expect(waiting.bots.data.status).toBe("waiting");
    expect(waiting.bots.data.handoffId).toBe("h1");
    expect(waiting.openHandoffs).toHaveLength(1);
    expect(waiting.openHandoffs[0]).toMatchObject({
      id: "h1",
      fromBotId: "data",
      toBotId: "wesley",
    });

    const receiver = replayState({ roster, events: dayEvents, playhead: 3, dayStart: DAY_START });
    expect(receiver.openHandoffs).toEqual([]);
    // Accepting rests the sender and starts the receiver's task.
    expect(receiver.bots.data.status).toBe("idle");
    expect(receiver.bots.data.label).toBeUndefined();
    expect(receiver.bots.wesley).toMatchObject({ status: "working", taskId: "t2" });

    const rest = replayState({ roster, events: dayEvents, playhead: 4, dayStart: DAY_START });
    expect(rest.bots.wesley.status).toBe("idle");
    expect(rest.lastEventSeq).toBe(5);
  });

  it("ignores events for bots that were not registered in the live snapshot", () => {
    const events = [event(1, { botId: "after-dark", type: "task_started", taskId: "t9" })];
    const state = replayState({ roster, events, playhead: 0, dayStart: DAY_START });
    expect(state.bots).not.toHaveProperty("after-dark");
    expect(state.events).toHaveLength(1);
  });

  it("caps the replayed HUD feed at the live feed limit", () => {
    const events = Array.from({ length: REPLAY_FEED_LIMIT + 5 }, (_, index) =>
      event(index + 1, {
        botId: "data",
        type: "status_changed",
        status: index % 2 === 0 ? "working" : "reviewing",
      }),
    );
    const state = replayState({ roster, events, playhead: events.length - 1, dayStart: DAY_START });
    expect(state.events).toHaveLength(REPLAY_FEED_LIMIT);
    expect(state.events.at(-1)?.seq).toBe(events.length);
  });

  it("replays the day's maximum 2000 events within a coarse budget", () => {
    const events: StreamEvent[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const botId = index % 2 === 0 ? "data" : "wesley";
      const taskId = `task-${index}`;
      events.push(
        index % 3 === 0
          ? event(index + 1, { botId, type: "task_finished", taskId, result: "done" })
          : event(index + 1, { botId, type: "task_started", taskId, label: "Chunk" }),
      );
    }
    const started = performance.now();
    const state = replayState({ roster, events, playhead: events.length - 1, dayStart: DAY_START });
    const elapsed = performance.now() - started;
    expect(state.lastEventSeq).toBe(2000);
    expect(elapsed, `replay took ${elapsed.toFixed(0)}ms`).toBeLessThan(2000);
  });
});
