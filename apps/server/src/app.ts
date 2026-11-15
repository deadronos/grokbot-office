import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { HEALTH_PATH, type Health } from "@grokbot-office/shared";

import type { AppEnv } from "./auth/middleware.ts";
import { requireAdmin } from "./auth/middleware.ts";
import type { HeartbeatConfig } from "./config.ts";
import type { Repo } from "./db/repo.ts";
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

/**
 * Builds the app from its dependencies so tests can hand in an in-memory repo.
 * `adminToken` is the env `ADMIN_TOKEN`; when it is unset or the placeholder the
 * admin API answers 503. `hub` is the in-process SSE fan-out (index.ts owns one;
 * tests create their own). `stream` shortens the ping interval and client cap in tests.
 */
export function createApp({
  repo,
  adminToken,
  heartbeat,
  hub,
  sessionTtlSec,
  stream = DEFAULT_STREAM_CONFIG,
}: {
  repo: Repo;
  adminToken: string | undefined;
  heartbeat: HeartbeatConfig;
  hub: StreamHub;
  sessionTtlSec: number;
  stream?: StreamConfig;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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
  app.route("/api/admin", adminRoutes(repo));
  app.route("/api/bots", botRoutes(repo, heartbeat, hub));
  app.route("/api/events", eventRoutes({ repo, adminToken, hub }));
  app.route("/api/state", stateRoutes({ repo, adminToken }));
  app.route("/api/session", sessionRoutes({ repo, adminToken, sessionTtlSec }));
  app.route("/api/stream", streamRoutes({ repo, adminToken, hub, config: stream }));

  return app;
}
