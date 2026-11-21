import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { APP_NAME, type StreamEvent } from "@grokbot-office/shared";

import { APP_TITLE_LAYOUT, historyBarBox } from "../hudLayout";
import { HistoryBarView, type HistoryBarViewProps } from "./HistoryBar";
import type { HistoryStats } from "./stats";

const event: StreamEvent = {
  seq: 7,
  botId: "data",
  type: "task_started",
  taskId: "t1",
  label: "Build",
  receivedAt: "2026-01-15T09:00:00.000Z",
};

const stats: HistoryStats = {
  days: [
    { day: "2026-01-14", count: 0 },
    { day: "2026-01-15", count: 3 },
  ],
  latency: { count: 2, medianMs: 25_000, averageMs: 25_000, open: 1 },
  busiest: { botId: "data", name: "Data", count: 3 },
};

function props(overrides: Partial<HistoryBarViewProps> = {}): HistoryBarViewProps {
  return {
    day: "2026-01-15",
    today: "2026-01-15",
    dayEvents: [event],
    playhead: 0,
    playing: false,
    loading: false,
    error: null,
    stats,
    onSelectDay: vi.fn(),
    onTogglePlay: vi.fn(),
    onScrub: vi.fn(),
    onStep: vi.fn(),
    onExit: vi.fn(),
    onReload: vi.fn(),
    ...overrides,
  };
}

describe("HistoryBarView", () => {
  it("renders the date picker, scrubber, playback controls and stats", () => {
    const markup = renderToStaticMarkup(<HistoryBarView {...props()} />);
    expect(markup).toContain('aria-label="History day"');
    expect(markup).toContain('type="date"');
    expect(markup).toContain('value="2026-01-15"');
    expect(markup).toContain('max="2026-01-15"');
    expect(markup).toContain('aria-label="Timeline"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain('aria-label="Play"');
    expect(markup).toContain('aria-label="Previous event"');
    expect(markup).toContain('aria-label="Next event"');
    expect(markup).toContain('aria-label="Back to live"');
    expect(markup).toContain("1 / 1 events");
    expect(markup).toContain("started · Build");

    expect(markup).toContain("Tasks per day");
    expect(markup).toContain("01-14");
    expect(markup).toContain("Handoff latency: median 25s · average 25s · 1 open");
    expect(markup).toContain("Busiest bot: Data · 3 tasks");
    // Event text is rendered as text, never as markup.
    expect(markup).not.toContain("dangerouslySetInnerHTML");
  });

  it("shows the empty state and disables time travel for a day with no events", () => {
    const markup = renderToStaticMarkup(
      <HistoryBarView {...props({ dayEvents: [], playhead: -1, stats: { ...stats, days: [] } })} />,
    );
    expect(markup).toContain("No events on this day.");
    expect(markup).toMatch(/aria-label="Timeline"[^>]*disabled/);
    expect(markup).toMatch(/aria-label="Play"[^>]*disabled/);
  });

  it("offers Pause while playing and reports the load error", () => {
    const markup = renderToStaticMarkup(
      <HistoryBarView {...props({ playing: true, error: "History request failed (503)." })} />,
    );
    expect(markup).toContain('aria-label="Pause"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("History request failed (503).");
  });
});

describe("short-window dock", () => {
  it("sits beside the app title instead of covering it", () => {
    const viewport = { width: 844, height: 390 };
    const box = historyBarBox(viewport);
    const markup = renderToStaticMarkup(
      <>
        <h1 className="app-title">{APP_NAME}</h1>
        <HistoryBarView
          {...props()}
          style={{ left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 }}
        />
      </>,
    );

    const barStyle = /<aside class="history-bar" style="([^"]*)"/.exec(markup)?.[1] ?? "";
    const style = Object.fromEntries(
      barStyle
        .split(";")
        .map((pair) => pair.split(":").map((part) => part.trim()))
        .map(([property, value]) => [property, Number.parseFloat(value ?? "")]),
    );
    expect(style.left).toBeGreaterThanOrEqual(APP_TITLE_LAYOUT.left + APP_TITLE_LAYOUT.width);
    // The dock shares the title's top band but starts to its right, so the x gap
    // alone keeps it clear of the title (the suite has no layout engine).
    expect(style.top).toBeLessThan(APP_TITLE_LAYOUT.top + APP_TITLE_LAYOUT.height);
    expect((style.width ?? 0) + (style.left ?? 0)).toBeLessThanOrEqual(viewport.width);

    // The constants mirror the fixed title rule; keep them honest.
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    const css = readFileSync(join(root, "src/styles.css"), "utf8");
    const titleRule = css.slice(css.indexOf(".app-title {")).split("}")[0] ?? "";
    expect(titleRule).toContain(`top: ${APP_TITLE_LAYOUT.top / 16}rem`);
    expect(titleRule).toContain(`left: ${APP_TITLE_LAYOUT.left / 16}rem`);
  });
});
