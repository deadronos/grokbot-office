import { describe, expect, it } from "vitest";

import { HEALTH_PATH } from "@grokbot-office/shared";

import { testSetup } from "./test-utils.ts";
import { SERVICE_NAME } from "./app.ts";

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const { app, close } = testSetup();
    try {
      const res = await app.request(HEALTH_PATH);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      await expect(res.json()).resolves.toEqual({ ok: true, service: SERVICE_NAME });
    } finally {
      close();
    }
  });
});
