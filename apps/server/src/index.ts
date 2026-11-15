import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { resolveHeartbeatConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";

// Invalid heartbeat settings stop the server here instead of at the first request.
const heartbeat = resolveHeartbeatConfig(process.env);

const db = openDatabase();
const app = createApp({
  repo: createSqliteRepo(db),
  adminToken: process.env.ADMIN_TOKEN,
  heartbeat,
});

const port = Number(process.env.PORT ?? 8787);

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`grokbot-office server listening on http://127.0.0.1:${info.port}`);
});

// Keep the handle alive for the whole run and close it on shutdown: better-sqlite3
// checkpoints the WAL on close, so the -wal/-shm files are cleaned up too.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
