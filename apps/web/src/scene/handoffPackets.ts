import type { Handoff } from "@grokbot-office/shared";

import { DESK_STATIONS, type DeskStation } from "./deskStations";

/** A live send flies for 1.2 s from the sender's desk into the receiver's tray. */
export const PACKET_FLIGHT_MS = 1_200;
/** An accept lifts the packet out of the tray before it disappears. */
export const PACKET_PICKUP_MS = 400;
/** Arc peak above the straight line: high enough to clear desks and screens. */
export const PACKET_ARC_HEIGHT = 1.1;
/** Edge length of the procedural packet cube in world units. */
export const PACKET_SIZE = 0.16;

/** Landed packets shift inside one tray so several of them never z-fight. */
const TRAY_SLOT_STEP_X = 0.08;
const TRAY_SLOT_STEP_Y = 0.08;
const TRAY_SLOT_COLUMNS = 2;
/** The pickup ends this far above the receiver's seat, above the tray it left. */
const PICKUP_LIFT = 0.8;

export type Point = [number, number, number];

/** One handoff in the scene: a snapshot packet is already sitting in the tray. */
export type PacketTimeline = {
  handoffId: string;
  fromBotId: string;
  toBotId: string;
  /** `performance.now()` when the live flight began; null when it was already in the tray. */
  sentAt: number | null;
  /** `performance.now()` when the accept arrived; null while the handoff is open. */
  acceptedAt: number | null;
};

export type PacketPhase = "flying" | "landed" | "picking" | "gone";

const stationByBot = new Map(DESK_STATIONS.map((station) => [station.desk.botId, station]));

/** The fixed desk station for a bot, or `undefined` for a HUD-only bot. */
export function deskStation(botId: string): DeskStation | undefined {
  return stationByBot.get(botId);
}

export function clamp01(t: number): number {
  return Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
}

/** Parabola from `start` (t=0) to `end` (t=1); the midpoint sits `PACKET_ARC_HEIGHT` higher. */
export function packetPosition(start: Point, end: Point, t: number): Point {
  const k = clamp01(t);
  return [
    start[0] + (end[0] - start[0]) * k,
    start[1] + (end[1] - start[1]) * k + PACKET_ARC_HEIGHT * 4 * k * (1 - k),
    start[2] + (end[2] - start[2]) * k,
  ];
}

/** Stable launch point above the sender's desk, clear of its screen and character. */
export function packetStartPoint(station: DeskStation): Point {
  return [...station.packetLaunch.position];
}

/** Centre of tray slot `slot`: the first two side by side, later ones stacked above. */
export function traySlotPoint(station: DeskStation, slot: number): Point {
  const index = Math.max(0, Math.floor(slot));
  const column = index % TRAY_SLOT_COLUMNS;
  const row = Math.floor(index / TRAY_SLOT_COLUMNS);
  return [
    station.tray.position[0] + column * TRAY_SLOT_STEP_X,
    station.tray.position[1] + PACKET_SIZE / 2 + row * TRAY_SLOT_STEP_Y,
    station.tray.position[2],
  ];
}

/** Open handoffs addressed to one bot; the tray count, whatever is still flying. */
export function trayCount(openHandoffs: readonly Handoff[], botId: string): number {
  return openHandoffs.filter((handoff) => handoff.toBotId === botId).length;
}

/** Lifts a landed packet off the tray and toward the receiver's character. */
export function pickupPosition(tray: Point, station: DeskStation, t: number): Point {
  const k = clamp01(t);
  const ease = 1 - (1 - k) * (1 - k);
  const [x, y, z] = station.bot.position;
  return [
    tray[0] + (x - tray[0]) * ease,
    tray[1] + (y + PICKUP_LIFT - tray[1]) * ease + 0.25 * k * (1 - k),
    tray[2] + (z - tray[2]) * ease,
  ];
}

/** Where one handoff's packet is in its lifecycle right now. */
export function packetPhase(
  packet: PacketTimeline,
  now: number,
  reducedMotion: boolean,
): PacketPhase {
  if (reducedMotion) return packet.acceptedAt === null ? "landed" : "gone";
  if (packet.acceptedAt !== null) {
    return now - packet.acceptedAt < PACKET_PICKUP_MS ? "picking" : "gone";
  }
  if (packet.sentAt !== null && now - packet.sentAt < PACKET_FLIGHT_MS) return "flying";
  return "landed";
}

