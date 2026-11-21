import type { Handoff, StreamEvent } from "@grokbot-office/shared";
import { describe, expect, it } from "vitest";

import { DESK_STATIONS, type DeskStation } from "./deskStations";
import {
  PACKET_ARC_HEIGHT,
  PACKET_FLIGHT_MS,
  PACKET_PICKUP_MS,
  liveSendsFromEvents,
  packetPhase,
  packetPose,
  packetPosition,
  packetStartPoint,
  packetsAnimating,
  pickupPosition,
  settlePackets,
  syncPackets,
  trayCount,
  traySlotPoint,
  traySlots,
  type PacketTimeline,
} from "./handoffPackets";

function station(botId: string): DeskStation {
  const found = DESK_STATIONS.find((entry) => entry.desk.botId === botId);
  if (!found) throw new Error(`no desk for ${botId}`);
  return found;
}

function handoff(id: string, fromBotId: string, toBotId: string): Handoff {
  return {
    id,
    fromBotId,
    toBotId,
    state: "sent",
    sentAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Component-wise float comparison, since the arc lands on 0.1 sums. */
function expectClose(actual: number[], expected: readonly number[]): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!));
}

/** `count` live sends, all stamped at the same instant as `h1`, `h2`, … */
function settles(count: number): Map<string, number> {
  return new Map([...Array(count)].map((_, index) => [`h${index + 1}`, 0]));
}

function packet(
  handoffId: string,
  fromBotId: string,
  toBotId: string,
  overrides: Partial<PacketTimeline> = {},
): PacketTimeline {
  return { handoffId, fromBotId, toBotId, sentAt: null, acceptedAt: null, slot: 0, ...overrides };
}

function sentEvent(
  seq: number,
  fromBotId: string,
  toBotId: string,
  handoffId: string,
): StreamEvent {
  return {
    seq,
    botId: fromBotId,
    type: "handoff_sent",
    handoffId,
    to: toBotId,
    receivedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("packet flight", () => {
  it("flies for 1.2 s", () => {
    expect(PACKET_FLIGHT_MS).toBe(1_200);
  });

  it("starts at the sender and ends exactly at the tray", () => {
    const start = packetStartPoint(station("data"));
    const end = traySlotPoint(station("wesley"), 0);
    expectClose(packetPosition(start, end, 0), start);
    expectClose(packetPosition(start, end, 1), end);
    // Out-of-range samples clamp instead of overshooting.
    expectClose(packetPosition(start, end, -1), start);
    expectClose(packetPosition(start, end, 2), end);
    expectClose(packetPosition(start, end, Number.NaN), start);
  });

  it("peaks a clear arc above the straight line", () => {
    const start: [number, number, number] = [-4.5, 1.12, 3];
    const end: [number, number, number] = [-1.5, 0.98, 3];
    const mid = packetPosition(start, end, 0.5);
    const straight = (start[1] + end[1]) / 2;
    expect(mid[0]).toBeCloseTo((start[0] + end[0]) / 2);
    expect(mid[2]).toBeCloseTo((start[2] + end[2]) / 2);
    expect(mid[1]).toBeCloseTo(straight + PACKET_ARC_HEIGHT);
    expect(mid[1]).toBeGreaterThan(start[1]);
    expect(mid[1]).toBeGreaterThan(end[1]);
    // Monotone height on each half of the arc.
    expect(packetPosition(start, end, 0.25)[1]).toBeLessThan(mid[1]);
    expect(packetPosition(start, end, 0.75)[1]).toBeLessThan(mid[1]);
  });

  it("stacks landed packets in distinct tray slots", () => {
    const wesley = station("wesley");
    const slots = [0, 1, 2, 3].map((slot) => traySlotPoint(wesley, slot));
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        expect(slots[i]).not.toEqual(slots[j]);
      }
      expect(slots[i]![1]).toBeGreaterThan(wesley.tray.position[1]);
    }
  });
});

