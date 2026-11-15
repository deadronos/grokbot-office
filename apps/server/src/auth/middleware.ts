import { createMiddleware } from "hono/factory";

import type { Repo, Token } from "../db/repo.ts";
import type { TokenKind } from "./tokens.ts";
import { extractBearerToken, hashToken, isAdminTokenUsable, secretsEqual } from "./tokens.ts";

export type AppEnv = { Variables: { token: Token } };

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
    if (!secretsEqual(token, adminToken)) return c.json({ error: "invalid token" }, 401);
    await next();
  });
}

/**
 * Bearer-token auth for later bot/viewer routes. `botIdParam` names the route
 * param holding the bot slug and requires the token to be bound to that bot.
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
    if (!header) return c.json({ error: "missing bearer token" }, 401);
    const plaintext = extractBearerToken(header);
    if (!plaintext) return c.json({ error: "malformed authorization header" }, 401);
    const token = repo.findTokenByHash(hashToken(plaintext));
    if (!token) return c.json({ error: "invalid token" }, 401);
    if (token.revokedAt) return c.json({ error: "token revoked" }, 401);
    if (token.kind !== kind) return c.json({ error: "wrong token kind" }, 403);
    if (kind === "bot" && botIdParam && (!token.botId || token.botId !== c.req.param(botIdParam))) {
      return c.json({ error: "token is not valid for this bot" }, 403);
    }
    repo.touchToken(token.id, new Date().toISOString());
    c.set("token", token);
    await next();
  });
}
