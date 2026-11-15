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

/** Ten minutes before `NOW`: stale for the default 300 s timeout. */
const STALE = "2025-12-31T23:50:00.000Z";
const timeoutSec = 300;

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

describe("heartbeat sweeper", () => {
  it("takes a stale working bot offline once, clears its links and notifies", async () => {
    const { repo, hub } = setup();
    working(repo);
    const notify = vi.spyOn(hub, "notify");
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec });

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
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec });

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

    expect(sweepStaleBots({ repo, hub, timeoutSec })).toBe(0);
    expect(offlineEvents(repo)).toEqual([]);
    expect(repo.getBotStatus("data")?.since).toBe(STALE);
    expect(notify).not.toHaveBeenCalled();
  });

  it("only sweeps bots with a status row", () => {
    const { repo, hub } = setup();
    // `wesley` has a bot row but no `bot_status`: not yet online, never invented.
    expect(sweepStaleBots({ repo, hub, timeoutSec })).toBe(0);
    expect(repo.getBotStatus("wesley")).toBeUndefined();
  });

  it("sends the offline event to an SSE client", async () => {
    const { app, repo, hub } = setup();
    const viewerToken = issueToken(repo, { kind: "viewer" }).token;
    working(repo);
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec });

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

  it("clears its interval on stop", () => {
    const { repo, hub } = setup();
    const stop = startHeartbeatSweeper({ repo, hub, timeoutSec });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
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

  it("clears its interval on stop", () => {
    const { repo } = setup();
    const stop = startRetentionPrune({ repo, retentionDays: 90 });
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(RETENTION_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