describe("tray counts", () => {
  it("counts only the open handoffs addressed to that bot", () => {
    const open = [
      handoff("h1", "data", "wesley"),
      handoff("h2", "geordi", "wesley"),
      handoff("h3", "wesley", "data"),
    ];
    expect(trayCount([], "wesley")).toBe(0);
    expect(trayCount(open, "wesley")).toBe(2);
    expect(trayCount(open, "data")).toBe(1);
    expect(trayCount(open, "lumi")).toBe(0);
  });
});

describe("packet lifecycle", () => {
  it("flies, then lands in the tray", () => {
    const from = station("data");
    const to = station("wesley");
    const flying = packet("h1", "data", "wesley", { sentAt: 1_000 });

    expect(packetPhase(flying, 1_000, false)).toBe("flying");
    expect(packetPose(flying, from, to, 0, 1_000, false)).toEqual(packetStartPoint(from));
    const mid = packetPose(flying, from, to, 0, 1_000 + PACKET_FLIGHT_MS / 2, false);
    expect(mid![1]).toBeGreaterThan(packetStartPoint(from)[1]);
    expect(packetPose(flying, from, to, 0, 1_000 + PACKET_FLIGHT_MS, false)).toEqual(
      traySlotPoint(to, 0),
    );
  });

  it("sits in the tray with no flight for snapshot handoffs", () => {
    const from = station("data");
    const to = station("wesley");
    const landed = packet("h1", "data", "wesley");
    expect(packetPhase(landed, 0, false)).toBe("landed");
    expect(packetPose(landed, from, to, 0, 0, false)).toEqual(traySlotPoint(to, 0));
  });

  it("picks up a landed packet from its tray and is gone after the pickup", () => {
    const to = station("wesley");
    const tray = traySlotPoint(to, 0);
    const accepted = packet("h1", "data", "wesley", { acceptedAt: 1_000 });
    expect(packetPhase(accepted, 1_000, false)).toBe("picking");
    expect(packetPose(accepted, station("data"), to, 0, 1_000, false)).toEqual(tray);

    const half = packetPose(accepted, station("data"), to, 0, 1_000 + PACKET_PICKUP_MS / 2, false);
    const seat = to.bot.position;
    const distance = (point: [number, number, number]) =>
      Math.hypot(point[0] - seat[0], point[1] - seat[1], point[2] - seat[2]);
    expect(distance(half!)).toBeLessThan(distance(tray));

    expect(packetPhase(accepted, 1_000 + PACKET_PICKUP_MS, false)).toBe("gone");
    expect(
      packetPose(accepted, station("data"), to, 0, 1_000 + PACKET_PICKUP_MS, false),
    ).toBeNull();
  });

  it("continues a mid-air accept from where the packet is", () => {
    const from = station("data");
    const to = station("wesley");
    const tray = traySlotPoint(to, 0);
    const accepted = packet("h1", "data", "wesley", { sentAt: 0, acceptedAt: 300 });
    const arc = packetPosition(packetStartPoint(from), tray, 300 / PACKET_FLIGHT_MS);

    expect(packetPhase(accepted, 300, false)).toBe("picking");
    // The pickup starts where the arc was, not back at the tray.
    expectClose(packetPose(accepted, from, to, 0, 300, false)!, arc);
    expect(packetPose(accepted, from, to, 0, 300, false)).not.toEqual(tray);

    const half = packetPose(accepted, from, to, 0, 300 + PACKET_PICKUP_MS / 2, false)!;
    const seat = to.bot.position;
    const distance = (point: [number, number, number]) =>
      Math.hypot(point[0] - seat[0], point[1] - seat[1], point[2] - seat[2]);
    expect(distance(half)).toBeLessThan(distance(arc));

    expect(packetPhase(accepted, 300 + PACKET_PICKUP_MS, false)).toBe("gone");
    expect(packetPose(accepted, from, to, 0, 300 + PACKET_PICKUP_MS, false)).toBeNull();
  });

  it("falls back to the tray when the accept lands after the flight", () => {
    const from = station("data");
    const to = station("wesley");
    const accepted = packet("h1", "data", "wesley", {
      sentAt: 0,
      acceptedAt: PACKET_FLIGHT_MS + 200,
    });
    expect(packetPose(accepted, from, to, 0, PACKET_FLIGHT_MS + 200, false)).toEqual(
      traySlotPoint(to, 0),
    );
  });

  it("snaps under reduced motion: send is already in the tray, accept is gone", () => {
    const from = station("data");
    const to = station("wesley");
    const flying = packet("h1", "data", "wesley", { sentAt: 0 });
    expect(packetPhase(flying, 0, true)).toBe("landed");
    expect(packetPose(flying, from, to, 0, 0, true)).toEqual(traySlotPoint(to, 0));
    expect(packetPhase({ ...flying, acceptedAt: 0 }, 0, true)).toBe("gone");
    expect(packetPose({ ...flying, acceptedAt: 0 }, from, to, 0, 0, true)).toBeNull();
  });
});

