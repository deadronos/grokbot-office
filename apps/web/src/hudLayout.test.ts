import { describe, expect, it } from "vitest";

import { DESKS } from "@grokbot-office/shared";

import { HUD_LAYOUT, hudScreenBox, hudVariant } from "./hudLayout";
import { defaultCamera, deskScreenRect, rectsOverlap, type Viewport } from "./scene/screenBox";

const VIEWPORTS: readonly Viewport[] = [
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 844, height: 390 },
];

describe("hud layout", () => {
  it("uses a right panel on wide screens and a bottom bar below the breakpoint", () => {
    expect(hudVariant(HUD_LAYOUT.wideMinWidth, 720)).toBe("wide");
    expect(hudVariant(HUD_LAYOUT.wideMinWidth - 1, 720)).toBe("narrow");
    expect(hudVariant(HUD_LAYOUT.wideMinWidth, 1024)).toBe("narrow");
  });

  it("never covers a desk at the listed viewports", () => {
    for (const viewport of VIEWPORTS) {
      const camera = defaultCamera(viewport);
      const hud = hudScreenBox(viewport);
      for (const desk of DESKS) {
        expect(
          rectsOverlap(hud, deskScreenRect(camera, desk, viewport)),
          `HUD covers ${desk.name} at ${viewport.width}x${viewport.height}`,
        ).toBe(false);
      }
    }
  });

  it("stays inside the viewport", () => {
    for (const viewport of VIEWPORTS) {
      const hud = hudScreenBox(viewport);
      expect(hud.x0).toBeGreaterThanOrEqual(0);
      expect(hud.y0).toBeGreaterThanOrEqual(0);
      expect(hud.x1).toBeLessThanOrEqual(viewport.width);
      expect(hud.y1).toBeLessThanOrEqual(viewport.height);
    }
  });
});
