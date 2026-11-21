import { afterEach, describe, expect, it, vi } from "vitest";

import { issueToken } from "./auth/tokens.ts";
import { NOW, Sse, botRecord, testSetup } from "./test-utils.ts";
import {
  pruneRetention,
  RETENTION_INTERVAL_MS,
  startHeartbeatSweeper,
  startRetentionPrune,
  SWEEP_INTERVAL_MS,
  sweepStaleBots,
} from "./jobs.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) close();
});

/** Two days before `NOW`: past the 300 s timeout and past the one-day away window. */
const STALE = "2025-12-30T00:00:00.000Z";
const timeoutSec = 300;
const awaySec = 86_400;

const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;

function setup() {
  const context = testSetup();
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot(botRecord("wesley"));
  // Frozen clock: the injectable jobs default to `nowUtc()`.
  vi.useFakeTimers({ now: new Date(NOW) });
  return context;
}

const working = (repo: ReturnType<typeof setup>["repo"], lastHeartbeatAt = STALE) =>
  repo.setBotStatus({
    botId: "data",
    status: "working",
    label: "plan",
    taskId: "t-1",
    handoffTo: "wesley",
    handoffId: null,
    labelHandoffId: null,
    since: STALE,
    lastHeartbeatAt,
    lastEventSeq: null,
  });

const offlineEvents = (repo: ReturnType<typeof setup>["repo"]) =>
  repo.getEventsPage(0, 50).rows.filter((row) => row.type === "offline");

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const heartbeat = (
  app: ReturnType<typeof setup>["app"],
  id: string,
  token: string,
  payload?: unknown,
) =>
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

