import { afterEach, describe, expect, it } from "vitest";

import { StreamEvent } from "@grokbot-office/shared";

import { MAX_API_BODY_BYTES } from "../app.ts";
import { issueToken } from "../auth/tokens.ts";
import { NOW, TEST_ADMIN_TOKEN, botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

type App = ReturnType<typeof testSetup>["app"];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Event ids are ULIDs; a counter keeps them distinct and readable in assertions. */
const ulid = (n: number) => `01J${String(n).padStart(23, "0")}`;

function setup() {
  const context = testSetup();
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot(botRecord("wesley"));
  const token = (id: string) => issueToken(context.repo, { kind: "bot", botId: id }).token;
  return {
    ...context,
    dataToken: token("data"),
    wesleyToken: token("wesley"),
    viewerToken: issueToken(context.repo, { kind: "viewer" }).token,
  };
}

const post = (app: App, token: string | null, payload: unknown) =>
  app.request("/api/events", {
    method: "POST",
    headers: {
      ...(token === null ? {} : auth(token)),
      "content-type": "application/json",
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

type EventsPage = {
  events: StreamEvent[];
  nextSince: number;
  hasMore: boolean;
  lastSeq: number;
};

const getEvents = (app: App, token?: string, query = "") =>
  app.request(`/api/events${query}`, token === undefined ? {} : { headers: auth(token) });

const ev = (id: number, type: string, extra: Record<string, unknown> = {}) => ({
  botId: "data",
  eventId: ulid(id),
  type,
  ...extra,
});
const batch = (...events: object[]) => ({ events });

/** Geordi's repro: hidden `ghost` starts `classified` and hands `h-secret` to data. */
const ghost = (id: number, type: string, extra: Record<string, unknown> = {}) => ({
  ...ev(id, type, extra),
  botId: "ghost",
});
const SECRETS = ["ghost", "classified", "h-secret"];
const seqs = (body: EventsPage) => body.events.map((event) => event.seq);

function hiddenSetup() {
  const context = setup();
  context.repo.upsertBot({ ...botRecord("ghost"), hidden: true });
  // Hidden is display-only: the bot can still post. Direct repo calls keep this short.
  const ghostEvents = (...events: ReturnType<typeof ghost>[]) =>
    context.repo.applyEvents("ghost", events as never, NOW);
  return { ...context, ghostEvents };
}

describe("POST /api/events", () => {
  it("accepts a batch, stores the events and derives the status", async () => {
    const { app, repo, dataToken } = setup();
    repo.setBotStatus({
      botId: "data",
      status: "idle",
      label: null,
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      since: NOW,
      lastHeartbeatAt: NOW,
      lastEventSeq: null,
    });

    const res = await post(
      app,
      dataToken,
      batch(ev(1, "task_started", { taskId: "t1", label: "planning" })),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ accepted: 1, duplicates: 0, lastSeq: 1 });
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "working",
      taskId: "t1",
      label: "planning",
      lastEventSeq: 1,
    });
    const [row] = repo.listEventsSince(0);
    expect(row).toMatchObject({
      botId: "data",
      eventId: ulid(1),
      type: "task_started",
      taskId: "t1",
      label: "planning",
    });
    expect(row?.receivedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(row?.receivedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(NOW));
  });

  it("applies status_changed labels and task_finished results", async () => {
    const { app, repo, dataToken } = setup();

    await post(
      app,
      dataToken,
      batch(ev(1, "status_changed", { status: "reviewing", label: "reviewing plan" })),
    );
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "reviewing",
      label: "reviewing plan",
    });

    await post(app, dataToken, batch(ev(2, "task_started", { taskId: "t1", label: "planning" })));
    await post(app, dataToken, batch(ev(3, "task_finished", { result: "done" })));

    // Finishing clears the task and the label: neither describes the bot any more.
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "idle",
      taskId: null,
      label: null,
    });
    const rows = repo.listEventsSince(0);
    expect(rows[0]).toMatchObject({ type: "status_changed", status: "reviewing" });
    expect(rows[2]).toMatchObject({ type: "task_finished", result: "done", taskId: null });
  });

  it("turns handoff_sent into waiting and handoff_accepted into working", async () => {
    const { app, repo, dataToken, wesleyToken } = setup();

    const sent = await post(
      app,
      dataToken,
      batch(ev(1, "handoff_sent", { to: "wesley", handoffId: "h1", label: "plan" })),
    );
    expect(sent.status).toBe(200);
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "waiting",
      handoffTo: "wesley",
      taskId: null,
    });
    expect(repo.getHandoff("h1")).toMatchObject({
      fromBotId: "data",
      toBotId: "wesley",
      label: "plan",
      state: "sent",
      acceptedAt: null,
    });

    const accepted = await post(
      app,
      wesleyToken,
      batch({ botId: "wesley", eventId: ulid(2), type: "handoff_accepted", handoffId: "h1" }),
    );
    expect(accepted.status).toBe(200);
    expect(repo.getHandoff("h1")).toMatchObject({ state: "accepted" });
    expect(repo.getHandoff("h1")?.acceptedAt).toMatch(/^\d{4}-/);
    expect(repo.getBotStatus("wesley")).toMatchObject({
      status: "working",
      label: "plan",
      handoffTo: null,
    });
    // The sender was only waiting for this.
    expect(repo.getBotStatus("data")).toMatchObject({ status: "idle", handoffTo: null });

    // A second acceptance with a new event id is another no-op, not an error.
    const again = await post(
      app,
      wesleyToken,
      batch({ botId: "wesley", eventId: ulid(3), type: "handoff_accepted", handoffId: "h1" }),
    );
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ accepted: 1, duplicates: 0, lastSeq: 3 });
  });

  it("moves the receiver onto the handed-off task, replacing its old one", async () => {
    const { app, repo, dataToken, wesleyToken } = setup();
    await post(
      app,
      wesleyToken,
      batch({ botId: "wesley", eventId: ulid(1), type: "task_started", taskId: "old" }),
    );
    await post(app, dataToken, batch(ev(2, "handoff_sent", { to: "wesley", handoffId: "h2" })));
    const res = await post(
      app,
      wesleyToken,
      batch({
        botId: "wesley",
        eventId: ulid(3),
        type: "handoff_accepted",
        handoffId: "h2",
        taskId: "review-h2",
      }),
    );
    expect(res.status).toBe(200);
    expect(repo.getBotStatus("wesley")).toMatchObject({ status: "working", taskId: "review-h2" });
  });

  it("releases task and handoff links when status_changed brings a bot to rest", async () => {
    const { app, repo, dataToken } = setup();
    await post(app, dataToken, batch(ev(1, "task_started", { taskId: "t1", label: "Plan" })));
    await post(app, dataToken, batch(ev(2, "status_changed", { status: "idle" })));
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "idle",
      taskId: null,
      label: null,
      handoffTo: null,
      handoffId: null,
    });

    await post(app, dataToken, batch(ev(3, "handoff_sent", { to: "wesley", handoffId: "h9" })));
    expect(repo.getBotStatus("data")).toMatchObject({ status: "waiting", handoffId: "h9" });
    await post(
      app,
      dataToken,
      batch(ev(4, "status_changed", { status: "offline", label: "Signed off" })),
    );
    // Links are released; an explicit label on the same event still applies.
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "offline",
      label: "Signed off",
      handoffTo: null,
      handoffId: null,
    });
  });

  it("frees the sender only when the handoff it waits on is accepted (side-handoff repro)", async () => {
    const { app, repo, dataToken, wesleyToken } = setup();
    // Sender works on t-primary, sends a side handoff (stays working), then hands off t-primary.
    await post(app, dataToken, batch(ev(1, "task_started", { taskId: "t-primary" })));
    await post(app, dataToken, batch(ev(2, "handoff_sent", { to: "wesley", handoffId: "h-side" })));
    expect(repo.getBotStatus("data")).toMatchObject({ status: "working", taskId: "t-primary" });
    await post(
      app,
      dataToken,
      batch(ev(3, "handoff_sent", { to: "wesley", handoffId: "h-primary", taskId: "t-primary" })),
    );
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "waiting",
      handoffTo: "wesley",
      handoffId: "h-primary",
    });

    // B accepts the side handoff: the sender keeps waiting, h-primary is still sent.
    const side = await post(
      app,
      wesleyToken,
      batch({ botId: "wesley", eventId: ulid(4), type: "handoff_accepted", handoffId: "h-side" }),
    );
    expect(side.status).toBe(200);
    expect(repo.getHandoff("h-primary")?.state).toBe("sent");
    expect(repo.getBotStatus("data")).toMatchObject({ status: "waiting", handoffId: "h-primary" });

    // B accepts h-primary: now the sender is free.
    await post(
      app,
      wesleyToken,
      batch({
        botId: "wesley",
        eventId: ulid(5),
        type: "handoff_accepted",
        handoffId: "h-primary",
      }),
    );
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "idle",
      taskId: null,
      label: null,
      handoffTo: null,
      handoffId: null,
    });
  });

  it("records task_finished for another task without wiping the current work", async () => {
    const { app, repo, dataToken } = setup();
    await post(app, dataToken, batch(ev(1, "task_started", { taskId: "t1", label: "Plan" })));
    const res = await post(
      app,
      dataToken,
      batch(ev(2, "task_finished", { taskId: "t-other", result: "done" })),
    );
    await expect(res.json()).resolves.toMatchObject({ accepted: 1 });
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "working",
      taskId: "t1",
      label: "Plan",
    });
    expect(repo.listEventsSince(0).map((event) => event.type)).toEqual([
      "task_started",
      "task_finished",
    ]);

    // The matching id, or no id at all, finishes the current task.
    await post(app, dataToken, batch(ev(3, "task_finished", { taskId: "t1", result: "done" })));
    expect(repo.getBotStatus("data")).toMatchObject({ status: "idle", taskId: null, label: null });
    await post(app, dataToken, batch(ev(4, "task_started", { taskId: "t2" })));
    await post(app, dataToken, batch(ev(5, "task_finished", { result: "cancelled" })));
    expect(repo.getBotStatus("data")).toMatchObject({ status: "idle", taskId: null });
  });

  it("keeps the sender working while another task is still open", async () => {
    const { app, repo, dataToken } = setup();
    await post(app, dataToken, batch(ev(1, "task_started", { taskId: "t1" })));
    await post(
      app,
      dataToken,
      batch(ev(2, "handoff_sent", { to: "wesley", handoffId: "h1", taskId: "t2" })),
    );
    expect(repo.getBotStatus("data")).toMatchObject({ status: "working", taskId: "t1" });

    // Handing off the task it is actually working on does release the bot.
    await post(
      app,
      dataToken,
      batch(ev(3, "handoff_sent", { to: "wesley", handoffId: "h2", taskId: "t1" })),
    );
    expect(repo.getBotStatus("data")).toMatchObject({ status: "waiting", taskId: null });
  });

  it("counts duplicates without repeating their side effects", async () => {
    const { app, repo, dataToken } = setup();
    const events = batch(
      ev(1, "task_started", { taskId: "t1" }),
      ev(2, "task_finished", { result: "done" }),
    );
    const first = await post(app, dataToken, events);
    await expect(first.json()).resolves.toEqual({ accepted: 2, duplicates: 0, lastSeq: 2 });

    const replay = await post(app, dataToken, events);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ accepted: 0, duplicates: 2, lastSeq: 2 });
    expect(repo.listEventsSince(0)).toHaveLength(2);
  });

  it("clamps the client clock to ±10 minutes and stamps one server time per batch", async () => {
    const { app, repo, dataToken } = setup();
    const res = await post(
      app,
      dataToken,
      batch(
        ev(1, "status_changed", { status: "working", at: "2020-01-01T00:00:00.000Z" }),
        ev(2, "status_changed", { status: "idle", at: "2030-01-01T00:00:00.000Z" }),
        ev(3, "status_changed", { status: "reviewing" }),
      ),
    );
    expect(res.status).toBe(200);

    const rows = repo.listEventsSince(0);
    const received = Date.parse(rows[0]?.receivedAt ?? "");
    expect(Date.parse(rows[0]?.clientAt ?? "")).toBe(received - 10 * 60 * 1000);
    expect(Date.parse(rows[1]?.clientAt ?? "")).toBe(received + 10 * 60 * 1000);
    expect(rows[2]?.clientAt).toBeNull();
    expect(new Set(rows.map((row) => row.receivedAt))).toEqual(new Set([rows[0]?.receivedAt]));
  });

  it("treats any batch as a heartbeat, including one that was entirely duplicates", async () => {
    const { app, repo, dataToken } = setup();
    const events = batch(ev(1, "task_started", { taskId: "t1" }));
    await post(app, dataToken, events);

    const old = "2026-01-01T00:00:00.000Z";
    repo.setBotStatus({ ...repo.getBotStatus("data")!, lastHeartbeatAt: old });
    await post(app, dataToken, events);

    expect(repo.getBotStatus("data")?.lastHeartbeatAt).not.toBe(old);
  });

  describe("rejected events", () => {
    it("rolls the batch back for a handoff to itself or an unknown bot", async () => {
      const { app, repo, dataToken } = setup();
      for (const to of ["data", "nobody"]) {
        const res = await post(
          app,
          dataToken,
          batch(ev(1, "handoff_sent", { to, handoffId: "h1" })),
        );
        expect(res.status).toBe(422);
        await expect(res.json()).resolves.toEqual({ error: "invalid event", index: 0 });
      }
      expect(repo.listEventsSince(0)).toEqual([]);
      expect(repo.getBotStatus("data")).toBeUndefined();
    });

    it("rolls the batch back for a handoff not addressed to the receiver", async () => {
      const { app, repo, dataToken } = setup();
      await post(app, dataToken, batch(ev(1, "handoff_sent", { to: "wesley", handoffId: "h1" })));

      const res = await post(
        app,
        dataToken,
        batch(
          ev(2, "task_started", { taskId: "t1" }),
          ev(3, "handoff_accepted", { handoffId: "h1" }),
        ),
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toEqual({ error: "invalid event", index: 1 });
      // The plausible task_started in the same batch rolled back too.
      expect(repo.getBotStatus("data")?.taskId).toBeNull();
      expect(repo.listEventsSince(0)).toHaveLength(1);
    });

    it("rolls the batch back for a reused handoff id", async () => {
      const { app, repo, dataToken } = setup();
      await post(app, dataToken, batch(ev(1, "handoff_sent", { to: "wesley", handoffId: "h1" })));

      const res = await post(
        app,
        dataToken,
        batch(ev(2, "handoff_sent", { to: "wesley", handoffId: "h1" })),
      );
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toEqual({ error: "invalid event", index: 0 });
      expect(repo.listEventsSince(0)).toHaveLength(1);
    });
  });

  describe("auth", () => {
    it("refuses anonymous and viewer tokens generically", async () => {
      const { app, viewerToken } = setup();
      const anonymous = await post(app, null, batch(ev(1, "task_started")));
      expect(anonymous.status).toBe(401);
      await expect(anonymous.json()).resolves.toEqual({ error: "unauthorized" });

      const viewer = await post(app, viewerToken, batch(ev(1, "task_started")));
      expect(viewer.status).toBe(403);
      await expect(viewer.json()).resolves.toEqual({ error: "forbidden" });
    });

    it("refuses events for another bot", async () => {
      const { app, repo, wesleyToken } = setup();
      const res = await post(app, wesleyToken, batch(ev(1, "task_started")));
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "forbidden" });
      expect(repo.listEventsSince(0)).toEqual([]);
    });
  });

  describe("validation", () => {
    const twentyOne = Array.from({ length: 21 }, (_, index) => ev(index, "task_started"));
    const cases: [string, unknown][] = [
      ["an empty batch", batch()],
      ["more than 20 events", batch(...twentyOne)],
      ["an unknown type", batch(ev(1, "offline"))],
      ["a server-only type", batch(ev(1, "bot_registered"))],
      ["an unknown event key", batch(ev(1, "task_started", { extra: true }))],
      ["an unknown batch key", { events: [ev(1, "task_started")], extra: true }],
      ["a control character in a task id", batch(ev(1, "task_started", { taskId: "t\u200B1" }))],
      ["an event id that is not a ULID", batch({ ...ev(1, "task_started"), eventId: " e1" })],
      ["an event for a malformed bot id", batch({ ...ev(1, "task_started"), botId: "Data" })],
    ];

    for (const [name, payload] of cases) {
      it(`answers 400 for ${name}`, async () => {
        const { app, dataToken } = setup();
        const res = await post(app, dataToken, payload);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "invalid body" });
      });
    }

    it("answers 400 for a body that is not JSON", async () => {
      const { app, dataToken } = setup();
      const res = await post(app, dataToken, "{");
      expect(res.status).toBe(400);
    });

    it("answers 413 above the body cap", async () => {
      const { app, dataToken } = setup();
      const res = await post(app, dataToken, "x".repeat(MAX_API_BODY_BYTES + 1));
      expect(res.status).toBe(413);
    });
  });
});

