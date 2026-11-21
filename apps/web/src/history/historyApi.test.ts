import { afterEach, describe, expect, it, vi } from "vitest";

import type { StreamEvent } from "@grokbot-office/shared";

import { EVENTS_URL, fetchEventsWindow, type HistoryPage } from "./historyApi";

function streamEvent(seq: number): StreamEvent {
  return {
    seq,
    botId: "data",
    type: "status_changed",
    status: "working",
    receivedAt: "2026-01-15T09:00:00.000Z",
  };
}

function jsonResponse(body: HistoryPage, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("history paging", () => {
  it("reads every page of a window and returns events in seq order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          events: [streamEvent(3), streamEvent(5)],
          nextSince: 5,
          hasMore: true,
          lastSeq: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ events: [streamEvent(8)], nextSince: 8, hasMore: false, lastSeq: 8 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchEventsWindow({
      from: "2026-01-15T00:00:00.000Z",
      to: "2026-01-16T00:00:00.000Z",
    });
    expect(events.map((event) => event.seq)).toEqual([3, 5, 8]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0][0] as string, "http://office.test");
    expect(firstUrl.pathname).toBe(EVENTS_URL);
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      since: "0",
      limit: "500",
      from: "2026-01-15T00:00:00.000Z",
      to: "2026-01-16T00:00:00.000Z",
    });
    const secondUrl = new URL(fetchMock.mock.calls[1][0] as string, "http://office.test");
    expect(secondUrl.searchParams.get("since")).toBe("5");
  });

  it("surfaces a non-ok response as a readable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    await expect(
      fetchEventsWindow({ from: "2026-01-15T00:00:00.000Z", to: "2026-01-16T00:00:00.000Z" }),
    ).rejects.toThrow("History request failed (503).");
  });

  it("rejects a page that is not an events page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          events: [
            {
              seq: 0,
              botId: "data",
              type: "status_changed",
              receivedAt: "2026-01-15T00:00:00.000Z",
            },
          ],
          nextSince: 0,
          hasMore: false,
          lastSeq: 0,
        }),
      ),
    );
    await expect(
      fetchEventsWindow({ from: "2026-01-15T00:00:00.000Z", to: "2026-01-16T00:00:00.000Z" }),
    ).rejects.toThrow();
  });
});
