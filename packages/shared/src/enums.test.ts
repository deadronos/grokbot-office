import { describe, expect, it } from "vitest";

import {
  BOT_STATUSES,
  CLIENT_STATUSES,
  EVENT_TYPES,
  HANDOFF_STATES,
  PODS,
  SERVER_EVENT_TYPES,
  TASK_RESULTS,
} from "./enums";

describe("enums", () => {
  it("lists the bot statuses and keeps away out of client reports", () => {
    expect(BOT_STATUSES).toEqual(["idle", "working", "waiting", "reviewing", "away", "offline"]);
    expect(CLIENT_STATUSES).toEqual(["idle", "working", "waiting", "reviewing", "offline"]);
  });

  it("lists client and server-only event types", () => {
    expect(EVENT_TYPES).toEqual([
      "status_changed",
      "task_started",
      "task_finished",
      "handoff_sent",
      "handoff_accepted",
      "offline",
      "bot_registered",
    ]);
  });

  it("lists task results and pods", () => {
    expect(TASK_RESULTS).toEqual(["done", "failed", "cancelled"]);
    expect(PODS).toEqual(["command", "dev", "ops"]);
  });

  it("lists handoff states and keeps the server-only event types apart", () => {
    expect(HANDOFF_STATES).toEqual(["sent", "accepted", "cancelled"]);
    expect(SERVER_EVENT_TYPES).toEqual(["offline", "bot_registered"]);
  });
});