describe("concurrent packets", () => {
  it("tracks two sends to the same desk and one in the other direction", () => {
    const open = [
      handoff("h1", "data", "wesley"),
      handoff("h2", "geordi", "wesley"),
      handoff("h3", "wesley", "data"),
    ];
    const packets = syncPackets({
      previous: [],
      openHandoffs: open,
      liveSends: settles(3),
      now: 0,
      reducedMotion: false,
    });
    expect(packets).toHaveLength(3);
    expect(packets.every((entry) => entry.sentAt === 0)).toBe(true);

    const slots = traySlots(packets);
    expect(slots.get("h1")).not.toBe(slots.get("h2"));
    // The opposite direction has its own tray numbering.
    expect(slots.get("h3")).toBe(0);
    expect(packetsAnimating(packets)).toBe(true);
  });

  it("keeps snapshot packets landed while live sends fly", () => {
    const open = [handoff("h1", "data", "wesley"), handoff("h2", "geordi", "wesley")];
    const packets = syncPackets({
      previous: [],
      openHandoffs: open,
      liveSends: new Map([["h2", 0]]),
      now: 0,
      reducedMotion: false,
    });
    expect(
      packetPhase(
        packets.find((entry) => entry.handoffId === "h1")!,
        0,
        false,
      ),
    ).toBe("landed");
    expect(
      packetPhase(
        packets.find((entry) => entry.handoffId === "h2")!,
        0,
        false,
      ),
    ).toBe("flying");
  });

  it("accepts one packet while another is still flying", () => {
    const open = [handoff("h1", "data", "wesley"), handoff("h2", "geordi", "wesley")];
    const flying = syncPackets({
      previous: [],
      openHandoffs: open,
      liveSends: settles(2),
      now: 0,
      reducedMotion: false,
    });
    expect(packetPhase(flying[0]!, 500, false)).toBe("flying");

    const accepted = syncPackets({
      previous: flying,
      openHandoffs: [open[1]!],
      liveSends: new Map(),
      now: 500,
      reducedMotion: false,
    });
    const picked = accepted.find((entry) => entry.handoffId === "h1")!;
    expect(packetPhase(picked, 500, false)).toBe("picking");
    expect(
      packetPhase(
        accepted.find((entry) => entry.handoffId === "h2")!,
        500,
        false,
      ),
    ).toBe("flying");

    const settled = settlePackets(accepted, 500 + PACKET_PICKUP_MS, false);
    expect(settled.map((entry) => entry.handoffId)).toEqual(["h2"]);
  });

  it("snaps a mid-flight packet into the tray when reduced motion turns on", () => {
    const flying = [packet("h1", "data", "wesley", { sentAt: 0 })];
    const snapped = syncPackets({
      previous: flying,
      openHandoffs: [handoff("h1", "data", "wesley")],
      liveSends: new Map(),
      now: 300,
      reducedMotion: true,
    });
    expect(snapped[0]!.sentAt).toBeNull();
    expect(packetsAnimating(snapped)).toBe(false);
  });

  it("drops the accept instantly under reduced motion", () => {
    const open = [handoff("h1", "data", "wesley")];
    const packets = syncPackets({
      previous: [],
      openHandoffs: open,
      liveSends: settles(1),
      now: 0,
      reducedMotion: true,
    });
    expect(packets[0]!.sentAt).toBeNull();
    expect(
      syncPackets({
        previous: packets,
        openHandoffs: [],
        liveSends: new Map(),
        now: 10,
        reducedMotion: true,
      }),
    ).toEqual([]);
  });
});

