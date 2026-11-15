import { createApp } from "./app.ts";
import { DEFAULT_SESSION_TTL_SEC, type HeartbeatConfig, resolveHeartbeatConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createSqliteRepo } from "./db/repo.ts";
import type { StreamConfig } from "./routes/stream.ts";
import { createStreamHub } from "./stream/hub.ts";

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
  sessionTtlSec = DEFAULT_SESSION_TTL_SEC,
  stream,
}: {
  adminToken?: string;
  heartbeat?: HeartbeatConfig;
  sessionTtlSec?: number;
  stream?: StreamConfig;
} = {}) {
  const db = openDatabase(":memory:");
  const repo = createSqliteRepo(db);
  const hub = createStreamHub();
  const app = createApp({
    repo,
    adminToken,
    heartbeat,
    hub,
    sessionTtlSec,
    stream,
  });
  // Ending streams first stops their ping timers, so no test leaks a timer.
  return {
    db,
    repo,
    hub,
    app,
    close: () => {
      hub.closeAll();
      db.close();
    },
  };
}

export const adminHeaders = (token = TEST_ADMIN_TOKEN) => ({ authorization: `Bearer ${token}` });

export type SseFrame = { event: string; data: string; id?: string };

/** Reads SSE frames out of a streaming Response (the `/api/stream` tests). */
export class Sse {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();

  constructor(res: Response) {
    if (res.body === null) throw new Error("stream response has no body");
    this.reader = res.body.getReader();
  }

  async next(): Promise<SseFrame> {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        const frame: SseFrame = { event: "", data: "" };
        for (const line of block.split("\n")) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const field = line.slice(0, colon);
          const value = line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") frame.event = value;
          if (field === "data") frame.data = frame.data === "" ? value : `${frame.data}\n${value}`;
          if (field === "id") frame.id = value;
        }
        return frame;
      }
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error("stream ended before a frame");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Resolves once the server ends the stream, dropping any queued frames. */
  async ended(): Promise<void> {
    for (;;) {
      const chunk = await this.reader.read();
      if (chunk.done) return;
    }
  }

  cancel(): Promise<void> {
    return this.reader.cancel();
  }
}