const register = (
  app: ReturnType<typeof setup>["app"],
  token: string,
  payload: Record<string, unknown>,
) =>
  app.request("/api/bots/register", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

const snapshotBot = async (app: ReturnType<typeof setup>["app"], token: string, id: string) => {
  const body = (await (await app.request("/api/state", { headers: auth(token) })).json()) as {
    bots: { id: string; status: string; since: string }[];
  };
  return body.bots.find((bot) => bot.id === id);
};

const PROFILE = {
  id: "data",
  name: "Data",
  role: "worker",
  avatar: "robot",
  pod: "dev" as const,
};

describe("heartbeat sweeper", () => {
  it("takes a stale working bot offline once, clears its links and notifies", async () => {
    const { repo, hub } = setup();
    working(repo);
    const notify = vi.spyOn(hub, "notify");
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec, awaySec });

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

    const status = repo.getBotStatus("data");
    expect(status).toMatchObject({
      status: "offline",
      label: null,
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      // The missed heartbeat is the point: only `since` moves.
      lastHeartbeatAt: STALE,
      since: at(SWEEP_INTERVAL_MS),
    });
    const events = offlineEvents(repo);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ botId: "data", type: "offline", status: "offline" });
    expect(events[0].eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(notify).toHaveBeenCalledTimes(1);

    // Already offline: no second event, no `since` rewrite.
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(offlineEvents(repo)).toHaveLength(1);
    expect(repo.getBotStatus("data")?.since).toBe(at(SWEEP_INTERVAL_MS));
    expect(notify).toHaveBeenCalledTimes(1);
    stop();
  });

  it("leaves a bot that heartbeats inside the timeout alone", async () => {
    const { repo, hub } = setup();
    working(repo, at(-60_000));
    const notify = vi.spyOn(hub, "notify");
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec, awaySec });

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

    expect(repo.getBotStatus("data")).toMatchObject({
      status: "working",
      label: "plan",
      taskId: "t-1",
      handoffTo: "wesley",
      lastHeartbeatAt: at(-60_000),
    });
    expect(offlineEvents(repo)).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    stop();
  });

  it("leaves a stale bot that is already offline alone", async () => {
    const { repo, hub } = setup();
    repo.setBotStatus({
      botId: "data",
      status: "offline",
      label: null,
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      since: STALE,
      lastHeartbeatAt: STALE,
      lastEventSeq: null,
    });
    const notify = vi.spyOn(hub, "notify");
    const refresh = vi.spyOn(hub, "refresh");

    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec })).toMatchObject({
      swept: 0,
      away: new Set(),
    });
    expect(offlineEvents(repo)).toEqual([]);
    expect(repo.getBotStatus("data")?.since).toBe(STALE);
    expect(notify).not.toHaveBeenCalled();
    // An explicit offline is not overwritten with away.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("only sweeps bots with a status row", () => {
    const { repo, hub } = setup();
    // `wesley` has a bot row but no `bot_status`: not yet online, never invented.
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec })).toMatchObject({
      swept: 0,
      away: new Set(),
    });
    expect(repo.getBotStatus("wesley")).toBeUndefined();
  });

  it("sends the offline event to an SSE client", async () => {
    const { app, repo, hub } = setup();
    const viewerToken = issueToken(repo, { kind: "viewer" }).token;
    working(repo);
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec, awaySec });

    const sse = new Sse(
      await app.request("/api/stream", { headers: { authorization: `Bearer ${viewerToken}` } }),
    );
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

    const frame = await sse.next();
    expect(frame.event).toBe("event");
    expect(JSON.parse(frame.data)).toMatchObject({
      botId: "data",
      type: "offline",
      status: "offline",
    });
    await sse.cancel();
    stop();
  });

  it("does not write away: a quiet bot keeps its stored activity and links", () => {
    const { repo, hub } = setup();
    working(repo, at(-10 * 60_000));
    const refresh = vi.spyOn(hub, "refresh");
    const notify = vi.spyOn(hub, "notify");

    const result = sweepStaleBots({ repo, hub, timeoutSec, awaySec });

    expect(result).toEqual({ swept: 0, away: new Set(["data"]) });
    expect(offlineEvents(repo)).toEqual([]);
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "working",
      label: "plan",
      taskId: "t-1",
      lastHeartbeatAt: at(-10 * 60_000),
    });
    expect(notify).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The same away set on the next tick is not another refresh.
    const again = sweepStaleBots({ repo, hub, timeoutSec, awaySec, previousAway: result.away });
    expect(again.away).toEqual(new Set(["data"]));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("puts a bot at exactly the timeout inside, and one millisecond past it away", () => {
    const { repo, hub } = setup();
    working(repo, at(-timeoutSec * 1000));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec }).away).toEqual(new Set());

    working(repo, at(-timeoutSec * 1000 - 1));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec }).away).toEqual(new Set(["data"]));
  });

  it("goes offline only past the away window", () => {
    const { repo, hub } = setup();
    // The sweeper compares with `<`, so the edge itself is still away, not offline.
    working(repo, at(-awaySec * 1000));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec })).toEqual({
      swept: 0,
      away: new Set(["data"]),
    });

    working(repo, at(-awaySec * 1000 - 1));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec })).toEqual({
      swept: 1,
      away: new Set(),
    });
    expect(offlineEvents(repo)).toHaveLength(1);
    expect(repo.getBotStatus("data")?.status).toBe("offline");
  });

  it("refreshes open streams once when a bot becomes away", async () => {
    const { repo, hub } = setup();
    working(repo, at(-10 * 60_000));
    const refresh = vi.spyOn(hub, "refresh");
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec, awaySec });

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("clears its interval on stop", () => {
    const { repo, hub } = setup();
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec, awaySec });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

async function sweepData(context: ReturnType<typeof setup>) {
  working(context.repo);
  const token = issueToken(context.repo, { kind: "bot", botId: "data" }).token;
  const viewerToken = issueToken(context.repo, { kind: "viewer" }).token;
  const stop = startHeartbeatSweeper({
    repo: context.repo,
    hub: context.hub,
    timeoutSec,
    awaySec,
  });
  await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
  expect(context.repo.getBotStatus("data")?.status).toBe("offline");
  return { token, viewerToken, stop };
}

