import type { Context } from "hono";

import type { RateLimitConfig } from "./config.ts";

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSec: number };

type Bucket = { tokens: number; at: number };

/** Default cap on in-memory keys; evicts the oldest `at` when a new key would exceed it. */
export const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000;

/**
 * In-process token buckets: `burst` requests at once, then one more every `60 / perMin`
 * seconds. Injectable clock so tests can run short windows without waiting.
 *
 * The map is swept on access: when it would grow past `maxKeys`, the oldest bucket is dropped.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(
    private readonly clock: () => number = Date.now,
    options: { maxKeys?: number } = {},
  ) {
    this.maxKeys = options.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS;
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string, burst: number, perMin: number): RateLimitDecision {
    const at = this.clock();
    const perSec = perMin / 60;
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
      this.evictOldest();
    }
    const bucket = this.buckets.get(key) ?? { tokens: burst, at };
    const tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) / 1000) * perSec);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at });
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / perSec)) };
    }
    this.buckets.set(key, { tokens: tokens - 1, at });
    return { allowed: true };
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, bucket] of this.buckets) {
      if (bucket.at < oldestAt) {
        oldestAt = bucket.at;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

/** The budgets: per authenticated token, per unauthenticated IP, and failed bearer attempts. */
export type RateLimits = {
  token: (key: string) => RateLimitDecision;
  ip: (key: string) => RateLimitDecision;
  failedAuth: (key: string) => RateLimitDecision;
};

export function createRateLimits(
  config: RateLimitConfig,
  clock: () => number = Date.now,
  options: { maxKeys?: number } = {},
): RateLimits {
  const buckets = new TokenBuckets(clock, options);
  return {
    token: (key) => buckets.take(`token:${key}`, config.burst, config.perMin),
    ip: (key) => buckets.take(`ip:${key}`, config.ipBurst, config.ipPerMin),
    failedAuth: (key) => buckets.take(`failed:${key}`, config.ipBurst, config.ipPerMin),
  };
}

/**
 * The connection address. We bind loopback only, so `X-Forwarded-For` is ignored: a
 * local reverse proxy still connects from 127.0.0.1, which is all this limit needs.
 */
export function clientIp(c: Context): string {
  // SAFETY: @hono/node-server puts the Node request on `c.env.incoming`; plain hono
  // contexts (unit tests) have no socket, hence the optional chain below.
  const env = c.env as unknown as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

/** The one body every rate-limited request gets; `Retry-After` says when to try again. */
export function rateLimited(c: Context, retryAfterSec: number): Response {
  c.header("Retry-After", String(retryAfterSec));
  return c.json({ error: "rate limited" }, 429);
}
