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
