import { randomBytes, randomUUID } from "node:crypto";

import type { CookieOptions } from "hono/utils/cookie";

import type { Repo, Session } from "../db/repo.ts";
import { toUtc } from "../time.ts";
import { hashToken } from "./tokens.ts";

/** The `__Secure-` prefix requires HTTPS, which the `secure` flag already promises. */
export const SESSION_COOKIE_NAME = "__Secure-bo_session";
/** Same secret size as bearer tokens; the hash is all the database ever sees. */
export const SESSION_SECRET_BYTES = 32;

/** HttpOnly, Secure, SameSite=Strict and scoped to `/api`, so no script can read it. */
export function sessionCookieOptions(ttlSec: number): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: "Strict", path: "/api", maxAge: ttlSec };
}

export type CreatedSession = { secret: string; expiresAt: string };

/**
 * Creates a session for a viewer token and returns the one-time secret for the cookie.
 * Pruning expired rows and evicting the token's oldest live session past the cap happen
 * in the same transaction as the insert (`Repo.insertSessionCapped`).
 */
export function createSession(
  repo: Repo,
  tokenId: string,
  now: string,
  ttlSec: number,
  maxPerToken: number,
  idleSec: number,
): CreatedSession {
  const secret = randomBytes(SESSION_SECRET_BYTES).toString("base64url");
  const expiresAt = toUtc(new Date(Date.parse(now) + ttlSec * 1000));
  const idleCutoff = toUtc(new Date(Date.parse(now) - idleSec * 1000));
  repo.insertSessionCapped(
    {
      id: randomUUID(),
      tokenHash: hashToken(secret),
      tokenId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      revokedAt: null,
      prevTokenHash: null,
      rotatedAt: null,
    },
    maxPerToken,
    now,
    idleCutoff,
  );
  return { secret, expiresAt };
}

/**
 * Replaces the secret on the same row, so the cap keeps counting one session. The
 * absolute `expires_at` does not move: the cookie only ever gets the remaining TTL.
 */
export function rotateSession(
  repo: Repo,
  session: Session,
  now: string,
): { secret: string; maxAgeSec: number } | undefined {
  const secret = randomBytes(SESSION_SECRET_BYTES).toString("base64url");
  // Compare-and-swap on the current hash: a lost race leaves the previous hash valid
  // for the grace window, and this caller must not Set-Cookie a secret it did not store.
  if (!repo.rotateSessionCas(session.id, session.tokenHash, hashToken(secret), now)) {
    return undefined;
  }
  const remainingSec = Math.ceil((Date.parse(session.expiresAt) - Date.parse(now)) / 1000);
  return { secret, maxAgeSec: Math.max(1, remainingSec) };
}
