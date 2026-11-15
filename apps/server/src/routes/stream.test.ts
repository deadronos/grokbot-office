import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamEvent } from "@grokbot-office/shared";

import { SESSION_COOKIE_NAME } from "../auth/session.ts";
import { issueToken } from "../auth/tokens.ts";
import { NOW, Sse, botRecord, testSetup } from "../test-utils.ts";
import type { StreamConfig } from "./stream.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) close();
});

type Context = ReturnType<typeof testSetup>;
type App = Context["app"];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Long ping by default: most tests should only ever see events. */
function setup(stream: Partial<StreamConfig> = {}) {
  const context = testSetup({
    stream: { pingIntervalMs: 60_000, maxClients: 50, ...stream },
  });
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot(botRecord("wesley"));
  const token = (id: string | null, kind: "bot" | "viewer" = "bot") =>
    issueToken(context.repo, { kind, botId: id }).token;
  return {
    ...context,
    dataToken: token("data"),
    viewerToken: token(null, "viewer"),
  };
}

const ulid = (n: number) => `01J${String(n).padStart(23, "0")}`;

const post = (app: App, token: string, batch: object[]) =>
  app.request("/api/events", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({ events: batch }),
  });

const open = (app: App, headers: Record<string, string>, path = "/api/stream") =>
  app.request(path, { headers });

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sessionCookie = async (app: App, viewerToken: string) => {
  const res = await app.request("/api/session", { method: "POST", headers: auth(viewerToken) });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (raw === undefined) throw new Error("session cookie missing");
  return `${SESSION_COOKIE_NAME}=${raw.split(";")[0].split("=")[1]}`;
};

describe("GET /api/stream auth", () => {
  it("needs credentials", async () => {
    const { app } = setup();
    expect((await open(app, {})).status).toBe(401);
  });

  it("refuses a bot token", async () => {
    const { app, dataToken } = setup();
    expect((await open(app, auth(dataToken))).status).toBe(403);
  });

  it("refuses an unknown token", async () => {
    const { app } = setup();
    expect((await open(app, auth("not-a-real-token"))).status).toBe(401);
  });
});

describe("GET /api/stream frames", () => {
  it("streams a newly posted event as an SSE frame", async () => {
    const { app, viewerToken, dataToken } = setup();
    const res = await open(app, auth(viewerToken));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const sse = new Sse(res);
    await post(app, dataToken, [
      { botId: "data", eventId: ulid(1), type: "status_changed", status: "idle", label: "ready" },
    ]);

    const frame = await sse.next();
    expect(frame.event).toBe("event");
    expect(frame.id).toBe("1");
    const event = StreamEvent.parse(JSON.parse(frame.data));
    expect(event).toMatchObject({
      seq: 1,
      botId: "data",
      type: "status_changed",
      status: "idle",
      label: "ready",
    });
    await sse.cancel();
  });

  it("starts live without a cursor and replays from a cursor", async () => {
    const { app, viewerToken, dataToken } = setup();
    for (const n of [1, 2, 3]) {
      await post(app, dataToken, [
        { botId: "data", eventId: ulid(n), type: "status_changed", status: "idle" },
      ]);
    }

    // No cursor: nothing that already happened.
    const live = new Sse(await open(app, auth(viewerToken)));
    await post(app, dataToken, [
      { botId: "data", eventId: ulid(4), type: "status_changed", status: "idle" },
    ]);
    expect((await live.next()).id).toBe("4");
    await live.cancel();

    // Last-Event-ID wins over ?since on reconnect.
    const resumed = new Sse(
      await open(app, {
        ...auth(viewerToken),
        "last-event-id": "2",
      }),
    );
    expect((await resumed.next()).id).toBe("3");
    expect((await resumed.next()).id).toBe("4");
    await resumed.cancel();

    const since = new Sse(await open(app, auth(viewerToken)));
    await since.cancel();

    const fromQuery = new Sse(await open(app, auth(viewerToken), "/api/stream?since=3"));
    expect((await fromQuery.next()).id).toBe("4");
    await fromQuery.cancel();
  });
});

