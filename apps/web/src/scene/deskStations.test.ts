import { DESKS, getDesk } from "@grokbot-office/shared";
import { describe, expect, it } from "vitest";

import { BOT_COLORS } from "./botColors";
import { DESK_STATIONS } from "./deskStations";

describe("desk stations", () => {
  it("has one station per shared desk", () => {
    expect(DESK_STATIONS.map((station) => station.desk.botId)).toEqual(
      DESKS.map((desk) => desk.botId),
    );
  });

  it("has a capsule colour for every desk bot", () => {
    expect(Object.keys(BOT_COLORS).toSorted()).toEqual(DESKS.map((desk) => desk.botId).toSorted());
  });

  it("puts the chair behind the desk and the screen in front, along the facing", () => {
    const lumi = DESK_STATIONS.find((station) => station.desk.botId === "lumi");
    const dev = DESK_STATIONS.find((station) => station.desk.botId === "data");
    const ops = DESK_STATIONS.find((station) => station.desk.botId === "uhura");
    if (!lumi || !dev || !ops) throw new Error("missing station");

    // facing 0 looks toward +z: screen at +z of the desk, chair at -z.
    expect(lumi.screen.position[2]).toBeGreaterThan(lumi.desk.z);
    expect(lumi.chairSeat.position[2]).toBeLessThan(lumi.desk.z);
    expect(ops.screen.position[2]).toBeGreaterThan(ops.desk.z);
    expect(ops.chairSeat.position[2]).toBeLessThan(ops.desk.z);
    // facing PI looks toward -z: reversed.
    expect(dev.screen.position[2]).toBeLessThan(dev.desk.z);
    expect(dev.chairSeat.position[2]).toBeGreaterThan(dev.desk.z);
  });

  it("places the plate above the bot", () => {
    for (const station of DESK_STATIONS) {
      expect(station.namePlate.position[0]).toBe(station.bot.position[0]);
      expect(station.namePlate.position[2]).toBe(station.bot.position[2]);
      expect(station.namePlate.position[1]).toBeGreaterThan(station.bot.position[1]);
    }
  });

  it("only covers the fixed desks", () => {
    expect(getDesk("token-optimizer")).toBeUndefined();
    expect(DESK_STATIONS.every((station) => getDesk(station.desk.botId) === station.desk)).toBe(
      true,
    );
  });
});
