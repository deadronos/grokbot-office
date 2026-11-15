import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const migrationsFolder = resolve(
  import.meta.dirname,
  import.meta.dirname.endsWith("/dist") ? "../drizzle" : "../../drizzle",
);

export function openDatabase(
  path = process.env.DATABASE_PATH ?? "./data/bot-office.db",
): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    migrate(drizzle(db), { migrationsFolder });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