describe("GET /api/events", () => {
  it("returns the log in seq order, mapped to StreamEvent", async () => {
    const { app, dataToken, viewerToken } = setup();
    await post(
      app,
      dataToken,
      batch(
        ev(1, "status_changed", { status: "working", label: "coding" }),
        ev(2, "handoff_sent", { to: "wesley", handoffId: "h1", label: "review" }),
      ),
    );

    const res = await getEvents(app, viewerToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as EventsPage;
    expect(body).toMatchObject({ nextSince: 2, hasMore: false, lastSeq: 2 });
    expect(body.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);
    expect(body.events[0]).toMatchObject({
      botId: "data",
      type: "status_changed",
      status: "working",
      label: "coding",
    });
    expect(body.events[1]).toMatchObject({
      type: "handoff_sent",
      to: "wesley",
      handoffId: "h1",
      label: "review",
    });
    for (const event of body.events) {
      expect(() => StreamEvent.parse(event)).not.toThrow();
    }
  });

  it("maps the task result and the clamped client time", async () => {
    const { app, repo, dataToken, viewerToken } = setup();
    await post(
      app,
      dataToken,
      batch(ev(1, "task_finished", { result: "failed", at: "2020-01-01T00:00:00.000Z" })),
    );

    const body = (await (await getEvents(app, viewerToken)).json()) as EventsPage;
    const [event] = body.events;
    expect(event).toMatchObject({ botId: "data", type: "task_finished", result: "failed" });
    expect(() => StreamEvent.parse(event)).not.toThrow();
    expect(event).not.toHaveProperty("status");
    expect(event).not.toHaveProperty("handoffId");

    const row = repo.listEventsSince(0)[0];
    expect(event.at).toBe(row?.clientAt);
    expect(Date.parse(event.at ?? "") - Date.parse(event.receivedAt)).toBe(-10 * 60 * 1000);
  });

  it("defaults to 100 events", async () => {
    const { app, dataToken, viewerToken } = setup();
    for (let start = 1; start <= 101; start += 20) {
      const size = Math.min(20, 102 - start);
      const events = Array.from({ length: size }, (_, index) =>
        ev(start + index, "status_changed", { status: "working" }),
      );
      expect((await post(app, dataToken, batch(...events))).status).toBe(200);
    }

    const body = (await (await getEvents(app, viewerToken)).json()) as EventsPage;
    expect(body.events).toHaveLength(100);
    expect(body).toMatchObject({ nextSince: 100, hasMore: true, lastSeq: 101 });
  });

  it("pages by since and limit, and turns hasMore off on the last page", async () => {
    const { app, dataToken, viewerToken } = setup();
    await post(
      app,
      dataToken,
      batch(
        ev(1, "status_changed", { status: "working" }),
        ev(2, "status_changed", { status: "idle" }),
        ev(3, "status_changed", { status: "working" }),
        ev(4, "status_changed", { status: "idle" }),
      ),
    );

    const first = (await (await getEvents(app, viewerToken, "?limit=2")).json()) as EventsPage;
    expect(first.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextSince: 2, hasMore: true, lastSeq: 4 });

    const second = (await (
      await getEvents(app, viewerToken, `?since=${first.nextSince}&limit=2`)
    ).json()) as EventsPage;
    expect(second.events.map((event: { seq: number }) => event.seq)).toEqual([3, 4]);
    expect(second).toMatchObject({ nextSince: 4, hasMore: false, lastSeq: 4 });

    const beyond = await (await getEvents(app, viewerToken, "?since=999")).json();
    // Clamped like the stream cursor: the client goes live at the high-water mark.
    expect(beyond).toEqual({ events: [], nextSince: 4, hasMore: false, lastSeq: 4 });
  });

  it("clamps a `since` past the newest event to the high-water mark", async () => {
    const { app, dataToken, viewerToken } = setup();
    await post(
      app,
      dataToken,
      batch(
        ev(1, "status_changed", { status: "working" }),
        ev(2, "status_changed", { status: "idle" }),
      ),
    );

    const body = (await (await getEvents(app, viewerToken, "?since=99999")).json()) as EventsPage;
    expect(body).toEqual({ events: [], nextSince: 2, hasMore: false, lastSeq: 2 });
  });

  describe("hidden bots", () => {
    it("leaves out events by a hidden bot and handoffs addressed to one", async () => {
      const { app, dataToken, viewerToken, ghostEvents } = hiddenSetup();
      expect(
        (await post(app, dataToken, batch(ev(1, "task_started", { taskId: "t-1" })))).status,
      ).toBe(200);
      ghostEvents(
        ghost(2, "task_started", { taskId: "classified", label: "classified" }),
        ghost(3, "handoff_sent", { to: "data", handoffId: "h-secret", taskId: "classified" }),
      );
      const toGhost = ev(4, "handoff_sent", { to: "ghost", handoffId: "h-in" });
      expect((await post(app, dataToken, batch(toGhost))).status).toBe(200);
      const after = ev(5, "status_changed", { status: "working" });
      expect((await post(app, dataToken, batch(after))).status).toBe(200);

      const res = await getEvents(app, viewerToken);
      const text = await res.text();
      const body = JSON.parse(text) as EventsPage;
      expect(body.events.map((event) => event.seq)).toEqual([1, 5]);
      for (const secret of [...SECRETS, "h-in"]) expect(text).not.toContain(secret);
      // The high-water mark stays global; seq paging already tolerates gaps.
      expect(body).toMatchObject({ nextSince: 5, hasMore: false, lastSeq: 5 });
    });

    it("pages past runs of hidden events without stalling", async () => {
      const { app, dataToken, viewerToken, ghostEvents } = hiddenSetup();
      await post(app, dataToken, batch(ev(1, "status_changed", { status: "working" })));
      ghostEvents(...[2, 3, 4, 5, 6].map((n) => ghost(n, "status_changed", { status: "idle" })));
      await post(app, dataToken, batch(ev(7, "status_changed", { status: "idle" })));
      await post(app, dataToken, batch(ev(8, "status_changed", { status: "working" })));

      const page = async (query: string) =>
        (await (await getEvents(app, viewerToken, query)).json()) as EventsPage;

      const first = await page("?limit=1");
      expect([seqs(first), first]).toMatchObject([[1], { nextSince: 1, hasMore: true }]);
      // A whole page's worth of hidden rows sits between 1 and 7: skipped, not returned.
      const second = await page(`?since=${first.nextSince}&limit=1`);
      expect([seqs(second), second]).toMatchObject([[7], { nextSince: 7, hasMore: true }]);
      const third = await page(`?since=${second.nextSince}&limit=1`);
      expect([seqs(third), third]).toMatchObject([[8], { nextSince: 8, hasMore: false }]);
    });

    it("moves the cursor to lastSeq when only hidden events remain", async () => {
      const { app, dataToken, viewerToken, ghostEvents } = hiddenSetup();
      await post(app, dataToken, batch(ev(1, "status_changed", { status: "working" })));
      ghostEvents(...[2, 3, 4].map((n) => ghost(n, "status_changed", { status: "idle" })));

      const body = (await (
        await getEvents(app, viewerToken, "?since=1&limit=2")
      ).json()) as EventsPage;
      expect(body).toEqual({ events: [], nextSince: 4, hasMore: false, lastSeq: 4 });

      // The next visible event is found from there.
      await post(app, dataToken, batch(ev(5, "status_changed", { status: "idle" })));
      const next = (await (
        await getEvents(app, viewerToken, `?since=${body.nextSince}`)
      ).json()) as EventsPage;
      expect(next.events.map((event) => event.seq)).toEqual([5]);
    });

    it("shows the history again once the bot is un-hidden", async () => {
      const { app, repo, viewerToken, ghostEvents } = hiddenSetup();
      ghostEvents(ghost(1, "task_started", { taskId: "classified" }));
      repo.updateBot("ghost", { hidden: false });
      const body = (await (await getEvents(app, viewerToken)).json()) as EventsPage;
      expect(body.events.map((event) => event.botId)).toEqual(["ghost"]);
    });
  });

  it("returns an empty, resumable page on an empty database", async () => {
    const { app, viewerToken } = setup();
    const body = await (await getEvents(app, viewerToken)).json();
    expect(body).toEqual({ events: [], nextSince: 0, hasMore: false, lastSeq: 0 });
  });

  describe("invalid query", () => {
    const cases = [
      "since=-1",
      "since=1.5",
      "since=abc",
      "since=",
      "limit=0",
      "limit=501",
      "limit=",
      "unknown=1",
      "since=1&since=2",
      "limit=1&limit=2",
      "since=00",
      "since=01",
      "limit=03",
    ];

    for (const query of cases) {
      it(`answers 400 for ?${query}`, async () => {
        const { app, viewerToken } = setup();
        const res = await getEvents(app, viewerToken, `?${query}`);
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "invalid query" });
      });
    }
  });

  describe("auth", () => {
    it("accepts viewer and admin tokens and rejects bot tokens with 403", async () => {
      const { app, repo, dataToken, viewerToken } = setup();
      const revoked = issueToken(repo, { kind: "viewer" });
      repo.revokeToken(revoked.id, NOW);

      for (const token of [undefined, "unknown-token-value", revoked.token]) {
        const res = await getEvents(app, token);
        expect(res.status).toBe(401);
        await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
      }

      const malformed = await app.request("/api/events", {
        headers: { authorization: "Basic abc" },
      });
      expect(malformed.status).toBe(401);

      const bot = await getEvents(app, dataToken);
      expect(bot.status).toBe(403);
      await expect(bot.json()).resolves.toEqual({ error: "forbidden" });

      expect((await getEvents(app, viewerToken)).status).toBe(200);
      expect((await getEvents(app, TEST_ADMIN_TOKEN)).status).toBe(200);
    });

    it("ignores an admin token the env does not make usable", async () => {
      const context = testSetup({ adminToken: "short" });
      cleanups.push(context.close);
      const viewer = issueToken(context.repo, { kind: "viewer" });
      expect((await getEvents(context.app, TEST_ADMIN_TOKEN)).status).toBe(401);
      expect((await getEvents(context.app, "short")).status).toBe(401);
      expect((await getEvents(context.app, viewer.token)).status).toBe(200);
    });
  });
});
