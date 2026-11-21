import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HEALTH_PATH } from "@grokbot-office/shared";

import { createApp, WEB_CSP } from "./app.ts";
import { issueToken } from "./auth/tokens.ts";
import { resolveHeartbeatConfig, resolveRateLimitConfig, resolveSessionConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";
import { createRateLimits } from "./rate-limit.ts";
import { createStreamHub } from "./stream/hub.ts";
import { SESSION_COOKIE_NAME } from "./auth/session.ts";
import { TEST_ADMIN_TOKEN, botRecord, testSetup } from "./test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

/** An app whose rate-limit clock the test moves by hand. */
function rateLimitedApp(
  config = { perMin: 60, burst: 2, ipPerMin: 60, ipBurst: 2, cookieFailurePerMin: 600 },
) {
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
  return { app, db, clock, viewer, bot };
}

function sessionCookieHeader(res: Response): string {
  const raw = res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (raw === undefined) throw new Error("session cookie missing");
  return raw.split(";")[0];
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
    expect(WEB_CSP).not.toContain("'unsafe-eval'");
  });

  it("allows WebAssembly in the viewer without opening script-src further", () => {
    const scriptSrc = WEB_CSP.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("script-src"));

    // meshopt's decoder is WebAssembly: browsers refuse it without wasm-unsafe-eval.
    expect(scriptSrc).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
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
    const { app } = rateLimitedApp({
      perMin: 1,
      burst: 1,
      ipPerMin: 60,
      ipBurst: 1,
      cookieFailurePerMin: 600,
    });
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

  it("does not rate-limit logout, and still revokes during a failed-auth flood", async () => {
    const { app, viewer } = rateLimitedApp();
    const cookie = sessionCookieHeader(
      await app.request("/api/session", {
        method: "POST",
        headers: { authorization: `Bearer ${viewer.token}` },
      }),
    );

    const flood = () => app.request("/api/state", { headers: { authorization: "Bearer nope" } });
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(429);

    const res = await app.request("/api/session/logout", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(204);
    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(401);
  });

  it("still returns 401 for an expired cookie during a failed-auth flood", async () => {
    const { app, db, viewer } = rateLimitedApp();
    const cookie = sessionCookieHeader(
      await app.request("/api/session", {
        method: "POST",
        headers: { authorization: `Bearer ${viewer.token}` },
      }),
    );
    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(200);
    db.prepare("update sessions set expires_at = ?").run("2000-01-01T00:00:00.000Z");

    const flood = () => app.request("/api/state", { headers: { authorization: "Bearer nope" } });
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(429);

    const res = await app.request("/api/state", { headers: { cookie } });
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toEqual({ error: "unauthorized" });
  });

  it("answers a stale cookie with 401 and clears it during a failed-bearer flood", async () => {
    // Single-port/Funnel clients all share one loopback IP; the failed-auth burst of 2
    // is what a garbage-token flood spends.
    const { app, db, viewer } = rateLimitedApp();
    const cookie = sessionCookieHeader(
      await app.request("/api/session", {
        method: "POST",
        headers: { authorization: `Bearer ${viewer.token}` },
      }),
    );
    // The row behind the cookie disappears (revoked elsewhere, DB reset): stale cookie.
    db.prepare("delete from sessions").run();

    const flood = () => app.request("/api/state", { headers: { authorization: "Bearer nope" } });
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(429);

    // Garbage cookies never spend that bucket either, so they stay 401 rather than 429.
    const garbage = () =>
      app.request("/api/state", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-secret` },
      });
    for (let index = 0; index < 3; index += 1) {
      expect((await garbage()).status).toBe(401);
    }

    const stale = await app.request("/api/state", { headers: { cookie } });
    expect(stale.status).toBe(401);
    expect((await stale.json()) as object).toEqual({ error: "unauthorized" });
    expect(
      stale.headers
        .getSetCookie()
        .some(
          (value) => value.startsWith(`${SESSION_COOKIE_NAME}=;`) && value.includes("Max-Age=0"),
        ),
    ).toBe(true);
  });

  it("ceils garbage-cookie failures per IP without hashing them forever", async () => {
    const { app, clock } = rateLimitedApp({
      perMin: 60,
      burst: 2,
      ipPerMin: 60,
      ipBurst: 2,
      cookieFailurePerMin: 2,
    });
    const garbage = () =>
      app.request("/api/state", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-secret` },
      });

    // Two failures fit the ceiling; the third answers 429 before the cookie is
    // cleared, so the response carries no clearing Set-Cookie.
    expect((await garbage()).status).toBe(401);
    expect((await garbage()).status).toBe(401);
    const limited = await garbage();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    // Two per minute: half a minute later the ceiling has room again.
    clock.now += 31_000;
    expect((await garbage()).status).toBe(401);
  });

  it("still accepts a valid session cookie from an IP whose garbage bucket is spent", async () => {
    const { app, viewer } = rateLimitedApp({
      perMin: 60,
      burst: 2,
      ipPerMin: 60,
      ipBurst: 2,
      cookieFailurePerMin: 2,
    });
    const cookie = sessionCookieHeader(
      await app.request("/api/session", {
        method: "POST",
        headers: { authorization: `Bearer ${viewer.token}` },
      }),
    );
    const garbage = () =>
      app.request("/api/state", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-secret` },
      });

    // Every viewer behind Funnel shares one loopback IP, so this flood must not lock
    // the valid session out.
    expect((await garbage()).status).toBe(401);
    expect((await garbage()).status).toBe(401);
    expect((await garbage()).status).toBe(429);
    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(200);
  });

  it("keeps rate-limit buckets apart per surface", async () => {
    const config = { perMin: 60, burst: 2, ipPerMin: 60, ipBurst: 2, cookieFailurePerMin: 600 };
    const db = openDatabase(":memory:");
    const repo = createSqliteRepo(db);
    const hub = createStreamHub();
    cleanups.push(() => {
      hub.closeAll();
      db.close();
    });
    repo.upsertBot(botRecord("data"));
    const viewer = issueToken(repo, { kind: "viewer" });
    const shared = {
      repo,
      adminToken: TEST_ADMIN_TOKEN,
      heartbeat: resolveHeartbeatConfig({}),
      hub,
      session: resolveSessionConfig({}),
    };
    const botApp = createApp({ ...shared, limits: createRateLimits(config), surface: "bot" });
    const viewerApp = createApp({
      ...shared,
      limits: createRateLimits(config),
      surface: "viewer",
    });

    const flood = () =>
      botApp.request("/api/events", {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      });
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(401);
    expect((await flood()).status).toBe(429);

    expect(
      (
        await viewerApp.request("/api/state", {
          headers: { authorization: `Bearer ${viewer.token}` },
        })
      ).status,
    ).toBe(200);
    // The viewer's own failed-auth budget is still empty.
    expect(
      (await viewerApp.request("/api/state", { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
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

describe("viewer static and HSTS", () => {
  it("answers unknown /api paths with JSON 404, not the web index", async () => {
    const webDist = mkdtempSync(join(tmpdir(), "grokbot-web-"));
    writeFileSync(join(webDist, "index.html"), "<!doctype html><title>office</title>");
    cleanups.push(() => rmSync(webDist, { recursive: true, force: true }));

    const db = openDatabase(":memory:");
    const repo = createSqliteRepo(db);
    const hub = createStreamHub();
    cleanups.push(() => {
      hub.closeAll();
      db.close();
    });
    const app = createApp({
      repo,
      adminToken: TEST_ADMIN_TOKEN,
      heartbeat: resolveHeartbeatConfig({}),
      hub,
      session: resolveSessionConfig({}),
      limits: createRateLimits(resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: "1000000" })),
      webDist,
    });

    const missing = await app.request("/api/does-not-exist");
    expect(missing.status).toBe(404);
    expect((await missing.json()) as object).toEqual({ error: "not found" });
    const page = await app.request("/");
    expect(await page.text()).toContain("office");
  });

  it("sends HSTS on the viewer surface and not on the bot surface", async () => {
    const db = openDatabase(":memory:");
    const repo = createSqliteRepo(db);
    const hub = createStreamHub();
    cleanups.push(() => {
      hub.closeAll();
      db.close();
    });
    const shared = {
      repo,
      adminToken: TEST_ADMIN_TOKEN,
      heartbeat: resolveHeartbeatConfig({}),
      hub,
      session: resolveSessionConfig({}),
      limits: createRateLimits(resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: "1000000" })),
    };
    const viewer = createApp({ ...shared, surface: "viewer" });
    const bot = createApp({ ...shared, surface: "bot" });

    // A plain http request (dev, or Node behind a TLS proxy with no hint) must not get HSTS.
    expect((await viewer.request(HEALTH_PATH)).headers.get("strict-transport-security")).toBeNull();
    expect((await bot.request(HEALTH_PATH)).headers.get("strict-transport-security")).toBeNull();

    const httpsHints = [
      { origin: "https://office.example" },
      { referer: "https://office.example/office" },
      { "x-forwarded-proto": "https" },
    ];
    for (const headers of httpsHints) {
      const res = await viewer.request(HEALTH_PATH, { headers });
      expect([headers, res.headers.get("strict-transport-security")]).toEqual([
        headers,
        "max-age=31536000",
      ]);
      expect(res.headers.get("strict-transport-security")).not.toContain("preload");
    }
    // Even with a proto hint, the Funnel/bot surface stays HSTS-free.
    expect(
      (await bot.request(HEALTH_PATH, { headers: { "x-forwarded-proto": "https" } })).headers.get(
        "strict-transport-security",
      ),
    ).toBeNull();
  });

  it("sends HSTS on every surface when explicitly opted in", async () => {
    const db = openDatabase(":memory:");
    const repo = createSqliteRepo(db);
    const hub = createStreamHub();
    cleanups.push(() => {
      hub.closeAll();
      db.close();
    });
    const shared = {
      repo,
      adminToken: TEST_ADMIN_TOKEN,
      heartbeat: resolveHeartbeatConfig({}),
      hub,
      session: resolveSessionConfig({}),
      limits: createRateLimits(resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: "1000000" })),
      hsts: true,
    };
    // No request hint at all: HSTS=true asserts the deployment is always https.
    for (const surface of ["all", "viewer", "bot"] as const) {
      const res = await createApp({ ...shared, surface }).request(HEALTH_PATH);
      expect([surface, res.headers.get("strict-transport-security")]).toEqual([
        surface,
        "max-age=31536000",
      ]);
    }
  });
});
