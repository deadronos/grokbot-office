import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.ts";
import { createSqliteRepo, type Status } from "./repo.ts";

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
  return { db, repo: createSqliteRepo(db) };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("SQLite repository", () => {
  it("applies migrations and enforces foreign keys", () => {
    const { db } = setup();
    const names = db
      .prepare("select name from sqlite_master where type in ('table', 'index')")
      .all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "bots",
        "bot_status",
        "events",
        "handoffs",
        "tokens",
        "events_bot_id_event_id_unique",
        "events_received_at_idx",
        "events_bot_id_seq_idx",
        "bot_status_last_heartbeat_at_idx",
        "handoffs_to_bot_id_state_idx",
        "tokens_hash_unique",
        "tokens_bot_id_idx",
      ]),
    );
    expect(() =>
      db
        .prepare(
          "insert into bot_status (bot_id, status, since, last_heartbeat_at) values ('missing', 'idle', ?, ?)",
        )
        .run(now, now),
    ).toThrow();
  });
  it("upserts bots and status", () => {
    const { repo } = setup();
    repo.upsertBot(bot("a"));
    repo.upsertBot({ ...bot("a"), name: "updated" });
    expect(repo.getBot("a")?.name).toBe("updated");
    expect(repo.listBots()).toHaveLength(1);
    const status = {
      botId: "a",
      status: "idle" as const,
      label: null,
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      since: now,
      lastHeartbeatAt: now,
      lastEventSeq: null,
    };
    repo.setBotStatus(status);
    expect(repo.getBotStatus("a")).toEqual(status);
  });
  it("deduplicates events per bot and assigns increasing sequence numbers", () => {
    const { repo } = setup();
    repo.upsertBot(bot("a"));
    repo.upsertBot(bot("b"));
    const event = {
      eventId: "event",
      botId: "a",
      type: "task_started" as const,
      label: null,
      ref: null,
      taskId: null,
      handoffId: null,
      toBotId: null,
      result: null,
      clientAt: now,
      receivedAt: now,
    };
    const first = repo.insertEvent(event);
    expect(first).toEqual({ duplicate: false, seq: 1 });
    expect(repo.insertEvent(event)).toEqual({ duplicate: true, seq: 1 });
    const second = repo.insertEvent({ ...event, botId: "b" });
    expect(second.duplicate).toBe(false);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(repo.listEventsSince(first.seq).map((row) => row.botId)).toEqual(["b"]);
  });
  it("creates and updates handoffs and stores token hashes", () => {
    const { db, repo } = setup();
    repo.upsertBot(bot("a"));
    repo.upsertBot(bot("b"));
    const handoff = {
      id: "h",
      fromBotId: "a",
      toBotId: "b",
      label: "work",
      state: "sent" as const,
      sentAt: now,
      acceptedAt: null,
    };
    repo.createHandoff(handoff);
    repo.updateHandoffState("h", "accepted", now);
    expect(repo.getHandoff("h")).toEqual({ ...handoff, state: "accepted", acceptedAt: now });
    const token = {
      id: "t",
      kind: "bot" as const,
      botId: "a",
      prefix: "12345678",
      hash: "hash-value",
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    repo.insertToken(token);
    expect(repo.findTokenByHash(token.hash)).toEqual(token);
    repo.revokeToken("t", now);
    expect(repo.findTokenByHash(token.hash)?.revokedAt).toBe(now);
    expect(
      (db.prepare("pragma table_info(tokens)").all() as { name: string }[]).map((c) => c.name),
    ).toEqual([
      "id",
      "kind",
      "bot_id",
      "prefix",
      "hash",
      "created_at",
      "last_used_at",
      "revoked_at",
    ]);
  });
  it("stores events without a client timestamp", () => {
    const { repo } = setup();
    repo.upsertBot(bot("guest"));
    const result = repo.insertEvent({
      eventId: "01JD7X5K2M3Q8V9R4T6Y0ZB1AC",
      botId: "guest",
      type: "task_started",
      receivedAt: now,
    });
    expect(result.duplicate).toBe(false);
    expect(repo.listEventsSince(0)[0]?.clientAt).toBeNull();
  });
  it("registers bots idempotently, keeping admin-owned fields", () => {
    const { repo } = setup();
    const later = "2026-02-01T00:00:00.000Z";
    const profile = { id: "a", name: "A", role: "worker", avatar: "robot", pod: "dev" as const };
    repo.registerBot(profile, now);
    repo.updateBot("a", { hidden: true });
    repo.registerBot({ ...profile, name: "A II", pod: "ops" }, later);

    expect(repo.getBot("a")).toEqual({
      ...profile,
      name: "A II",
      pod: "ops",
      hidden: true,
      createdAt: now,
      updatedAt: later,
    });
    expect(repo.getBotStatus("a")).toMatchObject({
      status: "idle",
      since: now,
      lastHeartbeatAt: later,
    });
  });
  it("touches heartbeats without letting them enter working or waiting", () => {
    const { repo } = setup();
    repo.upsertBot(bot("a"));
    const later = "2026-01-02T00:00:00.000Z";
    const laterStill = "2026-01-03T00:00:00.000Z";

    // working/waiting are rejected at the route; the repo also leaves state untouched.
    repo.touchHeartbeat("a", "working", now);
    expect(repo.getBotStatus("a")).toBeUndefined();

    repo.touchHeartbeat("a", undefined, now);
    expect(repo.getBotStatus("a")).toMatchObject({
      status: "idle",
      since: now,
      lastHeartbeatAt: now,
    });

    repo.touchHeartbeat("a", "waiting", later);
    expect(repo.getBotStatus("a")).toMatchObject({
      status: "idle",
      since: now,
      lastHeartbeatAt: now,
    });

    repo.touchHeartbeat("a", undefined, later);
    expect(repo.getBotStatus("a")).toMatchObject({
      status: "idle",
      since: now,
      lastHeartbeatAt: later,
    });

    // A heartbeat may enter reviewing, but never leave it for working/waiting.
    repo.touchHeartbeat("a", "reviewing", laterStill);
    expect(repo.getBotStatus("a")).toMatchObject({ status: "reviewing", since: laterStill });
    repo.touchHeartbeat("a", "working", laterStill);
    expect(repo.getBotStatus("a")).toMatchObject({
      status: "reviewing",
      since: laterStill,
      lastHeartbeatAt: laterStill,
    });

    // A heartbeat cannot end derived working; only `offline` gets through.
    repo.setBotStatus({ ...(repo.getBotStatus("a") as Status), status: "working" });
    repo.touchHeartbeat("a", "reviewing", laterStill);
    expect(repo.getBotStatus("a")).toMatchObject({ status: "working", since: laterStill });

    repo.touchHeartbeat("a", "offline", laterStill);
    expect(repo.getBotStatus("a")).toMatchObject({
      status: "offline",
      since: laterStill,
      lastHeartbeatAt: laterStill,
    });
  });

  it("does not bring an offline bot back on a working or waiting heartbeat", () => {
    const { repo } = setup();
    repo.upsertBot(bot("a"));
    const offline = "2026-01-02T00:00:00.000Z";
    const back = "2026-01-03T00:00:00.000Z";
    repo.setBotStatus({
      botId: "a",
      status: "offline",
      label: null,
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      since: offline,
      lastHeartbeatAt: offline,
      lastEventSeq: null,
    });

    for (const status of ["working", "waiting"] as const) {
      expect(repo.touchHeartbeat("a", status, back)).toBe(false);
      expect(repo.getBotStatus("a")).toMatchObject({
        status: "offline",
        since: offline,
        lastHeartbeatAt: offline,
      });
      expect(repo.listEventsSince(0)).toEqual([]);
    }

    expect(repo.touchHeartbeat("a", undefined, back)).toBe(true);
    expect(repo.getBotStatus("a")).toMatchObject({ status: "idle", since: back });
    expect(repo.listEventsSince(0).at(-1)).toMatchObject({
      type: "status_changed",
      status: "idle",
    });
  });

  it("releases task and handoff links when a heartbeat brings a bot to rest", () => {
    const { repo } = setup();
    repo.upsertBot(bot("a"));
    repo.upsertBot(bot("b"));
    const start = "2026-01-01T00:00:00.000Z";
    repo.setBotStatus({
      botId: "a",
      status: "working",
      label: "Plan",
      taskId: "t1",
      handoffTo: "b",
      handoffId: null,
      labelHandoffId: null,
      since: start,
      lastHeartbeatAt: start,
      lastEventSeq: null,
    });
    repo.touchHeartbeat("a", "idle", "2026-01-02T00:00:00.000Z");
    expect(repo.getBotStatus("a")).toMatchObject({ status: "working", taskId: "t1" });
    repo.touchHeartbeat("a", "offline", "2026-01-02T00:00:00.000Z");
    expect(repo.getBotStatus("a")).toMatchObject({
      status: "offline",
      taskId: null,
      label: null,
      handoffTo: null,
      handoffId: null,
    });
    // From a resting state a heartbeat may set any status.
    repo.touchHeartbeat("a", "reviewing", "2026-01-03T00:00:00.000Z");
    expect(repo.getBotStatus("a")).toMatchObject({ status: "reviewing" });
    repo.touchHeartbeat("a", "idle", "2026-01-04T00:00:00.000Z");
    expect(repo.getBotStatus("a")).toMatchObject({ status: "idle", taskId: null });
  });
  it("opens file databases in WAL mode and re-applies migrations idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "grokbot-office-db-"));
    try {
      const path = join(dir, "nested", "bot-office.db");
      const first = openDatabase(path);
      expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(first.pragma("foreign_keys", { simple: true })).toBe(1);
      // WAL + NORMAL: durable across app crashes, may lose the last commits on power loss.
      expect(first.pragma("synchronous", { simple: true })).toBe(1);
      createSqliteRepo(first).upsertBot(bot("a"));
      first.close();
      const second = openDatabase(path);
      expect(createSqliteRepo(second).listBots()).toHaveLength(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
