import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { EventsBatch } from "@grokbot-office/shared";

import type { AppEnv } from "../auth/middleware.ts";
import { requireToken, requireViewer } from "../auth/middleware.ts";
import { InvalidEventError, type Repo } from "../db/repo.ts";
import { nowUtc } from "../time.ts";
import { toStreamEvent } from "./mappers.ts";

const EVENTS_LIMIT_DEFAULT = 100;
const EVENTS_LIMIT_MAX = 500;

/** Query values are digit strings; `Number("")` is 0, so empty input must fail here. */
const integerQuery = z
  .string()
  .regex(/^\d+$/, "must be a non-negative integer")
  .transform(Number)
  .refine(Number.isSafeInteger, "must be a safe integer");

const EventsQuery = z
  .object({
    since: integerQuery.optional(),
    limit: integerQuery
      .refine((value) => value >= 1 && value <= EVENTS_LIMIT_MAX, `must be 1-${EVENTS_LIMIT_MAX}`)
      .optional(),
  })
  .strict();

/** Strictly parsed query; repeated or unknown parameters are refused, not merged. */
function parseEventsQuery(c: Context<AppEnv>): { since: number; limit: number } | undefined {
  const raw: Record<string, string> = {};
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length !== 1) return undefined;
    raw[key] = values[0];
  }
  const parsed = EventsQuery.safeParse(raw);
  if (!parsed.success) return undefined;
  return {
    since: parsed.data.since ?? 0,
    limit: parsed.data.limit ?? EVENTS_LIMIT_DEFAULT,
  };
}

/**
 * Bot event ingest. The token decides the identity, so a batch whose events name
 * another bot is refused whole; schema errors never echo the input back.
 *
 * `GET` is the viewer's paged replay of the same log, behind its own auth.
 */
export function eventRoutes({ repo, adminToken }: { repo: Repo; adminToken: string | undefined }) {
  const api = new Hono<AppEnv>();

  api.get("/", requireViewer({ repo, adminToken }), (c) => {
    const query = parseEventsQuery(c);
    if (!query) return c.json({ error: "invalid query" }, 400);

    // One extra row is fetched only to answer `hasMore` without a second query.
    const rows = repo.listEventsPage(query.since, query.limit);
    const events = rows.slice(0, query.limit).map(toStreamEvent);
    // Private data: never let a shared cache keep it.
    c.header("Cache-Control", "no-store");
    return c.json({
      events,
      nextSince: events.at(-1)?.seq ?? query.since,
      hasMore: rows.length > query.limit,
      lastSeq: repo.getLastEventSeq(),
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
      return c.json(repo.applyEvents(botId, parsed.data.events, now));
    } catch (error) {
      if (!(error instanceof InvalidEventError)) throw error;
      return c.json({ error: "invalid event", index: error.index }, 422);
    }
  });

  return api;
}
