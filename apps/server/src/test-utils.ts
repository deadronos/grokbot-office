import { createApp } from "./app.ts";
import { type HeartbeatConfig, resolveHeartbeatConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";

/** Obviously fake admin token; real ones never live in the repo. */
export const TEST_ADMIN_TOKEN = "test-admin-token-not-a-real-secret-0000";

export const NOW = "2026-01-01T00:00:00.000Z";

export const botRecord = (id: string) => ({
  id,
  name: id,
  role: "worker",
  avatar: "robot",
  pod: "dev" as const,
  hidden: false,
  createdAt: NOW,
  updatedAt: NOW,
});

/** In-memory app + repo for route and middleware tests. */
export function testSetup({
  adminToken = TEST_ADMIN_TOKEN,
  heartbeat = resolveHeartbeatConfig({}),
}: { adminToken?: string; heartbeat?: HeartbeatConfig } = {}) {
  const db = openDatabase(":memory:");
  const repo = createSqliteRepo(db);
  const app = createApp({ repo, adminToken, heartbeat });
  return { db, repo, app, close: () => db.close() };
}

export const adminHeaders = (token = TEST_ADMIN_TOKEN) => ({ authorization: `Bearer ${token}` });