describe("GET /api/stream hidden bot", () => {
  it("streams only the bot_hidden frame, with no other field from the hidden bot", async () => {
    const { app, repo, hub, viewerToken } = setup();
    repo.upsertBot({ ...botRecord("ghost"), hidden: true });
    repo.applyEvents(
      "ghost",
      [
        {
          botId: "ghost",
          eventId: ulid(1),
          type: "task_started",
          taskId: "classified",
          label: "classified",
        },
        {
          botId: "ghost",
          eventId: ulid(2),
          type: "handoff_sent",
          to: "data",
          handoffId: "h-secret",
          label: "classified",
        },
      ] as never,
      NOW,
    );
    const sse = new Sse(await open(app, auth(viewerToken)));

    repo.insertEvent({
      eventId: ulid(3),
      botId: "ghost",
      type: "bot_hidden",
      receivedAt: NOW,
    });
    hub.notify();

    const frame = await sse.next();
    expect(JSON.parse(frame.data)).toMatchObject({
      seq: 3,
      botId: "ghost",
      type: "bot_hidden",
    });
    for (const secret of ["classified", "h-secret"]) expect(frame.data).not.toContain(secret);
    await sse.cancel();
  });
});

describe("GET /api/stream opening", () => {
  it("writes a retry + comment frame first, so EventSource opens at once", async () => {
    const { app, viewerToken } = setup();
    const res = await open(app, auth(viewerToken));
    expect(res.headers.get("connection")).toBe("close");
    const sse = new Sse(res);
    // Nothing to replay: the opening frame still arrives without waiting for an event.
    expect(await sse.nextRaw()).toEqual({ event: "", data: "", retry: "3000", comment: "open" });
    await sse.cancel();
  });
});

describe("GET /api/stream cursor beyond the newest event", () => {
  for (const [name, path, headers] of [
    ["Last-Event-ID", "/api/stream", { "last-event-id": "999" }],
    ["?since", "/api/stream?since=999", {}],
  ] as const) {
    it(`clamps ${name} to the newest event and goes live (e.g. after a DB reset)`, async () => {
      const { app, viewerToken, dataToken } = setup();
      await post(app, dataToken, [
        { botId: "data", eventId: ulid(1), type: "status_changed", status: "working" },
      ]);
      const sse = new Sse(await open(app, { ...auth(viewerToken), ...headers }, path));
      await post(app, dataToken, [
        { botId: "data", eventId: ulid(2), type: "status_changed", status: "idle" },
      ]);
      // Without the clamp the cursor would stay at 999 and seq 2 would never arrive.
      expect((await sse.next()).id).toBe("2");
      await sse.cancel();
    });
  }
});

describe("GET /api/stream hidden sender after accept", () => {
  it("streams nothing from a handoff whose sender is hidden after the accept", async () => {
    const { app, repo, viewerToken, dataToken } = setup();
    const wesleyToken = issueToken(repo, { kind: "bot", botId: "wesley" }).token;
    await post(app, wesleyToken, [
      {
        botId: "wesley",
        eventId: ulid(1),
        type: "handoff_sent",
        to: "data",
        handoffId: "h-later",
        label: "LATER-HIDDEN-LABEL",
      },
    ]);
    await post(app, dataToken, [
      { botId: "data", eventId: ulid(2), type: "handoff_accepted", handoffId: "h-later" },
    ]);
    repo.updateBot("wesley", { hidden: true });

    const sse = new Sse(await open(app, { ...auth(viewerToken), "last-event-id": "0" }));
    const frame = await sse.next();
    expect(frame.id).toBe("2");
    expect(frame.data).not.toContain("h-later");
    expect(frame.data).not.toContain("LATER-HIDDEN-LABEL");
    expect(frame.data).not.toContain("wesley");
    await sse.cancel();
  });
});

describe("GET /api/stream query", () => {
  it("refuses invalid cursors and unknown params before the stream opens", async () => {
    const { app, viewerToken } = setup();
    for (const path of [
      "/api/stream?since=03",
      "/api/stream?since=",
      "/api/stream?since=-1",
      "/api/stream?since=1.5",
      "/api/stream?since=1&since=2",
      "/api/stream?nope=1",
    ]) {
      const res = await open(app, auth(viewerToken), path);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "invalid query" });
    }
    const badHeader = await open(app, { ...auth(viewerToken), "last-event-id": "nope" });
    expect(badHeader.status).toBe(400);
  });
});

