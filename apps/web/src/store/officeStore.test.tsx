import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StateSnapshot, StreamEvent } from "@grokbot-office/shared";

import {
  BAD_RESPONSE_MESSAGE,
  BAD_TOKEN_MESSAGE,
  CLOSED_AFTER_MS,
  UNREACHABLE_MESSAGE,
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
    phase: "checking",
    connection: "reconnecting",
    pending: false,
    error: null,
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
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
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
});

describe("stream", () => {
  it("opens the stream with credentials", () => {
    const source = startStream();
    expect(source.url).toBe("/api/stream");
    expect(source.init?.withCredentials).toBe(true);
  });

  it("goes live on open and applies event frames", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshot));
    await useOfficeStore.getState().checkSession();
    const source = startStream();

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
        streamEvent(8, { type: "handoff_sent", to: "wesley", handoffId: "handoff-1" }),
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

    source.emit("open");
    expect(useOfficeStore.getState().connection).toBe("live");

    source.emit("error");
    expect(useOfficeStore.getState().connection).toBe("reconnecting");

    source.emit("ping");
    expect(useOfficeStore.getState().connection).toBe("live");

    source.emit("error");
    vi.advanceTimersByTime(CLOSED_AFTER_MS - 1);
    expect(useOfficeStore.getState().connection).toBe("reconnecting");
    vi.advanceTimersByTime(1);
    expect(useOfficeStore.getState().connection).toBe("closed");
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
