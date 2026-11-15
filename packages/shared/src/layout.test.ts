import { describe, expect, it } from "vitest";

import { DESKS, getDesk } from "./layout";

describe("desk layout", () => {
  it("has exactly the nine fixed desks", () => {
    expect(DESKS.map((desk) => desk.botId).toSorted()).toEqual(
      ["data", "geordi", "guinan", "lumi", "quark", "spock", "uhura", "wesley", "worf"].toSorted(),
    );
  });

  it("puts Lumi at the centre command desk and the rest in their pods", () => {
    expect(getDesk("lumi")).toMatchObject({ pod: "command", x: 0, z: 0 });
    expect(DESKS.filter((desk) => desk.pod === "dev").map((desk) => desk.botId)).toEqual([
      "data",
      "wesley",
      "geordi",
      "spock",
    ]);
    expect(DESKS.filter((desk) => desk.pod === "ops").map((desk) => desk.botId)).toEqual([
      "uhura",
      "guinan",
      "quark",
      "worf",
    ]);
  });

  it("gives every desk a unique spot and index inside its pod", () => {
    expect(new Set(DESKS.map((desk) => `${desk.x},${desk.z}`)).size).toBe(DESKS.length);
    for (const pod of ["command", "dev", "ops"]) {
      const indexes = DESKS.filter((desk) => desk.pod === pod).map((desk) => desk.index);
      expect(new Set(indexes).size).toBe(indexes.length);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(DESKS)).toBe(true);
    expect(Object.isFrozen(DESKS[0])).toBe(true);
  });

  it("returns no desk for bots outside the layout", () => {
    expect(getDesk("token-optimizer")).toBeUndefined();
  });
});