describe("coming back online after a sweep", () => {
  it("brings the bot back with an empty heartbeat: snapshot and an SSE frame", async () => {
    const context = setup();
    const { app, repo, hub } = context;
    const { token, viewerToken, stop } = await sweepData(context);
    const notify = vi.spyOn(hub, "notify");

    const sse = new Sse(await app.request("/api/stream", { headers: auth(viewerToken) }));
    expect((await heartbeat(app, "data", token)).status).toBe(204);

    expect(repo.getBotStatus("data")).toMatchObject({
      status: "idle",
      since: at(SWEEP_INTERVAL_MS),
    });
    const snap = await snapshotBot(app, viewerToken, "data");
    expect(snap).toMatchObject({ id: "data", status: "idle" });

    const frame = await sse.next();
    expect(frame.event).toBe("event");
    expect(JSON.parse(frame.data)).toMatchObject({
      botId: "data",
      type: "status_changed",
      status: "idle",
    });
    expect(notify).toHaveBeenCalled();
    await sse.cancel();
    stop();
  });

  it("shows away with lastSeenAt, and a heartbeat restores the stored activity", async () => {
    const context = setup();
    const { app, repo } = context;
    const quiet = at(-10 * 60_000);
    working(repo, quiet);
    const token = issueToken(repo, { kind: "bot", botId: "data" }).token;
    const viewerToken = issueToken(repo, { kind: "viewer" }).token;

    expect(await snapshotBot(app, viewerToken, "data")).toMatchObject({
      status: "away",
      label: "plan",
      taskId: "t-1",
      lastSeenAt: quiet,
      lastHeartbeatAt: quiet,
    });
    // Nothing was written: the row still holds the activity.
    expect(repo.getBotStatus("data")?.status).toBe("working");

    expect((await heartbeat(app, "data", token)).status).toBe(204);
    expect(await snapshotBot(app, viewerToken, "data")).toMatchObject({
      status: "working",
      label: "plan",
      lastSeenAt: at(0),
    });
    expect(repo.getEventsPage(0, 50).rows.filter((row) => row.type === "status_changed")).toEqual(
      [],
    );
  });

  it("emits a status_changed event for a heartbeat with status idle after a sweep", async () => {
    const context = setup();
    const { app, repo } = context;
    const { token, stop } = await sweepData(context);

    expect((await heartbeat(app, "data", token, { status: "idle" })).status).toBe(204);
    expect(repo.getBotStatus("data")?.status).toBe("idle");
    const online = repo
      .getEventsPage(0, 50)
      .rows.filter((row) => row.type === "status_changed" && row.status === "idle");
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({ botId: "data", type: "status_changed", status: "idle" });
    stop();
  });

  it("resets an offline bot to idle on re-register", async () => {
    const context = setup();
    const { app, repo } = context;
    const { token, viewerToken, stop } = await sweepData(context);
    const sinceOffline = repo.getBotStatus("data")?.since;
    await vi.advanceTimersByTimeAsync(1000);

    expect((await register(app, token, PROFILE)).status).toBe(200);
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "idle",
      since: at(SWEEP_INTERVAL_MS + 1000),
    });
    expect(sinceOffline).toBe(at(SWEEP_INTERVAL_MS));
    expect(await snapshotBot(app, viewerToken, "data")).toMatchObject({
      id: "data",
      status: "idle",
    });
    const online = repo
      .getEventsPage(0, 50)
      .rows.filter((row) => row.type === "status_changed" && row.botId === "data");
    expect(online).toHaveLength(1);
    expect(online[0].status).toBe("idle");
    stop();
  });

  it("emits no extra event for a heartbeat on an already-online bot", async () => {
    const context = setup();
    const { app, repo, hub } = context;
    const { token, stop } = await sweepData(context);
    await heartbeat(app, "data", token);
    expect(
      repo.getEventsPage(0, 50).rows.filter((row) => row.type === "status_changed"),
    ).toHaveLength(1);

    const notify = vi.spyOn(hub, "notify");
    const before = repo.lastEventSeq();
    expect((await heartbeat(app, "data", token)).status).toBe(204);
    expect((await heartbeat(app, "data", token, { status: "idle" })).status).toBe(204);
    expect(repo.getBotStatus("data")?.status).toBe("idle");
    expect(repo.lastEventSeq()).toBe(before);
    expect(
      repo.getEventsPage(0, 50).rows.filter((row) => row.type === "status_changed"),
    ).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    stop();
  });

  it("hides a hidden bot's come-back event from viewers", async () => {
    const context = setup();
    const { app, repo } = context;
    repo.upsertBot({ ...botRecord("ghost"), hidden: true });
    repo.setBotStatus({
      botId: "ghost",
      status: "working",
      label: "secret",
      taskId: "t-hidden",
      handoffTo: null,
      handoffId: null,
      labelHandoffId: null,
      since: STALE,
      lastHeartbeatAt: STALE,
      lastEventSeq: null,
    });
    const ghostToken = issueToken(repo, { kind: "bot", botId: "ghost" }).token;
    const { token, viewerToken, stop } = await sweepData(context);
    expect(repo.getBotStatus("ghost")?.status).toBe("offline");

    const sse = new Sse(await app.request("/api/stream", { headers: auth(viewerToken) }));
    expect((await heartbeat(app, "ghost", ghostToken)).status).toBe(204);
    expect(repo.getBotStatus("ghost")?.status).toBe("idle");
    const page = repo.getEventsPage(0, 50).rows;
    expect(page.filter((row) => row.botId === "ghost")).toEqual([]);
    expect(await snapshotBot(app, viewerToken, "ghost")).toBeUndefined();

    expect((await heartbeat(app, "data", token)).status).toBe(204);
    const frame = await sse.next();
    expect(JSON.parse(frame.data)).toMatchObject({
      botId: "data",
      type: "status_changed",
      status: "idle",
    });
    await sse.cancel();
    stop();
  });
});

