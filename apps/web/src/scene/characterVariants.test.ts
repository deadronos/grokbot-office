import { describe, expect, it } from "vitest";

import { BOT_COLORS } from "./botColors";
import { characterVariant, materialTint } from "./characterVariants";

const BOT_IDS = ["lumi", "data", "wesley", "geordi", "spock", "uhura", "guinan", "quark", "worf"];

describe("characterVariants", () => {
  it("gives every bot the shared identity colour", () => {
    for (const botId of BOT_IDS) {
      expect(characterVariant(botId).tint).toBe(BOT_COLORS[botId]);
    }
  });

  it("varies the accessory so the bots do not all read the same", () => {
    const accessories = BOT_IDS.map((botId) => characterVariant(botId).accessory);
    expect(new Set(accessories).size).toBeGreaterThanOrEqual(6);
    expect(accessories).toContain("visor");
    expect(accessories).toContain("hat");
    expect(accessories).toContain("ears");
    expect(accessories).toContain("earpiece");
    expect(accessories).toContain("sash");
  });

  it("only attaches accessories to bones the rig has", () => {
    for (const botId of BOT_IDS) {
      expect(["head", "torso"]).toContain(characterVariant(botId).bone);
    }
  });

  it("falls back to a plain, neutral variant for an unknown bot", () => {
    expect(characterVariant("mystery")).toEqual({
      tint: BOT_COLORS.data,
      accessory: "none",
      bone: "head",
    });
  });
});

describe("materialTint", () => {
  it("keeps white white and lightens a dark tint", () => {
    expect(materialTint("#ffffff")).toBe("#ffffff");

    const [rawR, rawG, rawB] = [0xc4, 0x45, 0x3d];
    const tinted = Number.parseInt(materialTint("#c4453d").slice(1), 16);
    expect((tinted >> 16) & 0xff).toBeGreaterThan(rawR);
    expect((tinted >> 8) & 0xff).toBeGreaterThan(rawG);
    expect(tinted & 0xff).toBeGreaterThan(rawB);
  });

  it("applies a 45% blend from white", () => {
    // #000000 -> 255 * (1 - 0.45) = 140 = 0x8c
    expect(materialTint("#000000")).toBe("#8c8c8c");
    // #808080 -> 255 + (128 - 255) * 0.45 = 198 = 0xc6
    expect(materialTint("#808080")).toBe("#c6c6c6");
  });
});
