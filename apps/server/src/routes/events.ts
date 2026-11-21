import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { EventsBatch } from "@grokbot-office/shared";

import type { AppEnv } from "../auth/middleware.ts";
import { requireToken, requireViewer, type ViewerSessionPolicy } from "../auth/middleware.ts";
import { InvalidEventError, type Repo } from "../db/repo.ts";
import type { StreamHub } from "../stream/hub.ts";
import { nowUtc } from "../time.ts";
import { toStreamEvent } from "./mappers.ts";

const EVENTS_LIMIT_DEFAULT = 100;
const EVENTS_LIMIT_MAX = 500;
/**
 * Widest accepted window: the viewer's stats read spans seven local days, plus
 * room for DST shifts. A wider window is a caller error, not a slow query.
 */
const EVENTS_WINDOW_MAX_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Query values are canonical digit strings: `Number("")` is 0, so empty input must
 * fail here, and leading zeros (`00`, `03`) are refused rather than normalized.
 */
const integerQuery = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "must be a non-negative integer without leading zeros")
  .transform(Number)
  .refine(Number.isSafeInteger, "must be a safe integer");

const isoInstant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const EventsQuery = z
  .object({
    since: integerQuery.optional(),
    limit: integerQuery
      .refine((value) => value >= 1 && value <= EVENTS_LIMIT_MAX, `must be 1-${EVENTS_LIMIT_MAX}`)
      .optional(),
    from: isoInstant.optional(),
    to: isoInstant.optional(),
  })
  .strict();

/** Strictly parsed query; repeated or unknown parameters are refused, not merged. */
function parseEventsQuery(
  c: Context<AppEnv>,
): { since: number; limit: number; from?: string; to?: string } | undefined {
  const raw: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) return undefined;
    raw[key] = values[0];
  }
  const parsed = EventsQuery.safeParse(raw);
  if (!parsed.success) return undefined;
  const { from, to } = parsed.data;
  // The window is half-open: an empty or reversed range is a caller error.
  if (from !== undefined && to !== undefined && from >= to) return undefined;
  if (
    from !== undefined &&
    to !== undefined &&
    Date.parse(to) - Date.parse(from) > EVENTS_WINDOW_MAX_MS
  ) {
    return undefined;
  }
  return {
    since: parsed.data.since ?? 0,
    limit: parsed.data.limit ?? EVENTS_LIMIT_DEFAULT,
    from,
    to,
  };
}

/**
 * Bot event ingest. The token decides the identity, so a batch whose events name
 * another bot is refused whole; schema errors never echo the input back.
 *
 * `GET` is the viewer's paged replay of the same log, behind its own auth.
 * A committed batch wakes the SSE clients through `hub`.
 */
export function eventRoutes({
  repo,
  adminToken,
  hub,
  policy,
}: {
  repo: Repo;
  adminToken: string | undefined;
  hub: StreamHub;
  policy: ViewerSessionPolicy;
}) {
  const api = new Hono<AppEnv>();

  api.get("/", requireViewer({ repo, adminToken, policy }), (c) => {
    const query = parseEventsQuery(c);
    if (!query) return c.json({ error: "invalid query" }, 400);

    // One read transaction; one extra row answers `hasMore` without a second query.
    const { rows, lastSeq } = repo.getEventsPage(query.since, query.limit, {
      from: query.from,
      to: query.to,
    });
    const events = rows.slice(0, query.limit).map(toStreamEvent);
    const hasMore = rows.length > query.limit;
    // Private data: never let a shared cache keep it.
    c.header("Cache-Control", "no-store");
    return c.json({
      events,
      // Hidden bots' events leave gaps in `seq`, and a `since` past the newest event
      // is clamped to the high-water mark (like the stream cursor), so a client never
      // waits for ids it will never see.
      nextSince: hasMore ? events[events.length - 1].seq : lastSeq,
      hasMore,
      lastSeq,
    });
  });

  api.post("/", requireToken({ repo, kind: "bot" }), async (c) => {
    const parsed = EventsBatch.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    const token = c.get("token");
    const botId = token.botId ?? "";
    // A token for an unregistered bot still names it; events need the bot row.
    if (parsed.data.events.some((event) => event.botId !== botId) || !repo.getBot(botId)) {
      // Same generic body as requireToken; the reason stays server-side.
      console.warn("auth: token rejected", {
        reason: "token bound to another bot",
        tokenId: token.id,
      });
      return c.json({ error: "forbidden" }, 403);
    }

    const now = nowUtc();
    try {
      const result = repo.applyEvents(botId, parsed.data.events, now);
      // Only a commit with at least one new event gives a stream something to send.
      if (result.accepted > 0) hub.notify();
      return c.json(result);
    } catch (error) {
      if (!(error instanceof InvalidEventError)) throw error;
      return c.json({ error: "invalid event", index: error.index }, 422);
    }
  });

  return api;
}
