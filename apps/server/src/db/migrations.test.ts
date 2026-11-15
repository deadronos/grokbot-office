import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import { openDatabase } from "./database.ts";

const MIGRATIONS = resolve(import.meta.dirname, "../../drizzle");
const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

/** A migrations folder that stops after 0000, so the old tables can be filled first. */
function folderAt0000(dir: string): string {
  const folder = join(dir, "drizzle-0000");
  mkdirSync(join(folder, "meta"), { recursive: true });
  copyFileSync(join(MIGRATIONS, "0000_init.sql"), join(folder, "0000_init.sql"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"));
  writeFileSync(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
  );
  return folder;
}

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

        expect(db.prepare("select * from bots where id = 'data'").get()).toMatchObject({
          name: "Data",
          desk_index: 3,
          hidden: 1,
          created_at: NOW,
        });
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
      db.prepare("insert into bots values ('data','Data','worker','robot','dev',0,0,?,?)").run(
        NOW,
        NOW,
      );
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
        db
          .prepare("insert into bots values ('b','B','worker','robot','moon',0,0,?,?)")
          .run(NOW, NOW),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
