import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  botCreate,
  isEntryModule,
  main,
  runCli,
  tokenCreate,
  tokenList,
  tokenRevoke,
} from "./cli.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";
import { botRecord, testSetup } from "./test-utils.ts";

const cleanups: (() => void)[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const context = testSetup();
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  return context;
}

const noop = () => undefined;

function captureRepo() {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line) };
}

describe("admin CLI commands", () => {
  it("creates a bot token, prints it exactly once and stores only the hash", () => {
    const { repo } = setup();
    const { lines, out } = captureRepo();
    tokenCreate(repo, ["--kind", "bot", "--bot", "data"], out);

    const [summary, token, warning] = lines;
    expect(summary).toContain('bot token for "data"');
    expect(token).toBeDefined();
    expect(warning).toContain("not shown again");
    expect(lines.join("\n").split(token!).length - 1).toBe(1);

    const stored = repo.listTokens()[0]!;
    expect(stored.kind).toBe("bot");
    expect(stored.prefix).toBe(token!.slice(0, 8));
    expect(stored.hash).not.toBe(token);
  });

  it("creates a bot from the fixed layout, then issues its first token", () => {
    const { repo } = setup();
    const { lines, out } = captureRepo();
    botCreate(repo, ["--id", "lumi", "--name", "Lumi", "--desk", "0"], out);

    expect(repo.getBot("lumi")).toMatchObject({
      id: "lumi",
      name: "Lumi",
      pod: "command",
      role: "bot",
      avatar: "robot",
      hidden: false,
    });
    expect(lines[0]).toContain('Created bot "lumi"');
    expect(lines[1]).toContain("token create --kind bot --bot lumi");
    expect(() =>
      tokenCreate(repo, ["--kind", "bot", "--bot", "lumi"], () => undefined),
    ).not.toThrow();
  });

  it("rejects ids, names, desks and pods the layout cannot hold", () => {
    const { repo } = setup();
    expect(() => botCreate(repo, ["--name", "Nobody"], noop)).toThrow(/--id/);
    expect(() => botCreate(repo, ["--id", "Data", "--name", "Data"], noop)).toThrow(/--id/);
    expect(() => botCreate(repo, ["--id", "lumi"], noop)).toThrow(/--name/);
    expect(() => botCreate(repo, ["--id", "data", "--name", "Data"], noop)).toThrow(
      /already exists/,
    );

    // The desk index must be the bot's own desk in its pod.
    expect(() => botCreate(repo, ["--id", "wesley", "--name", "W", "--desk", "0"], noop)).toThrow(
      /index 1/,
    );
    expect(() => botCreate(repo, ["--id", "spock", "--name", "S", "--desk", "x"], noop)).toThrow(
      /index 3/,
    );
    expect(() => botCreate(repo, ["--id", "lumi", "--name", "L", "--pod", "ops"], noop)).toThrow(
      /pod command/,
    );
    expect(() => botCreate(repo, ["--id", "lumi", "--name", "L", "--pod", "sales"], noop)).toThrow(
      /--pod/,
    );
  });

  it("keeps bots outside the layout HUD-only in the requested pod", () => {
    const { repo } = setup();
    botCreate(repo, ["--id", "scribe", "--name", "Scribe", "--pod", "ops"], () => undefined);
    expect(repo.getBot("scribe")).toMatchObject({ pod: "ops" });
    expect(() =>
      botCreate(repo, ["--id", "ghost", "--name", "Ghost", "--desk", "0"], () => undefined),
    ).toThrow(/no desk/);
  });

  it("creates viewer tokens and validates arguments", () => {
    const { repo } = setup();
    const { out } = captureRepo();
    expect(() => tokenCreate(repo, ["--kind", "viewer"], out)).not.toThrow();
    expect(() => tokenCreate(repo, ["--kind", "bot", "--bot", "nobody"], out)).toThrow(
      /unknown bot/,
    );
    expect(() => tokenCreate(repo, ["--kind", "bot"], out)).toThrow(/--bot/);
    expect(() => tokenCreate(repo, ["--kind", "party"], out)).toThrow(/--kind/);
    expect(() => tokenCreate(repo, ["--kind", "admin"], out)).toThrow(/--kind/);
    expect(() => tokenCreate(repo, ["--kind", "viewer", "--bot", "data"], out)).toThrow(/--bot/);
  });

  it("lists tokens without plaintext or hash", () => {
    const { repo } = setup();
    const issue = captureRepo();
    tokenCreate(repo, ["--kind", "bot", "--bot", "data"], issue.out);
    const token = issue.lines[1]!;

    const list = captureRepo();
    tokenList(repo, list.out);
    expect(list.lines).toHaveLength(1);
    expect(list.lines[0]).toContain("bot");
    expect(list.lines[0]).toContain("data");
    expect(list.lines[0]).toContain("last used never");
    expect(list.lines.join("\n")).not.toContain(token);

    const empty = captureRepo();
    tokenList(setup().repo, empty.out);
    expect(empty.lines).toEqual(["No tokens."]);
  });

  it("revokes tokens and rejects unknown ids", () => {
    const { repo } = setup();
    const issue = captureRepo();
    tokenCreate(repo, ["--kind", "viewer"], issue.out);
    const id = repo.listTokens()[0]!.id;

    tokenRevoke(repo, [id], () => undefined);
    expect(repo.getToken(id)?.revokedAt).not.toBeNull();
    expect(() => tokenRevoke(repo, ["unknown"], () => undefined)).toThrow(/unknown token/);
  });

  it("dispatches subcommands and rejects bad usage", () => {
    const { repo } = setup();
    const { lines, out } = captureRepo();
    runCli(repo, ["token", "create", "--kind", "bot", "--bot", "data"], out);
    expect(lines).toHaveLength(3);
    expect(() => runCli(repo, ["token", "list"], out)).not.toThrow();
    expect(() => runCli(repo, ["token", "wat"], out)).toThrow(/usage/);
    expect(() => runCli(repo, ["bots"], out)).toThrow(/usage/);
    expect(() => runCli(repo, ["bot", "wat"], out)).toThrow(/usage/);
  });
});

