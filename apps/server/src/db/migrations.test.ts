import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import { openDatabase } from "./database.ts";
import { createSqliteRepo } from "./repo.ts";

const MIGRATIONS = resolve(import.meta.dirname, "../../drizzle");
const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

/** A migrations folder holding only the first `count` migrations, so old tables can be filled. */
function folderAt(dir: string, count: number): string {
  const folder = join(dir, `drizzle-${count}`);
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const entries = journal.entries.slice(0, count);
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}
const folderAt0000 = (dir: string) => folderAt(dir, 1);

/**
 * SQLite cannot add CHECK or foreign-key constraints in place, so 0001 recreates
 * every table. This is the proof that it copies the data across instead of
 * dropping it, and that the deferred foreign keys survive the rebuild.
 */
describe("0001_constraints migration", () => {
  it("keeps existing rows and adds the constraints", () => {
    const dir = mkdtempSync(join(tmpdir(), "grokbot-office-migrations-"));
    const path = join(dir, "bot-office.db");
    try {
      const old = new Database(path);
      old.pragma("foreign_keys = ON");
      migrate(drizzle(old), { migrationsFolder: folderAt0000(dir) });
      old
        .prepare("insert into bots values ('data','Data','worker','robot','dev',3,1,?,?)")
        .run(NOW, NOW);
      old
        .prepare("insert into bots values ('wesley','Wesley','worker','robot','dev',0,0,?,?)")
        .run(NOW, NOW);
      old
        .prepare("insert into bot_status values ('data','working','plan','t1','wesley',?,?,7)")
        .run(NOW, LATER);
      old
        .prepare("insert into tokens values ('tok1','bot','data','abcd1234','hash',?,?,null)")
        .run(NOW, LATER);
      old
        .prepare("insert into handoffs values ('h1','data','wesley','plan','accepted',?,?)")
        .run(NOW, LATER);
      old
        .prepare(
          "insert into events (event_id,bot_id,type,label,ref,task_id,handoff_id,to_bot_id,result,client_at,received_at) " +
            "values ('e1','data','handoff_sent','plan','ref','t1','h1','wesley',null,?,?)",
        )
        .run(NOW, LATER);
      old.close();

      const db = openDatabase(path);
      try {
        // Enforcement is back on after the migration ran.
        expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

        const bot = db.prepare("select * from bots where id = 'data'").get();
        expect(bot).toMatchObject({ name: "Data", hidden: 1, created_at: NOW });
        // 0003 drops desk_index: desks come from the shared layout only.
        expect(bot).not.toHaveProperty("desk_index");
        expect(db.prepare("select * from bot_status").get()).toMatchObject({
          bot_id: "data",
          status: "working",
          label: "plan",
          task_id: "t1",
          handoff_to: "wesley",
          last_event_seq: 7,
        });
        expect(db.prepare("select * from tokens").get()).toMatchObject({
          id: "tok1",
          kind: "bot",
          prefix: "abcd1234",
        });
        expect(db.prepare("select * from handoffs").get()).toMatchObject({
          id: "h1",
          state: "accepted",
          accepted_at: LATER,
        });
        expect(db.prepare("select * from events").get()).toMatchObject({
          seq: 1,
          event_id: "e1",
          type: "handoff_sent",
          handoff_id: "h1",
          to_bot_id: "wesley",
          status: null,
          received_at: LATER,
        });

        const indexes = (
          db.prepare("select name from sqlite_master where type = 'index'").all() as {
            name: string;
          }[]
        ).map((row) => row.name);
        for (const index of [
          "events_bot_id_event_id_unique",
          "events_received_at_idx",
          "events_bot_id_seq_idx",
          "bot_status_last_heartbeat_at_idx",
          "handoffs_to_bot_id_state_idx",
          "tokens_hash_unique",
          "tokens_bot_id_idx",
        ]) {
          expect(indexes).toContain(index);
        }

        expect(db.pragma("foreign_key_check")).toEqual([]);
        expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects bad enum values and dangling handoff ids", () => {
    const db = openDatabase(":memory:");
    try {
      db.prepare(
        "insert into bots (id, name, role, avatar, pod, hidden, created_at, updated_at) values ('data','Data','worker','robot','dev',0,?,?)",
      ).run(NOW, NOW);
      const insertStatus = db.prepare(
        "insert into bot_status (bot_id, status, since, last_heartbeat_at) values ('data', ?, ?, ?)",
      );
      expect(() => insertStatus.run("napping", NOW, NOW)).toThrow(/CHECK/);
      insertStatus.run("idle", NOW, NOW);

      const insertEvent = (type: string, result: string | null, handoffId: string | null) =>
        db
          .prepare(
            "insert into events (event_id,bot_id,type,handoff_id,result,received_at) values (?, 'data', ?, ?, ?, ?)",
          )
          .run(`${type}-${Math.random()}`, type, handoffId, result, NOW);
      expect(() => insertEvent("teleported", null, null)).toThrow(/CHECK/);
      expect(() => insertEvent("task_finished", "shipped", null)).toThrow(/CHECK/);
      expect(() => insertEvent("task_finished", null, "missing")).toThrow(/FOREIGN KEY/);

      expect(() =>
        db.prepare("insert into tokens values ('t','root',null,'x','y',?,null,null)").run(NOW),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare("insert into handoffs values ('h','data','data',null,'weird',?,null)").run(NOW),
      ).toThrow(/CHECK/);
      expect(() =>
        db.prepare("insert into bots values ('b','B','worker','robot','moon',0,?,?)").run(NOW, NOW),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});

describe("0005_label_handoff migration", () => {
  it("backfills the label source of accepts stored before the upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "grokbot-office-migrations-"));
    const path = join(dir, "bot-office.db");
    try {
      const old = new Database(path);
      old.pragma("foreign_keys = ON");
      migrate(drizzle(old), { migrationsFolder: folderAt(dir, 5) });
      const bot = old.prepare(
        "insert into bots (id, name, role, avatar, pod, hidden, created_at, updated_at) values (?, ?, 'worker', 'robot', 'dev', 0, ?, ?)",
      );
      for (const id of ["quark", "zeta", "omega"]) bot.run(id, id, NOW, NOW);
      old
        .prepare(
          "insert into handoffs (id, from_bot_id, to_bot_id, label, state, sent_at, accepted_at) values ('h-later', 'quark', 'zeta', 'LATER-HIDDEN-LABEL', 'accepted', ?, ?)",
        )
        .run(NOW, LATER);
      old
        .prepare(
          "insert into events (event_id, bot_id, type, handoff_id, received_at) values ('e2', 'zeta', 'handoff_accepted', 'h-later', ?)",
        )
        .run(LATER);
      const status = old.prepare(
        "insert into bot_status (bot_id, status, label, since, last_heartbeat_at) values (?, 'working', ?, ?, ?)",
      );
      status.run("zeta", "LATER-HIDDEN-LABEL", LATER, LATER);
      // Same receiver pattern, but a label of its own: not attributed.
      status.run("omega", "own work", LATER, LATER);
      old.close();

      const db = openDatabase(path);
      try {
        const sources = db
          .prepare("select bot_id, label_handoff_id from bot_status order by bot_id")
          .all();
        expect(sources).toEqual([
          { bot_id: "omega", label_handoff_id: null },
          { bot_id: "zeta", label_handoff_id: "h-later" },
        ]);
        expect(db.pragma("foreign_key_check")).toEqual([]);

        // Hiding the sender after the upgrade scrubs the backfilled label at read time.
        const repo = createSqliteRepo(db);
        repo.updateBot("quark", { hidden: true });
        const zeta = repo.getSnapshot().statuses.find((row) => row.botId === "zeta");
        expect(zeta?.label).toBeNull();
        expect(repo.getSnapshot().statuses.find((row) => row.botId === "omega")?.label).toBe(
          "own work",
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