/** One old + one new event per bot, plus handoffs in every state. */
function aged(repo: ReturnType<typeof setup>["repo"]) {
  repo.createHandoff({
    id: "h-old-accepted",
    fromBotId: "data",
    toBotId: "wesley",
    label: "old",
    state: "accepted",
    sentAt: at(-100 * DAY_MS),
    acceptedAt: at(-99 * DAY_MS),
  });
  repo.createHandoff({
    id: "h-old-cancelled",
    fromBotId: "data",
    toBotId: "wesley",
    label: "old",
    state: "cancelled",
    sentAt: at(-100 * DAY_MS),
    acceptedAt: null,
  });
  repo.createHandoff({
    id: "h-old-open",
    fromBotId: "data",
    toBotId: "wesley",
    label: "open",
    state: "sent",
    sentAt: at(-100 * DAY_MS),
    acceptedAt: null,
  });
  repo.createHandoff({
    id: "h-new-accepted",
    fromBotId: "data",
    toBotId: "wesley",
    label: "new",
    state: "accepted",
    sentAt: at(-2 * DAY_MS),
    acceptedAt: at(-DAY_MS),
  });
  const event = (botId: string, id: string, receivedAt: string) =>
    repo.insertEvent({
      eventId: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
      botId,
      type: "status_changed",
      status: "idle",
      receivedAt,
    });
  event("data", "1", at(-100 * DAY_MS));
  event("wesley", "2", at(-1 * DAY_MS));
}

