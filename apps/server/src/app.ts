import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";

import { HEALTH_PATH, type Health } from "@grokbot-office/shared";

import type { AppEnv } from "./auth/middleware.ts";
import { requireAdmin } from "./auth/middleware.ts";
import type { HeartbeatConfig, SessionConfig } from "./config.ts";
import type { Repo } from "./db/repo.ts";
import type { RateLimits } from "./rate-limit.ts";
import { adminRoutes } from "./routes/admin.ts";
import { botRoutes } from "./routes/bots.ts";
import { eventRoutes } from "./routes/events.ts";
import { sessionRoutes } from "./routes/session.ts";
import { stateRoutes } from "./routes/state.ts";
import { DEFAULT_STREAM_CONFIG, type StreamConfig, streamRoutes } from "./routes/stream.ts";
import type { StreamHub } from "./stream/hub.ts";

export const SERVICE_NAME = "grokbot-office-server";

/** Abuse cap from the plan; real limits are per-field in the shared schemas. */
export const MAX_API_BODY_BYTES = 16 * 1024;

/** Which endpoints this app instance exposes: both, the Funneled bot API only, or viewer only. */
export type Surface = "all" | "bot" | "viewer";

/**
 * Response hardening for every route. The API only ever returns JSON, so its policy can
 * forbid everything; the viewer web app needs its own scripts, styles and SSE connection.
 */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
// `wasm-unsafe-eval` is needed by meshopt's decoder; it does not enable JS eval.
export const WEB_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const BOT_HEARTBEAT_PATH = /^\/api\/bots\/[^/]+\/heartbeat$/;

/**
 * Send HSTS when the request already looks like https, or when the deployment opted in
 * with `HSTS=true` (always https). Node behind the Tailscale TLS proxy sees `http`, and
 * we do not want to pin a plain `http://127.0.0.1:5173` Vite session. The signals are an
 * https Origin or Referer, or `X-Forwarded-Proto: https` (first hop). `X-Forwarded-For`
 * stays untrusted; a forged proto hint can only *add* this header, and browsers ignore
 * HSTS on a plain http response, so this is the safe simple option.
 */
function requestLooksHttps(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;
  for (const value of [c.req.header("origin"), c.req.header("referer")]) {
    if (value === undefined || value.trim() === "") continue;
    try {
      if (new URL(value).protocol === "https:") return true;
    } catch {
      // Ignore unparseable Origin/Referer; they are not a reason to send HSTS.
    }
  }
  return false;
}

/** The four bot-facing endpoints; everything else is viewer territory. */
function isBotEndpoint(method: string, path: string): boolean {
  if (method === "GET") return path === HEALTH_PATH;
  if (method !== "POST") return false;
  return path === "/api/bots/register" || path === "/api/events" || BOT_HEARTBEAT_PATH.test(path);
}

/**
 * Builds the app from its dependencies so tests can hand in an in-memory repo.
 * `adminToken` is the env `ADMIN_TOKEN`; when it is unset or the placeholder the
 * admin API answers 503. `hub` is the in-process SSE fan-out (index.ts owns one;
 * tests create their own). `stream` shortens the ping interval and client cap in tests.
 * `session` carries the cookie lifetime, idle cutoff, rotation age and per-token cap;
 * `limits` is the rate limiter; `corsOrigins` are the exact browser origins allowed to
 * call the API with credentials. `surface` narrows the routes, `webDist` (absolute)
 * lets the viewer surface serve the built web app, and `hsts` is the explicit
 * `HSTS=true` opt-in for deployments that are always https.
 */
