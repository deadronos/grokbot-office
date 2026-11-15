import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";

import type { Repo, Session, Token } from "../db/repo.ts";
import { clientIp, rateLimited, type RateLimits } from "../rate-limit.ts";
import { nowUtc, toUtc } from "../time.ts";
import { rotateSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "./session.ts";
import type { TokenKind } from "./tokens.ts";
import { extractBearerToken, hashToken, isAdminTokenUsable, secretsEqual } from "./tokens.ts";

export type AppEnv = { Variables: { token: Token; limits: RateLimits } };

/** Every budget a viewer needs: idle cutoff and cookie-rotation age. */
export type ViewerSessionPolicy = { idleSec: number; rotateSec: number };

/** One generic body for every auth failure, so a caller cannot probe which check failed. */
function reject(c: Context<AppEnv>, status: 401 | 403, reason: string, tokenId?: string) {
  // Failed auth burns IP budget first: the 429 wins so the password stays affordable to crack.
  const limit = ipLimited(c);
  if (limit) return limit;
  // Never log the token, its prefix/hash, or the Authorization header.
  console.warn("auth: token rejected", tokenId === undefined ? { reason } : { reason, tokenId });
  return c.json({ error: status === 401 ? "unauthorized" : "forbidden" }, status);
}

/** Costs one request against a token's budget; `undefined` means go ahead. */
function tokenLimited(c: Context<AppEnv>, key: string): Response | undefined {
  // A bare `new Hono<AppEnv>()` in middleware tests never sets `limits`; live apps always do.
  const limits = c.get("limits") as RateLimits | undefined;
  if (!limits) return;
  const decision = limits.token(key);
  return decision.allowed ? undefined : rateLimited(c, decision.retryAfterSec);
}

/** Costs one request against the caller's IP budget. */
export function ipLimited(c: Context<AppEnv>): Response | undefined {
  const limits = c.get("limits") as RateLimits | undefined;
  if (!limits) return;
  const decision = limits.ip(clientIp(c));
  return decision.allowed ? undefined : rateLimited(c, decision.retryAfterSec);
}

export type ViewerValidation =
  | { ok: true; token: Token | undefined; session: Session | undefined }
  | { ok: false; status: 401 | 403; reason: string; tokenId?: string };

/**
 * Viewer auth for one credential pair: a bearer header decides alone, otherwise the
 * session cookie. Neither means no credentials. Pure, so the SSE stream can re-check
 * the very credential it opened with later (on every ping).
 *
 * A session is valid only while it exists, is unexpired, unrevoked, seen within
 * `idleSec`, and its viewer token still exists and is unrevoked.
 */
export function validateViewer({
  repo,
  adminToken,
  header,
  secret,
  now,
  idleSec,
}: {
  repo: Repo;
  adminToken: string | undefined;
  header: string | undefined;
  secret: string | undefined;
  now: string;
  idleSec: number;
}): ViewerValidation {
  if (header !== undefined) {
    const plaintext = extractBearerToken(header);
    if (!plaintext) return { ok: false, status: 401, reason: "malformed header" };

    // The admin token is env-only, not a DB row: match before hashing, and never log it.
    if (isAdminTokenUsable(adminToken) && secretsEqual(plaintext, adminToken.trim())) {
      return { ok: true, token: undefined, session: undefined };
    }

    const token = repo.findTokenByHash(hashToken(plaintext));
    if (!token) return { ok: false, status: 401, reason: "unknown token" };
    if (token.revokedAt)
      return { ok: false, status: 401, reason: "revoked token", tokenId: token.id };
    if (token.kind !== "viewer") {
      return { ok: false, status: 403, reason: "wrong token kind", tokenId: token.id };
    }
    return { ok: true, token, session: undefined };
  }

  if (secret === undefined) return { ok: false, status: 401, reason: "missing credentials" };

  const session = repo.findSessionByHash(hashToken(secret));
  if (!session) return { ok: false, status: 401, reason: "unknown session" };
  if (session.revokedAt !== null) {
    return { ok: false, status: 401, reason: "revoked session", tokenId: session.tokenId };
  }
  // Stored UTC text: time order is text order.
  if (session.expiresAt <= now) {
    return { ok: false, status: 401, reason: "expired session", tokenId: session.tokenId };
  }
  if (session.lastSeenAt < toUtc(new Date(Date.parse(now) - idleSec * 1000))) {
    return { ok: false, status: 401, reason: "idle session", tokenId: session.tokenId };
  }
  const token = repo.getToken(session.tokenId);
  if (!token || token.revokedAt !== null) {
    return { ok: false, status: 401, reason: "revoked token", tokenId: session.tokenId };
  }
  return { ok: true, token, session };
}

/**
 * Admin auth is env-only: `ADMIN_TOKEN` (never committed, never in the DB).
 * Unset or placeholder means the admin API refuses to serve at all (503).
 * Authorization headers are read, never logged.
 */
export function requireAdmin({ adminToken }: { adminToken: string | undefined }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!isAdminTokenUsable(adminToken)) {
      return ipLimited(c) ?? c.json({ error: "admin token is not configured" }, 503);
    }
    const header = c.req.header("authorization");
    if (!header) return ipLimited(c) ?? c.json({ error: "missing bearer token" }, 401);
    const token = extractBearerToken(header);
    if (!token) return ipLimited(c) ?? c.json({ error: "malformed authorization header" }, 401);
    // Whitespace around a pasted token is a copy/paste artefact, not a different secret.
    if (!secretsEqual(token, adminToken.trim())) {
      return ipLimited(c) ?? c.json({ error: "invalid token" }, 401);
    }
    // One budget for the env token; it has no DB row to key on.
    const limit = tokenLimited(c, "admin");
    if (limit) return limit;
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
  adminToken,
}: {
  repo: Repo;
  kind: TokenKind;
  botIdParam?: string;
  /** When set, a usable env admin bearer is refused with 403 instead of 401. */
  adminToken?: string;
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    const plaintext = extractBearerToken(header);
    if (!header) return reject(c, 401, "missing header");
    if (!plaintext) return reject(c, 401, "malformed header");
    if (
      adminToken !== undefined &&
      isAdminTokenUsable(adminToken) &&
      secretsEqual(plaintext, adminToken.trim())
    ) {
      return reject(c, 403, "admin token");
    }

    const token = repo.findTokenByHash(hashToken(plaintext));
    if (!token) return reject(c, 401, "unknown token");
    if (token.revokedAt) return reject(c, 401, "revoked token", token.id);
    if (token.kind !== kind) return reject(c, 403, "wrong token kind", token.id);
    if (kind === "bot" && botIdParam && token.botId !== c.req.param(botIdParam)) {
      return reject(c, 403, "token bound to another bot", token.id);
    }

    const limit = tokenLimited(c, token.id);
    if (limit) return limit;
    repo.touchToken(token.id, nowUtc());
    c.set("token", token);
    await next();
  });
}

