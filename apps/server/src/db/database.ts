import { mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export const DEFAULT_DATABASE_PATH = "./data/bot-office.db";

/**
 * `apps/server` package directory. The dev entry lives in `src/db/`, the bundled
 * entry in `dist/`, so `import.meta.dirname` is one of those two.
 */
export function serverRoot(moduleDir = import.meta.dirname): string {
  return resolve(moduleDir, basename(moduleDir) === "dist" ? ".." : "../..");
}

/** Migrations ship next to the bundle (`dist/drizzle`) and in the package (`drizzle`). */
export function migrationsFolder(moduleDir = import.meta.dirname): string {
  return basename(moduleDir) === "dist"
    ? resolve(moduleDir, "drizzle")
    : resolve(moduleDir, "../../drizzle");
}

/**
 * Resolves `DATABASE_PATH` against the app root, not the cwd, so the server and the
 * admin CLI open the same file from any directory. Production requires an absolute path.
 */
export function resolveDatabasePath(
  path = process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH,
  {
    appRoot = serverRoot(),
    production = process.env.NODE_ENV === "production",
  }: { appRoot?: string; production?: boolean } = {},
): string {
  if (path === ":memory:" || isAbsolute(path)) return path;
  if (production) {
    throw new Error(`DATABASE_PATH must be an absolute path in production, got "${path}"`);
  }
  return resolve(appRoot, path);
}

export function openDatabase(path = resolveDatabasePath()): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    migrate(drizzle(db), { migrationsFolder: migrationsFolder() });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
