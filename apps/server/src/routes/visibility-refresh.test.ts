import { afterEach, describe, expect, it } from "vitest";

import { issueToken } from "../auth/tokens.ts";
import { Sse, adminHeaders, botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const SECRETS = ["ghost", "classified", "h-secret"];

function setup() {
  const context = testSetup({ stream: { pingIntervalMs: 60_000, maxClients: 50 } });
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot(botRecord("ghost"));
  const token = (id: string | null, kind: "bot" | "viewer" = "bot") =>
    issueToken(context.repo, { kind, botId: id }).token;
  return { ...context, viewerToken: token(null, "viewer"), ghostToken: token("ghost") };
}

const patchHidden = (app: ReturnType<typeof setup>["app"], hidden: boolean) =>
  app.request("/api/admin/bots/ghost", {
    method: "PATCH",
    headers: { ...adminHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ hidden }),
  });

describe("hidden bot visibility (no stored bot_hidden event)", () => {
  it("does not leak a hidden botId through /api/events after a hide", async () => {
    const { app, repo, viewerToken, ghostToken } = setup();
    expect(
      (
        await app.request("/api/events", {
          method: "POST",
          headers: { authorization: `Bearer ${ghostToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            events: [
              {
                botId: "ghost",
                eventId: "01J00000000000000000000001",
                type: "task_started",
                taskId: "classified",
                label: "classified",
              },
            ],
          }),
        })
      ).status,
    ).toBe(200);

    expect((await patchHidden(app, true)).status).toBe(200);
    expect(repo.getBot("ghost")?.hidden).toBe(true);
    expect(JSON.stringify(repo.listEventsSince(0).map((event) => event.type))).not.toContain(
      "bot_hidden",
    );

    const res = await app.request("/api/events?since=0", {
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain("bot_hidden");
  });

  it("broadcasts an id-less refresh frame on hide, with no hidden botId in the payload", async () => {
    const { app, repo, viewerToken } = setup();
    const sse = new Sse(
      await app.request("/api/stream", { headers: { authorization: `Bearer ${viewerToken}` } }),
    );
    expect((await sse.nextRaw()).comment).toBe("open");

    expect((await patchHidden(app, true)).status).toBe(200);
    expect(repo.getBot("ghost")?.hidden).toBe(true);

    const frame = await sse.next();
    expect(frame.event).toBe("refresh");
    expect(frame.id).toBeUndefined();
    expect(frame.data).toBe("{}");
    for (const secret of SECRETS) expect(frame.data).not.toContain(secret);
    expect(JSON.stringify(frame)).not.toContain("ghost");
    await sse.cancel();
  });

  it("broadcasts an id-less refresh frame on un-hide and still stores no bot_hidden row", async () => {
    const { app, repo, viewerToken } = setup();
    expect((await patchHidden(app, true)).status).toBe(200);
    const sse = new Sse(
      await app.request("/api/stream", { headers: { authorization: `Bearer ${viewerToken}` } }),
    );
    expect((await sse.nextRaw()).comment).toBe("open");

    expect((await patchHidden(app, false)).status).toBe(200);
    expect(repo.getBot("ghost")?.hidden).toBe(false);
    expect(JSON.stringify(repo.listEventsSince(0).map((event) => event.type))).not.toContain(
      "bot_hidden",
    );

    const frame = await sse.next();
    expect(frame.event).toBe("refresh");
    expect(frame.id).toBeUndefined();
    expect(frame.data).toBe("{}");
    await sse.cancel();
  });
});
