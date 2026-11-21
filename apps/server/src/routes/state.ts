import { Hono } from "hono";

import type { StateSnapshot } from "@grokbot-office/shared";

import type { AppEnv } from "../auth/middleware.ts";
import { requireViewer, type ViewerSessionPolicy } from "../auth/middleware.ts";
import type { Repo } from "../db/repo.ts";
import { nowUtc } from "../time.ts";
import { compareByLayout, toBotSnapshot, toHandoff } from "./mappers.ts";

/** Viewer snapshot: who is where and doing what, plus the event high-water mark. */
export function stateRoutes({
  repo,
  adminToken,
  policy,
  timeoutSec,
  awaySec,
}: {
  repo: Repo;
  adminToken: string | undefined;
  policy: ViewerSessionPolicy;
  timeoutSec: number;
  awaySec: number;
}) {
  const api = new Hono<AppEnv>();

  api.get("/", requireViewer({ repo, adminToken, policy }), (c) => {
    // The snapshot takes no parameters; anything in the query is a client bug.
    if (new URL(c.req.url).search !== "") return c.json({ error: "invalid query" }, 400);
    const snapshot = repo.getSnapshot();
    // A bot silent past this window reads as away; the stored status is untouched.
    const presence = {
      nowMs: new Date(nowUtc()).getTime(),
      timeoutMs: timeoutSec * 1000,
      awayMs: awaySec * 1000,
    };
    const statuses = new Map(snapshot.statuses.map((status) => [status.botId, status]));
    const body: StateSnapshot = {
      bots: snapshot.bots
        .toSorted(compareByLayout)
        .map((bot) => toBotSnapshot(bot, statuses.get(bot.id), presence)),
      openHandoffs: snapshot.openHandoffs.map(toHandoff),
      lastEventSeq: snapshot.lastEventSeq,
    };
    // Private data: never let a shared cache keep it.
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  return api;
}
