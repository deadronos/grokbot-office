import { Hono } from "hono";

import { BotId, HeartbeatBody, RegisterBody } from "@grokbot-office/shared";

import type { AppEnv } from "../auth/middleware.ts";
import { requireToken } from "../auth/middleware.ts";
import type { HeartbeatConfig } from "../config.ts";
import type { Repo } from "../db/repo.ts";

/**
 * Bot-facing API. Both routes only trust a bot token bound to the bot being
 * written; the token decides the identity, the body never overrides it.
 */
export function botRoutes(repo: Repo, heartbeat: HeartbeatConfig) {
  const api = new Hono<AppEnv>();

  api.post("/register", requireToken({ repo, kind: "bot" }), async (c) => {
    const parsed = RegisterBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const bot = parsed.data;
    const token = c.get("token");
    if (token.botId !== bot.id) {
      // Same generic body as requireToken; the reason stays server-side.
      console.warn("auth: token rejected", {
        reason: "token bound to another bot",
        tokenId: token.id,
      });
      return c.json({ error: "forbidden" }, 403);
    }

    repo.registerBot(bot, new Date().toISOString());
    return c.json({
      id: bot.id,
      heartbeatIntervalSec: heartbeat.intervalSec,
      timeoutSec: heartbeat.timeoutSec,
    });
  });

  // Auth runs first so a token for another bot gets 403, not 400.
  api.post("/:id/heartbeat", requireToken({ repo, kind: "bot", botIdParam: "id" }), async (c) => {
    const id = c.req.param("id");
    if (!BotId.safeParse(id).success) return c.json({ error: "invalid bot id" }, 400);

    const text = await c.req.text().catch(() => "");
    let raw: unknown = {};
    if (text.trim() !== "") {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
    }
    const parsed = HeartbeatBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    repo.touchHeartbeat(id, parsed.data.status, new Date().toISOString());
    return c.body(null, 204);
  });

  return api;
}
