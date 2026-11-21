import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import { useOfficeStore } from "../store/officeStore";
import { BOT_COLORS } from "./botColors";
import { DESK_STATIONS, type DeskStation } from "./deskStations";
import {
  PACKET_SIZE,
  consumedSeqAtFirstRun,
  deskStation,
  liveSendsFromEvents,
  packetPose,
  settlePackets,
  syncPackets,
  trayCount,
  traySlotPoint,
  type PacketTimeline,
} from "./handoffPackets";

const TRAY_COLOR = "#5a6474";
const TRAY_INSET = "#232a35";
const BADGE_RADIUS = 0.13;

/**
 * Tracks handoff packets from the store: a live `handoff_sent` newer than the
 * last consumed seq flies (keyed by handoff id, so a replay batch flies each
 * one), handoffs already open at connect start in the tray, and an accept
 * lifts the packet out from wherever it is.
 */
export function useHandoffPackets(reducedMotion: boolean): {
  packets: PacketTimeline[];
  settle: (now: number) => void;
} {
  const openHandoffs = useOfficeStore((state) => state.openHandoffs);
  const [packets, setPackets] = useState<PacketTimeline[]>([]);
  // The frame loop must see the newest packets without re-subscribing each frame.
  const packetsRef = useRef<PacketTimeline[]>(packets);
  // Everything already in the store when this first runs is snapshot history.
  const consumedSeqRef = useRef<number | null>(null);

  useEffect(() => {
    const now = performance.now();
    const state = useOfficeStore.getState();
    const newestEventSeq = state.events.reduce((max, event) => Math.max(max, event.seq), 0);
    // Seed from the snapshot: a send that arrived while this chunk loaded is
    // newer than `snapshotSeq` and must still fly.
    const lastConsumedSeq = consumedSeqAtFirstRun({
      consumed: consumedSeqRef.current,
      snapshotSeq: state.snapshotSeq,
      lastEventSeq: state.lastEventSeq,
      newestEventSeq,
    });
    const live = liveSendsFromEvents({
      events: state.events,
      lastConsumedSeq,
      now,
      reducedMotion,
    });
    consumedSeqRef.current = Math.max(live.lastConsumedSeq, newestEventSeq);
    if (state.handoffFlash) state.clearHandoffFlash();
    const next = syncPackets({
      previous: packetsRef.current,
      openHandoffs,
      liveSends: live.liveSends,
      now,
      reducedMotion,
    });
    packetsRef.current = next;
    setPackets(next);
  }, [openHandoffs, reducedMotion]);

  const settle = useCallback(
    (now: number) => {
      const previous = packetsRef.current;
      const next = settlePackets(previous, now, reducedMotion);
      if (next === previous) return;
      packetsRef.current = next;
      setPackets(next);
    },
    [reducedMotion],
  );

  return { packets, settle };
}

function createCountTexture(count: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for tray counts");
  context.beginPath();
  context.arc(64, 64, 52, 0, Math.PI * 2);
  context.fillStyle = count > 0 ? "#f4c46a" : "#3a4250";
  context.fill();
  context.lineWidth = 10;
  context.strokeStyle = "#141821";
  context.stroke();
  context.font = "700 64px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = count > 0 ? "#141821" : "#8b93a1";
  context.fillText(String(count), 64, 66);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Open-handoff count over a tray: a canvas texture, so no font or sprite asset. */
function TrayBadge({ station, count }: { station: DeskStation; count: number }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const texture = useMemo(() => createCountTexture(count), [count]);
  useEffect(() => () => texture.dispose(), [texture]);
  useFrame(({ camera }) => {
    meshRef.current?.quaternion.copy(camera.quaternion);
  });
  const [x, y, z] = station.tray.position;
  return (
    <mesh ref={meshRef} position={[x, y + 0.42, z]}>
      <planeGeometry args={[BADGE_RADIUS * 2, BADGE_RADIUS * 2]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

function Tray({ station }: { station: DeskStation }) {
  return (
    <group position={station.tray.position} rotation={[0, station.tray.rotationY, 0]}>
      <mesh position={[0, -0.025, 0]}>
        <boxGeometry args={[0.36, 0.05, 0.26]} />
        <meshLambertMaterial color={TRAY_COLOR} />
      </mesh>
      {/* Top just under the rim so its face cannot z-fight with the base. */}
      <mesh position={[0, -0.018, 0]}>
        <boxGeometry args={[0.28, 0.026, 0.2]} />
        <meshLambertMaterial color={TRAY_INSET} />
      </mesh>
    </group>
  );
}

/** One packet: a sender-coloured cube with a dark band, placed by its timeline. */
function Packet({
  packet,
  slot,
  reducedMotion,
}: {
  packet: PacketTimeline;
  slot: number;
  reducedMotion: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const from = deskStation(packet.fromBotId);
  const to = deskStation(packet.toBotId);
  const tray = useMemo(() => (to ? traySlotPoint(to, slot) : null), [to, slot]);

  useFrame(() => {
    const group = groupRef.current;
    if (!group || !from || !to) return;
    const pose = packetPose(packet, from, to, slot, performance.now(), reducedMotion);
    group.visible = pose !== null;
    if (pose) group.position.set(pose[0], pose[1], pose[2]);
  });

  if (!from || !to || !tray) return null;
  return (
    <group ref={groupRef} position={tray}>
      <mesh>
        <boxGeometry args={[PACKET_SIZE, PACKET_SIZE, PACKET_SIZE]} />
        <meshLambertMaterial color={BOT_COLORS[packet.fromBotId] ?? "#f4f6fb"} />
      </mesh>
      <mesh position={[0, PACKET_SIZE * 0.18, 0]}>
        <boxGeometry args={[PACKET_SIZE * 1.04, PACKET_SIZE * 0.3, PACKET_SIZE * 1.04]} />
        <meshBasicMaterial color="#141821" />
      </mesh>
    </group>
  );
}

/** Advances packet phases at their exact boundary, then draws trays and packets. */
export function HandoffPackets({
  packets,
  settle,
  reducedMotion,
}: {
  packets: readonly PacketTimeline[];
  settle: (now: number) => void;
  reducedMotion: boolean;
}) {
  const openHandoffs = useOfficeStore((state) => state.openHandoffs);

  useFrame(() => settle(performance.now()));

  return (
    <>
      {DESK_STATIONS.map((station) => (
        <group key={station.desk.botId}>
          <Tray station={station} />
          <TrayBadge station={station} count={trayCount(openHandoffs, station.desk.botId)} />
        </group>
      ))}
      {packets.map((packet) => (
        <Packet
          key={packet.handoffId}
          packet={packet}
          slot={packet.slot}
          reducedMotion={reducedMotion}
        />
      ))}
    </>
  );
}
