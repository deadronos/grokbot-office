import { describe, expect, it } from "vitest";

import { HEALTH_PATH } from "@grokbot-office/shared";

import { testSetup } from "./test-utils.ts";

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const { app, close } = testSetup();
    try {
      const res = await app.request(HEALTH_PATH);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true });
    } finally {
      close();
    }
  });
});
