import { describe, expect, it } from "vitest";

import {
  EventIn,
  EventsBatch,
  HeartbeatBody,
  RegisterBody,
  StateSnapshot,
  StreamEvent,
} from "./schemas";

const ULID = "01JD7X5K2M3Q8V9R4T6Y0ZB1AC";
const UUID = "3f0c8b2e-9a4d-4c6e-8f1a-2b3c4d5e6f70";
const AT = "2026-11-15T01:10:00Z";

const batch = (count: number) => ({ events: Array.from({ length: count }, () => event) });

const event = {
  eventId: ULID,
  botId: "data",
  type: "task_started",
  at: AT,
  label: "Plan bot-office",
  taskId: "bo-plan",
};

describe("RegisterBody", () => {
  it("accepts a registration", () => {
    const parsed = RegisterBody.parse({
      id: "data",
      name: "Data",
      role: "Code-Orchestrator",
      avatar: "android-gold",
      pod: "dev",
    });
    expect(parsed.id).toBe("data");
  });

  it("rejects non-slug ids, unknown pods and missing fields", () => {
    expect(
      RegisterBody.safeParse({ id: "Data", name: "Data", role: "r", avatar: "a", pod: "dev" })
        .success,
    ).toBe(false);
    expect(
      RegisterBody.safeParse({ id: "data", name: "Data", role: "r", avatar: "a", pod: "sales" })
        .success,
    ).toBe(false);
    expect(RegisterBody.safeParse({ id: "data", name: "Data" }).success).toBe(false);
  });
});

