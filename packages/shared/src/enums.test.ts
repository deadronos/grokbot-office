import { describe, expect, it } from "vitest";

import { BOT_STATUSES, EVENT_TYPES, PODS, TASK_RESULTS } from "./enums";

describe("enums", () => {
  it("lists the five bot statuses", () => {
    expect(BOT_STATUSES).toEqual(["idle", "working", "waiting", "reviewing", "offline"]);
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
});
