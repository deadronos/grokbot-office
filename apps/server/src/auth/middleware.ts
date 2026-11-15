import { createMiddleware } from "hono/factory";

import type { Repo, Token } from "../db/repo.ts";
import { nowUtc } from "../time.ts";
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
    const token = plaintext === undefined ? undefined : repo.findTokenByHash(hashToken(plaintext));

    // Never log the token, its prefix/hash, or the Authorization header.
    const reject = (status: 401 | 403, reason: string) => {
      console.warn("auth: token rejected", { reason, tokenId: token?.id });
      return c.json({ error: status === 401 ? "unauthorized" : "forbidden" }, status);
    };

    if (!header) return reject(401, "missing header");
    if (!plaintext) return reject(401, "malformed header");
    if (!token) return reject(401, "unknown token");
    if (token.revokedAt) return reject(401, "revoked token");
    if (token.kind !== kind) return reject(403, "wrong token kind");
    if (kind === "bot" && botIdParam && token.botId !== c.req.param(botIdParam)) {
      return reject(403, "token bound to another bot");
    }

    repo.touchToken(token.id, nowUtc());
    c.set("token", token);
    await next();
  });
}
