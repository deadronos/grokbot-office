import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_HEARTBEAT_TIMEOUT_SEC,
  DEFAULT_RETENTION_DAYS,
  RETENTION_DAYS_MAX,
  DEFAULT_SESSION_TTL_SEC,
  resolveHeartbeatConfig,
  resolveRetentionDays,
  resolveSessionTtlSec,
  SESSION_TTL_MAX_SEC,
} from "./config.ts";

describe("resolveHeartbeatConfig", () => {
  it("falls back to the documented defaults", () => {
    expect(resolveHeartbeatConfig({})).toEqual({ intervalSec: 60, timeoutSec: 300 });
    expect(DEFAULT_HEARTBEAT_INTERVAL_SEC).toBe(60);
    expect(DEFAULT_HEARTBEAT_TIMEOUT_SEC).toBe(300);
  });

  it("treats blank values as unset", () => {
    expect(
      resolveHeartbeatConfig({ HEARTBEAT_INTERVAL_SEC: " ", HEARTBEAT_TIMEOUT_SEC: "" }),
    ).toEqual({ intervalSec: 60, timeoutSec: 300 });
  });

  it("reads overrides and trims surrounding whitespace", () => {
    expect(
      resolveHeartbeatConfig({ HEARTBEAT_INTERVAL_SEC: " 30 ", HEARTBEAT_TIMEOUT_SEC: "120 " }),
    ).toEqual({ intervalSec: 30, timeoutSec: 120 });
  });

  it("rejects values that are not positive integers", () => {
    for (const value of ["0", "-5", "1.5", "abc", "1e3", "Infinity"]) {
      expect(() => resolveHeartbeatConfig({ HEARTBEAT_INTERVAL_SEC: value })).toThrow(
        /HEARTBEAT_INTERVAL_SEC/,
      );
      expect(() => resolveHeartbeatConfig({ HEARTBEAT_TIMEOUT_SEC: value })).toThrow(
        /HEARTBEAT_TIMEOUT_SEC/,
      );
    }
  });

  it("requires the timeout to exceed the interval", () => {
    expect(() =>
      resolveHeartbeatConfig({ HEARTBEAT_INTERVAL_SEC: "300", HEARTBEAT_TIMEOUT_SEC: "300" }),
    ).toThrow(/must be greater than HEARTBEAT_INTERVAL_SEC/);
    expect(() =>
      resolveHeartbeatConfig({ HEARTBEAT_INTERVAL_SEC: "300", HEARTBEAT_TIMEOUT_SEC: "60" }),
    ).toThrow(/must be greater than HEARTBEAT_INTERVAL_SEC/);
  });
});

describe("resolveRetentionDays", () => {
  it("falls back to ninety days", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(resolveRetentionDays({})).toBe(90);
    expect(resolveRetentionDays({ RETENTION_DAYS: " " })).toBe(90);
  });

  it("reads an override and trims it", () => {
    expect(resolveRetentionDays({ RETENTION_DAYS: " 30 " })).toBe(30);
  });

  it("rejects values that are not positive integers", () => {
    for (const value of ["0", "-5", "1.5", "abc", "1e3", "Infinity"]) {
      expect(() => resolveRetentionDays({ RETENTION_DAYS: value })).toThrow(/RETENTION_DAYS/);
    }
  });

  it("caps retention at 36500 days and rejects anything larger at startup", () => {
    expect(RETENTION_DAYS_MAX).toBe(36500);
    expect(resolveRetentionDays({ RETENTION_DAYS: "36500" })).toBe(36500);
    expect(() => resolveRetentionDays({ RETENTION_DAYS: "36501" })).toThrow(/RETENTION_DAYS/);
    expect(() => resolveRetentionDays({ RETENTION_DAYS: "200000000" })).toThrow(/RETENTION_DAYS/);
  });
});

describe("resolveSessionTtlSec", () => {
  it("falls back to eight hours", () => {
    expect(DEFAULT_SESSION_TTL_SEC).toBe(28800);
    expect(resolveSessionTtlSec({})).toBe(28800);
    expect(resolveSessionTtlSec({ SESSION_TTL_SEC: " " })).toBe(28800);
  });

  it("reads an override and trims it", () => {
    expect(resolveSessionTtlSec({ SESSION_TTL_SEC: " 3600 " })).toBe(3600);
    expect(resolveSessionTtlSec({ SESSION_TTL_SEC: String(SESSION_TTL_MAX_SEC) })).toBe(
      SESSION_TTL_MAX_SEC,
    );
  });

  it("rejects values that are not positive integers", () => {
    for (const value of ["0", "-5", "1.5", "abc", "1e3", "Infinity"]) {
      expect(() => resolveSessionTtlSec({ SESSION_TTL_SEC: value })).toThrow(/SESSION_TTL_SEC/);
    }
  });

  it("rejects more than a week", () => {
    expect(() =>
      resolveSessionTtlSec({ SESSION_TTL_SEC: String(SESSION_TTL_MAX_SEC + 1) }),
    ).toThrow(/SESSION_TTL_SEC/);
  });
});
