import { describe, expect, it } from "vitest";

import { BOT_COLORS } from "./botColors";
import { CAMERA, CANVAS_DPR, FRAMELOOP, ORBIT_LIMITS, SHADOWS } from "./sceneConfig";

describe("scene config", () => {
  it("renders on demand at a capped DPR without shadows", () => {
    expect(FRAMELOOP).toBe("demand");
    expect(CANVAS_DPR).toEqual([1, 1.5]);
    expect(SHADOWS).toBe(false);
  });

  it("keeps the fixed camera inside the limited orbit", () => {
    const [x, y, z] = CAMERA.position;
    const [tx, ty, tz] = ORBIT_LIMITS.target;
    const distance = Math.hypot(x - tx, y - ty, z - tz);
    expect(distance).toBeGreaterThan(ORBIT_LIMITS.minDistance);
    expect(distance).toBeLessThan(ORBIT_LIMITS.maxDistance);
  });

  it("limits polar and azimuth angles to a usable range", () => {
    expect(ORBIT_LIMITS.minDistance).toBeLessThan(ORBIT_LIMITS.maxDistance);
    expect(ORBIT_LIMITS.minPolarAngle).toBeLessThan(ORBIT_LIMITS.maxPolarAngle);
    expect(ORBIT_LIMITS.minPolarAngle).toBeGreaterThan(0);
    expect(ORBIT_LIMITS.maxPolarAngle).toBeLessThanOrEqual(Math.PI / 2);
    expect(ORBIT_LIMITS.minAzimuthAngle).toBeLessThan(ORBIT_LIMITS.maxAzimuthAngle);
    expect(ORBIT_LIMITS.maxAzimuthAngle - ORBIT_LIMITS.minAzimuthAngle).toBeLessThan(Math.PI);
  });
});

describe("bot colours", () => {
  it("covers every bot colour with a distinct value", () => {
    expect(Object.values(BOT_COLORS)).toHaveLength(9);
    expect(new Set(Object.values(BOT_COLORS)).size).toBe(9);
  });
});
