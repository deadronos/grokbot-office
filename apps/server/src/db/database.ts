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
    // WAL + NORMAL trades an fsync per commit for losing only the last transactions on power loss.
    db.pragma("synchronous = NORMAL");
    // SQLite cannot add CHECK or foreign-key constraints in place, so migrations rebuild
    // tables by copy/drop/rename. That needs enforcement off: the migrator wraps every
    // pending migration in one transaction, so a pragma inside the .sql file cannot
    // change it, and the deferred checks left by the dropped tables fail the COMMIT.
    // Every query after this point runs with enforcement back on.
    db.pragma("foreign_keys = OFF");
    migrate(drizzle(db), { migrationsFolder: migrationsFolder() });
    db.pragma("foreign_keys = ON");
    // With enforcement off during the rebuild, prove nothing dangling was left behind.
    const violations = db.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) {
      throw new Error(`database has ${violations.length} foreign key violation(s) after migrating`);
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
