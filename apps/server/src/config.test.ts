import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEARTBEAT_AWAY_SEC,
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_HEARTBEAT_TIMEOUT_SEC,
  DEFAULT_RETENTION_DAYS,
  RETENTION_DAYS_MAX,
  DEFAULT_SESSION_IDLE_SEC,
  DEFAULT_SESSION_ROTATE_SEC,
  DEFAULT_SESSION_ROTATE_GRACE_SEC,
  DEFAULT_SESSION_TTL_SEC,
  SESSION_MAX_PER_TOKEN_LIMIT,
  resolveHeartbeatConfig,
  resolveHsts,
  resolveRetentionDays,
  resolveCorsOrigins,
  resolvePort,
  resolveRateLimitConfig,
  resolveSessionConfig,
  resolveSessionTtlSec,
  resolveViewerTailnetOnly,
  SESSION_TTL_MAX_SEC,
} from "./config.ts";

describe("resolveHeartbeatConfig", () => {
  it("falls back to the documented defaults", () => {
    expect(resolveHeartbeatConfig({})).toEqual({
      intervalSec: 60,
      timeoutSec: 300,
      awaySec: 86_400,
    });
    expect(DEFAULT_HEARTBEAT_INTERVAL_SEC).toBe(60);
    expect(DEFAULT_HEARTBEAT_TIMEOUT_SEC).toBe(300);
    expect(DEFAULT_HEARTBEAT_AWAY_SEC).toBe(86_400);
  });

  it("treats blank values as unset", () => {
    expect(
      resolveHeartbeatConfig({ HEARTBEAT_INTERVAL_SEC: " ", HEARTBEAT_TIMEOUT_SEC: "" }),
    ).toEqual({ intervalSec: 60, timeoutSec: 300, awaySec: 86_400 });
  });

  it("reads overrides and trims surrounding whitespace", () => {
    expect(
      resolveHeartbeatConfig({
        HEARTBEAT_INTERVAL_SEC: " 30 ",
        HEARTBEAT_TIMEOUT_SEC: "120 ",
        HEARTBEAT_AWAY_SEC: " 600 ",
      }),
    ).toEqual({ intervalSec: 30, timeoutSec: 120, awaySec: 600 });
  });

  it("rejects values that are not positive integers", () => {
    for (const value of ["0", "-5", "1.5", "abc", "1e3", "Infinity"]) {
      expect(() => resolveHeartbeatConfig({ HEARTBEAT_INTERVAL_SEC: value })).toThrow(
        /HEARTBEAT_INTERVAL_SEC/,
      );
      expect(() => resolveHeartbeatConfig({ HEARTBEAT_TIMEOUT_SEC: value })).toThrow(
        /HEARTBEAT_TIMEOUT_SEC/,
      );
      expect(() => resolveHeartbeatConfig({ HEARTBEAT_AWAY_SEC: value })).toThrow(
        /HEARTBEAT_AWAY_SEC/,
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

  it("requires the away window to exceed the timeout", () => {
    expect(() =>
      resolveHeartbeatConfig({ HEARTBEAT_TIMEOUT_SEC: "300", HEARTBEAT_AWAY_SEC: "300" }),
    ).toThrow(/must be greater than HEARTBEAT_TIMEOUT_SEC/);
    expect(() =>
      resolveHeartbeatConfig({ HEARTBEAT_TIMEOUT_SEC: "300", HEARTBEAT_AWAY_SEC: "60" }),
    ).toThrow(/must be greater than HEARTBEAT_TIMEOUT_SEC/);
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

describe("resolveSessionConfig", () => {
  it("caps sessions per token at five by default", () => {
    expect(resolveSessionConfig({}).maxPerToken).toBe(5);
    expect(resolveSessionConfig({ SESSION_MAX_PER_TOKEN: "20" }).maxPerToken).toBe(20);
  });

  it("rejects a cap that is not a positive integer or is above fifty", () => {
    for (const value of ["0", "-1", "1.5", "abc", String(SESSION_MAX_PER_TOKEN_LIMIT + 1)]) {
      expect(() => resolveSessionConfig({ SESSION_MAX_PER_TOKEN: value })).toThrow(
        /SESSION_MAX_PER_TOKEN/,
      );
    }
  });

  it("keeps the idle timeout and rotation under the ttl", () => {
    expect(resolveSessionConfig({})).toEqual({
      ttlSec: DEFAULT_SESSION_TTL_SEC,
      maxPerToken: 5,
      idleSec: DEFAULT_SESSION_IDLE_SEC,
      rotateSec: DEFAULT_SESSION_ROTATE_SEC,
      graceSec: DEFAULT_SESSION_ROTATE_GRACE_SEC,
    });
    expect(DEFAULT_SESSION_IDLE_SEC).toBe(3600);
    expect(DEFAULT_SESSION_ROTATE_SEC).toBe(900);
    expect(DEFAULT_SESSION_ROTATE_GRACE_SEC).toBe(60);
    // A shorter ttl drags the defaults down instead of making them invalid.
    const short = resolveSessionConfig({ SESSION_TTL_SEC: "120" });
    expect([short.idleSec, short.rotateSec]).toEqual([120, 120]);
    expect(() => resolveSessionConfig({ SESSION_TTL_SEC: "600", SESSION_IDLE_SEC: "601" })).toThrow(
      /SESSION_IDLE_SEC/,
    );
    expect(() =>
      resolveSessionConfig({ SESSION_TTL_SEC: "600", SESSION_ROTATE_SEC: "601" }),
    ).toThrow(/SESSION_ROTATE_SEC/);
  });

  it("reads explicit idle and rotation windows", () => {
    const config = resolveSessionConfig({ SESSION_IDLE_SEC: "900", SESSION_ROTATE_SEC: "300" });
    expect([config.idleSec, config.rotateSec]).toEqual([900, 300]);
  });

  it("rejects an idle timeout shorter than 60 seconds (above the 25 s ping)", () => {
    expect(() => resolveSessionConfig({ SESSION_IDLE_SEC: "59" })).toThrow(/SESSION_IDLE_SEC/);
    expect(resolveSessionConfig({ SESSION_IDLE_SEC: "60" }).idleSec).toBe(60);
  });

  it("validates the rotation grace window", () => {
    expect(resolveSessionConfig({}).graceSec).toBe(60);
    expect(resolveSessionConfig({ SESSION_ROTATE_GRACE_SEC: "15" }).graceSec).toBe(15);
    for (const value of ["0", "-1", "1.5", "abc"]) {
      expect(() => resolveSessionConfig({ SESSION_ROTATE_GRACE_SEC: value })).toThrow(
        /SESSION_ROTATE_GRACE_SEC/,
      );
    }
    expect(() =>
      resolveSessionConfig({ SESSION_TTL_SEC: "120", SESSION_ROTATE_GRACE_SEC: "121" }),
    ).toThrow(/SESSION_ROTATE_GRACE_SEC/);
  });
});

describe("resolveRateLimitConfig", () => {
  it("falls back to the documented budgets", () => {
    expect(resolveRateLimitConfig({})).toEqual({
      perMin: 60,
      burst: 20,
      ipPerMin: 30,
      ipBurst: 10,
      cookieFailurePerMin: 600,
    });
  });

  it("reads overrides", () => {
    expect(
      resolveRateLimitConfig({
        RATE_LIMIT_PER_MIN: "120",
        RATE_LIMIT_BURST: "30",
        RATE_LIMIT_IP_PER_MIN: "40",
        RATE_LIMIT_IP_BURST: "5",
        RATE_LIMIT_COOKIE_PER_MIN: "120",
      }),
    ).toEqual({ perMin: 120, burst: 30, ipPerMin: 40, ipBurst: 5, cookieFailurePerMin: 120 });
  });

  it("rejects a burst larger than its per-minute budget", () => {
    expect(() =>
      resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: "10", RATE_LIMIT_BURST: "11" }),
    ).toThrow(/RATE_LIMIT_BURST/);
    expect(() =>
      resolveRateLimitConfig({ RATE_LIMIT_IP_PER_MIN: "10", RATE_LIMIT_IP_BURST: "11" }),
    ).toThrow(/RATE_LIMIT_IP_BURST/);
  });

  it("rejects values that are not positive integers", () => {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      expect(() => resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: value })).toThrow(
        /RATE_LIMIT_PER_MIN/,
      );
    }
  });
});

describe("resolveCorsOrigins", () => {
  it("is empty when unset", () => {
    expect(resolveCorsOrigins({})).toEqual([]);
    expect(resolveCorsOrigins({ CORS_ORIGINS: " , " })).toEqual([]);
  });

  it("keeps exact origins, trimmed", () => {
    expect(
      resolveCorsOrigins({ CORS_ORIGINS: " https://a.example ,http://localhost:5173" }),
    ).toEqual(["https://a.example", "http://localhost:5173"]);
  });

  it("rejects a wildcard or a non-http origin", () => {
    expect(() => resolveCorsOrigins({ CORS_ORIGINS: "*" })).toThrow(/CORS_ORIGINS/);
    expect(() => resolveCorsOrigins({ CORS_ORIGINS: "ftp://a.example" })).toThrow(/CORS_ORIGINS/);
    expect(() => resolveCorsOrigins({ CORS_ORIGINS: "a.example" })).toThrow(/CORS_ORIGINS/);
  });
});

describe("resolvePort", () => {
  it("defaults to 8787 and 8788", () => {
    expect(resolvePort({})).toBe(8787);
    expect(resolvePort({}, "VIEWER_PORT", 8788)).toBe(8788);
    expect(resolvePort({ PORT: "9000" })).toBe(9000);
  });

  it("rejects values that are not usable ports", () => {
    for (const value of ["0", "-1", "65536", "abc", "1.5"]) {
      expect(() => resolvePort({ PORT: value })).toThrow(/PORT/);
    }
  });
});

describe("resolveViewerTailnetOnly", () => {
  it("is off unless asked for", () => {
    for (const value of [undefined, "", "false", "0"]) {
      expect(resolveViewerTailnetOnly({ VIEWER_TAILNET_ONLY: value })).toBe(false);
    }
  });

  it("turns on for the documented truthy values", () => {
    for (const value of ["true", "1", " TRUE "]) {
      expect(resolveViewerTailnetOnly({ VIEWER_TAILNET_ONLY: value })).toBe(true);
    }
  });

  it("refuses an ambiguous value", () => {
    expect(() => resolveViewerTailnetOnly({ VIEWER_TAILNET_ONLY: "yes" })).toThrow(
      /VIEWER_TAILNET_ONLY/,
    );
  });
});

describe("resolveHsts", () => {
  it("is off unless the deployment opts in", () => {
    for (const value of [undefined, "", "false", "0"]) {
      expect(resolveHsts({ HSTS: value })).toBe(false);
    }
  });

  it("turns on for the documented truthy values", () => {
    for (const value of ["true", "1", " TRUE "]) {
      expect(resolveHsts({ HSTS: value })).toBe(true);
    }
  });

  it("refuses an ambiguous value", () => {
    expect(() => resolveHsts({ HSTS: "yes" })).toThrow(/HSTS/);
  });
});
