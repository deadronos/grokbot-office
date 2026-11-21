import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BotSnapshot, StreamEvent } from "@grokbot-office/shared";

import { HudView, botStatusLabel, describeEvent, formatSince } from "./Hud";

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

describe("botStatusLabel", () => {
  it("ages away from the last report, not from the activity", () => {
    const base = Date.parse(AT);
    const away = bot({ status: "away", since: AT, lastSeenAt: AT, lastHeartbeatAt: AT });

    expect(botStatusLabel(away, base + 12 * 60_000)).toBe("away · last seen 12m ago");
    expect(botStatusLabel(bot({ status: "offline" }), base)).toBe("offline");
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
    expect(describeEvent(event(1, { type: "bot_registered" }))).toBe("registered");
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

  it("labels an away bot with its last-seen age instead of the activity age", () => {
    const base = Date.parse(AT);
    const html = render(
      {
        data: bot({
          status: "away",
          label: "issue-13",
          since: "2025-12-31T18:00:00.000Z",
          lastSeenAt: "2025-12-31T23:48:00.000Z",
          lastHeartbeatAt: "2025-12-31T23:48:00.000Z",
        }),
      },
      [],
      base,
    );

    expect(html).toContain("status-away");
    expect(html).toContain("away · last seen 12m ago");
    // The `since` age of six hours must not be what the row shows.
    expect(html).not.toContain(">6h<");
    expect(html).toContain("issue-13");
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

  it("makes each bot row a keyboard-activatable button", () => {
    const html = renderToStaticMarkup(
      <HudView
        bots={{ data: bot({}), wesley: bot({ id: "wesley", name: "Wesley", status: "idle" }) }}
        events={[]}
        now={Date.parse(AT)}
        selectedBotId="data"
        onSelectBot={() => {}}
      />,
    );

    expect(html).toMatch(/<button[^>]*type="button"[^>]*class="hud-bot"/);
    expect(html).toMatch(
      /<button[^>]*class="hud-bot"[^>]*aria-current="true"[^>]*>\s*<span[^>]*>\s*<\/span>\s*<span class="hud-name">Data<\/span>/,
    );
    // Only the selected row is marked, and the name stays inside the button.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain("</button>");
  });

  it("truncates a long label without cutting the status word", () => {
    const html = render({
      data: bot({
        status: "reviewing",
        label: "this-label-is-deliberately-very-long-and-must-not-eat-the-status",
      }),
    });
    expect(html).toContain(">reviewing<");
    expect(html).toContain("hud-label");
    expect(html).toContain("hud-status");
    // Status and label are separate nodes so a long label cannot ellipsis the status.
    expect(html).toMatch(/hud-status[^>]*>reviewing</);
    expect(html).toMatch(
      /hud-label[^>]*>this-label-is-deliberately-very-long-and-must-not-eat-the-status</,
    );
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
    const statusRule = css.slice(css.indexOf(".hud-status"));
    // The shared ellipsis rule must not apply to status; only the label truncates.
    expect(css).not.toMatch(/\.hud-label,\s*\.hud-status[^{]*{[\s\S]*text-overflow:\s*ellipsis/);
    expect(statusRule.split("}")[0]).not.toContain("text-overflow");
    const feedRule = css.slice(css.indexOf(".hud-event .hud-status"));
    expect(feedRule.split("}")[0]).toContain("text-overflow");
  });

  it("does not show a hidden bot in a fresh session", () => {
    const html = render({ data: bot({}) }, [
      event(1, { type: "task_started", taskId: "issue-13" }),
    ]);
    expect(html).not.toContain("quark");
    expect(html).not.toContain(">hidden<");
    expect(html).not.toContain("bot_hidden");
  });
});

describe("hud box", () => {
  it("counts padding and border inside the tested height and width", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
    const rule = css.slice(css.indexOf(".hud {")).split("}")[0];
    expect(rule).toContain("box-sizing: border-box");
  });
});

describe("asset credit", () => {
  it("credits Kenney CC0 with a link", () => {
    const html = render({});
    expect(html).toContain("Models:");
    expect(html).toContain("CC0");
    expect(html).toMatch(/href="https:\/\/kenney\.nl"/);
  });
});

const stylesheet = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

describe("bounded wide panel", () => {
  it("makes the sections bounded columns and their lists the scrolling part", () => {
    // The suite has no layout engine: this CSS contract is the layout proof, so a
    // section can no longer shrink under its list and let it paint over the credit.
    const text = stylesheet();
    const section = /(?:^|\n)\.hud-section \{([^}]*)\}/.exec(text)?.[1] ?? "";
    expect(section).toContain("display: flex");
    expect(section).toContain("flex-direction: column");
    expect(section).toContain("min-height: 0");

    const lists = /(?:^|\n)\.hud-bots,\n\.hud-events \{([^}]*)\}/.exec(text)?.[1] ?? "";
    expect(lists).toContain("flex: 1 1 auto");
    expect(lists).toContain("min-height: 0");
    expect(lists).toContain("overflow-y: auto");

    const credit = text.slice(text.indexOf("\n.hud-credit {")).split("}")[0] ?? "";
    expect(credit).toContain("flex: none");
  });

  it("keeps the panel inside its max height with a full roster and feed", () => {
    const bots = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => {
        const id = `bot-${index}`;
        return [id, bot({ id, name: `Bot ${index}` })];
      }),
    );
    const events = Array.from({ length: 20 }, (_, index) => event(index + 1));
    const markup = renderToStaticMarkup(
      <HudView bots={bots} events={events} now={Date.parse(AT)} variant="wide" />,
    );

    expect(markup).toContain("hud hud-wide");
    expect(markup).toContain("max-height:55vh");
    // Both sections carry their own heading, list and the credit stays a sibling.
    expect(markup.match(/class="hud-section"/g)).toHaveLength(2);
    expect(markup.match(/class="hud-bot"/g)).toHaveLength(10);
    expect(markup.match(/class="hud-event"/g)).toHaveLength(20);
    expect(markup.indexOf('class="hud-credit"')).toBeGreaterThan(
      markup.indexOf('class="hud-events"'),
    );
  });
});
