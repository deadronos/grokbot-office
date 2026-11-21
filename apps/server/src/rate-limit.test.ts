import { describe, expect, it } from "vitest";

import { TokenBuckets, createRateLimits } from "./rate-limit.ts";

const ALLOW = { allowed: true };

describe("TokenBuckets", () => {
  it("allows a burst then refuses until the bucket refills", () => {
    let now = 0;
    const limits = createRateLimits(
      { perMin: 60, burst: 2, ipPerMin: 30, ipBurst: 1, cookieFailurePerMin: 60 },
      () => now,
    );

    expect(limits.token("t")).toEqual(ALLOW);
    expect(limits.token("t")).toEqual(ALLOW);
    const refused = limits.token("t");
    expect(refused).toEqual({ allowed: false, retryAfterSec: 1 });

    // One token per second at 60/min, so a second is enough for one more.
    now = 1000;
    expect(limits.token("t")).toEqual(ALLOW);
  });

  it("keeps budgets apart per key and per kind", () => {
    const limits = createRateLimits({
      perMin: 60,
      burst: 1,
      ipPerMin: 30,
      ipBurst: 1,
      cookieFailurePerMin: 60,
    });

    expect(limits.token("a")).toEqual(ALLOW);
    expect(limits.token("a").allowed).toBe(false);
    expect(limits.token("b")).toEqual(ALLOW);
    expect(limits.ip("10.0.0.1")).toEqual(ALLOW);
    expect(limits.ip("10.0.0.1").allowed).toBe(false);
    expect(limits.ip("10.0.0.2")).toEqual(ALLOW);
  });

  it("never reports a zero wait", () => {
    const limits = createRateLimits(
      { perMin: 60, burst: 1, ipPerMin: 30, ipBurst: 1, cookieFailurePerMin: 60 },
      () => 0,
    );
    limits.token("a");
    for (const decision of [limits.token("a"), limits.token("a"), limits.token("a")]) {
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });

  it("evicts the oldest keys once the map hits its cap", () => {
    const buckets = new TokenBuckets(() => 0, { maxKeys: 2 });
    expect(buckets.take("a", 1, 60).allowed).toBe(true);
    expect(buckets.take("b", 1, 60).allowed).toBe(true);
    expect(buckets.take("c", 1, 60).allowed).toBe(true);
    expect(buckets.size).toBe(2);
    // "a" was evicted, so it starts a fresh burst.
    expect(buckets.take("a", 1, 60).allowed).toBe(true);
  });

  it("keeps failed-auth budgets apart from general unauthenticated IP traffic", () => {
    const limits = createRateLimits({
      perMin: 60,
      burst: 1,
      ipPerMin: 30,
      ipBurst: 1,
      cookieFailurePerMin: 60,
    });
    expect(limits.failedAuth("10.0.0.1")).toEqual(ALLOW);
    expect(limits.failedAuth("10.0.0.1").allowed).toBe(false);
    expect(limits.ip("10.0.0.1")).toEqual(ALLOW);
  });

  it("counts cookie failures in a high ceiling of their own", () => {
    const limits = createRateLimits({
      perMin: 60,
      burst: 1,
      ipPerMin: 30,
      ipBurst: 1,
      cookieFailurePerMin: 2,
    });
    expect(limits.cookieFailure("10.0.0.1")).toEqual(ALLOW);
    expect(limits.cookieFailure("10.0.0.1")).toEqual(ALLOW);
    expect(limits.cookieFailure("10.0.0.1").allowed).toBe(false);
    // Garbage cookies leave the bearer and no-credential budgets alone.
    expect(limits.ip("10.0.0.1")).toEqual(ALLOW);
    expect(limits.failedAuth("10.0.0.1")).toEqual(ALLOW);
  });
});