describe("live sends from the event feed", () => {
  it("ignores handoffs a snapshot already brought in", () => {
    const events = [sentEvent(4, "data", "wesley", "h1"), sentEvent(5, "geordi", "wesley", "h2")];
    const { liveSends, lastConsumedSeq } = liveSendsFromEvents({
      events,
      lastConsumedSeq: 5,
      now: 100,
      reducedMotion: false,
    });
    expect(liveSends.size).toBe(0);
    expect(lastConsumedSeq).toBe(5);

    // A leftover {data → wesley} flash must not launch the open pair either.
    const packets = syncPackets({
      previous: [],
      openHandoffs: [handoff("h1", "data", "wesley"), handoff("h2", "geordi", "wesley")],
      liveSends,
      now: 100,
      reducedMotion: false,
    });
    expect(packets.every((entry) => entry.sentAt === null)).toBe(true);
  });

  it("starts a flight for every handoff in a synchronous replay batch", () => {
    const events = [
      sentEvent(1, "data", "wesley", "h1"),
      sentEvent(2, "geordi", "wesley", "h2"),
      // Same pair as h1, and an opposite direction: each is its own flight.
      sentEvent(3, "data", "wesley", "h3"),
      sentEvent(4, "wesley", "data", "h4"),
    ];
    const { liveSends } = liveSendsFromEvents({
      events,
      lastConsumedSeq: 0,
      now: 50,
      reducedMotion: false,
    });
    expect([...liveSends.keys()].toSorted()).toEqual(["h1", "h2", "h3", "h4"]);
    for (const startedAt of liveSends.values()) expect(startedAt).toBe(50);
  });

  it("consumes only events newer than the last consumed seq", () => {
    const events = [
      sentEvent(7, "data", "wesley", "h1"),
      sentEvent(8, "geordi", "wesley", "h2"),
      sentEvent(9, "data", "wesley", "h3"),
    ];
    const { liveSends, lastConsumedSeq } = liveSendsFromEvents({
      events,
      lastConsumedSeq: 7,
      now: 10,
      reducedMotion: false,
    });
    // The earlier h1 is already seen; the newer two fly.
    expect([...liveSends.keys()].toSorted()).toEqual(["h2", "h3"]);
    expect(lastConsumedSeq).toBe(9);
  });

  it("consumes without flying under reduced motion", () => {
    const events = [sentEvent(3, "data", "wesley", "h1"), sentEvent(4, "data", "data", "h2")];
    const { liveSends, lastConsumedSeq } = liveSendsFromEvents({
      events,
      lastConsumedSeq: 2,
      now: 10,
      reducedMotion: true,
    });
    expect(liveSends.size).toBe(0);
    expect(lastConsumedSeq).toBe(4);
  });

  it("ignores sends without a handoff id and other events", () => {
    const events: StreamEvent[] = [
      sentEvent(5, "data", "wesley", "h1"),
      { ...sentEvent(6, "data", "wesley", "h2"), handoffId: undefined },
      { ...sentEvent(7, "data", "wesley", "h3"), type: "handoff_accepted" },
    ];
    const { liveSends } = liveSendsFromEvents({
      events,
      lastConsumedSeq: 4,
      now: 0,
      reducedMotion: false,
    });
    expect([...liveSends.keys()]).toEqual(["h1"]);
  });
});

