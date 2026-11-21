import { APP_NAME } from "@grokbot-office/shared";

import type { ScreenRect } from "./scene/screenBox";

export type Viewport = { width: number; height: number };

/** Same numbers the HUD applies inline, so the coverage test cannot drift from the page. */
export const HUD_LAYOUT = {
  wideMinWidth: 1280,
  /** A right panel needs a wide enough scene; taller windows use the bottom bar. */
  wideMinAspect: 1.6,
  wide: { right: 20, bottom: 16, width: 216, maxHeightVh: 55 },
  narrow: { inset: 8, height: 64 },
} as const;

export type HudVariant = "wide" | "narrow";

/** Bottom (or top-left on short screens) history dock, with room for stats. */
const TITLE_FONT_PX = 16 * 0.9;
/**
 * `.app-title`'s fixed footprint in `styles.css`: `top: 1rem; left: 1.25rem`, one
 * `0.9rem` line drawn uppercase with `letter-spacing: 0.1em`. A sans uppercase
 * glyph advances at most ~0.8em, so this box covers `APP_NAME` (14 glyphs) plus a
 * pad; the short-viewport dock starts to its right instead of guessing.
 */
export const APP_TITLE_LAYOUT = {
  top: 16,
  left: 20,
  width:
    Math.ceil(APP_NAME.length * TITLE_FONT_PX * 0.8 + (APP_NAME.length - 1) * TITLE_FONT_PX * 0.1) +
    8,
  height: 20,
} as const;

export const HISTORY_LAYOUT = {
  barHeight: 96,
  gap: 8,
  wideWidth: 420,
  shortMaxHeight: 480,
  shortWidth: 560,
  inset: 8,
} as const;

export function hudVariant(width: number, height: number): HudVariant {
  return width >= HUD_LAYOUT.wideMinWidth && width / height >= HUD_LAYOUT.wideMinAspect
    ? "wide"
    : "narrow";
}

/** Largest box the HUD can occupy in screen pixels. */
export function hudScreenBox({ width, height }: Viewport): ScreenRect {
  if (hudVariant(width, height) === "wide") {
    const { right, bottom, width: panel, maxHeightVh } = HUD_LAYOUT.wide;
    return {
      x0: width - right - panel,
      x1: width - right,
      y0: height - bottom - (height * maxHeightVh) / 100,
      y1: height - bottom,
    };
  }
  const { inset, height: bar } = HUD_LAYOUT.narrow;
  return { x0: inset, x1: width - inset, y0: height - inset - bar, y1: height - inset };
}

/**
 * History bar placement. Normally it docks at the bottom: left of the wide HUD,
 * above the narrow one. Short windows put it at the top-left instead, where the
 * projected desks still leave room, but below the fixed app title.
 */
export function historyBarBox({ width, height }: Viewport): ScreenRect {
  const { barHeight, gap, wideWidth, shortMaxHeight, shortWidth, inset } = HISTORY_LAYOUT;
  if (height <= shortMaxHeight) {
    // Beside the app title, not under it: the top band is the only space the
    // projected desks leave free, and a full-width dock would cover the title.
    const left = APP_TITLE_LAYOUT.left + APP_TITLE_LAYOUT.width + inset;
    return {
      x0: left,
      x1: Math.min(width - inset, left + shortWidth),
      y0: inset,
      y1: inset + barHeight,
    };
  }
  if (hudVariant(width, height) === "wide") {
    return {
      x0: inset,
      x1: inset + wideWidth,
      y0: height - HUD_LAYOUT.wide.bottom - barHeight,
      y1: height - HUD_LAYOUT.wide.bottom,
    };
  }
  const bottom = inset + HUD_LAYOUT.narrow.height + gap;
  return {
    x0: inset,
    x1: width - inset,
    y0: height - bottom - barHeight,
    y1: height - bottom,
  };
}
