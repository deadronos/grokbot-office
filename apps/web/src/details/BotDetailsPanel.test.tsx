import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { BotSnapshot, Handoff, StreamEvent } from "@grokbot-office/shared";

import {
  BotDetailsView,
  focusRestoreTarget,
  isCloseKey,
  panelBot,
  retargetFocus,
} from "./BotDetailsPanel";
import { botDetails } from "./botDetails";

const AT = "2026-01-01T00:00:00.000Z";

const bot = (overrides: Partial<BotSnapshot> = {}): BotSnapshot => ({
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
  type: "task_started",
  taskId: `task-${seq}`,
  receivedAt: AT,
  ...overrides,
});

const handoff = (
  id: string,
  from: string,
  to: string,
  overrides: Partial<Handoff> = {},
): Handoff => ({
  id,
  fromBotId: from,
  toBotId: to,
  state: "sent",
  sentAt: AT,
  ...overrides,
});

function renderPanel(
  subject: BotSnapshot,
  openHandoffs: Handoff[] = [],
  events: StreamEvent[] = [],
): string {
  const bots = {
    [subject.id]: subject,
    wesley: bot({ id: "wesley", name: "Wesley" }),
    geordi: bot({ id: "geordi", name: "Geordi" }),
  };
  return renderToStaticMarkup(
    <BotDetailsView
      bot={subject}
      details={botDetails(subject, openHandoffs, events, bots)}
      onClose={() => {}}
    />,
  );
}

describe("isCloseKey", () => {
  it("closes on Escape only", () => {
    expect(isCloseKey("Escape")).toBe(true);
    expect(isCloseKey("Esc")).toBe(false);
    expect(isCloseKey("Enter")).toBe(false);
  });
});

describe("BotDetailsView", () => {
  it("is a named dialog with the bot's role, status, task, handoffs and events", () => {
    const html = renderPanel(
      bot({ label: "issue-19", taskId: "issue-19" }),
      [
        handoff("in-1", "wesley", "data", { label: "review packet" }),
        handoff("out-1", "data", "geordi"),
      ],
      [event(1, { taskId: "issue-13" }), event(2, { taskId: "issue-19" })],
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="bot-details-name"');
    expect(html).toContain('id="bot-details-name"');
    expect(html).toContain("Data");
    expect(html).toContain("Code-Orchestrator");
    expect(html).toContain("working");
    expect(html).toContain("issue-19");
    expect(html).toContain("wesley → data");
    expect(html).toContain("review packet");
    expect(html).toContain("data → geordi");
    expect(html).toContain("started · issue-19");
    // Newest first.
    expect(html.indexOf("issue-19<")).toBeLessThan(html.indexOf("issue-13"));
    expect(html).toMatch(
      /type="button"[^>]*class="details-close"|class="details-close"[^>]*type="button"/,
    );
    expect(html).toContain(">Close<");
  });

  it("handles an empty bot with empty states", () => {
    const html = renderPanel(bot({ id: "wesley", name: "Wesley", status: "idle" }));
    expect(html).toContain("None open.");
    expect(html).toContain("No events yet.");
    expect(html).not.toContain("Task id");
  });

  it("renders every label as text, never as markup", () => {
    const html = renderPanel(
      bot({
        name: "<img src=x onerror=alert(1)>",
        role: "<script>alert(1)</script>",
        label: "<b>bold</b>",
        taskId: "<i>task</i>",
      }),
      [handoff("in-1", "wesley", "data", { label: "<b>handoff</b>" })],
      [event(1, { label: "<svg onload=alert(1)>" })],
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).not.toContain("<svg");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&lt;b&gt;handoff&lt;/b&gt;");
  });
});

/** A stand-in focus target: the helpers only need focus() and isConnected. */
function target(isConnected = true) {
  const element = {
    isConnected,
    focusCount: 0,
    focus(): void {
      element.focusCount += 1;
    },
  };
  return element;
}

describe("focus restore", () => {
  it("returns focus to the row that opened the panel", () => {
    const row = target();
    const body = target();
    expect(focusRestoreTarget(row, body)).toBe(row);
  });

  it("falls back to the body when that row is gone", () => {
    const body = target();
    expect(focusRestoreTarget(target(false), body)).toBe(body);
    expect(focusRestoreTarget(null, body)).toBe(body);

    focusRestoreTarget(target(false), body).focus();
    expect(body.focusCount).toBe(1);
  });

  it("retargets the stored row when another bot is chosen in place", () => {
    const first = target();
    const second = target();
    const retargeted = retargetFocus(first, second);
    expect(retargeted).toBe(second);
    // Closing after the switch returns to the new row, not the original one.
    expect(focusRestoreTarget(retargeted, target())).toBe(second);
    // Nothing held focus at the switch: keep what we had.
    expect(retargetFocus(first, null)).toBe(first);
  });
});

describe("panelBot", () => {
  it("resolves only a selected bot that is in the snapshot", () => {
    const data = bot();
    const bots = { data };

    expect(panelBot({ bots, selectedBotId: "data" })).toBe(data);
    expect(panelBot({ bots, selectedBotId: "quark" })).toBeUndefined();
    expect(panelBot({ bots, selectedBotId: null })).toBeUndefined();
  });
});