function hiddenSetup(stream: Partial<StreamConfig> = {}) {
  const context = setup(stream);
  context.repo.upsertBot({ ...botRecord("ghost"), hidden: true });
  const ghostEvents = (n: number, extra: Record<string, unknown> = {}) =>
    context.repo.applyEvents(
      "ghost",
      [{ botId: "ghost", eventId: ulid(n), type: "status_changed", ...extra }] as never,
      NOW,
    );
  return { ...context, ghostEvents };
}

describe("GET /api/stream hidden bots", () => {
  it("does not stream events a hidden bot sends", async () => {
    const { app, viewerToken, dataToken, ghostEvents } = hiddenSetup();
    const sse = new Sse(await open(app, auth(viewerToken)));

    await ghostEvents(1, { status: "idle", label: "classified" });
    await post(app, dataToken, [
      { botId: "data", eventId: ulid(2), type: "status_changed", status: "idle" },
    ]);

    const frame = await sse.next();
    expect(frame.id).toBe("2");
    expect(frame.data).not.toContain("ghost");
    expect(frame.data).not.toContain("classified");
    await sse.cancel();
  });

  it("does not stream events that hand off to a hidden bot", async () => {
    const { app, viewerToken, dataToken, ghostEvents } = hiddenSetup();
    const sse = new Sse(await open(app, auth(viewerToken)));

    const res = await post(app, dataToken, [
      {
        botId: "data",
        eventId: ulid(1),
        type: "handoff_sent",
        to: "ghost",
        handoffId: "h1",
        label: "review",
      },
    ]);
    expect(res.status).toBe(200);
    await ghostEvents(2, { status: "idle" });
    await post(app, dataToken, [
      { botId: "data", eventId: ulid(3), type: "status_changed", status: "idle" },
    ]);

    const frame = await sse.next();
    expect(frame.id).toBe("3");
    expect(frame.data).not.toContain("ghost");
    await sse.cancel();
  });

  it("does not stream events a hidden bot receives, and skips its run on resume", async () => {
    const { app, viewerToken, dataToken, ghostEvents } = hiddenSetup();
    await post(app, dataToken, [
      { botId: "data", eventId: ulid(1), type: "status_changed", status: "idle" },
    ]);
    await ghostEvents(2, { status: "idle", to: "data" });
    await ghostEvents(3, { status: "idle", to: "data" });

    // Resuming after 1 skips the hidden run and picks up only the next visible event.
    const sse = new Sse(await open(app, { ...auth(viewerToken), "last-event-id": "1" }));
    await post(app, dataToken, [
      { botId: "data", eventId: ulid(4), type: "status_changed", status: "idle" },
    ]);

    const frame = await sse.next();
    expect(frame.id).toBe("4");
    expect(frame.data).not.toContain("ghost");
    await sse.cancel();
  });
});

