import { describe, expect, it } from "vitest";

import { REVIEW_MONITOR, deskVisual, pulseFactor } from "./deskVisuals";

const BOT = "#5ad19a";

describe("deskVisual", () => {
  it("leaves an idle monitor grey", () => {
    const visual = deskVisual("idle", BOT);
    expect(visual.monitor).not.toBe(BOT);
    expect(visual.occupant).toBe(true);
    expect(visual.pulsing).toBe(false);
  });

  it("glows the bot colour and pulses while working", () => {
    const visual = deskVisual("working", BOT);
    expect(visual.monitor).toBe(BOT);
    expect(visual.monitorIntensity).toBe(1);
    expect(visual.pulsing).toBe(true);
  });

  it("gives a waiting bot a thought bubble", () => {
    const visual = deskVisual("waiting", BOT);
    expect(visual.thoughtBubble).toBe(true);
    expect(visual.magnifier).toBe(false);
  });

  it("gives a reviewing bot an amber monitor and a magnifier", () => {
    const visual = deskVisual("reviewing", BOT);
    expect(visual.monitor).toBe(REVIEW_MONITOR);
    expect(visual.magnifier).toBe(true);
  });

  it("dims an offline desk and leaves the chair empty", () => {
    const visual = deskVisual("offline", BOT);
    expect(visual.occupant).toBe(false);
    expect(visual.dim).toBeLessThan(1);
    expect(visual.thoughtBubble).toBe(false);
    expect(visual.magnifier).toBe(false);
    expect(visual.pulsing).toBe(false);
  });

  it("dims an away desk but keeps the occupant, with no motion", () => {
    const visual = deskVisual("away", BOT);
    expect(visual.occupant).toBe(true);
    expect(visual.dim).toBeLessThan(1);
    expect(visual.dim).toBeGreaterThan(deskVisual("offline", BOT).dim);
    expect(visual.pulsing).toBe(false);
    expect(visual.thoughtBubble).toBe(false);
    expect(visual.magnifier).toBe(false);
    // Calmer than an idle desk, which is neither dimmed nor pulsing.
    expect(visual.monitorIntensity).toBeLessThan(deskVisual("idle", BOT).monitorIntensity);
  });

  it("treats a bot that is not in the snapshot as idle", () => {
    expect(deskVisual(undefined, BOT)).toEqual(deskVisual("idle", BOT));
  });
});

describe("pulseFactor", () => {
  it("stays within a visible range and moves over time", () => {
    const samples = [0, 0.2, 0.5, 1, 2, 3.7].map(pulseFactor);
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(0.55);
      expect(sample).toBeLessThanOrEqual(1);
    }
    expect(new Set(samples).size).toBeGreaterThan(1);
  });
});
