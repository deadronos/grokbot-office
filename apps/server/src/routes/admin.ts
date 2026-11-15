import { z } from "zod";
import { Hono } from "hono";

import { BotId, RegisterBody } from "@grokbot-office/shared";

import type { AppEnv } from "../auth/middleware.ts";
import { issueToken } from "../auth/tokens.ts";
import type { Repo, Token } from "../db/repo.ts";

const CreateTokenBody = z.object({
  // `admin` is deliberately not issuable: admin access stays env-only.
  kind: z.enum(["bot", "viewer"]),
  botId: BotId.optional(),
});

const PatchBotBody = z
  .object({
    // Same sanitizing and caps as registration.
    name: RegisterBody.shape.name.optional(),
    role: RegisterBody.shape.role.optional(),
    avatar: RegisterBody.shape.avatar.optional(),
    pod: RegisterBody.shape.pod.optional(),
    deskIndex: z.number().int().nonnegative().nullable().optional(),
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

export function adminRoutes(repo: Repo) {
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
    repo.revokeToken(id, new Date().toISOString());
    return c.json({ ok: true });
  });

  api.patch("/bots/:id", async (c) => {
    const id = c.req.param("id");
    if (!BotId.safeParse(id).success) return c.json({ error: "invalid bot id" }, 400);
    if (!repo.getBot(id)) return c.json({ error: "unknown bot" }, 404);
    const parsed = PatchBotBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const updated = repo.updateBot(id, { ...parsed.data, updatedAt: new Date().toISOString() });
    return c.json(updated);
  });

  return api;
}
