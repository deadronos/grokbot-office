import { afterEach, describe, expect, it } from "vitest";

import { HEALTH_PATH } from "@grokbot-office/shared";

import { createApp, WEB_CSP } from "./app.ts";
import { issueToken } from "./auth/tokens.ts";
import { resolveHeartbeatConfig, resolveRateLimitConfig, resolveSessionConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";
import { createRateLimits } from "./rate-limit.ts";
import { createStreamHub } from "./stream/hub.ts";
import { TEST_ADMIN_TOKEN, botRecord, testSetup } from "./test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

/** An app whose rate-limit clock the test moves by hand. */
function rateLimitedApp(config = { perMin: 60, burst: 2, ipPerMin: 60, ipBurst: 2 }) {
  const db = openDatabase(":memory:");
  const repo = createSqliteRepo(db);
  const hub = createStreamHub();
  const clock = { now: Date.parse("2026-01-01T00:00:00.000Z") };
  const app = createApp({
    repo,
    adminToken: TEST_ADMIN_TOKEN,
    heartbeat: resolveHeartbeatConfig({}),
    hub,
    session: resolveSessionConfig({}),
    limits: createRateLimits(config, () => clock.now),
    corsOrigins: ["https://viewer.example"],
  });
  cleanups.push(() => {
    hub.closeAll();
    db.close();
  });
  repo.upsertBot(botRecord("data"));
  const viewer = issueToken(repo, { kind: "viewer" });
  const bot = issueToken(repo, { kind: "bot", botId: "data" });
  return { app, clock, viewer, bot };
}

describe("security headers", () => {
  it("hardens every API response and forbids everything in its CSP", async () => {
    const { app, close } = testSetup();
    cleanups.push(close);
    const res = await app.request(HEALTH_PATH);

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it("hardens error responses too", async () => {
    const { app, close } = testSetup();
    cleanups.push(close);
    const res = await app.request("/api/state");

    expect(res.status).toBe(401);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("gives non-API responses the web policy, which allows the app's own scripts", async () => {
    const { app, close } = testSetup();
    cleanups.push(close);
    const res = await app.request("/");

    expect(res.headers.get("content-security-policy")).toBe(WEB_CSP);
    expect(WEB_CSP).not.toContain("unsafe-eval");
  });
});

describe("CORS", () => {
  it("reflects an allowlisted origin with credentials", async () => {
    const { app } = rateLimitedApp();
    const res = await app.request("/api/state", {
      headers: { authorization: "Bearer nope", origin: "https://viewer.example" },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://viewer.example");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("never answers a foreign origin, and never `*` with credentials", async () => {
    const { app } = rateLimitedApp();
    const res = await app.request("/api/state", {
      headers: { authorization: "Bearer nope", origin: "https://evil.example" },
    });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
  it("answers a preflight for an allowlisted origin", async () => {
    const { app } = rateLimitedApp();
    const res = await app.request("/api/state", {
      method: "OPTIONS",
      headers: {
        origin: "https://viewer.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://viewer.example");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("rate limits", () => {
  it("leaves /api/health alone", async () => {
    const { app } = rateLimitedApp({ perMin: 1, burst: 1, ipPerMin: 60, ipBurst: 1 });
    for (let index = 0; index < 5; index += 1) {
      expect((await app.request(HEALTH_PATH)).status).toBe(200);
    }
  });

  it("spends a token's budget, then answers 429 with Retry-After", async () => {
    const { app, clock, viewer } = rateLimitedApp();
    const state = () =>
      app.request("/api/state", { headers: { authorization: `Bearer ${viewer.token}` } });

    expect((await state()).status).toBe(200);
    expect((await state()).status).toBe(200);
    const res = await state();
    expect(res.status).toBe(429);
    expect((await res.json()) as object).toEqual({ error: "rate limited" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);

    // One second refills one request: budget is per minute, spread evenly.
    clock.now += 1000;
    expect((await state()).status).toBe(200);
  });

  it("keeps each token on its own budget", async () => {
    const { app, viewer, bot } = rateLimitedApp();
    for (let index = 0; index < 2; index += 1) {
      await app.request("/api/state", { headers: { authorization: `Bearer ${viewer.token}` } });
    }
    const res = await app.request("/api/bots/data/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${bot.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).not.toBe(429);
  });

  it("still answers 401 under the limit, then 429 over it", async () => {
    const { app } = rateLimitedApp();
    const probe = () => app.request("/api/state", { headers: { authorization: "Bearer nope" } });

    expect((await probe()).status).toBe(401);
    expect((await probe()).status).toBe(401);
    expect((await probe()).status).toBe(429);
  });

  it("limits failed admin attempts by IP", async () => {
    const { app } = rateLimitedApp();
    const probe = () =>
      app.request("/api/admin/bots", { headers: { authorization: "Bearer nope" } });

    expect((await probe()).status).toBe(401);
    expect((await probe()).status).toBe(401);
    expect((await probe()).status).toBe(429);
  });

  it("limits unauthenticated logout by IP", async () => {
    const { app } = rateLimitedApp();
    const probe = () => app.request("/api/session/logout", { method: "POST" });

    expect((await probe()).status).toBe(204);
    expect((await probe()).status).toBe(204);
    expect((await probe()).status).toBe(429);
  });
});

describe("surfaces", () => {
  it("keeps viewer data off the bot surface", async () => {
    const db = openDatabase(":memory:");
    const repo = createSqliteRepo(db);
    const hub = createStreamHub();
    const app = createApp({
      repo,
      adminToken: TEST_ADMIN_TOKEN,
      heartbeat: resolveHeartbeatConfig({}),
      hub,
      session: resolveSessionConfig({}),
      limits: createRateLimits(resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: "1000000" })),
      surface: "bot",
    });
    cleanups.push(() => {
      hub.closeAll();
      db.close();
    });
    const viewer = issueToken(repo, { kind: "viewer" });

    for (const path of [
      "/api/state",
      "/api/bots",
      "/api/session",
      "/api/stream",
      "/api/admin/bots",
    ]) {
      const res = await app.request(path, { headers: { authorization: `Bearer ${viewer.token}` } });
      expect([path, res.status]).toEqual([path, 404]);
    }
    expect((await app.request(HEALTH_PATH)).status).toBe(200);
  });

  it("keeps bot ingest off the viewer surface", async () => {
    const db = openDatabase(":memory:");
    const repo = createSqliteRepo(db);
    repo.upsertBot(botRecord("data"));
    const hub = createStreamHub();
    const app = createApp({
      repo,
      adminToken: TEST_ADMIN_TOKEN,
      heartbeat: resolveHeartbeatConfig({}),
      hub,
      session: resolveSessionConfig({}),
      limits: createRateLimits(resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: "1000000" })),
      surface: "viewer",
    });
    cleanups.push(() => {
      hub.closeAll();
      db.close();
    });
    const bot = issueToken(repo, { kind: "bot", botId: "data" });

    const posted = await app.request("/api/events", {
      method: "POST",
      headers: { authorization: `Bearer ${bot.token}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(posted.status).toBe(404);
    const heartbeat = await app.request("/api/bots/data/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${bot.token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(heartbeat.status).toBe(404);
    // The viewer's own replay endpoint stays reachable on this surface.
    expect((await app.request("/api/events?since=0")).status).toBe(401);
    expect((await app.request(HEALTH_PATH)).status).toBe(200);
  });
});
