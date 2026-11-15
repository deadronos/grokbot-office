import { afterEach, describe, expect, it } from "vitest";

import { MAX_API_BODY_BYTES } from "../app.ts";
import { issueToken } from "../auth/tokens.ts";
import { botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

const body = {
  id: "data",
  name: "Data",
  role: "Code-Orchestrator",
  avatar: "android-gold",
  pod: "dev" as const,
};

type App = ReturnType<typeof testSetup>["app"];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function setup({ heartbeat }: { heartbeat?: { intervalSec: number; timeoutSec: number } } = {}) {
  const context = testSetup({ heartbeat });
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot(botRecord("wesley"));
  const token = (id: string | null, kind: "bot" | "viewer" = "bot") =>
    issueToken(context.repo, { kind, botId: id }).token;
  return {
    ...context,
    dataToken: token("data"),
    wesleyToken: token("wesley"),
    viewerToken: issueToken(context.repo, { kind: "viewer" }).token,
  };
}

const register = (app: App, token: string, payload: unknown) =>
  app.request("/api/bots/register", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

const heartbeat = (app: App, id: string, token: string, payload?: unknown) =>
  app.request(`/api/bots/${id}/heartbeat`, {
    method: "POST",
    headers: {
      ...auth(token),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    body:
      payload === undefined
        ? undefined
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload),
  });

describe("POST /api/bots/register", () => {
  it("upserts the profile, creates an idle status row and returns the heartbeat config", async () => {
    const { app, repo, dataToken } = setup();
    const res = await register(app, dataToken, body);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: "data",
      heartbeatIntervalSec: 60,
      timeoutSec: 300,
    });

    const before = Date.parse("2026-01-01T00:00:00.000Z");
    expect(repo.getBot("data")).toMatchObject({
      name: "Data",
      role: "Code-Orchestrator",
      avatar: "android-gold",
      pod: "dev",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(Date.parse(repo.getBot("data")?.updatedAt ?? "")).toBeGreaterThan(before);

    const status = repo.getBotStatus("data");
    expect(status).toMatchObject({ botId: "data", status: "idle" });
    expect(status?.since).toBe(status?.lastHeartbeatAt);
  });

  it("is idempotent and keeps admin-owned fields and created_at", async () => {
    const { app, db, repo, dataToken } = setup();
    const first = await register(app, dataToken, body);
    const second = await register(app, dataToken, body);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual(await first.json());

    repo.updateBot("data", { hidden: true });
    await register(app, dataToken, { ...body, name: "Data II", pod: "ops" });

    const bot = repo.getBot("data");
    expect(bot).toMatchObject({
      name: "Data II",
      pod: "ops",
      hidden: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const counts = db
      .prepare(
        "select (select count(*) from bots) as bots, (select count(*) from bot_status) as status",
      )
      .get();
    expect(counts).toEqual({ bots: 2, status: 1 });
  });

  it("refreshes the heartbeat on re-register without resetting the status", async () => {
    const { app, repo, dataToken } = setup();
    await register(app, dataToken, body);
    const old = "2026-01-01T00:00:00.000Z";
    repo.setBotStatus({
      botId: "data",
      status: "working",
      label: null,
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      since: old,
      lastHeartbeatAt: old,
      lastEventSeq: null,
    });
    await register(app, dataToken, body);

    const status = repo.getBotStatus("data");
    expect(status?.status).toBe("working");
    expect(status?.since).toBe(old);
    expect(Date.parse(status?.lastHeartbeatAt ?? "")).toBeGreaterThan(Date.parse(old));
  });

  it("refuses a token bound to another bot", async () => {
    const { app, wesleyToken, dataToken } = setup();
    const res = await register(app, wesleyToken, body);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
    expect((await register(app, dataToken, { ...body })).status).toBe(200);
  });

  it("rejects other token kinds", async () => {
    const { app, viewerToken } = setup();
    const res = await register(app, viewerToken, body);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("validates the body", async () => {
    const { app, repo, dataToken } = setup();
    expect((await register(app, dataToken, "{")).status).toBe(400);
    expect((await register(app, dataToken, "")).status).toBe(400);
    expect((await register(app, dataToken, { id: "data" })).status).toBe(400);
    expect((await register(app, dataToken, { ...body, name: "x".repeat(41) })).status).toBe(400);
    expect((await register(app, dataToken, { ...body, pod: "moon" })).status).toBe(400);
    expect((await register(app, dataToken, { ...body, id: "Bad Slug" })).status).toBe(400);

    expect((await register(app, dataToken, { ...body, name: "Data\u0000X" })).status).toBe(200);
    expect(repo.getBot("data")?.name).toBe("Data X");
  });
});

describe("POST /api/bots/:id/heartbeat", () => {
  it("records a heartbeat and answers 204 with no body", async () => {
    const { app, repo, dataToken } = setup();
    expect(repo.getBotStatus("data")).toBeUndefined();

    const res = await heartbeat(app, "data", dataToken);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const status = repo.getBotStatus("data");
    expect(status).toMatchObject({ botId: "data", status: "idle" });
    expect(status?.since).toBe(status?.lastHeartbeatAt);
  });

  it("accepts an empty JSON object and an explicit status", async () => {
    const { app, repo, dataToken } = setup();
    expect((await heartbeat(app, "data", dataToken, {})).status).toBe(204);
    expect(repo.getBotStatus("data")?.status).toBe("idle");

    expect((await heartbeat(app, "data", dataToken, { status: "working" })).status).toBe(204);
    const working = repo.getBotStatus("data");
    expect(working?.status).toBe("working");
    expect(working?.since).toBe(working?.lastHeartbeatAt);
  });

  it("refreshes last_heartbeat_at and resets since only when the status changes", async () => {
    const { app, repo, dataToken } = setup();
    const old = "2026-01-01T00:00:00.000Z";
    repo.setBotStatus({
      botId: "data",
      status: "working",
      label: null,
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      since: old,
      lastHeartbeatAt: old,
      lastEventSeq: null,
    });

    await heartbeat(app, "data", dataToken, { status: "working" });
    const same = repo.getBotStatus("data");
    expect(same?.since).toBe(old);
    expect(Date.parse(same?.lastHeartbeatAt ?? "")).toBeGreaterThan(Date.parse(old));

    // Derived working can't be overridden by a heartbeat, except with offline.
    await heartbeat(app, "data", dataToken, { status: "reviewing" });
    expect(repo.getBotStatus("data")).toMatchObject({ status: "working", since: old });

    await heartbeat(app, "data", dataToken, { status: "offline" });
    const changed = repo.getBotStatus("data");
    expect(changed?.status).toBe("offline");
    expect(Date.parse(changed?.since ?? "")).toBeGreaterThan(Date.parse(old));
  });

  it("refuses a token bound to another bot", async () => {
    const { app, repo, wesleyToken } = setup();
    const res = await heartbeat(app, "data", wesleyToken);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
    expect(repo.getBotStatus("data")).toBeUndefined();
  });

  it("answers 401 for a bad token and 400 for a bad body or bot id", async () => {
    const { app, repo, dataToken } = setup();
    expect((await heartbeat(app, "data", "unknown-token")).status).toBe(401);
    expect((await heartbeat(app, "data", dataToken, "{")).status).toBe(400);
    expect((await heartbeat(app, "data", dataToken, { status: "daydreaming" })).status).toBe(400);

    // The only way to reach the id check is a token bound to that same bad slug.
    repo.upsertBot({ ...botRecord("Bad Slug") });
    const badSlugToken = issueToken(repo, { kind: "bot", botId: "Bad Slug" }).token;
    expect((await heartbeat(app, "Bad%20Slug", badSlugToken)).status).toBe(400);
  });
});

describe("API body limit", () => {
  it("rejects an oversized register body with 413", async () => {
    const { app, dataToken } = setup();
    const huge = { ...body, role: "x".repeat(MAX_API_BODY_BYTES + 1) };
    const res = await register(app, dataToken, huge);
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "payload too large" });
  });
});
