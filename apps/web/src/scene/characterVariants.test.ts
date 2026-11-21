import { describe, expect, it } from "vitest";

import { BOT_COLORS } from "./botColors";
import { characterVariant } from "./characterVariants";

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