/**
 * Read access for the viewer: an `Authorization` header (viewer token or the env
 * `ADMIN_TOKEN`) when present, otherwise the HttpOnly session cookie.
 *
 * Cookie requests count against their viewer token's budget, refresh `last_seen_at`,
 * and — unless `rotate: false`, as the SSE stream and its pings use — swap in a new
 * secret once the cookie is older than `policy.rotateSec`.
 */
export function requireViewer({
  repo,
  adminToken,
  policy,
  rotate = true,
}: {
  repo: Repo;
  adminToken: string | undefined;
  policy: ViewerSessionPolicy;
  rotate?: boolean;
}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const now = nowUtc();
    const result = validateViewer({
      repo,
      adminToken,
      header: c.req.header("authorization"),
      secret: getCookie(c, SESSION_COOKIE_NAME),
      now,
      idleSec: policy.idleSec,
    });
    if (!result.ok) return reject(c, result.status, result.reason, result.tokenId);

    const limit = tokenLimited(c, result.token?.id ?? result.session?.tokenId ?? "admin");
    if (limit) return limit;

    if (result.token) {
      repo.touchToken(result.token.id, now);
      c.set("token", result.token);
    }
    if (result.session) {
      repo.touchSession(result.session.id, now);
      // A stream cannot read a new cookie mid-connection, so it never rotates.
      if (
        rotate &&
        Date.parse(now) - Date.parse(result.session.createdAt) > policy.rotateSec * 1000
      ) {
        const rotated = rotateSession(repo, result.session, now);
        setCookie(c, SESSION_COOKIE_NAME, rotated.secret, sessionCookieOptions(rotated.maxAgeSec));
      }
    }
    await next();
  });
}