describe("stable tray slots", () => {
  const h1 = packet("h1", "data", "wesley", { sentAt: 1 });
  const h2 = packet("h2", "geordi", "wesley", { sentAt: 2 });
  const h3 = packet("h3", "lumi", "wesley", { sentAt: 3 });

  it("keeps landed slots when the middle packet leaves", () => {
    const before = traySlots([h1, h2, h3]);
    expect([before.get("h1"), before.get("h2"), before.get("h3")]).toEqual([0, 1, 2]);

    const after = traySlots([h1, h3], before);
    expect(after.get("h1")).toBe(0);
    expect(after.get("h3")).toBe(2);
  });

  it("lets a new packet reuse a freed slot without moving the others", () => {
    const before = traySlots([h1, h2, h3]);
    const after = traySlots([h1, h3], before);
    const h4 = packet("h4", "wesley", "geordi", { sentAt: 4 });
    const h5 = packet("h5", "data", "wesley", { sentAt: 5 });
    const next = traySlots([h1, h3, h5], after);
    expect(next.get("h1")).toBe(0);
    expect(next.get("h3")).toBe(2);
    expect(next.get("h5")).toBe(1);
    // Another desk keeps its own numbering.
    expect(traySlots([h4]).get("h4")).toBe(0);
  });

  it("numbers a fresh tray from scratch, snapshot packets first", () => {
    const snapshot = packet("s1", "data", "wesley");
    const slots = traySlots([h2, snapshot]);
    expect(slots.get("s1")).toBe(0);
    expect(slots.get("h2")).toBe(1);
  });
});

describe("settlePackets", () => {
  it("moves a flight to the tray once its time is up", () => {
    const flying = [packet("h1", "data", "wesley", { sentAt: 0 })];
    expect(packetPhase(flying[0]!, PACKET_FLIGHT_MS - 1, false)).toBe("flying");
    const settled = settlePackets(flying, PACKET_FLIGHT_MS, false);
    expect(settled[0]!.sentAt).toBeNull();
    expect(packetPhase(settled[0]!, PACKET_FLIGHT_MS, false)).toBe("landed");
  });

  it("removes a finished pickup", () => {
    const picked = [packet("h1", "data", "wesley", { acceptedAt: 0 })];
    expect(settlePackets(picked, PACKET_PICKUP_MS, false)).toEqual([]);
  });

  it("returns the same array while nothing changes", () => {
    const landed = [packet("h1", "data", "wesley")];
    expect(settlePackets(landed, 5_000, false)).toBe(landed);
    expect(settlePackets(landed, 5_000, true)).toBe(landed);
  });
});

describe("packet animation flag", () => {
  it("is on for a flight or pickup, off for a landed packet", () => {
    expect(packetsAnimating([packet("h1", "data", "wesley")])).toBe(false);
    expect(packetsAnimating([packet("h1", "data", "wesley", { sentAt: 0 })])).toBe(true);
    expect(packetsAnimating([packet("h1", "data", "wesley", { acceptedAt: 0 })])).toBe(true);
    expect(packetsAnimating([])).toBe(false);
  });
});

describe("tray placement", () => {
  it("puts a tray on every desk, just above the desk top and below the screen", () => {
    for (const entry of DESK_STATIONS) {
      expect(entry.tray.position[1]).toBeGreaterThan(entry.deskBody.position[1] + 0.37);
      expect(entry.tray.position[1]).toBeLessThan(entry.screen.position[1]);
      expect(entry.packetLaunch.position[1]).toBeGreaterThan(entry.tray.position[1]);
    }
  });

  it("lifts every packet's pickup toward its own receiver", () => {
    for (const entry of DESK_STATIONS) {
      const tray = traySlotPoint(entry, 0);
      const end = pickupPosition(tray, entry, 1);
      expect(end[0]).toBeCloseTo(entry.bot.position[0]);
      expect(end[2]).toBeCloseTo(entry.bot.position[2]);
      expect(end[1]).toBeGreaterThan(tray[1]);
    }
  });
});
