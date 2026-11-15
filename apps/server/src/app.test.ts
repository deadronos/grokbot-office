import { describe, expect, it } from "vitest";

import { HEALTH_PATH } from "@grokbot-office/shared";

import { app } from "./app.ts";

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const res = await app.request(HEALTH_PATH);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
  });
});
