import { describe, expect, it } from "vitest";

import type { BotSnapshot, Handoff, StreamEvent } from "@grokbot-office/shared";

import { DETAIL_EVENT_LIMIT, botDetails } from "./botDetails";

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
  type: "status_changed",
  status: "working",
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

describe("botDetails", () => {
  /** Both endpoints visible, except the hidden-peer cases below. */
  const bots = { data: bot(), wesley: bot({ id: "wesley", name: "Wesley" }) };

  it("splits open handoffs and keeps only this bot's events, newest first", () => {
    const detailed = bot({ label: "issue-19", taskId: "issue-19" });
    const details = botDetails(
      detailed,
      [
        handoff("in-1", "wesley", "data", { label: "review packet" }),
        handoff("out-1", "data", "wesley"),
        handoff("other", "wesley", "wesley"),
      ],
      [event(1), event(2, { botId: "wesley" }), event(3)],
      { ...bots, data: detailed },
    );

    expect(details.handoffsIn.map((item) => item.id)).toEqual(["in-1"]);
    expect(details.handoffsOut.map((item) => item.id)).toEqual(["out-1"]);
    expect(details.events.map((item) => item.seq)).toEqual([3, 1]);
  });

  it("has empty lists when nothing is open or fed yet", () => {
    const details = botDetails(bot(), [], [], bots);
    expect(details.handoffsIn).toEqual([]);
    expect(details.handoffsOut).toEqual([]);
    expect(details.events).toEqual([]);
  });

  it("shows the events that are there when the feed has fewer than ten", () => {
    const details = botDetails(bot(), [], [event(1), event(2), event(3)], bots);
    expect(details.events.map((item) => item.seq)).toEqual([3, 2, 1]);
  });

  it("caps the list at the newest ten", () => {
    const events = Array.from({ length: 15 }, (_, index) => event(index + 1));
    const details = botDetails(bot(), [], events, bots);
    expect(details.events).toHaveLength(DETAIL_EVENT_LIMIT);
    expect(details.events[0]?.seq).toBe(15);
    expect(details.events.at(-1)?.seq).toBe(6);
  });

  it("does not re-introduce a bot that is outside the snapshot", () => {
    // The store drops hidden bots from the feed and handoffs; even if a stale row
    // reached this helper, it only matches the selected (visible) bot's own id.
    const details = botDetails(bot(), [], [event(1), event(2, { botId: "quark" })], bots);
    expect(details.events.map((item) => item.botId)).toEqual(["data"]);
    expect(JSON.stringify(details)).not.toContain("quark");
  });

  it("drops a handoff that names a hidden peer on either end", () => {
    // Defence in depth: if a stale handoff still names a hidden bot, the panel
    // must not show that id (here: selected `data`, handoff data → quark).
    const details = botDetails(
      bot(),
      [
        handoff("out-hidden", "data", "quark"),
        handoff("in-hidden", "quark", "data"),
        handoff("visible", "data", "wesley"),
      ],
      [],
      bots,
    );

    expect(details.handoffsIn).toEqual([]);
    expect(details.handoffsOut.map((item) => item.id)).toEqual(["visible"]);
    expect(JSON.stringify(details)).not.toContain("quark");
  });
});
