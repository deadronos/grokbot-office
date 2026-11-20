import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StateSnapshot, StreamEvent } from "@grokbot-office/shared";

import {
  BAD_RESPONSE_MESSAGE,
  BAD_TOKEN_MESSAGE,
  CLOSED_AFTER_MS,
  NOT_VIEWER_MESSAGE,
  UNREACHABLE_MESSAGE,
  resetOfficeStoreInternals,
  selectBot,
  useOfficeStore,
} from "./officeStore";

const { invalidateScene } = vi.hoisted(() => ({ invalidateScene: vi.fn() }));
vi.mock("../scene/invalidateScene", () => ({ invalidateScene }));

const AT = "2026-01-01T00:00:00.000Z";

const snapshot: StateSnapshot = {
  bots: [
    {
      id: "data",
      name: "Data",
      role: "Code-Orchestrator",
      avatar: "android-gold",
      pod: "dev",
      status: "working",
      label: "issue-11",
      taskId: "issue-11",
      since: AT,
      lastHeartbeatAt: AT,
      lastEventSeq: 7,
    },
    {
      id: "wesley",
      name: "Wesley",
      role: "Reviewer",
      avatar: "human",
      pod: "dev",
      status: "idle",
      since: AT,
      lastHeartbeatAt: AT,
      lastEventSeq: 7,
    },
  ],
  openHandoffs: [],
  lastEventSeq: 7,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

/** Minimal EventSource: records construction, lets tests push frames by hand. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  readonly init?: { withCredentials?: boolean };
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  closed = false;

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.init = init;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type, data } as MessageEvent);
    }
  }
}

const fetchMock = vi.fn<typeof fetch>();
const stops: Array<() => void> = [];

function resetStore(): void {
  useOfficeStore.setState({
    bots: {},
    openHandoffs: [],
    lastEventSeq: 0,
    events: [],
    handoffFlash: null,
    phase: "checking",
    connection: "reconnecting",
    pending: false,
    error: null,
    pageUnloading: false,
  });
}

function streamEvent(seq: number, overrides: Partial<StreamEvent> = {}): StreamEvent {
  return { seq, botId: "data", type: "status_changed", receivedAt: AT, ...overrides };
}

function startStream(): MockEventSource {
  stops.push(useOfficeStore.getState().startStream());
  const source = MockEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was opened");
  return source;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("sessionStorage", { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
  MockEventSource.instances.length = 0;
  stops.length = 0;
  fetchMock.mockReset();
  invalidateScene.mockClear();
  resetOfficeStoreInternals();
  resetStore();
});

afterEach(() => {
  for (const stop of stops) stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("checkSession", () => {
  it("loads the snapshot and goes ready", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));

    await useOfficeStore.getState().checkSession();

    const state = useOfficeStore.getState();
    expect(fetchMock).toHaveBeenCalledWith("/api/state", { credentials: "same-origin" });
    expect(state.phase).toBe("ready");
    expect(state.bots.data?.status).toBe("working");
    expect(state.lastEventSeq).toBe(7);
    expect(invalidateScene).toHaveBeenCalledTimes(1);
  });

  it("shows the login form when there is no session", async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(401));

    await useOfficeStore.getState().checkSession();

    expect(useOfficeStore.getState().phase).toBe("login");
    expect(useOfficeStore.getState().error).toBeNull();
  });

  it("rejects an unexpected snapshot body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ bots: "nope" }));

    await useOfficeStore.getState().checkSession();

    const state = useOfficeStore.getState();
    expect(state.phase).toBe("login");
    expect(state.error).toBe(BAD_RESPONSE_MESSAGE);
    expect(state.connection).toBe("closed");
  });

  it("reports an unreachable office", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    await useOfficeStore.getState().checkSession();

    const state = useOfficeStore.getState();
    expect(state.phase).toBe("login");
    expect(state.error).toBe(UNREACHABLE_MESSAGE);
    expect(state.connection).toBe("closed");
  });
});

describe("login", () => {
  it("exchanges the token for a cookie session and drops the token", async () => {
    useOfficeStore.setState({ phase: "login" });
    fetchMock.mockResolvedValueOnce(jsonResponse({ expiresAt: "2026-01-01T01:00:00.000Z" }, 201));
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));

    await useOfficeStore.getState().login("viewer-test-token");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: "Bearer viewer-test-token" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/state", { credentials: "same-origin" });
    expect(useOfficeStore.getState().phase).toBe("ready");
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("shows an error when the token is refused", async () => {
    useOfficeStore.setState({ phase: "login" });
    fetchMock.mockResolvedValueOnce(emptyResponse(401));

    await useOfficeStore.getState().login("bad-viewer-token");

    const state = useOfficeStore.getState();
    expect(state.phase).toBe("login");
    expect(state.error).toBe(BAD_TOKEN_MESSAGE);
    expect(state.pending).toBe(false);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
  });

  it("rejects a bot token or the admin bearer", async () => {
    useOfficeStore.setState({ phase: "login" });
    fetchMock.mockResolvedValueOnce(emptyResponse(403));

    await useOfficeStore.getState().login("bot-token");

    expect(useOfficeStore.getState().error).toBe(NOT_VIEWER_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("only accepts 201, not any other success status", async () => {
    useOfficeStore.setState({ phase: "login" });
    fetchMock.mockResolvedValueOnce(emptyResponse(200));

    await useOfficeStore.getState().login("viewer-test-token");

    expect(useOfficeStore.getState().phase).toBe("login");
    expect(useOfficeStore.getState().error).toBe("Sign in failed (200).");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("logout", () => {
  it("clears the cookie, drops the data and stops the stream", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    stops.push(useOfficeStore.getState().startStream());
    const source = MockEventSource.instances[0];
    fetchMock.mockResolvedValueOnce(emptyResponse(204));

    await useOfficeStore.getState().logout();

    expect(fetchMock).toHaveBeenLastCalledWith("/api/session/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    const state = useOfficeStore.getState();
    expect(state.phase).toBe("login");
    expect(state.bots).toEqual({});
    expect(state.lastEventSeq).toBe(0);
    expect(source?.closed).toBe(true);
  });

  it("returns to the login form even when the logout call fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));

    await useOfficeStore.getState().logout();

    expect(useOfficeStore.getState().phase).toBe("login");
    expect(useOfficeStore.getState().bots).toEqual({});
  });
});

describe("stream", () => {
  it("opens the stream with credentials and asks for the events after the snapshot", () => {
    const source = startStream();
    expect(source.url).toBe("/api/stream?since=0");
    expect(source.init?.withCredentials).toBe(true);
  });

  it("goes live on open and applies event frames", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();
    expect(source.url).toBe("/api/stream?since=7");

    source.emit("open");
    expect(useOfficeStore.getState().connection).toBe("live");

    source.emit(
      "event",
      JSON.stringify(
        streamEvent(8, { type: "status_changed", status: "waiting", label: "review" }),
      ),
    );
    const state = useOfficeStore.getState();
    expect(state.lastEventSeq).toBe(8);
    expect(state.bots.data?.status).toBe("waiting");
    expect(state.bots.data?.label).toBe("review");
  });

  it("ignores bad JSON and repeated sequences", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();

    source.emit("event", "{not json");
    expect(useOfficeStore.getState().lastEventSeq).toBe(7);

    source.emit("event", JSON.stringify(streamEvent(8, { type: "task_started", taskId: "t1" })));
    source.emit("event", JSON.stringify(streamEvent(8, { type: "task_finished", result: "done" })));
    expect(useOfficeStore.getState().bots.data?.status).toBe("working");
    expect(useOfficeStore.getState().bots.data?.taskId).toBe("t1");
  });

  it("tracks handoffs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();

    source.emit(
      "event",
      JSON.stringify(
        streamEvent(8, {
          type: "handoff_sent",
          to: "wesley",
          handoffId: "handoff-1",
          taskId: "issue-11",
        }),
      ),
    );
    expect(useOfficeStore.getState().openHandoffs).toHaveLength(1);
    expect(useOfficeStore.getState().bots.data?.status).toBe("waiting");

    source.emit(
      "event",
      JSON.stringify(
        streamEvent(9, {
          botId: "wesley",
          type: "handoff_accepted",
          handoffId: "handoff-1",
          taskId: "issue-11",
        }),
      ),
    );
    const state = useOfficeStore.getState();
    expect(state.openHandoffs).toHaveLength(0);
    expect(state.bots.wesley?.status).toBe("working");
    expect(state.bots.data?.status).toBe("idle");
  });

  it("goes reconnecting on error, stays live on ping, then closed after the grace period", () => {
    vi.useFakeTimers();
    const source = startStream();
    fetchMock.mockResolvedValue(jsonResponse(snapshot));

    source.emit("open");
    expect(useOfficeStore.getState().connection).toBe("live");
    invalidateScene.mockClear();

    source.emit("ping", "{}");
    expect(useOfficeStore.getState().connection).toBe("live");
    expect(useOfficeStore.getState().lastEventSeq).toBe(0);
    expect(invalidateScene).not.toHaveBeenCalled();

    source.emit("error");
    expect(useOfficeStore.getState().connection).toBe("reconnecting");
    expect(source.closed).toBe(false);

    source.emit("ping", "{}");
    expect(useOfficeStore.getState().connection).toBe("live");

    source.emit("error");
    vi.advanceTimersByTime(CLOSED_AFTER_MS - 1);
    expect(useOfficeStore.getState().connection).toBe("reconnecting");
    vi.advanceTimersByTime(1);
    expect(useOfficeStore.getState().connection).toBe("closed");
  });

  it("returns to login when the stream dies and the session is gone", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();
    source.emit("open");

    fetchMock.mockResolvedValueOnce(emptyResponse(401));
    source.emit("error");

    await vi.waitFor(() => expect(useOfficeStore.getState().phase).toBe("login"));
    const state = useOfficeStore.getState();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/state", { credentials: "same-origin" });
    expect(source.closed).toBe(true);
    expect(state.bots).toEqual({});
    expect(state.lastEventSeq).toBe(0);
    expect(state.error).toBeNull();
  });

  it("does not probe the session when the page is unloading", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    fetchMock.mockClear();
    const source = startStream();
    source.emit("open");

    useOfficeStore.getState().setPageUnloading(true);
    source.emit("error");
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOfficeStore.getState().phase).toBe("ready");
    expect(source.closed).toBe(false);
  });

  it("resets the unload flag on pageshow and re-probes a persisted page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();
    source.emit("open");
    fetchMock.mockClear();

    useOfficeStore.getState().onPageHide();
    expect(useOfficeStore.getState().pageUnloading).toBe(true);
    source.emit("error");
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    await useOfficeStore.getState().onPageShow(false);
    expect(useOfficeStore.getState().pageUnloading).toBe(false);
    expect(useOfficeStore.getState().phase).toBe("ready");
    expect(fetchMock).not.toHaveBeenCalled();

    useOfficeStore.getState().onPageHide();
    fetchMock.mockResolvedValueOnce(emptyResponse(401));
    await useOfficeStore.getState().onPageShow(true);

    expect(useOfficeStore.getState().pageUnloading).toBe(false);
    expect(useOfficeStore.getState().phase).toBe("login");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/state", { credentials: "same-origin" });
  });

  it("re-renders one bot without touching the others", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const wesleyBefore = useOfficeStore.getState().bots.wesley;
    const source = startStream();

    expect(selectBot("data")(useOfficeStore.getState())?.status).toBe("working");

    source.emit(
      "event",
      JSON.stringify(streamEvent(8, { type: "status_changed", status: "reviewing" })),
    );

    expect(selectBot("data")(useOfficeStore.getState())?.status).toBe("reviewing");
    expect(useOfficeStore.getState().bots.wesley).toBe(wesleyBefore);
    expect(invalidateScene).toHaveBeenCalledTimes(2);
  });
});

describe("applyEvent", () => {
  it("keeps the current label when status_changed has none", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    useOfficeStore
      .getState()
      .applyEvent(streamEvent(8, { type: "status_changed", status: "reviewing" }));

    const bot = useOfficeStore.getState().bots.data;
    expect(bot?.status).toBe("reviewing");
    expect(bot?.label).toBe("issue-11");
    expect(bot?.taskId).toBe("issue-11");
  });

  it("replaces the label when status_changed carries one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    useOfficeStore
      .getState()
      .applyEvent(
        streamEvent(8, { type: "status_changed", status: "reviewing", label: "reviewing plan" }),
      );

    expect(useOfficeStore.getState().bots.data?.label).toBe("reviewing plan");
  });

  it("refetches the snapshot when a new bot registers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    const withLumi: StateSnapshot = {
      ...snapshot,
      bots: [
        ...snapshot.bots,
        {
          id: "lumi",
          name: "Lumi",
          role: "Designer",
          avatar: "glow",
          pod: "ops",
          status: "idle",
          since: AT,
          lastHeartbeatAt: AT,
          lastEventSeq: 8,
        },
      ],
      lastEventSeq: 8,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(withLumi));

    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "lumi" }));

    await vi.waitFor(() => expect(useOfficeStore.getState().bots.lumi?.name).toBe("Lumi"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/state", { credentials: "same-origin" });
    expect(useOfficeStore.getState().lastEventSeq).toBe(8);
  });

  it("does not refetch when a known bot re-registers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    fetchMock.mockClear();

    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "data" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOfficeStore.getState().bots.data?.name).toBe("Data");
    expect(useOfficeStore.getState().lastEventSeq).toBe(8);
  });

  it("goes from offline to idle live on a status_changed come-back event", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();

    source.emit("event", JSON.stringify(streamEvent(8, { type: "offline" })));
    expect(useOfficeStore.getState().bots.data).toMatchObject({
      status: "offline",
      label: undefined,
      taskId: undefined,
    });

    // The sweeper's come-back is a status_changed (idle, or an explicit non-offline
    // status). The reducer already maps that type; no new event type is needed.
    source.emit(
      "event",
      JSON.stringify(streamEvent(9, { type: "status_changed", status: "idle" })),
    );
    expect(useOfficeStore.getState().bots.data).toMatchObject({
      status: "idle",
      lastEventSeq: 9,
    });
    expect(useOfficeStore.getState().lastEventSeq).toBe(9);
  });

  it("clears the label and task when a status_changed rests the bot", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    useOfficeStore
      .getState()
      .applyEvent(streamEvent(8, { type: "status_changed", status: "idle" }));

    expect(useOfficeStore.getState().bots.data).toMatchObject({
      status: "idle",
      label: undefined,
      taskId: undefined,
    });
  });

  it("labels an accepted handoff with the handoff label when the event has none", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();

    source.emit(
      "event",
      JSON.stringify(
        streamEvent(8, {
          type: "handoff_sent",
          to: "wesley",
          handoffId: "handoff-1",
          label: "issue-11",
        }),
      ),
    );
    source.emit(
      "event",
      JSON.stringify(
        streamEvent(9, {
          botId: "wesley",
          type: "handoff_accepted",
          handoffId: "handoff-1",
          taskId: "issue-11",
        }),
      ),
    );

    expect(useOfficeStore.getState().bots.wesley).toMatchObject({
      status: "working",
      label: "issue-11",
      taskId: "issue-11",
    });
  });

  it("refetches the snapshot on a refresh frame and drops a bot that is no longer in it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();
    useOfficeStore
      .getState()
      .applyEvent(streamEvent(8, { type: "task_started", taskId: "issue-13" }));
    expect(useOfficeStore.getState().events.some((event) => event.botId === "data")).toBe(true);
    fetchMock.mockClear();

    const withoutData: StateSnapshot = {
      ...snapshot,
      bots: snapshot.bots.filter((bot) => bot.id !== "data"),
      openHandoffs: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(withoutData));
    source.emit("refresh", "{}");

    await vi.waitFor(() => expect(useOfficeStore.getState().bots.data).toBeUndefined());
    expect(useOfficeStore.getState().bots.wesley).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/state", { credentials: "same-origin" });
    expect(useOfficeStore.getState().events.some((event) => event.botId === "data")).toBe(false);
    expect(JSON.stringify(useOfficeStore.getState().events)).not.toContain("bot_hidden");
    expect(JSON.stringify(useOfficeStore.getState().events)).not.toContain("issue-13");
  });

  it("expires the session when a snapshot refetch returns 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();
    source.emit("open");
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(emptyResponse(401));

    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "lumi" }));

    await vi.waitFor(() => expect(useOfficeStore.getState().phase).toBe("login"));
    expect(useOfficeStore.getState().bots).toEqual({});
    expect(useOfficeStore.getState().events).toEqual([]);
  });

  it("keeps applying events for known bots while a refetch retries", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(emptyResponse(500));
    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "lumi" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    useOfficeStore
      .getState()
      .applyEvent(streamEvent(9, { type: "status_changed", status: "reviewing" }));
    expect(useOfficeStore.getState().bots.data?.status).toBe("reviewing");
    expect(useOfficeStore.getState().bots.lumi).toBeUndefined();
  });

  it("replays queued and live events in seq order after a snapshot, without duplicate feed rows", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    const lumiIdle = {
      id: "lumi",
      name: "Lumi",
      role: "Designer",
      avatar: "glow",
      pod: "ops" as const,
      status: "idle" as const,
      since: AT,
      lastHeartbeatAt: AT,
      lastEventSeq: 8,
    };
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...snapshot, bots: [...snapshot.bots, lumiIdle], lastEventSeq: 8 }),
    );

    // Register starts a refetch; the following start is queued as an unknown bot.
    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "lumi" }));
    useOfficeStore.getState().applyEvent(
      streamEvent(9, {
        type: "task_started",
        botId: "lumi",
        taskId: "issue-13",
        label: "lights",
      }),
    );
    // A later known-bot event is applied live and would skip seq 9 if replay were unsorted.
    useOfficeStore
      .getState()
      .applyEvent(streamEvent(10, { type: "status_changed", status: "reviewing" }));

    await vi.waitFor(() => expect(useOfficeStore.getState().bots.lumi?.status).toBe("working"));
    expect(useOfficeStore.getState().bots.lumi?.taskId).toBe("issue-13");
    expect(useOfficeStore.getState().bots.data?.status).toBe("reviewing");
    expect(useOfficeStore.getState().lastEventSeq).toBe(10);
    const seqs = useOfficeStore.getState().events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].toSorted((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("drops an overflowing unknown-bot queue and refetches after the snapshot lands", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    vi.useFakeTimers();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(emptyResponse(500));
    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "lumi" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    for (let seq = 9; seq <= 8 + 501; seq++) {
      useOfficeStore
        .getState()
        .applyEvent(streamEvent(seq, { type: "bot_registered", botId: `bot-${seq}` }));
    }

    // The dropped queue must not replay. The first snapshot may be stale, so a
    // second refetch runs and takes its lastEventSeq.
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, lastEventSeq: 8 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...snapshot, lastEventSeq: 509 }));
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(useOfficeStore.getState().lastEventSeq).toBe(509);
    expect(useOfficeStore.getState().bots.lumi).toBeUndefined();
    expect(Object.keys(useOfficeStore.getState().bots).toSorted()).toEqual(["data", "wesley"]);
  });

  it("flashes a handoff line and clears it on request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();

    source.emit(
      "event",
      JSON.stringify(
        streamEvent(8, { type: "handoff_sent", to: "wesley", handoffId: "handoff-1" }),
      ),
    );
    expect(useOfficeStore.getState().handoffFlash).toEqual({ seq: 8, from: "data", to: "wesley" });

    useOfficeStore.getState().clearHandoffFlash();
    expect(useOfficeStore.getState().handoffFlash).toBeNull();
  });

  it("seeds the feed from the events API and keeps it ordered", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        events: [
          streamEvent(6, { type: "task_started", taskId: "issue-11" }),
          { ...streamEvent(5), type: "bogus" },
        ],
      }),
    );

    await useOfficeStore.getState().checkSession();

    await vi.waitFor(() => expect(useOfficeStore.getState().events).toHaveLength(1));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/events?since=0&limit=20", {
      credentials: "same-origin",
    });
    expect(useOfficeStore.getState().events[0]).toMatchObject({ seq: 6, type: "task_started" });
  });

  it("retries a failed snapshot refetch with backoff and replays queued events", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(emptyResponse(500));
    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "lumi" }));
    // The frame that started the refresh is superseded by the snapshot; later
    // frames wait in the queue and replay once a snapshot lands.
    useOfficeStore
      .getState()
      .applyEvent(streamEvent(9, { type: "status_changed", status: "reviewing" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The retry waits one second before trying again.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ...snapshot,
        bots: [
          ...snapshot.bots,
          {
            id: "lumi",
            name: "Lumi",
            role: "Designer",
            avatar: "glow",
            pod: "ops",
            status: "idle",
            since: AT,
            lastHeartbeatAt: AT,
            lastEventSeq: 7,
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useOfficeStore.getState().bots.lumi?.name).toBe("Lumi");
    expect(useOfficeStore.getState().bots.data?.status).toBe("reviewing");
    expect(useOfficeStore.getState().lastEventSeq).toBe(9);
  });

  it("drops a queued snapshot retry on logout", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(emptyResponse(500));
    useOfficeStore.getState().applyEvent(streamEvent(8, { type: "bot_registered", botId: "lumi" }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    await useOfficeStore.getState().logout();
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOfficeStore.getState().bots).toEqual({});
  });
});