describe("retention prune", () => {
  it("drops events and closed handoffs older than the window", () => {
    const context = setup();
    const { repo, db } = context;
    aged(repo);

    const result = pruneRetention({ repo, retentionDays: 90, now: () => NOW });

    expect(result).toEqual({ events: 1, handoffs: 2 });
    expect(repo.getEventsPage(0, 50).rows).toHaveLength(1);
    expect(repo.getHandoff("h-old-accepted")).toBeUndefined();
    expect(repo.getHandoff("h-old-cancelled")).toBeUndefined();
    expect(repo.getHandoff("h-old-open")).toBeDefined();
    expect(repo.getHandoff("h-new-accepted")).toBeDefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps a closed handoff a remaining event still refers to", () => {
    const { repo } = setup();
    repo.createHandoff({
      id: "h-referenced",
      fromBotId: "wesley",
      toBotId: "data",
      label: "kept",
      state: "accepted",
      sentAt: at(-100 * DAY_MS),
      acceptedAt: at(-100 * DAY_MS),
    });
    // New event about an old handoff: its row is still needed.
    repo.insertEvent({
      eventId: "00000000-0000-4000-8000-000000000010",
      botId: "data",
      type: "handoff_accepted",
      handoffId: "h-referenced",
      receivedAt: at(-1 * DAY_MS),
    });

    pruneRetention({ repo, retentionDays: 90, now: () => NOW });
    expect(repo.getHandoff("h-referenced")).toBeDefined();
  });

  it("keeps a closed handoff a live bot still links to", () => {
    const { repo } = setup();
    repo.createHandoff({
      id: "h-held",
      fromBotId: "wesley",
      toBotId: "data",
      label: "held",
      state: "accepted",
      sentAt: at(-100 * DAY_MS),
      acceptedAt: at(-100 * DAY_MS),
    });
    repo.setBotStatus({
      botId: "data",
      status: "working",
      label: "held",
      taskId: null,
      handoffTo: null,
      handoffId: null,
      labelHandoffId: "h-held",
      since: at(-100 * DAY_MS),
      lastHeartbeatAt: NOW,
      lastEventSeq: null,
    });

    pruneRetention({ repo, retentionDays: 90, now: () => NOW });
    expect(repo.getHandoff("h-held")).toBeDefined();
  });

  it("runs once at start and then on its interval", async () => {
    const { repo } = setup();
    const event = (id: string) =>
      repo.insertEvent({
        eventId: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
        botId: "data",
        type: "status_changed",
        status: "idle",
        receivedAt: at(-100 * DAY_MS),
      });
    event("1");
    const stop = startRetentionPrune({ repo, retentionDays: 90, intervalMs: 1000 });
    expect(repo.getEventsPage(0, 10).rows).toHaveLength(0);

    event("2");
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.getEventsPage(0, 10).rows).toHaveLength(0);
    stop();
  });

  it("does not write away: a quiet bot keeps its stored activity and links", () => {
    const { repo, hub } = setup();
    working(repo, at(-10 * 60_000));
    const refresh = vi.spyOn(hub, "refresh");
    const notify = vi.spyOn(hub, "notify");

    const result = sweepStaleBots({ repo, hub, timeoutSec, awaySec });

    expect(result).toEqual({ swept: 0, away: new Set(["data"]) });
    expect(offlineEvents(repo)).toEqual([]);
    expect(repo.getBotStatus("data")).toMatchObject({
      status: "working",
      label: "plan",
      taskId: "t-1",
      lastHeartbeatAt: at(-10 * 60_000),
    });
    expect(notify).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);

    // The same away set on the next tick is not another refresh.
    const again = sweepStaleBots({ repo, hub, timeoutSec, awaySec, previousAway: result.away });
    expect(again.away).toEqual(new Set(["data"]));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("puts a bot at exactly the timeout inside, and one millisecond past it away", () => {
    const { repo, hub } = setup();
    working(repo, at(-timeoutSec * 1000));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec }).away).toEqual(new Set());

    working(repo, at(-timeoutSec * 1000 - 1));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec }).away).toEqual(new Set(["data"]));
  });

  it("goes offline only past the away window", () => {
    const { repo, hub } = setup();
    // The sweeper compares with `<`, so the edge itself is still away, not offline.
    working(repo, at(-awaySec * 1000));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec })).toEqual({
      swept: 0,
      away: new Set(["data"]),
    });

    working(repo, at(-awaySec * 1000 - 1));
    expect(sweepStaleBots({ repo, hub, timeoutSec, awaySec })).toEqual({
      swept: 1,
      away: new Set(),
    });
    expect(offlineEvents(repo)).toHaveLength(1);
    expect(repo.getBotStatus("data")?.status).toBe("offline");
  });

  it("refreshes open streams once when a bot becomes away", async () => {
    const { repo, hub } = setup();
    working(repo, at(-10 * 60_000));
    const refresh = vi.spyOn(hub, "refresh");
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec, awaySec });

    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("clears its interval on stop", () => {
    const { repo } = setup();
    const stop = startRetentionPrune({ repo, retentionDays: 90 });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(RETENTION_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
