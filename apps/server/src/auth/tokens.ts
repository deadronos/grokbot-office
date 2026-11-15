import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { TOKEN_KINDS as TOKEN_KIND_VALUES, type TokenKind } from "@grokbot-office/shared";

import type { Repo } from "../db/repo.ts";
import { nowUtc } from "../time.ts";

export const TOKEN_BYTES = 32;
/** Stored prefix length; long enough to tell tokens apart, short enough not to narrow a guess. */
export const TOKEN_PREFIX_LENGTH = 8;
export const TOKEN_KINDS = TOKEN_KIND_VALUES;
export type { TokenKind };

/** `.env.example` ships this placeholder; the server refuses admin access until it is replaced. */
export const ADMIN_TOKEN_PLACEHOLDER = "change-me";
/** A short token is treated as unconfigured: `openssl rand -base64 32` gives 44 chars. */
export const ADMIN_TOKEN_MIN_LENGTH = 32;

export type IssuedToken = {
  id: string;
  kind: TokenKind;
  botId: string | null;
  prefix: string;
  /** Plaintext; returned once at creation and never stored. */
  token: string;
};

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hashToken(token: string): string {
  return digest(token).toString("hex");
}

/** First TOKEN_PREFIX_LENGTH chars of the token, capped so a prefix can never grow. */
export function tokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

export function issueToken(
  repo: Repo,
  { kind, botId = null }: { kind: TokenKind; botId?: string | null },
): IssuedToken {
  // Admin access stays env-only, whatever the caller is.
  if (kind === "admin") throw new Error("admin tokens cannot be issued");
  const token = generateToken();
  const prefix = tokenPrefix(token);
  const id = randomUUID();
  repo.insertToken({
    id,
    kind,
    botId,
    prefix,
    hash: hashToken(token),
    createdAt: nowUtc(),
    lastUsedAt: null,
    revokedAt: null,
  });
  return { id, kind, botId, prefix, token };
}

/** Constant-time compare: hashing both sides first gives two equal-length digests. */
export function secretsEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function isAdminTokenUsable(adminToken: string | undefined): adminToken is string {
  if (adminToken === undefined) return false;
  const trimmed = adminToken.trim();
  return trimmed !== ADMIN_TOKEN_PLACEHOLDER && trimmed.length >= ADMIN_TOKEN_MIN_LENGTH;
}

/** `Bearer <token>`; returns undefined for an absent or malformed header. */
export function extractBearerToken(header: string | undefined): string | undefined {
  return /^Bearer +(\S+)$/i.exec(header?.trim() ?? "")?.[1];
}
