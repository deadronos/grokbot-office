import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEARTBEAT_INTERVAL_SEC,
  DEFAULT_HEARTBEAT_TIMEOUT_SEC,
  resolveHeartbeatConfig,
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
