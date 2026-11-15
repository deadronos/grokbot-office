import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import type { AppEnv } from "../auth/middleware.ts";
import { requireViewer, validateViewer } from "../auth/middleware.ts";
import { SESSION_COOKIE_NAME } from "../auth/session.ts";
import type { Repo } from "../db/repo.ts";
import type { StreamHub } from "../stream/hub.ts";
import { nowUtc } from "../time.ts";
import { toStreamEvent } from "./mappers.ts";

/** One drain page; the same cap as the replay endpoint's largest page. */
export const STREAM_PAGE = 500;
export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_MAX_STREAM_CLIENTS = 200;

/** Tests shorten the ping and the client cap; production uses the defaults. */
export type StreamConfig = { pingIntervalMs: number; maxClients: number };

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
  maxClients: DEFAULT_MAX_STREAM_CLIENTS,
};

/** Same canonical digit rule as `/api/events`: no empty input, no leading zeros. */
const cursorValue = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative integer without leading zeros")
  .transform(Number)
  .refine(Number.isSafeInteger, "must be a safe integer");

const StreamQuery = z.object({ since: cursorValue.optional() }).strict();

/**
 * Resume cursor: `Last-Event-ID` (what EventSource sends after a reconnect) wins,
 * else `?since`. `undefined` means start live at the current high-water mark.
 */
function parseStreamCursor(c: Context<AppEnv>): { since: number | undefined } | undefined {
  const raw: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) return undefined;
    raw[key] = values[0];
  }
  const query = StreamQuery.safeParse(raw);
  if (!query.success) return undefined;

  const header = c.req.header("last-event-id");
  if (header !== undefined) {
    const parsed = cursorValue.safeParse(header);
    if (!parsed.success) return undefined;
    return { since: parsed.data };
  }
  return { since: query.data.since };
}

/**
 * The live stream. Delivery is notify-then-pull: the hub says "something landed"
 * and each client drains `getEventsPage` from its own cursor, so the hidden-bot
 * filter of #7 applies to live and replayed events alike. Events are the only
 * payload besides pings.
 */
export function streamRoutes({
  repo,
  adminToken,
  hub,
  config = DEFAULT_STREAM_CONFIG,
}: {
  repo: Repo;
  adminToken: string | undefined;
  hub: StreamHub;
  config?: StreamConfig;
}) {
  const api = new Hono<AppEnv>();

  api.get("/", requireViewer({ repo, adminToken }), (c) => {
    const parsed = parseStreamCursor(c);
    if (!parsed) return c.json({ error: "invalid query" }, 400);
    if (hub.size() >= config.maxClients) {
      return c.json({ error: "too many streams" }, 503);
    }

    // Captured once: every ping re-checks the very credential the stream opened with.
    const header = c.req.header("authorization");
    const secret = getCookie(c, SESSION_COOKIE_NAME);
    const start = parsed.since ?? repo.lastEventSeq();

    const response = streamSSE(c, async (stream) => {
      let cursor = start;
      let draining = false;
      let again = false;
      let stopped = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let finish = () => {};

      const ended = new Promise<void>((resolve) => {
        finish = resolve;
      });

      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        hub.remove(client);
        finish();
      };

      /** Serialized per client: a notify during a drain runs one more drain afterwards. */
      const drain = async () => {
        if (stopped) return;
        if (draining) {
          again = true;
          return;
        }
        draining = true;
        try {
          do {
            again = false;
            for (;;) {
              const page = repo.getEventsPage(cursor, STREAM_PAGE);
              for (const row of page.rows.slice(0, STREAM_PAGE)) {
                if (stopped) return;
                await stream.writeSSE({
                  id: String(row.seq),
                  event: "event",
                  data: JSON.stringify(toStreamEvent(row)),
                });
                cursor = row.seq;
              }
              // The page was the last one: skip any trailing run of hidden events.
              if (page.rows.length <= STREAM_PAGE) {
                cursor = Math.max(cursor, page.lastSeq);
                break;
              }
            }
          } while (again && !stopped);
        } finally {
          draining = false;
        }
      };

      const client = {
        notify: () => void drain().catch(stop),
        close: stop,
      };
      hub.add(client);
      stream.onAbort(stop);

      timer = setInterval(() => {
        if (stopped) return;
        // A session can expire or be revoked, and a token can die: pings are the check.
        const check = validateViewer({ repo, adminToken, header, secret, now: nowUtc() });
        if (!check.ok) {
          stop();
          return;
        }
        void stream.writeSSE({ event: "ping", data: "{}" });
      }, config.pingIntervalMs);

      // Replay (or catch up) and then stay open until a ping, an abort or shutdown ends us.
      // The finally keeps the hub and the timer clean even if a write or the DB throws.
      try {
        await drain();
        await ended;
      } finally {
        stop();
      }
    });
    // streamSSE asks for `no-cache`; the viewer payload is private, so it wins.
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  return api;
}
