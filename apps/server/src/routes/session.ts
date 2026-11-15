import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import type { AppEnv } from "../auth/middleware.ts";
import { requireToken } from "../auth/middleware.ts";
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
}: {
  repo: Repo;
  adminToken: string | undefined;
  sessionTtlSec: number;
}) {
  const api = new Hono<AppEnv>();

  // Any request body is ignored on purpose: the bearer token decides everything.
  api.post("/", requireToken({ repo, kind: "viewer", adminToken }), (c) => {
    const { secret, expiresAt } = createSession(repo, c.get("token").id, nowUtc(), sessionTtlSec);
    setCookie(c, SESSION_COOKIE_NAME, secret, sessionCookieOptions(sessionTtlSec));
    c.header("Cache-Control", "no-store");
    return c.json({ expiresAt }, 201);
  });

  // Idempotent and unauthenticated: no cookie, an unknown cookie or a dead session
  // all just clear the cookie and answer 204, so there is nothing to probe.
  api.post("/logout", (c) => {
    const secret = getCookie(c, SESSION_COOKIE_NAME);
    if (secret !== undefined) {
      const session = repo.findSessionByHash(hashToken(secret));
      if (session && session.revokedAt === null) repo.revokeSession(session.id, nowUtc());
    }
    deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(0));
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  });

  return api;
}
