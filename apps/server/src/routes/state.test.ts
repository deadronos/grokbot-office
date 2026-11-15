import { afterEach, describe, expect, it, vi } from "vitest";

import { StateSnapshot, getDesk } from "@grokbot-office/shared";

import { issueToken } from "../auth/tokens.ts";
import { NOW, TEST_ADMIN_TOKEN, botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
});

type App = ReturnType<typeof testSetup>["app"];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Event ids are ULIDs; a counter keeps them distinct and readable in assertions. */
const ulid = (n: number) => `01J${String(n).padStart(23, "0")}`;

function setup(adminToken?: string) {
  const context = testSetup(adminToken === undefined ? {} : { adminToken });
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot(botRecord("wesley"));
  return { ...context, viewerToken: issueToken(context.repo, { kind: "viewer" }).token };
}

const get = (app: App, token?: string) =>
  app.request("/api/state", token === undefined ? {} : { headers: auth(token) });

const UNAUTHORIZED = { error: "unauthorized" };
const FORBIDDEN = { error: "forbidden" };

describe("GET /api/state", () => {
  it("returns visible bots in desk order, with offline defaults and no nulls", async () => {
    const { app, repo, viewerToken } = setup();
    repo.upsertBot({ ...botRecord("data"), deskIndex: 1 });
    repo.upsertBot({ ...botRecord("alpha"), deskIndex: 1 });
    // Not in the desk layout: it shows in the HUD list only.
    repo.upsertBot({ ...botRecord("helper"), deskIndex: 0 });
    repo.upsertBot({ ...botRecord("hidden"), hidden: true });
    repo.upsertBot({ ...botRecord("aardvark"), deskIndex: null });

    const res = await get(app, viewerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = StateSnapshot.parse(await res.json());

    // desk index first, then id, no desk index last; the hidden bot is gone.
    expect(body.bots.map((bot) => bot.id)).toEqual([
      "helper",
      "wesley",
      "alpha",
      "data",
      "aardvark",
    ]);
    expect(body.bots[0]).not.toHaveProperty("desk");
    expect(body.bots[3]?.desk).toEqual(getDesk("data"));

    // No status row yet: offline since registration, no events.
    expect(body.bots[3]).toMatchObject({
      status: "offline",
      since: NOW,
      lastHeartbeatAt: NOW,
      lastEventSeq: 0,
    });
    expect(body.bots[3]).not.toHaveProperty("label");
    expect(body.bots[3]).not.toHaveProperty("taskId");
    expect(body).toMatchObject({ openHandoffs: [], lastEventSeq: 0 });
  });

  it("reflects the derived status and the event high-water mark", async () => {
    const { app, repo, viewerToken } = setup();
    repo.applyEvents(
      "data",
      [
        {
          botId: "data",
          eventId: ulid(1),
          type: "task_started",
          taskId: "t1",
          label: "planning",
        },
      ],
      NOW,
    );

    const body = StateSnapshot.parse(await (await get(app, viewerToken)).json());
    const data = body.bots.find((bot) => bot.id === "data");
    expect(data).toMatchObject({
      status: "working",
      taskId: "t1",
      label: "planning",
      since: NOW,
      lastHeartbeatAt: NOW,
      lastEventSeq: 1,
    });
    expect(body.lastEventSeq).toBe(1);
  });

  it("lists only handoffs that are still sent, without null optionals", async () => {
    const { app, repo, viewerToken } = setup();
    repo.applyEvents(
      "data",
      [
        {
          botId: "data",
          eventId: ulid(1),
          type: "handoff_sent",
          to: "wesley",
          handoffId: "h1",
          label: "plan",
        },
      ],
      NOW,
    );
    repo.applyEvents(
      "wesley",
      [{ botId: "wesley", eventId: ulid(2), type: "handoff_accepted", handoffId: "h1" }],
      NOW,
    );
    repo.applyEvents(
      "data",
      [{ botId: "data", eventId: ulid(3), type: "handoff_sent", to: "wesley", handoffId: "h2" }],
      NOW,
    );

    const body = StateSnapshot.parse(await (await get(app, viewerToken)).json());
    expect(body.openHandoffs).toEqual([
      { id: "h2", fromBotId: "data", toBotId: "wesley", state: "sent", sentAt: NOW },
    ]);
    expect(body.openHandoffs[0]).not.toHaveProperty("label");
    expect(body.openHandoffs[0]).not.toHaveProperty("acceptedAt");
  });
});

describe("GET /api/state auth", () => {
  it("accepts viewer and admin tokens and rejects everything else generically", async () => {
    const { app, repo, viewerToken } = setup();
    const revoked = issueToken(repo, { kind: "viewer" });
    repo.revokeToken(revoked.id, NOW);
    const bot = issueToken(repo, { kind: "bot", botId: "data" });

    for (const token of [undefined, "unknown-token-value", revoked.token]) {
      const res = await get(app, token);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual(UNAUTHORIZED);
    }

    const malformed = await app.request("/api/state", {
      headers: { authorization: "Basic abc" },
    });
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toEqual(UNAUTHORIZED);

    const botRes = await get(app, bot.token);
    expect(botRes.status).toBe(403);
    await expect(botRes.json()).resolves.toEqual(FORBIDDEN);

    expect((await get(app, viewerToken)).status).toBe(200);
    expect((await get(app, TEST_ADMIN_TOKEN)).status).toBe(200);
  });

  it("ignores an admin token the env does not make usable", async () => {
    const { app, repo } = setup("short");
    const viewer = issueToken(repo, { kind: "viewer" });
    expect((await get(app, TEST_ADMIN_TOKEN)).status).toBe(401);
    expect((await get(app, "short")).status).toBe(401);
    expect((await get(app, viewer.token)).status).toBe(200);
  });

  it("logs one reason and the token id, never token material", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, repo } = setup();
    const viewer = issueToken(repo, { kind: "viewer" });
    const bot = issueToken(repo, { kind: "bot", botId: "data" });

    await get(app, bot.token);
    await get(app, viewer.token);
    await get(app, "unknown-token-value");

    const serialized = JSON.stringify(warn.mock.calls);
    expect(serialized).not.toContain(viewer.token);
    expect(serialized).not.toContain(viewer.prefix);
    expect(serialized).not.toContain(bot.token);
    expect(serialized).not.toContain(bot.prefix);
    expect(serialized).not.toContain("unknown-token-value");
    expect(serialized).toContain("auth: token rejected");
    expect(serialized).toContain(bot.id);
  });
  it("refuses query parameters", async () => {
    const { app, viewerToken } = setup();
    const res = await app.request("/api/state?since=1", { headers: auth(viewerToken) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid query" });
  });
});
