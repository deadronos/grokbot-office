import { describe, expect, it } from "vitest";

import { DESK_CLICK_SLOP_PX, deskClickSelects } from "./deskPick";

describe("deskClickSelects", () => {
  it("selects a desk on a still click", () => {
    expect(deskClickSelects(0)).toBe(true);
    expect(deskClickSelects(DESK_CLICK_SLOP_PX)).toBe(true);
  });

  it("ignores a press that turned into an orbit drag", () => {
    expect(deskClickSelects(DESK_CLICK_SLOP_PX + 1)).toBe(false);
    expect(deskClickSelects(120)).toBe(false);
  });
});
