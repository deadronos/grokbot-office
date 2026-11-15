import { describe, expect, it } from "vitest";

import { sanitizeText } from "./sanitize";

describe("sanitizeText", () => {
  it("strips control characters, keeping the rest", () => {
    expect(sanitizeText("Review\u0000 plan\n\tfor\u007f office\u0085")).toBe(
      "Review planfor office",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeText("  Plan bot-office  ")).toBe("Plan bot-office");
  });

  it("keeps normal unicode text", () => {
    expect(sanitizeText("Lumi – chief orchestrator ✅")).toBe("Lumi – chief orchestrator ✅");
  });
});
