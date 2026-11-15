import { describe, expect, it } from "vitest";

import { sanitizeText } from "./sanitize";

describe("sanitizeText", () => {
  it("strips invisible format characters", () => {
    expect(sanitizeText("pl\u200Ban")).toBe("plan");
    expect(sanitizeText("\u202Eevil\u202C")).toBe("evil"); // RLO/PDF bidi overrides
    expect(sanitizeText("\uFEFFPlan bot-office\u200D")).toBe("Plan bot-office"); // BOM, ZWJ
  });

  it("turns control characters into a space", () => {
    expect(sanitizeText("plan\nfor")).toBe("plan for");
    expect(sanitizeText("plan\tfor\r\noffice")).toBe("plan for office");
    expect(sanitizeText("Review\u0000 plan\u007f office\u0085")).toBe("Review plan office");
  });

  it("collapses whitespace runs and trims", () => {
    expect(sanitizeText("  Plan \n\n  bot-office\t\t ")).toBe("Plan bot-office");
    expect(sanitizeText("a\u00A0\u00A0b")).toBe("a b");
  });

  it("keeps normal unicode text", () => {
    expect(sanitizeText("Lumi – chief orchestrator ✅")).toBe("Lumi – chief orchestrator ✅");
  });

  it("reduces whitespace-only input to the empty string", () => {
    expect(sanitizeText(" \n\t\u200B ")).toBe("");
  });
});
