import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireToken, type AppEnv } from "./middleware.ts";
import { issueToken, hashToken, TOKEN_PREFIX_LENGTH } from "./tokens.ts";
import { botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
});

/** Mounts the middleware the way the bot routes do, with a trivial handler behind it. */
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

const UNAUTHORIZED = { error: "unauthorized" };
const FORBIDDEN = { error: "forbidden" };

describe("requireToken", () => {
  it("rejects a missing or malformed authorization header generically", async () => {
    const app = botRoute(setup());
    const missing = await call(app, "data");
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual(UNAUTHORIZED);

    const malformed = await app.request("/api/bots/data/heartbeat", {
      headers: { authorization: "Basic abc" },
    });
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toEqual(UNAUTHORIZED);
  });

  it("rejects an unknown token generically", async () => {
    const res = await call(botRoute(setup()), "data", "not-a-real-token");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(UNAUTHORIZED);
  });

  it("rejects a revoked token generically", async () => {
    const repo = setup();
    const issued = issueToken(repo, { kind: "bot", botId: "data" });
    repo.revokeToken(issued.id, "2026-01-02T00:00:00.000Z");
    const res = await call(botRoute(repo), "data", issued.token);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual(UNAUTHORIZED);
  });

  it("rejects a token of the wrong kind with a generic 403", async () => {
    const repo = setup();
    const viewer = issueToken(repo, { kind: "viewer" });
    const res = await call(botRoute(repo), "data", viewer.token);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual(FORBIDDEN);
  });

  it("rejects a bot token used for another bot with a generic 403", async () => {
    const repo = setup();
    const data = issueToken(repo, { kind: "bot", botId: "data" });
    const wrongBot = await call(botRoute(repo), "wesley", data.token);
    expect(wrongBot.status).toBe(403);
    await expect(wrongBot.json()).resolves.toEqual(FORBIDDEN);
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

  it("logs one reason but never the token, prefix or hash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repo = setup();
    const issued = issueToken(repo, { kind: "bot", botId: "data" });
    await call(botRoute(repo), "wesley", issued.token);
    await call(botRoute(repo), "data", "unknown-token-value");

    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain(issued.prefix);
    expect(serialized).not.toContain(hashToken(issued.token));
    expect(serialized).not.toContain("unknown-token-value");
    expect(serialized).toContain("auth: token rejected");
    expect(serialized).toContain("token bound to another bot");
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