describe("admin CLI process", () => {
  it("closes the database handle so no -wal/-shm files are left behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "grokbot-office-cli-"));
    dirs.push(dir);
    const path = join(dir, "bot-office.db");
    const db = openDatabase(path);
    createSqliteRepo(db).upsertBot(botRecord("data"));
    // WAL files exist while the handle is open and disappear once it is closed.
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect(existsSync(`${path}-shm`)).toBe(true);
    db.close();
    expect(existsSync(`${path}-wal`)).toBe(false);

    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path;
    try {
      const { lines, out } = captureRepo();
      expect(main(["token", "create", "--kind", "bot", "--bot", "data"], { out, err: out })).toBe(
        0,
      );
      expect(lines[1]).toBeDefined();
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);

      const errors: string[] = [];
      expect(main(["token", "wat"], { out: () => undefined, err: (l) => errors.push(l) })).toBe(1);
      expect(errors[0]).toContain("usage");
      expect(existsSync(`${path}-wal`)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
    }
  });
});

describe("isEntryModule", () => {
  it("matches the entry file through a symlinked path", () => {
    const dir = mkdtempSync(join(tmpdir(), "go-cli-entry-"));
    dirs.push(dir);
    const real = join(dir, "cli.js");
    writeFileSync(real, "");
    const link = join(dir, "link.js");
    symlinkSync(real, link);
    const url = pathToFileURL(real).href;
    expect(isEntryModule(real, url)).toBe(true);
    expect(isEntryModule(link, url)).toBe(true);
    expect(isEntryModule(join(dir, "other.js"), url)).toBe(false);
    expect(isEntryModule(undefined, url)).toBe(false);
  });
});