describe("GET /api/stream keepalive", () => {
  it("does not leak the ping timer when the stream aborts before the open frame", async () => {
    vi.useFakeTimers();
    const { app, viewerToken, hub } = setup({ pingIntervalMs: 1000 });
    const res = await app.request("/api/stream", { headers: auth(viewerToken) });
    expect(res.status).toBe(200);

    // Cancel without reading: the opening write is still pending, so `stop()` runs
    // before the interval exists and must still be able to clear it.
    await res.body?.cancel();
    await Promise.resolve();
    await Promise.resolve();
    expect(hub.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pings with a bare event and no data of its own", async () => {
    const { app, viewerToken } = setup({ pingIntervalMs: 10 });
    const sse = new Sse(await open(app, auth(viewerToken)));

    const frame = await sse.next();
    expect(frame).toEqual({ event: "ping", data: "{}" });
    await sse.cancel();
  });

  it("ends a stream when its session is revoked", async () => {
    const { app, db, viewerToken, hub } = setup({ pingIntervalMs: 10 });
    const sse = new Sse(await open(app, { cookie: await sessionCookie(app, viewerToken) }));
    expect(hub.size()).toBe(1);

    db.prepare("update sessions set revoked_at = ?").run(new Date().toISOString());
    await sse.ended();
    expect(hub.size()).toBe(0);
  });

  it("ends a stream when its token is revoked", async () => {
    const { app, repo, viewerToken, hub } = setup({ pingIntervalMs: 10 });
    const token = repo.findTokenByHash((await import("../auth/tokens.ts")).hashToken(viewerToken));
    const sse = new Sse(await open(app, auth(viewerToken)));
    expect(hub.size()).toBe(1);

    repo.revokeToken(token?.id ?? "", new Date().toISOString());
    await sse.ended();
    expect(hub.size()).toBe(0);
  });

  it("ends a stream whose session went idle, and keeps a live one seen", async () => {
    const { app, db, viewerToken, hub } = setup({ pingIntervalMs: 10 });
    const cookie = await sessionCookie(app, viewerToken);

    const res = await open(app, { cookie });
    expect(res.status).toBe(200);
    expect(hub.size()).toBe(1);
    // The open refreshed last_seen_at; go stale now and let the next ping notice.
    db.prepare("update sessions set last_seen_at = ?").run("2000-01-01T00:00:00.000Z");

    const sse = new Sse(res);
    await sse.ended();
    expect(hub.size()).toBe(0);
  });

  it("refreshes last_seen_at on every ping", async () => {
    const { app, db, viewerToken } = setup({ pingIntervalMs: 10 });
    const sse = new Sse(await open(app, { cookie: await sessionCookie(app, viewerToken) }));
    const stale = new Date(Date.now() - 1_800_000).toISOString();
    db.prepare("update sessions set last_seen_at = ?").run(stale);

    await sse.next();
    const row = db.prepare("select last_seen_at from sessions").get() as {
      last_seen_at: string;
    };
    expect(Date.parse(row.last_seen_at)).toBeGreaterThan(Date.parse(stale));
    await sse.cancel();
  });

  it("does not rotate the cookie on an open stream", async () => {
    const { app, db, viewerToken } = setup();
    const cookie = await sessionCookie(app, viewerToken);
    // Older than the rotation age, still well inside the idle window.
    db.prepare("update sessions set created_at = ?").run("2000-01-01T00:00:00.000Z");

    const res = await open(app, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    await res.body?.cancel();
  });

  it("keeps an open stream alive after the cookie rotates, and ends it on revoke", async () => {
    const { app, db, viewerToken, hub } = setup({ pingIntervalMs: 15 });
    const cookie = await sessionCookie(app, viewerToken);
    const sse = new Sse(await open(app, { cookie }));
    expect(hub.size()).toBe(1);

    db.prepare("update sessions set created_at = ?").run(
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    const rotated = await app.request("/api/state", { headers: { cookie } });
    expect(rotated.status).toBe(200);
    expect(
      rotated.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`)),
    ).toBe(true);

    // A ping after the rotation must still arrive; re-checking the opening secret would end us.
    const frame = await sse.next();
    expect(frame).toEqual({ event: "ping", data: "{}" });
    expect(hub.size()).toBe(1);

    db.prepare("update sessions set revoked_at = ?").run(new Date().toISOString());
    await sse.ended();
    expect(hub.size()).toBe(0);
  });
});

describe("GET /api/stream lifecycle", () => {
  it("accepts the session cookie instead of the header", async () => {
    const { app, viewerToken, dataToken } = setup();
    const sse = new Sse(await open(app, { cookie: await sessionCookie(app, viewerToken) }));

    await post(app, dataToken, [
      { botId: "data", eventId: ulid(1), type: "status_changed", status: "idle" },
    ]);
    expect((await sse.next()).id).toBe("1");
    await sse.cancel();
  });

  it("unregisters an aborted stream", async () => {
    const { app, viewerToken, hub } = setup();
    const sse = new Sse(await open(app, auth(viewerToken)));
    expect(hub.size()).toBe(1);

    await sse.cancel();
    await until(() => hub.size() === 0);
  });

  it("caps concurrent streams", async () => {
    const { app, viewerToken } = setup({ maxClients: 1 });
    const sse = new Sse(await open(app, auth(viewerToken)));

    const res = await open(app, auth(viewerToken));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "too many streams" });
    await sse.cancel();
  });

  it("ends every stream on closeAll", async () => {
    const { app, viewerToken, hub } = setup();
    const first = new Sse(await open(app, auth(viewerToken)));
    const second = new Sse(await open(app, auth(viewerToken)));
    expect(hub.size()).toBe(2);

    hub.closeAll();
    await first.ended();
    await second.ended();
    expect(hub.size()).toBe(0);
  });
});
