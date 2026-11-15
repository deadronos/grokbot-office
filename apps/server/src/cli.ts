import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { issueToken } from "./auth/tokens.ts";
import { openDatabase } from "./db/database.ts";
import type { Repo } from "./db/repo.ts";
import { createSqliteRepo } from "./db/repo.ts";

const USAGE = `usage:
  token create --kind <bot|viewer> [--bot <slug>]
  token list
  token revoke <token id>`;

export type Output = (line: string) => void;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
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
  repo.revokeToken(id, new Date().toISOString());
  out(`Revoked token ${id}.`);
}

/** Exported for tests: no process exit, no implicit I/O. */
export function runCli(repo: Repo, argv: string[], out: Output): void {
  const [group, action, ...rest] = argv;
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

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // `pnpm admin ...` forwards arguments after its own `--`.
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  process.exitCode = main(argv);
}
