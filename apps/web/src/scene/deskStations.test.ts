import { describe, expect, it } from "vitest";

import { DESK_STATIONS, NAME_PLATE_SIZE, plateVisible } from "./deskStations";
import {
  defaultCamera,
  deskScreenRect,
  plateScreenRect,
  rectsOverlap,
  type Viewport,
} from "./screenBox";

const VIEWPORTS: readonly Viewport[] = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 844, height: 390 },
];

describe("name plates", () => {
  it("keep every plate clear of every desk and every other plate", () => {
    for (const viewport of VIEWPORTS) {
      const camera = defaultCamera(viewport);
      const plates = DESK_STATIONS.map((entry) => ({
        id: entry.desk.botId,
        rect: plateScreenRect(camera, entry.namePlate, viewport),
      }));
      const desks = DESK_STATIONS.map((entry) => ({
        id: entry.desk.botId,
        rect: deskScreenRect(camera, entry.desk, viewport),
      }));

      for (const plate of plates) {
        for (const desk of desks) {
          expect(
            rectsOverlap(plate.rect, desk.rect),
            `${plate.id} plate covers ${desk.id} desk at ${viewport.width}x${viewport.height}`,
          ).toBe(false);
        }
      }
      for (let i = 0; i < plates.length; i += 1) {
        for (let j = i + 1; j < plates.length; j += 1) {
          expect(
            rectsOverlap(plates[i]!.rect, plates[j]!.rect),
            `${plates[i]!.id} plate overlaps ${plates[j]!.id} plate at ${viewport.width}x${viewport.height}`,
          ).toBe(false);
        }
      }
    }
  });

  it("stay small enough not to cover a neighbouring desk", () => {
    expect(NAME_PLATE_SIZE[0]).toBeLessThanOrEqual(1.2);
    expect(NAME_PLATE_SIZE[1]).toBeLessThanOrEqual(0.28);
  });

  it("sit above every screen and bot", () => {
    for (const entry of DESK_STATIONS) {
      expect(entry.namePlate.position[1]).toBeGreaterThan(3);
      expect(entry.namePlate.position[1]).toBeGreaterThan(entry.screen.position[1]);
      expect(entry.namePlate.position[1]).toBeGreaterThan(entry.bot.position[1]);
    }
  });
});

describe("plate visibility", () => {
  it("hides a plate for an absent or offline bot", () => {
    expect(plateVisible(undefined)).toBe(false);
    expect(plateVisible("offline")).toBe(false);
  });

  it("shows a plate for every present bot", () => {
    for (const status of ["idle", "working", "waiting", "reviewing"] as const) {
      expect(plateVisible(status)).toBe(true);
    }
  });
});