export function createApp({
  repo,
  adminToken,
  heartbeat,
  hub,
  session,
  limits,
  corsOrigins = [],
  surface = "all",
  webDist,
  hsts = false,
  stream = DEFAULT_STREAM_CONFIG,
}: {
  repo: Repo;
  adminToken: string | undefined;
  heartbeat: HeartbeatConfig;
  hub: StreamHub;
  session: SessionConfig;
  limits: RateLimits;
  corsOrigins?: readonly string[];
  surface?: Surface;
  webDist?: string;
  hsts?: boolean;
  stream?: StreamConfig;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // One shared limiter instance per app; the middleware reads it off the context.
  app.use("*", async (c, next) => {
    c.set("limits", limits);
    await next();
  });

  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
      c.res.headers.set(name, value);
    }
    // Never override a handler's own policy (e.g. "/api/csp" tests nothing today).
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.res.headers.set(
        "Content-Security-Policy",
        c.req.path.startsWith("/api/") ? API_CSP : WEB_CSP,
      );
    }
    // The Funnel/bot port stays HSTS-free even with a proto hint; the viewer
    // surface (and the single-port app) only sends it when the request looks https.
    // `HSTS=true` overrides both: the operator asserts the deployment is always https.
    if (
      (hsts || (surface !== "bot" && requestLooksHttps(c))) &&
      !c.res.headers.has("Strict-Transport-Security")
    ) {
      c.res.headers.set("Strict-Transport-Security", "max-age=31536000");
    }
  });

  // Exact origins only, and set after the response exists: hono's `cors` helper touches
  // `c.res` before the route runs, and that copy clobbers a stream's own headers.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowed = origin !== undefined && corsOrigins.includes(origin) ? origin : undefined;
    const allow = (headers: Headers) => {
      if (allowed === undefined) return;
      headers.set("Access-Control-Allow-Origin", allowed);
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.append("Vary", "Origin");
    };

    if (c.req.method === "OPTIONS") {
      // The preflight is answered here, before auth or a body read; a foreign origin
      // gets a headerless 204 and the browser blocks the real request.
      if (allowed === undefined) return c.body(null, 204);
      const headers: Record<string, string> = {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          c.req.header("access-control-request-headers") ?? "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      };
      return c.body(null, 204, headers);
    }

    await next();
    allow(c.res.headers);
  });

  if (surface !== "all") {
    // A surface is a hard allowlist, so a leaked Funnel URL cannot reach viewer data.
    // Health is on both ports so a serve/Funnel probe still has something to hit.
    app.use("/api/*", async (c, next) => {
      const health = c.req.method === "GET" && c.req.path === HEALTH_PATH;
      const allowed = health
        ? true
        : surface === "bot"
          ? isBotEndpoint(c.req.method, c.req.path)
          : !isBotEndpoint(c.req.method, c.req.path);
      if (!allowed) return c.json({ error: "not found" }, 404);
      await next();
    });
  }

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_API_BODY_BYTES,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
  );

  app.get(HEALTH_PATH, (c) => c.json({ ok: true, service: SERVICE_NAME } satisfies Health));

  // No request logger on purpose: Authorization headers must never reach the logs.
  app.use("/api/admin/*", requireAdmin({ adminToken }));
  app.route("/api/admin", adminRoutes(repo, hub));
  app.route("/api/bots", botRoutes(repo, heartbeat, hub));
  app.route("/api/events", eventRoutes({ repo, adminToken, hub, policy: session }));
  app.route("/api/state", stateRoutes({ repo, adminToken, policy: session }));
  app.route(
    "/api/session",
    sessionRoutes({
      repo,
      adminToken,
      sessionTtlSec: session.ttlSec,
      sessionMaxPerToken: session.maxPerToken,
      sessionIdleSec: session.idleSec,
      corsOrigins,
    }),
  );
  app.route(
    "/api/stream",
    streamRoutes({ repo, adminToken, hub, policy: session, config: stream }),
  );

  // Unknown API paths must not fall through to the SPA index.html.
  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  if (webDist !== undefined && surface !== "bot") {
    // Real files first, then index.html for client-side routes (the viewer is an SPA).
    app.use("*", serveStatic({ root: webDist }));
    app.get("*", serveStatic({ root: webDist, path: "index.html" }));
  }

  return app;
}
