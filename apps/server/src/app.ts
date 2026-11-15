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

export const SERVICE_NAME = "grokbot-office-server";

/** Abuse cap from the plan; real limits are per-field in the shared schemas. */
export const MAX_API_BODY_BYTES = 16 * 1024;

/**
 * Builds the app from its dependencies so tests can hand in an in-memory repo.
 * `adminToken` is the env `ADMIN_TOKEN`; when it is unset or the placeholder the
 * admin API answers 503.
 */
export function createApp({
  repo,
  adminToken,
  heartbeat,
}: {
  repo: Repo;
  adminToken: string | undefined;
  heartbeat: HeartbeatConfig;
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
  app.route("/api/bots", botRoutes(repo, heartbeat));
  app.route("/api/events", eventRoutes(repo));

  return app;
}
