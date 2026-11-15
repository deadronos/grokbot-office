import { Hono } from "hono";

import { EventsBatch } from "@grokbot-office/shared";

import type { AppEnv } from "../auth/middleware.ts";
import { requireToken } from "../auth/middleware.ts";
import { InvalidEventError, type Repo } from "../db/repo.ts";
import { nowUtc } from "../time.ts";

/**
 * Bot event ingest. The token decides the identity, so a batch whose events name
 * another bot is refused whole; schema errors never echo the input back.
 */
export function eventRoutes(repo: Repo) {
  const api = new Hono<AppEnv>();

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
