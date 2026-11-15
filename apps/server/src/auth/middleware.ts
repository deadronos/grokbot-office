import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import type { Repo, Token } from "../db/repo.ts";
import { nowUtc } from "../time.ts";
import type { TokenKind } from "./tokens.ts";
import { extractBearerToken, hashToken, isAdminTokenUsable, secretsEqual } from "./tokens.ts";

export type AppEnv = { Variables: { token: Token } };

/** One generic body for every auth failure, so a caller cannot probe which check failed. */
function reject(c: Context<AppEnv>, status: 401 | 403, reason: string, tokenId?: string) {
  // Never log the token, its prefix/hash, or the Authorization header.
  console.warn("auth: token rejected", tokenId === undefined ? { reason } : { reason, tokenId });
  return c.json({ error: status === 401 ? "unauthorized" : "forbidden" }, status);
}

/**
 * Admin auth is env-only: `ADMIN_TOKEN` (never committed, never in the DB).
 * Unset or placeholder means the admin API refuses to serve at all (503).
 * Authorization headers are read, never logged.
 */
export function requireAdmin({ adminToken }: { adminToken: string | undefined }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isAdminTokenUsable(adminToken)) {
      return c.json({ error: "admin token is not configured" }, 503);
    }
    const header = c.req.header("authorization");
    if (!header) return c.json({ error: "missing bearer token" }, 401);
    const token = extractBearerToken(header);
    if (!token) return c.json({ error: "malformed authorization header" }, 401);
    // Whitespace around a pasted token is a copy/paste artefact, not a different secret.
    if (!secretsEqual(token, adminToken.trim())) return c.json({ error: "invalid token" }, 401);
    await next();
  });
}

/**
 * Bearer-token auth for bot/viewer routes. `botIdParam` names the route param
 * holding the bot slug and requires the token to be bound to that bot.
 *
 * Every failure answers the same generic 401/403 body so a caller cannot probe
 * which check failed; the specific reason goes to one server-side log line.
 */
export function requireToken({
  repo,
  kind,
  botIdParam,
}: {
  repo: Repo;
  kind: TokenKind;
  botIdParam?: string;
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    const plaintext = extractBearerToken(header);
    if (!header) return reject(c, 401, "missing header");
    if (!plaintext) return reject(c, 401, "malformed header");

    const token = repo.findTokenByHash(hashToken(plaintext));
    if (!token) return reject(c, 401, "unknown token");
    if (token.revokedAt) return reject(c, 401, "revoked token", token.id);
    if (token.kind !== kind) return reject(c, 403, "wrong token kind", token.id);
    if (kind === "bot" && botIdParam && token.botId !== c.req.param(botIdParam)) {
      return reject(c, 403, "token bound to another bot", token.id);
    }

    repo.touchToken(token.id, nowUtc());
    c.set("token", token);
    await next();
  });
}

/**
 * Read access for the viewer: an active viewer token, or the env `ADMIN_TOKEN`.
 * Only bearer headers for now; #10 plugs the HttpOnly session cookie in here.
 */
export function requireViewer({
  repo,
  adminToken,
}: {
  repo: Repo;
  adminToken: string | undefined;
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    const plaintext = extractBearerToken(header);
    if (!header) return reject(c, 401, "missing header");
    if (!plaintext) return reject(c, 401, "malformed header");

    // The admin token is env-only, not a DB row: match before hashing, and never log it.
    if (isAdminTokenUsable(adminToken) && secretsEqual(plaintext, adminToken.trim())) {
      await next();
      return;
    }

    const token = repo.findTokenByHash(hashToken(plaintext));
    if (!token) return reject(c, 401, "unknown token");
    if (token.revokedAt) return reject(c, 401, "revoked token", token.id);
    if (token.kind !== "viewer") return reject(c, 403, "wrong token kind", token.id);

    repo.touchToken(token.id, nowUtc());
    c.set("token", token);
    await next();
  });
}
