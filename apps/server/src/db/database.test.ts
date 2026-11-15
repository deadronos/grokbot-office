import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DATABASE_PATH,
  migrationsFolder,
  resolveDatabasePath,
  serverRoot,
} from "./database.ts";

const APP_ROOT = resolve(import.meta.dirname, "../..");

describe("DATABASE_PATH", () => {
  it("resolves relative paths against the server package, not the cwd", () => {
    expect(resolveDatabasePath(DEFAULT_DATABASE_PATH, { appRoot: APP_ROOT })).toBe(
      join(APP_ROOT, "data/bot-office.db"),
    );
    expect(resolveDatabasePath("./data/x.db", { appRoot: "/tmp/app" })).toBe("/tmp/app/data/x.db");
  });

  it("keeps absolute paths and :memory: as they are", () => {
    expect(resolveDatabasePath("/var/lib/x.db")).toBe("/var/lib/x.db");
    expect(resolveDatabasePath(":memory:")).toBe(":memory:");
  });

  it("requires an absolute path in production", () => {
    expect(() =>
      resolveDatabasePath("./data/x.db", { appRoot: APP_ROOT, production: true }),
    ).toThrow(/absolute/);
    expect(resolveDatabasePath("/var/lib/x.db", { appRoot: APP_ROOT, production: true })).toBe(
      "/var/lib/x.db",
    );
    expect(resolveDatabasePath(":memory:", { production: true })).toBe(":memory:");
  });

  it("derives the server root from the running module directory", () => {
    expect(serverRoot(join(APP_ROOT, "src/db"))).toBe(APP_ROOT);
    expect(serverRoot(join(APP_ROOT, "dist"))).toBe(APP_ROOT);
  });
});

describe("migrations folder", () => {
  it("uses apps/server/drizzle in dev and dist/drizzle when bundled", () => {
    const dev = migrationsFolder(join(APP_ROOT, "src/db"));
    expect(dev).toBe(join(APP_ROOT, "drizzle"));
    expect(existsSync(join(dev, "meta/_journal.json"))).toBe(true);

    expect(migrationsFolder(join(APP_ROOT, "dist"))).toBe(join(APP_ROOT, "dist/drizzle"));
  });
});