describe("HeartbeatBody", () => {
  it("accepts an empty body or a status", () => {
    expect(HeartbeatBody.safeParse({}).success).toBe(true);
    expect(HeartbeatBody.safeParse({ status: "working" }).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(HeartbeatBody.safeParse({ status: "busy" }).success).toBe(false);
  });
});

describe("EventIn", () => {
  it("accepts an event for every client type", () => {
    expect(EventIn.safeParse(event).success).toBe(true);
    expect(
      EventIn.safeParse({ ...event, type: "status_changed", status: "reviewing" }).success,
    ).toBe(true);
    expect(EventIn.safeParse({ ...event, type: "task_finished", result: "done" }).success).toBe(
      true,
    );
    expect(
      EventIn.safeParse({ ...event, type: "handoff_sent", to: "lumi", handoffId: "h-42" }).success,
    ).toBe(true);
    expect(
      EventIn.safeParse({ ...event, type: "handoff_accepted", handoffId: "h-42" }).success,
    ).toBe(true);
  });

  it("requires the fields each type needs", () => {
    expect(EventIn.safeParse({ ...event, type: "status_changed" }).success).toBe(false);
    expect(EventIn.safeParse({ ...event, type: "task_finished" }).success).toBe(false);
    expect(EventIn.safeParse({ ...event, type: "handoff_sent", handoffId: "h-42" }).success).toBe(
      false,
    );
    expect(EventIn.safeParse({ ...event, type: "handoff_sent", to: "lumi" }).success).toBe(false);
    expect(EventIn.safeParse({ ...event, type: "handoff_accepted" }).success).toBe(false);
  });

  it("rejects server-only and unknown types", () => {
    expect(EventIn.safeParse({ ...event, type: "offline" }).success).toBe(false);
    expect(EventIn.safeParse({ ...event, type: "bot_registered" }).success).toBe(false);
    expect(EventIn.safeParse({ ...event, type: "exploded" }).success).toBe(false);
  });

  it("requires a ULID or UUID eventId", () => {
    expect(EventIn.safeParse({ ...event, eventId: UUID }).success).toBe(true);
    expect(EventIn.safeParse({ ...event, eventId: "01JD7X5K2M3Q8V9R4T6Y0ZB1AI" }).success).toBe(
      false,
    ); // I not in base32
    expect(EventIn.safeParse({ ...event, eventId: "not-an-id" }).success).toBe(false);
    expect(EventIn.safeParse({ ...event, eventId: undefined }).success).toBe(false);
  });

  it("rejects a non-ISO at", () => {
    expect(EventIn.safeParse({ ...event, at: "yesterday" }).success).toBe(false);
  });
});

describe("label and ref limits", () => {
  it("accepts 80/120 chars and rejects 81/121", () => {
    expect(
      EventIn.safeParse({ ...event, label: "a".repeat(80), ref: "b".repeat(120) }).success,
    ).toBe(true);
    expect(EventIn.safeParse({ ...event, label: "a".repeat(81) }).success).toBe(false);
    expect(EventIn.safeParse({ ...event, ref: "b".repeat(121) }).success).toBe(false);
  });

  it("strips control characters before counting length", () => {
    const parsed = EventIn.parse({ ...event, label: `\u0001${"b\n".repeat(80)}` });
    expect(parsed.label).toBe("b".repeat(80));
    expect(parsed.label?.length).toBe(80);
  });

  it("rejects a label that is too long only after stripping", () => {
    // 80 real chars plus control chars is still fine; 81 real chars is not.
    expect(EventIn.safeParse({ ...event, label: `\u0001${"a".repeat(80)}\t` }).success).toBe(true);
    expect(EventIn.safeParse({ ...event, label: `\u0001${"a".repeat(81)}\t` }).success).toBe(false);
  });
});

describe("EventsBatch", () => {
  it("accepts 1 to 20 events", () => {
    expect(EventsBatch.safeParse(batch(1)).success).toBe(true);
    expect(EventsBatch.safeParse(batch(20)).success).toBe(true);
  });

  it("rejects 0 and 21 events", () => {
    expect(EventsBatch.safeParse(batch(0)).success).toBe(false);
    expect(EventsBatch.safeParse(batch(21)).success).toBe(false);
  });

  it("rejects a bad event inside the batch", () => {
    expect(EventsBatch.safeParse({ events: [event, { ...event, type: "offline" }] }).success).toBe(
      false,
    );
  });
});

describe("StateSnapshot", () => {
  const snapshot = {
    bots: [
      {
        id: "data",
        name: "Data",
        role: "Code-Orchestrator",
        avatar: "android-gold",
        pod: "dev",
        desk: { botId: "data", name: "Data", pod: "dev", index: 0, x: -4.5, z: 3, facing: Math.PI },
        status: "working",
        label: "Plan bot-office",
        taskId: "bo-plan",
        since: AT,
        lastHeartbeatAt: AT,
        lastEventSeq: 1234,
      },
      {
        id: "token-optimizer",
        name: "Token optimizer",
        role: "Optimizer",
        avatar: "default",
        pod: "dev",
        status: "offline",
        since: AT,
        lastHeartbeatAt: AT,
        lastEventSeq: 0,
      },
    ],
    openHandoffs: [
      {
        id: "h-42",
        fromBotId: "data",
        toBotId: "lumi",
        label: "Review plan",
        state: "sent",
        sentAt: AT,
      },
    ],
    lastEventSeq: 1234,
  };

  it("accepts a snapshot, with and without a desk", () => {
    expect(StateSnapshot.safeParse(snapshot).success).toBe(true);
    expect(StateSnapshot.parse(snapshot).bots[1]?.desk).toBeUndefined();
  });

  it("rejects a bad status and a bad handoff state", () => {
    const badStatus = { ...snapshot, bots: [{ ...snapshot.bots[0], status: "busy" }] };
    expect(StateSnapshot.safeParse(badStatus).success).toBe(false);
    const badHandoff = {
      ...snapshot,
      openHandoffs: [{ ...snapshot.openHandoffs[0], state: "pending" }],
    };
    expect(StateSnapshot.safeParse(badHandoff).success).toBe(false);
  });
});

describe("StreamEvent", () => {
  it("accepts stored events, including server-only types", () => {
    const stored = { seq: 1234, ...event, receivedAt: AT };
    expect(StreamEvent.safeParse(stored).success).toBe(true);
    expect(StreamEvent.safeParse({ ...stored, type: "offline" }).success).toBe(true);
    expect(StreamEvent.safeParse({ ...stored, type: "bot_registered" }).success).toBe(true);
  });

  it("requires seq and receivedAt", () => {
    expect(StreamEvent.safeParse({ ...event, receivedAt: AT }).success).toBe(false);
    expect(StreamEvent.safeParse({ seq: 1234, ...event }).success).toBe(false);
  });

  it("rejects unknown types and non-positive seq", () => {
    expect(
      StreamEvent.safeParse({ seq: 1234, ...event, type: "exploded", receivedAt: AT }).success,
    ).toBe(false);
    expect(StreamEvent.safeParse({ seq: 0, ...event, receivedAt: AT }).success).toBe(false);
  });
});
