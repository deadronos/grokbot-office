import { describe, expect, it } from "vitest";

import { shouldRenderContinuously } from "./renderMode";

describe("shouldRenderContinuously", () => {
  it("runs while a bot is online", () => {
    for (const status of ["idle", "working", "waiting", "reviewing"] as const) {
      expect(shouldRenderContinuously({ statuses: [status], reducedMotion: false })).toBe(true);
    }
  });

  it("drops back to on-demand when every bot is offline or absent", () => {
    expect(shouldRenderContinuously({ statuses: ["offline"], reducedMotion: false })).toBe(false);
    expect(
      shouldRenderContinuously({ statuses: [undefined, "offline"], reducedMotion: false }),
    ).toBe(false);
    expect(shouldRenderContinuously({ statuses: [], reducedMotion: false })).toBe(false);
    expect(shouldRenderContinuously({ statuses: [], reducedMotion: true })).toBe(false);
  });

  it("holds the on-demand loop when reduced motion is requested", () => {
    expect(shouldRenderContinuously({ statuses: ["working"], reducedMotion: true })).toBe(false);
    expect(
      shouldRenderContinuously({ statuses: [], reducedMotion: true, packetAnimating: true }),
    ).toBe(false);
  });

  it("runs for handoff packets even with every bot offline", () => {
    expect(
      shouldRenderContinuously({ statuses: [], reducedMotion: false, packetAnimating: true }),
    ).toBe(true);
    expect(
      shouldRenderContinuously({
        statuses: [undefined, "offline"],
        reducedMotion: false,
        packetAnimating: true,
      }),
    ).toBe(true);
  });

  it("stays on-demand when no packet is moving", () => {
    expect(
      shouldRenderContinuously({
        statuses: ["offline"],
        reducedMotion: false,
        packetAnimating: false,
      }),
    ).toBe(false);
  });
});
