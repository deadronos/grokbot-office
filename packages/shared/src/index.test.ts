import { describe, expect, it } from "vitest";

import { APP_NAME, HEALTH_PATH } from "./index";

describe("shared constants", () => {
  it("exposes the app name and health path", () => {
    expect(APP_NAME).toBe("Grokbot Office");
    expect(HEALTH_PATH).toBe("/api/health");
  });
});
