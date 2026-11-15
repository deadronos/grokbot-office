import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { AppEnv } from "../auth/middleware.ts";
import { requireToken } from "../auth/middleware.ts";
import { guardCookieMutation } from "../auth/csrf.ts";
import { createSession, SESSION_COOKIE_NAME, sessionCookieOptions } from "../auth/session.ts";
import { hashToken } from "../auth/tokens.ts";
import type { Repo } from "../db/repo.ts";
import { nowUtc } from "../time.ts";

/**
 * The browser's session exchange: `EventSource` cannot send an Authorization
 * header, so the viewer trades its bearer token for an HttpOnly cookie once.
 *
 * The token itself never goes in the cookie, and the DB stores only the hash.
 */
export function sessionRoutes({
  repo,
  adminToken,
  sessionTtlSec,
  sessionMaxPerToken,
  sessionIdleSec,
  corsOrigins,
}: {
  repo: Repo;
  adminToken: string | undefined;
  sessionTtlSec: number;
  sessionMaxPerToken: number;
  sessionIdleSec: number;
  corsOrigins: readonly string[];
}) {
  const api = new Hono<AppEnv>();

  // Any request body is ignored on purpose: the bearer token decides everything.
  api.post("/", requireToken({ repo, kind: "viewer", adminToken }), (c) => {
    const { secret, expiresAt } = createSession(
      repo,
      c.get("token").id,
      nowUtc(),
      sessionTtlSec,
      sessionMaxPerToken,
      sessionIdleSec,
    );
    setCookie(c, SESSION_COOKIE_NAME, secret, sessionCookieOptions(sessionTtlSec));
    c.header("Cache-Control", "no-store");
    return c.json({ expiresAt }, 201);
  });

  // Idempotent and unauthenticated: no cookie, an unknown cookie or a dead session
  // all just clear the cookie and answer 204, so there is nothing to probe.
  // It still refuses a cross-site caller, or a foreign page could log the viewer out.
  api.post("/logout", (c) => {
    const refused = guardCookieMutation(c, corsOrigins);
    if (refused) return refused;
    // Logout is never rate-limited: a bad-token flood must not leave a valid cookie in place.
    const secret = getCookie(c, SESSION_COOKIE_NAME);
    if (secret !== undefined) {
      // Current or previous hash, at any age: a post-rotation logout with the old
      // cookie must still revoke the row (and therefore both hashes).
      const hashed = hashToken(secret);
      const session = repo.findSessionByHash(hashed) ?? repo.findSessionByPrevHash(hashed);
      if (session && session.revokedAt === null) repo.revokeSession(session.id, nowUtc());
    }
    deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(0));
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  return api;
}
