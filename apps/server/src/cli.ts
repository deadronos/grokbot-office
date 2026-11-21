import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

import { z } from "zod/mini";

import { BotId, PODS, RegisterBody, getDesk, type Pod } from "@grokbot-office/shared";

import { issueToken } from "./auth/tokens.ts";
import { openDatabase } from "./db/database.ts";
import type { Repo } from "./db/repo.ts";
import { createSqliteRepo } from "./db/repo.ts";
import { loadRootEnv } from "./env.ts";
import { nowUtc } from "./time.ts";

const USAGE = `usage:
  bot create --id <slug> --name <name> [--desk <n>] [--pod <pod>] [--role <role>] [--avatar <avatar>]
  token create --kind <bot|viewer> [--bot <slug>]
  token list
  token revoke <token id>`;

export type Output = (line: string) => void;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  // `--name --desk 3` would otherwise silently name the bot "--desk".
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

/** The register schema's limits, so the CLI cannot store what the API would reject. */
const ProfileFields = z.pick(RegisterBody, { name: true, role: true, avatar: true });

/**
 * Creates the bot row a fresh bot needs before `token create --kind bot` can work.
 * The layout is fixed, so `--desk` must name the bot's own desk index in its pod;
 * bots without a desk take `--pod` (default `dev`) and sit in the HUD list only.
 */
export function botCreate(repo: Repo, args: string[], out: Output): void {
  const id = flag(args, "--id");
  if (id === undefined) throw new Error("--id <slug> is required");
  const parsed = BotId.safeParse(id);
  if (!parsed.success) throw new Error(`--id ${parsed.error.issues[0]?.message ?? "is invalid"}`);
  if (repo.getBot(parsed.data)) throw new Error(`bot "${parsed.data}" already exists`);

  const desk = getDesk(parsed.data);
  const deskFlag = flag(args, "--desk");
  if (deskFlag !== undefined) {
    if (desk === undefined) throw new Error(`bot "${parsed.data}" has no desk in the fixed layout`);
    if (!/^\d+$/.test(deskFlag) || Number(deskFlag) !== desk.index) {
      throw new Error(`desk for "${parsed.data}" is index ${desk.index}, got "${deskFlag}"`);
    }
  }

  const pod = flag(args, "--pod") ?? desk?.pod ?? "dev";
  if (!PODS.includes(pod as Pod)) throw new Error(`--pod must be one of ${PODS.join(", ")}`);
  if (desk !== undefined && pod !== desk.pod) {
    throw new Error(`bot "${parsed.data}" sits in pod ${desk.pod}, not ${pod}`);
  }

  const name = flag(args, "--name");
  if (name === undefined) throw new Error("--name <name> is required");
  const profile = ProfileFields.safeParse({
    name,
    role: flag(args, "--role") ?? "bot",
    avatar: flag(args, "--avatar") ?? "robot",
  });
  if (!profile.success) {
    const issue = profile.error.issues[0];
    throw new Error(`--${String(issue?.path[0])} ${issue?.message ?? "is invalid"}`);
  }
  const now = nowUtc();
  repo.upsertBot({
    id: parsed.data,
    name: profile.data.name,
    role: profile.data.role,
    avatar: profile.data.avatar,
    pod: pod as Pod,
    hidden: false,
    createdAt: now,
    updatedAt: now,
  });
  out(`Created bot "${parsed.data}" (${pod}).`);
  out(`Next: pnpm admin token create --kind bot --bot ${parsed.data}`);
}

export function tokenCreate(repo: Repo, args: string[], out: Output): void {
  // Admin access stays env-only (ADMIN_TOKEN), matching POST /api/admin/tokens.
  const kind = flag(args, "--kind");
  if (kind !== "bot" && kind !== "viewer") throw new Error("--kind must be one of bot, viewer");
  const botId = flag(args, "--bot");
  if (kind === "bot") {
    if (!botId) throw new Error("--bot <slug> is required for bot tokens");
    if (!repo.getBot(botId)) throw new Error(`unknown bot "${botId}"`);
  } else if (botId !== undefined) {
    throw new Error("--bot is only valid for bot tokens");
  }

  const issued = issueToken(repo, { kind, botId: kind === "bot" ? botId : null });
  const subject = issued.botId ? `bot token for "${issued.botId}"` : `${issued.kind} token`;
  out(`Created ${subject} (id ${issued.id}, prefix ${issued.prefix}).`);
  out(issued.token);
  out("Store it now: it is not shown again.");
}

export function tokenList(repo: Repo, out: Output): void {
  const tokens = repo.listTokens();
  if (tokens.length === 0) return out("No tokens.");
  for (const token of tokens) {
    const state = token.revokedAt ? `revoked ${token.revokedAt}` : "active";
    out(
      [
        token.id,
        token.kind,
        token.botId ?? "-",
        token.prefix,
        `created ${token.createdAt}`,
        `last used ${token.lastUsedAt ?? "never"}`,
        state,
      ].join("  "),
    );
  }
}

export function tokenRevoke(repo: Repo, args: string[], out: Output): void {
  const id = args[0];
  if (!id) throw new Error("token revoke needs a token id");
  if (!repo.getToken(id)) throw new Error(`unknown token "${id}"`);
  repo.revokeToken(id, nowUtc());
  out(`Revoked token ${id}.`);
}

/** Exported for tests: no process exit, no implicit I/O. */
export function runCli(repo: Repo, argv: string[], out: Output): void {
  const [group, action, ...rest] = argv;
  if (group === "bot") {
    if (action === "create") return botCreate(repo, rest, out);
    throw new Error(USAGE);
  }
  if (group !== "token") throw new Error(USAGE);
  if (action === "create") return tokenCreate(repo, rest, out);
  if (action === "list") return tokenList(repo, out);
  if (action === "revoke") return tokenRevoke(repo, rest, out);
  throw new Error(USAGE);
}

/** Opens the DB directly (no ADMIN_TOKEN needed locally) and always closes it. */
export function main(
  argv = process.argv.slice(2),
  io: { out: Output; err: Output } = { out: console.log, err: console.error },
): number {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase();
    runCli(createSqliteRepo(db), argv, io.out);
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    db?.close();
  }
}

/**
 * Node resolves symlinks for the entry module's URL but not for argv[1], so compare
 * real paths: otherwise `node /tmp/.../cli.js` on macOS (/tmp → /private/tmp) or a
 * symlinked install silently does nothing.
 */
export function isEntryModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1], import.meta.url)) {
  // Not at import time: tests must not pick up a developer's real .env.
  loadRootEnv();
  // `pnpm admin ...` forwards arguments after its own `--`.
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  process.exitCode = main(argv);
}
