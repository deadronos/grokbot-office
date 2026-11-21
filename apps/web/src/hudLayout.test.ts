import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { APP_NAME, DESKS } from "@grokbot-office/shared";

import {
  APP_TITLE_LAYOUT,
  HISTORY_LAYOUT,
  HUD_LAYOUT,
  historyBarBox,
  hudScreenBox,
  hudVariant,
} from "./hudLayout";
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

  it("docks the history bar without covering a desk", () => {
    for (const viewport of VIEWPORTS) {
      const camera = defaultCamera(viewport);
      const bar = historyBarBox(viewport);
      expect(bar.x0).toBeGreaterThanOrEqual(0);
      expect(bar.y0).toBeGreaterThanOrEqual(0);
      expect(bar.x1).toBeLessThanOrEqual(viewport.width);
      expect(bar.y1).toBeLessThanOrEqual(viewport.height);
      for (const desk of DESKS) {
        expect(
          rectsOverlap(bar, deskScreenRect(camera, desk, viewport)),
          `history bar covers ${desk.name} at ${viewport.width}x${viewport.height}`,
        ).toBe(false);
      }
    }
  });

  it("reserves room for the real app title beside a short dock", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
    const rule = /(?:^|\n)\.app-title \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("font-size: 0.9rem");
    expect(rule).toContain("letter-spacing: 0.1em");
    expect(rule).toContain("text-transform: uppercase");

    const fontPx = 0.9 * 16;
    // The widest uppercase glyph in APP_NAME (`O` in DejaVu Sans) advances 0.776em.
    const needed = Math.ceil(
      APP_NAME.length * fontPx * 0.78 + (APP_NAME.length - 1) * fontPx * 0.1,
    );
    expect(APP_TITLE_LAYOUT.width).toBeGreaterThan(needed);
    expect(APP_TITLE_LAYOUT.height).toBeGreaterThanOrEqual(fontPx);
  });

  it("keeps the short history dock beside the fixed app title", () => {
    const titleRight = APP_TITLE_LAYOUT.left + APP_TITLE_LAYOUT.width;
    const titleBottom = APP_TITLE_LAYOUT.top + APP_TITLE_LAYOUT.height;
    for (const viewport of [
      { width: 844, height: 390 },
      { width: 390, height: 390 },
      { width: 800, height: 480 },
      { width: 1280, height: 480 },
    ]) {
      expect(viewport.height).toBeLessThanOrEqual(HISTORY_LAYOUT.shortMaxHeight);
      const bar = historyBarBox(viewport);
      // The dock shares the title's top band but starts to its right.
      const overlapsTitle = bar.x0 < titleRight && bar.y0 < titleBottom;
      expect(overlapsTitle, `${viewport.width}x${viewport.height}`).toBe(false);
      expect(bar.x1).toBeLessThanOrEqual(viewport.width);
      expect(bar.y1).toBeLessThanOrEqual(viewport.height);
    }
  });
});
