import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BotSnapshot, StreamEvent } from "@grokbot-office/shared";

import { HudView, describeEvent, formatSince } from "./Hud";

const AT = "2026-01-01T00:00:00.000Z";

const bot = (overrides: Partial<BotSnapshot>): BotSnapshot => ({
  id: "data",
  name: "Data",
  role: "Code-Orchestrator",
  avatar: "android-gold",
  pod: "dev",
  status: "working",
  since: AT,
  lastHeartbeatAt: AT,
  lastEventSeq: 1,
  ...overrides,
});

const event = (seq: number, overrides: Partial<StreamEvent> = {}): StreamEvent => ({
  seq,
  botId: "data",
  type: "status_changed",
  status: "working",
  receivedAt: AT,
  ...overrides,
});

function render(
  bots: Record<string, BotSnapshot>,
  events: StreamEvent[] = [],
  now = Date.parse(AT),
): string {
  return renderToStaticMarkup(<HudView bots={bots} events={events} now={now} />);
}

describe("formatSince", () => {
  it("renders a compact age", () => {
    const base = Date.parse(AT);
    expect(formatSince(AT, base + 12_000)).toBe("12s");
    expect(formatSince(AT, base + 65_000)).toBe("1m");
    expect(formatSince(AT, base + 3 * 3600_000)).toBe("3h");
    expect(formatSince(AT, base + 2 * 86_400_000)).toBe("2d");
    expect(formatSince("not a date", base)).toBe("—");
  });
});

describe("describeEvent", () => {
  it("describes every event type as text", () => {
    expect(describeEvent(event(1, { status: "waiting", label: "review" }))).toBe(
      "status · waiting · review",
    );
    expect(describeEvent(event(1, { type: "task_started", taskId: "issue-13" }))).toBe(
      "started · issue-13",
    );
    expect(describeEvent(event(1, { type: "task_finished", result: "done" }))).toBe(
      "finished · done",
    );
    expect(describeEvent(event(1, { type: "handoff_sent", to: "wesley", label: "issue-13" }))).toBe(
      "handoff · to wesley · issue-13",
    );
    expect(describeEvent(event(1, { type: "offline" }))).toBe("went offline");
    expect(describeEvent(event(1, { type: "bot_hidden" }))).toBe("hidden");
  });
});

describe("HudView", () => {
  it("lists bots in desk order with status, label and age", () => {
    const html = render(
      {
        geordi: bot({ id: "geordi", name: "Geordi", status: "reviewing", label: "pr-39" }),
        data: bot({ id: "data", name: "Data", label: "issue-13" }),
      },
      [],
      Date.parse(AT) + 65_000,
    );

    expect(html.indexOf("Data")).toBeLessThan(html.indexOf("Geordi"));
    expect(html).toContain("status-working");
    expect(html).toContain("status-reviewing");
    expect(html).toContain("issue-13");
    expect(html).toContain("1m");
  });

  it("shows the newest 20 events first", () => {
    const events = Array.from({ length: 25 }, (_, index) =>
      event(index + 1, { type: "task_started", taskId: `task-${index + 1}` }),
    );

    const html = render({ data: bot({}) }, events);

    expect(html).toContain("task-25");
    expect(html).toContain("task-6");
    expect(html).not.toContain("task-5");
    expect(html.indexOf("task-25")).toBeLessThan(html.indexOf("task-24"));
  });

  it("renders labels as text, never as markup", () => {
    const html = render({
      data: bot({ name: "<img src=x onerror=alert(1)>", label: "<b>bold</b>" }),
    });

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("explains an empty office", () => {
    const html = render({}, []);
    expect(html).toContain("No bots online.");
    expect(html).toContain("No events yet.");
  });
});
