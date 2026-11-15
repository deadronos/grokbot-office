import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { resolveHeartbeatConfig, resolveSessionTtlSec } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";
import { createStreamHub } from "./stream/hub.ts";

/** How long shutdown waits for open connections before force-closing them. */
const SHUTDOWN_TIMEOUT_MS = 5000;

// Invalid heartbeat or session settings stop the server here, not at the first request.
const heartbeat = resolveHeartbeatConfig(process.env);
const sessionTtlSec = resolveSessionTtlSec(process.env);

const db = openDatabase();
const hub = createStreamHub();
const app = createApp({
  repo: createSqliteRepo(db),
  adminToken: process.env.ADMIN_TOKEN,
  heartbeat,
  hub,
  sessionTtlSec,
});

const port = Number(process.env.PORT ?? 8787);

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`grokbot-office server listening on http://127.0.0.1:${info.port}`);
});

// Keep the handle alive for the whole run and close it on shutdown: better-sqlite3
// checkpoints the WAL on close, so the -wal/-shm files are cleaned up too.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    // An open SSE stream never finishes on its own, so end them all first: otherwise
    // `server.close` would wait forever for those connections.
    hub.closeAll();
    const force = setTimeout(() => {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      db.close();
      process.exit(0);
    });
  });
}
