import { randomUUID } from "node:crypto";

import { z } from "zod";
import { Hono } from "hono";

import { BotId, RegisterBody } from "@grokbot-office/shared";

import type { AppEnv } from "../auth/middleware.ts";
import { issueToken } from "../auth/tokens.ts";
import type { Repo, Token } from "../db/repo.ts";
import type { StreamHub } from "../stream/hub.ts";
import { nowUtc } from "../time.ts";

const CreateTokenBody = z
  .object({
    // `admin` is deliberately not issuable: admin access stays env-only.
    kind: z.enum(["bot", "viewer"]),
    botId: BotId.optional(),
  })
  .strict();

const PatchBotBody = z
  .object({
    // Same sanitizing and caps as registration.
    name: RegisterBody.shape.name.optional(),
    role: RegisterBody.shape.role.optional(),
    avatar: RegisterBody.shape.avatar.optional(),
    pod: RegisterBody.shape.pod.optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

export function tokenSummary(token: Token) {
  return {
    id: token.id,
    kind: token.kind,
    botId: token.botId,
    prefix: token.prefix,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt,
    revokedAt: token.revokedAt,
  };
}

export function adminRoutes(repo: Repo, hub: StreamHub) {
  const api = new Hono<AppEnv>();

  api.post("/tokens", async (c) => {
    const parsed = CreateTokenBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const { kind, botId } = parsed.data;
    if (kind === "bot") {
      if (!botId) return c.json({ error: "botId is required for bot tokens" }, 400);
      if (!repo.getBot(botId)) return c.json({ error: "unknown bot" }, 404);
    } else if (botId !== undefined) {
      return c.json({ error: "botId is not allowed for viewer tokens" }, 400);
    }
    const issued = issueToken(repo, { kind, botId: kind === "bot" ? botId : null });
    return c.json(issued, 201);
  });

  api.get("/tokens", (c) => c.json({ tokens: repo.listTokens().map(tokenSummary) }));

  api.delete("/tokens/:id", (c) => {
    const id = c.req.param("id");
    if (!repo.getToken(id)) return c.json({ error: "unknown token" }, 404);
    repo.revokeToken(id, nowUtc());
    return c.json({ ok: true });
  });

  api.patch("/bots/:id", async (c) => {
    const id = c.req.param("id");
    if (!BotId.safeParse(id).success) return c.json({ error: "invalid bot id" }, 400);
    const before = repo.getBot(id);
    if (!before) return c.json({ error: "unknown bot" }, 404);
    const parsed = PatchBotBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const now = nowUtc();
    const updated = repo.updateBot(id, { ...parsed.data, updatedAt: now });
    // Toggling visibility is a feed event, so open viewers drop or re-add the bot now.
    if (parsed.data.hidden !== undefined && parsed.data.hidden !== before.hidden) {
      repo.insertEvent({
        eventId: randomUUID(),
        botId: id,
        type: parsed.data.hidden ? "bot_hidden" : "bot_registered",
        receivedAt: now,
      });
      hub.notify();
    }
    return c.json(updated);
  });

  return api;
}
