import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { requireToken, type AppEnv } from "./middleware.ts";
import { issueToken, hashToken, TOKEN_PREFIX_LENGTH } from "./tokens.ts";
import { botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

/** Mounts the middleware the way later bot routes will, without shipping those routes yet. */
function botRoute(repo: ReturnType<typeof testSetup>["repo"], kind: "bot" | "viewer" = "bot") {
  const app = new Hono<AppEnv>();
  app.use("/api/bots/:id/heartbeat", requireToken({ repo, kind, botIdParam: "id" }));
  app.get("/api/bots/:id/heartbeat", (c) => c.json({ botId: c.get("token").botId }));
  return app;
}

const call = (app: Hono<AppEnv>, id: string, token?: string) =>
  app.request(`/api/bots/${id}/heartbeat`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

function setup() {
  const { repo, close } = testSetup();
  cleanups.push(close);
  repo.upsertBot(botRecord("data"));
  repo.upsertBot(botRecord("wesley"));
  return repo;
}

describe("requireToken", () => {
  it("rejects a missing or malformed authorization header", async () => {
    const app = botRoute(setup());
    expect((await call(app, "data")).status).toBe(401);
    const malformed = await app.request("/api/bots/data/heartbeat", {
      headers: { authorization: "Basic abc" },
    });
    expect(malformed.status).toBe(401);
  });

  it("rejects an unknown token", async () => {
    const app = botRoute(setup());
    expect((await call(app, "data", "not-a-real-token")).status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const repo = setup();
    const issued = issueToken(repo, { kind: "bot", botId: "data" });
    repo.revokeToken(issued.id, "2026-01-02T00:00:00.000Z");
    expect((await call(botRoute(repo), "data", issued.token)).status).toBe(401);
  });

  it("rejects a token of the wrong kind", async () => {
    const repo = setup();
    const viewer = issueToken(repo, { kind: "viewer" });
    expect((await call(botRoute(repo), "data", viewer.token)).status).toBe(403);
  });

  it("rejects a bot token used for another bot", async () => {
    const repo = setup();
    const data = issueToken(repo, { kind: "bot", botId: "data" });
    expect((await call(botRoute(repo), "wesley", data.token)).status).toBe(403);
    expect((await call(botRoute(repo), "data", data.token)).status).toBe(200);
  });

  it("accepts a valid token and records last_used_at", async () => {
    const repo = setup();
    const issued = issueToken(repo, { kind: "bot", botId: "data" });
    expect(repo.getToken(issued.id)?.lastUsedAt).toBeNull();

    const res = await call(botRoute(repo), "data", issued.token);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ botId: "data" });
    expect(repo.getToken(issued.id)?.lastUsedAt).not.toBeNull();
  });
});

describe("token storage", () => {
  it("stores only a hash and an 8-char prefix", () => {
    const repo = setup();
    const issued = issueToken(repo, { kind: "bot", botId: "data" });
    const stored = repo.getToken(issued.id);
    expect(issued.prefix).toHaveLength(TOKEN_PREFIX_LENGTH);
    expect(stored?.prefix).toHaveLength(TOKEN_PREFIX_LENGTH);
    expect(stored?.hash).toBe(hashToken(issued.token));
    expect(stored?.hash).not.toContain(issued.token);
    expect(repo.findTokenByHash(issued.token)).toBeUndefined();
  });
});
