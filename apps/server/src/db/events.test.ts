import { afterEach, describe, expect, it } from "vitest";

import type { EventIn } from "@grokbot-office/shared";

import { openDatabase } from "./database.ts";
import { InvalidEventError, createSqliteRepo } from "./repo.ts";

const now = "2026-01-01T00:00:00.000Z";
const bot = (id: string) => ({
  id,
  name: id,
  role: "worker",
  avatar: "robot",
  pod: "dev" as const,
  hidden: false,
  createdAt: now,
  updatedAt: now,
});
const databases: ReturnType<typeof openDatabase>[] = [];
function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const repo = createSqliteRepo(db);
  repo.upsertBot(bot("data"));
  repo.upsertBot(bot("wesley"));
  return { db, repo };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const task = (eventId: string, taskId?: string): EventIn => ({
  botId: "data",
  eventId,
  type: "task_started",
  ...(taskId === undefined ? {} : { taskId }),
});

describe("applyEvents", () => {
  it("counts duplicates by (bot_id, event_id) without repeating their side effects", () => {
    const { repo } = setup();
    const first = repo.applyEvents("data", [task("e1", "t1"), task("e1", "t2")], now);
    expect(first).toEqual({ accepted: 1, duplicates: 1, lastSeq: 1 });
    // The duplicate was skipped before deriving, so the first task wins.
    expect(repo.getBotStatus("data")).toMatchObject({ status: "working", taskId: "t1" });

    const second = repo.applyEvents("data", [task("e1")], now);
    expect(second).toEqual({ accepted: 0, duplicates: 1, lastSeq: 1 });
    expect(repo.getBotStatus("data")).toMatchObject({ status: "working", taskId: "t1" });
    expect(repo.listEventsSince(0)).toHaveLength(1);
  });

  it("stores the server time and clamps the client clock to ±10 minutes", () => {
    const { repo } = setup();
    repo.applyEvents(
      "data",
      [
        { ...task("e1"), at: "2020-01-01T00:00:00.000Z" },
        { ...task("e2"), at: "2030-01-01T00:00:00.000Z" },
        task("e3"),
      ],
      now,
    );
    const [past, future, absent] = repo.listEventsSince(0);
    expect(past).toMatchObject({ clientAt: "2025-12-31T23:50:00.000Z", receivedAt: now });
    expect(future).toMatchObject({ clientAt: "2026-01-01T00:10:00.000Z", receivedAt: now });
    expect(absent?.clientAt).toBeNull();
  });

  it("rolls the whole batch back and reports the failing index", () => {
    const { repo } = setup();
    const events: EventIn[] = [
      task("e1", "t1"),
      { botId: "data", eventId: "e2", type: "handoff_sent", to: "nobody", handoffId: "h1" },
    ];
    expect(() => repo.applyEvents("data", events, now)).toThrow(InvalidEventError);

    expect(repo.listEventsSince(0)).toEqual([]);
    expect(repo.getBotStatus("data")).toBeUndefined();
  });

  it("keeps the sender working when another task is still open", () => {
    const { repo } = setup();
    repo.applyEvents("data", [task("e1", "t1")], now);
    repo.applyEvents(
      "data",
      [{ botId: "data", eventId: "e2", type: "handoff_sent", to: "wesley", handoffId: "h1" }],
      now,
    );
    expect(repo.getBotStatus("data")).toMatchObject({ status: "working", taskId: "t1" });
  });
});
