import { Hono } from "hono";

import { HEALTH_PATH, type Health } from "@grokbot-office/shared";

import type { AppEnv } from "./auth/middleware.ts";
import { requireAdmin } from "./auth/middleware.ts";
import type { Repo } from "./db/repo.ts";
import { adminRoutes } from "./routes/admin.ts";

export const SERVICE_NAME = "grokbot-office-server";

/**
 * Builds the app from its dependencies so tests can hand in an in-memory repo.
 * `adminToken` is the env `ADMIN_TOKEN`; when it is unset or the placeholder the
 * admin API answers 503.
 */
export function createApp({
  repo,
  adminToken,
}: {
  repo: Repo;
  adminToken: string | undefined;
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get(HEALTH_PATH, (c) => c.json({ ok: true, service: SERVICE_NAME } satisfies Health));

  // No request logger on purpose: Authorization headers must never reach the logs.
  app.use("/api/admin/*", requireAdmin({ adminToken }));
  app.route("/api/admin", adminRoutes(repo));

  return app;
}
