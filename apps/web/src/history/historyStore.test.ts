import type { BotSnapshot, StreamEvent } from "@grokbot-office/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOfficeStore } from "../store/officeStore";
import { useHistoryStore } from "./historyStore";
import { localDayKey } from "./time";

const today = localDayKey(new Date());

function at(hour: number): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function event(seq: number, hour: number, extra: Partial<StreamEvent> = {}): StreamEvent {
  return { seq, botId: "data", type: "status_changed", receivedAt: at(hour), ...extra };
}

const rosterBot: BotSnapshot = {
  id: "data",
  name: "Data",
  role: "engineer",
  avatar: "data",
  pod: "dev",
  status: "working",
  since: at(8),
  lastHeartbeatAt: at(8),
  lastEventSeq: 1,
};

function page(events: StreamEvent[], hasMore = false): Response {
  return new Response(
    JSON.stringify({
      events,
      nextSince: events.at(-1)?.seq ?? 0,
      hasMore,
      lastSeq: events.at(-1)?.seq ?? 0,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function stubFetch(events: StreamEvent[]): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(page(events)));
}

afterEach(() => {
  useHistoryStore.getState().exit();
  useOfficeStore.setState({ bots: {} });
  vi.unstubAllGlobals();
});

describe("history store", () => {
  it("opens on today with the playhead at the last event", async () => {
    useOfficeStore.setState({ bots: { data: rosterBot } });
    stubFetch([
      event(1, 10, { type: "task_started", label: "Build", taskId: "t1" }),
      event(2, 11, { type: "task_finished", taskId: "t1", result: "done" }),
    ]);

    await useHistoryStore.getState().enter();

    const state = useHistoryStore.getState();
    expect(state.active).toBe(true);
    expect(state.day).toBe(today);
    expect(state.dayEvents).toHaveLength(2);
    expect(state.playhead).toBe(1);
    expect(state.replay.bots.data?.status).toBe("idle");
    expect(state.replay.events).toHaveLength(2);
    expect(state.stats.days.find((day) => day.day === today)?.count).toBe(1);
    expect(state.loading).toBe(false);
  });

  it("scrubs, steps, and clamps inside the day", async () => {
    useOfficeStore.setState({ bots: { data: rosterBot } });
    stubFetch([
      event(1, 10, { type: "task_started", label: "Build", taskId: "t1" }),
      event(2, 11, { type: "task_finished", taskId: "t1", result: "done" }),
    ]);
    await useHistoryStore.getState().enter();

    useHistoryStore.getState().stepBy(-5);
    expect(useHistoryStore.getState().playhead).toBe(0);
    expect(useHistoryStore.getState().replay.bots.data?.status).toBe("working");
    expect(useHistoryStore.getState().replay.events).toHaveLength(1);

    useHistoryStore.getState().stepBy(9);
    expect(useHistoryStore.getState().playhead).toBe(1);
  });

  it("pauses on scrub and wraps Play at the end back to the start", async () => {
    useOfficeStore.setState({ bots: { data: rosterBot } });
    stubFetch([
      event(1, 10, { type: "task_started", label: "Build", taskId: "t1" }),
      event(2, 11, { type: "task_finished", taskId: "t1", result: "done" }),
    ]);
    const store = useHistoryStore.getState();
    await store.enter();

    const state = useHistoryStore.getState();
    state.togglePlay();
    expect(useHistoryStore.getState().playhead).toBe(0);
    expect(useHistoryStore.getState().playing).toBe(true);
    expect(useHistoryStore.getState().replay.events).toHaveLength(1);

    state.togglePlay();
    expect(useHistoryStore.getState().playing).toBe(false);

    state.scrubTo(1);
    expect(useHistoryStore.getState().playhead).toBe(1);
    expect(useHistoryStore.getState().replay.bots.data?.status).toBe("idle");
  });

  it("orders the day by arrival time, not by sequence", async () => {
    useOfficeStore.setState({ bots: { data: rosterBot } });
    stubFetch([
      event(2, 9, { type: "task_started", label: "First", taskId: "t1" }),
      event(1, 10, { type: "task_started", label: "Second", taskId: "t2" }),
    ]);

    await useHistoryStore.getState().enter();

    expect(useHistoryStore.getState().dayEvents.map((entry) => entry.seq)).toEqual([2, 1]);
    expect(useHistoryStore.getState().replay.bots.data?.label).toBe("Second");
  });

  it("keeps a readable error when the server fails", async () => {
    useOfficeStore.setState({ bots: {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));

    await useHistoryStore.getState().enter();

    const state = useHistoryStore.getState();
    expect(state.loading).toBe(false);
    expect(state.error).toBe("History request failed (503).");
    expect(state.dayEvents).toEqual([]);
  });
});
