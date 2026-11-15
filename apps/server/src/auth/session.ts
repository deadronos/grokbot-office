import { randomBytes, randomUUID } from "node:crypto";

import type { CookieOptions } from "hono/utils/cookie";

import type { Repo } from "../db/repo.ts";
import { toUtc } from "../time.ts";
import { hashToken } from "./tokens.ts";

/** The `__Secure-` prefix requires HTTPS, which the `secure` flag already promises. */
export const SESSION_COOKIE_NAME = "__Secure-bo_session";
/** Same secret size as bearer tokens; the hash is all the database ever sees. */
export const SESSION_SECRET_BYTES = 32;

const DAY_MS = 24 * 60 * 60 * 1000;

/** HttpOnly, Secure, SameSite=Strict and scoped to `/api`, so no script can read it. */
export function sessionCookieOptions(ttlSec: number): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: "Strict", path: "/api", maxAge: ttlSec };
}

export type CreatedSession = { secret: string; expiresAt: string };

/** Creates a session for a viewer token and returns the one-time secret for the cookie. */
export function createSession(
  repo: Repo,
  tokenId: string,
  now: string,
  ttlSec: number,
): CreatedSession {
  const secret = randomBytes(SESSION_SECRET_BYTES).toString("base64url");
  const expiresAt = toUtc(new Date(Date.parse(now) + ttlSec * 1000));
  repo.insertSession({
    id: randomUUID(),
    tokenHash: hashToken(secret),
    tokenId,
    createdAt: now,
    expiresAt,
    revokedAt: null,
  });
  // Lazy cleanup: a session that expired over a day ago is useless either way,
  // and creating one is rare enough to pay for the delete.
  repo.deleteExpiredSessions(toUtc(new Date(Date.parse(now) - DAY_MS)));
  return { secret, expiresAt };
}
