import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serve, type ServerType } from "@hono/node-server";

import { createApp } from "./app.ts";
import {
  DEFAULT_VIEWER_PORT,
  resolveCorsOrigins,
  resolveHeartbeatConfig,
  resolvePort,
  resolveRateLimitConfig,
  resolveRetentionDays,
  resolveSessionConfig,
  resolveViewerTailnetOnly,
} from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";
import { startHeartbeatSweeper, startRetentionPrune } from "./jobs.ts";
import { createRateLimits } from "./rate-limit.ts";
import { createStreamHub } from "./stream/hub.ts";

/** How long shutdown waits for open connections before force-closing them. */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** The built viewer, if `pnpm build` has run; the viewer surface serves it when present. */
const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

// Invalid heartbeat, retention, session, rate-limit or origin settings stop the server
// here, not at the first request.
const heartbeat = resolveHeartbeatConfig(process.env);
const retentionDays = resolveRetentionDays(process.env);
const session = resolveSessionConfig(process.env);
const limits = createRateLimits(resolveRateLimitConfig(process.env));
const corsOrigins = resolveCorsOrigins(process.env);
const tailnetOnly = resolveViewerTailnetOnly(process.env);
const port = resolvePort(process.env);
const viewerPort = resolvePort(process.env, "VIEWER_PORT", DEFAULT_VIEWER_PORT);
if (tailnetOnly && viewerPort === port) {
  throw new Error("VIEWER_PORT must differ from PORT when VIEWER_TAILNET_ONLY is set");
}

const db = openDatabase();
const hub = createStreamHub();
const repo = createSqliteRepo(db);

// Background jobs: both timers are `unref`ed so they never keep the process alive alone.
const stopSweeper = startHeartbeatSweeper({ repo, hub, timeoutSec: heartbeat.timeoutSec });
const stopPrune = startRetentionPrune({ repo, retentionDays });

const servers: ServerType[] = [];
const start = (serverPort: number, app: ReturnType<typeof createApp>, label: string) =>
  servers.push(
    serve({ fetch: app.fetch, port: serverPort, hostname: "127.0.0.1" }, (info) => {
      console.log(`grokbot-office ${label} listening on http://127.0.0.1:${info.port}`);
    }),
  );

if (tailnetOnly) {
  // One port is exposed through Funnel: it may only see the bot API, never viewer data.
  start(
    port,
    createApp({
      repo,
      adminToken: process.env.ADMIN_TOKEN,
      heartbeat,
      hub,
      session,
      limits,
      corsOrigins,
      surface: "bot",
    }),
    "bot api",
  );
  start(
    viewerPort,
    createApp({
      repo,
      adminToken: process.env.ADMIN_TOKEN,
      heartbeat,
      hub,
      session,
      limits,
      corsOrigins,
      surface: "viewer",
      webDist: existsSync(webDist) ? webDist : undefined,
    }),
    "viewer",
  );
} else {
  start(
    port,
    createApp({
      repo,
      adminToken: process.env.ADMIN_TOKEN,
      heartbeat,
      hub,
      session,
      limits,
      corsOrigins,
      webDist: existsSync(webDist) ? webDist : undefined,
    }),
    "",
  );
}

// Keep the handle alive for the whole run and close it on shutdown: better-sqlite3
// checkpoints the WAL on close, so the -wal/-shm files are cleaned up too.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopSweeper();
    stopPrune();
    // An open SSE stream never finishes on its own, so end them all first: otherwise
    // `close` would wait forever for those connections.
    hub.closeAll();
    const force = setTimeout(() => {
      for (const server of servers) {
        if ("closeAllConnections" in server) server.closeAllConnections();
      }
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    let pending = servers.length;
    for (const server of servers) {
      server.close(() => {
        pending -= 1;
        if (pending > 0) return;
        clearTimeout(force);
        db.close();
        process.exit(0);
      });
    }
    // `close` only drops connections that are idle right now; ended streams and other
    // keep-alive clients go idle a moment later, so sweep again instead of waiting for
    // the keep-alive timeout.
    const sweep = setInterval(() => {
      for (const server of servers) {
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      }
    }, 50);
    sweep.unref();
  });
}