/** World position of one packet this frame, or null once it is gone. */
export function packetPose(
  packet: PacketTimeline,
  from: DeskStation,
  to: DeskStation,
  slot: number,
  now: number,
  reducedMotion: boolean,
): Point | null {
  const phase = packetPhase(packet, now, reducedMotion);
  if (phase === "gone") return null;
  const tray = traySlotPoint(to, slot);
  if (phase === "flying") {
    const progress = (now - (packet.sentAt ?? now)) / PACKET_FLIGHT_MS;
    return packetPosition(packetStartPoint(from), tray, progress);
  }
  if (phase === "picking") {
    const progress = (now - (packet.acceptedAt ?? now)) / PACKET_PICKUP_MS;
    return pickupPosition(tray, to, progress);
  }
  return tray;
}

/** Deterministic tray slot per handoff: snapshot packets first, then sends in order. */
export function traySlots(packets: readonly PacketTimeline[]): ReadonlyMap<string, number> {
  const ordered = packets.toSorted((a, b) => {
    const left = a.sentAt ?? Number.NEGATIVE_INFINITY;
    const right = b.sentAt ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return left < right ? -1 : 1;
    return a.handoffId.localeCompare(b.handoffId);
  });
  const nextSlot = new Map<string, number>();
  const slots = new Map<string, number>();
  for (const packet of ordered) {
    const slot = nextSlot.get(packet.toBotId) ?? 0;
    slots.set(packet.handoffId, slot);
    nextSlot.set(packet.toBotId, slot + 1);
  }
  return slots;
}

/** True while a packet is flying or being picked up: the demand loop must keep running. */
export function packetsAnimating(packets: readonly PacketTimeline[]): boolean {
  return packets.some((packet) => packet.sentAt !== null || packet.acceptedAt !== null);
}

export type SyncPacketsInput = {
  previous: readonly PacketTimeline[];
  openHandoffs: readonly Handoff[];
  /** handoffId → `performance.now()` of the live `handoff_sent`. */
  liveSends: ReadonlyMap<string, number>;
  now: number;
  reducedMotion: boolean;
};

/**
 * Rebuilds the packet list from the store's open handoffs: new live sends fly,
 * handoffs already open (snapshot) start in the tray, and a handoff that is no
 * longer open is picked up. Reduced motion snaps straight to tray/gone.
 */
export function syncPackets(input: SyncPacketsInput): PacketTimeline[] {
  const { previous, openHandoffs, liveSends, now, reducedMotion } = input;
  const next: PacketTimeline[] = [];
  for (const handoff of openHandoffs) {
    const existing = previous.find((packet) => packet.handoffId === handoff.id);
    if (existing) {
      // Still open: cancel a stale accept (a snapshot may re-add it) and keep its flight.
      next.push(existing.acceptedAt === null ? existing : { ...existing, acceptedAt: null });
      continue;
    }
    next.push({
      handoffId: handoff.id,
      fromBotId: handoff.fromBotId,
      toBotId: handoff.toBotId,
      sentAt: reducedMotion ? null : (liveSends.get(handoff.id) ?? null),
      acceptedAt: null,
    });
  }
  // Toggling reduced motion on mid-flight snaps everything straight to the tray.
  if (reducedMotion) return next.map((packet) => ({ ...packet, sentAt: null }));
  for (const packet of previous) {
    if (openHandoffs.some((handoff) => handoff.id === packet.handoffId)) continue;
    const acceptedAt = packet.acceptedAt ?? now;
    // The count already dropped with the handoff; the pickup is only the visual.
    if (now - acceptedAt < PACKET_PICKUP_MS) next.push({ ...packet, acceptedAt });
  }
  return next;
}

/**
 * Moves packets past their phase boundary. Returns the same array when nothing
 * changed, so the caller can skip a re-render.
 */
export function settlePackets(
  packets: PacketTimeline[],
  now: number,
  reducedMotion: boolean,
): PacketTimeline[] {
  if (reducedMotion) return packets;
  let changed = false;
  const next: PacketTimeline[] = [];
  for (const packet of packets) {
    if (packet.acceptedAt !== null && now - packet.acceptedAt >= PACKET_PICKUP_MS) {
      changed = true;
      continue;
    }
    if (
      packet.acceptedAt === null &&
      packet.sentAt !== null &&
      now - packet.sentAt >= PACKET_FLIGHT_MS
    ) {
      next.push({ ...packet, sentAt: null });
      changed = true;
      continue;
    }
    next.push(packet);
  }
  return changed ? next : packets;
}
