import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { useOfficeStore } from "../store/officeStore";
import { BOT_COLORS } from "./botColors";
import { Characters } from "./Characters";
import { REVIEW_MONITOR, deskVisual, pulseFactor } from "./deskVisuals";
import {
  DESK_STATIONS,
  NAME_PLATE_SIZE,
  plateVisible,
  type DeskStation,
  type Placement,
} from "./deskStations";
import { HandoffPackets, useHandoffPackets } from "./HandoffPacketLayer";
import { deskClickSelects } from "./deskPick";
import { packetsAnimating } from "./handoffPackets";
import { setSceneInvalidator } from "./invalidateScene";
import { ModelBoundary } from "./ModelBoundary";
import { FurnitureModels } from "./models";
import { shouldRenderContinuously } from "./renderMode";
import { CAMERA, CANVAS_DPR, FRAMELOOP, ORBIT_LIMITS, SHADOWS } from "./sceneConfig";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

const ROOM = { width: 12.5, depth: 10.5, wallHeight: 3.2, wall: 0.2 };
const BACKGROUND = "#141821";
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// Static furniture placements, so their instance matrices are built exactly once.
const DESK_BODIES = DESK_STATIONS.map((station) => station.deskBody);
const SCREENS = DESK_STATIONS.map((station) => station.screen);
const SCREEN_STANDS = DESK_STATIONS.map((station) => station.screenStand);
const CHAIR_SEATS = DESK_STATIONS.map((station) => station.chairSeat);
const CHAIR_BACKS = DESK_STATIONS.map((station) => station.chairBack);

/** Registers R3F's on-demand renderer so later data changes can call `invalidateScene()`. */
function SceneInvalidator() {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    setSceneInvalidator(invalidate);
    return () => setSceneInvalidator(null);
  }, [invalidate]);
  return null;
}

/** Shell of the room: floor and two walls only, so the fixed camera looks into the corner. */
function Room() {
  return (
    <group>
      <mesh position={[0, -ROOM.wall / 2, 0]}>
        <boxGeometry args={[ROOM.width, ROOM.wall, ROOM.depth]} />
        <meshLambertMaterial color="#2c313b" />
      </mesh>
      <mesh position={[0, ROOM.wallHeight / 2, -ROOM.depth / 2]}>
        <boxGeometry args={[ROOM.width, ROOM.wallHeight, ROOM.wall]} />
        <meshLambertMaterial color="#39414f" />
      </mesh>
      <mesh position={[-ROOM.width / 2, ROOM.wallHeight / 2, 0]}>
        <boxGeometry args={[ROOM.wall, ROOM.wallHeight, ROOM.depth]} />
        <meshLambertMaterial color="#333a46" />
      </mesh>
    </group>
  );
}

/** Nine identical boxes in one draw call; matrices are set once, not per frame. */
function InstancedBoxes({
  items,
  size,
  color,
}: {
  items: Placement[];
  size: [number, number, number];
  color: string;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    items.forEach((item, index) => {
      position.set(...item.position);
      quaternion.setFromAxisAngle(Y_AXIS, item.rotationY);
      mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [items]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, items.length]} frustumCulled={false}>
      <boxGeometry args={size} />
      <meshLambertMaterial color={color} />
    </instancedMesh>
  );
}

function Furniture() {
  return (
    <group>
      <InstancedBoxes items={DESK_BODIES} size={[1.7, 0.74, 0.86]} color="#6b5138" />
      <InstancedBoxes items={SCREENS} size={[0.66, 0.4, 0.05]} color="#1b2029" />
      <InstancedBoxes items={SCREEN_STANDS} size={[0.08, 0.24, 0.08]} color="#3a4250" />
      <InstancedBoxes items={CHAIR_SEATS} size={[0.52, 0.1, 0.52]} color="#2f3646" />
      <InstancedBoxes items={CHAIR_BACKS} size={[0.52, 0.42, 0.1]} color="#2f3646" />
    </group>
  );
}

/** Name plates are canvas textures: no font asset, no network, and they live in the 3D tree. */
function createNameTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for name plates");
  context.font = "600 64px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "#f4f6fb";
  context.fillText(text, 256, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function NamePlate({ text, placement }: { text: string; placement: Placement }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const texture = useMemo(() => createNameTexture(text), [text]);
  useEffect(() => () => texture.dispose(), [texture]);
  // Billboard toward the camera so plates stay readable as the orbit moves.
  // useFrame only runs when the demand loop invalidates (mount and orbit).
  useFrame(({ camera }) => {
    meshRef.current?.quaternion.copy(camera.quaternion);
  });
  return (
    <mesh ref={meshRef} position={placement.position}>
      <planeGeometry args={[NAME_PLATE_SIZE[0], NAME_PLATE_SIZE[1]]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/** The screen itself: grey when idle, the bot colour while working, amber for review. */
function Monitor({
  station,
  base,
  intensity,
  pulsing,
}: {
  station: DeskStation;
  base: string;
  intensity: number;
  pulsing: boolean;
}) {
  const materialRef = useRef<THREE.MeshBasicMaterial>(null);
  const invalidate = useThree((state) => state.invalidate);
  const baseColor = useMemo(() => new THREE.Color(base), [base]);
  const [x, y, z] = station.screen.position;
  const [nx, nz] = [Math.sin(station.desk.facing), Math.cos(station.desk.facing)];
  // Sits just in front of the committed screen's display panel.
  const normalOffset = 0.05;

  useEffect(() => {
    materialRef.current?.color.copy(baseColor).multiplyScalar(intensity);
    invalidate();
  }, [baseColor, intensity, invalidate]);

  useFrame(({ clock }) => {
    if (!pulsing || !materialRef.current) return;
    // One animated draw call, and the loop stops as soon as no bot is working.
    materialRef.current.color
      .copy(baseColor)
      .multiplyScalar(0.55 + 0.45 * pulseFactor(clock.elapsedTime));
    invalidate();
  });

  return (
    <mesh
      position={[x + nx * normalOffset, y, z + nz * normalOffset]}
      rotation={[0, station.desk.facing, 0]}
    >
      <planeGeometry args={[0.8, 0.48]} />
      <meshBasicMaterial ref={materialRef} toneMapped={false} />
    </mesh>
  );
}

/** Three shrinking spheres: a thought bubble, no font or sprite needed. */
function ThoughtBubble({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[0.16, 12, 8]} />
        <meshBasicMaterial color="#e9edf5" />
      </mesh>
      <mesh position={[0.1, -0.24, 0]}>
        <sphereGeometry args={[0.07, 10, 6]} />
        <meshBasicMaterial color="#e9edf5" />
      </mesh>
      <mesh position={[0.16, -0.36, 0]}>
        <sphereGeometry args={[0.04, 8, 6]} />
        <meshBasicMaterial color="#e9edf5" />
      </mesh>
    </group>
  );
}

/** A ring plus a handle, floating over a reviewer's head. */
function Magnifier({
  position,
  rotationY,
}: {
  position: [number, number, number];
  rotationY: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh>
        <torusGeometry args={[0.15, 0.035, 8, 16]} />
        <meshBasicMaterial color={REVIEW_MONITOR} />
      </mesh>
      <mesh position={[0.13, -0.16, 0]} rotation={[0, 0, Math.PI / 4]}>
        <cylinderGeometry args={[0.03, 0.03, 0.22, 8]} />
        <meshBasicMaterial color={REVIEW_MONITOR} />
      </mesh>
    </group>
  );
}

/** Hides the lit furniture for an offline bot: dark overlay, plus the empty chair. */
function DimmedDesk({ station }: { station: DeskStation }) {
  return (
    <>
      <mesh position={station.deskBody.position} rotation={[0, station.deskBody.rotationY, 0]}>
        <boxGeometry args={[1.7, 0.74, 0.86]} />
        <meshBasicMaterial color="#0b0e14" transparent opacity={0.55} depthWrite={false} />
      </mesh>
      <mesh position={station.chairSeat.position} rotation={[0, station.chairSeat.rotationY, 0]}>
        <boxGeometry args={[0.52, 0.1, 0.52]} />
        <meshBasicMaterial color="#0b0e14" transparent opacity={0.55} depthWrite={false} />
      </mesh>
    </>
  );
}

/** One desk's live visuals: screen, status icon and dimming. */
function DeskStatus({ station }: { station: DeskStation }) {
  const bot = useOfficeStore((state) => state.bots[station.desk.botId]);
  const botColor = BOT_COLORS[station.desk.botId] ?? "#8b93a1";
  const visual = deskVisual(bot?.status, botColor);
  const [x, y, z] = station.bot.position;

  return (
    <group>
      <Monitor
        station={station}
        base={visual.monitor}
        intensity={visual.monitorIntensity}
        pulsing={visual.pulsing}
      />
      {plateVisible(bot?.status) ? (
        <NamePlate text={station.desk.name} placement={station.namePlate} />
      ) : null}
      {visual.thoughtBubble ? <ThoughtBubble position={[x, y + 1.45, z]} /> : null}
      {visual.magnifier ? (
        <Magnifier position={[x, y + 1.38, z]} rotationY={station.desk.facing} />
      ) : null}
      {visual.dim < 1 ? <DimmedDesk station={station} /> : null}
    </group>
  );
}

function DeskVitals() {
  return (
    <>
      {DESK_STATIONS.map((station) => (
        <DeskStatus key={station.desk.botId} station={station} />
      ))}
    </>
  );
}

/** Invisible boxes over each desk body: a still click selects its bot, an orbit drag does not. */
function DeskPicker() {
  return (
    <group>
      {DESK_STATIONS.map((station) => (
        <mesh
          key={station.desk.botId}
          position={station.deskBody.position}
          rotation={[0, station.deskBody.rotationY, 0]}
          onClick={(event) => {
            if (!deskClickSelects(event.delta)) return;
            useOfficeStore.getState().selectBot(station.desk.botId);
          }}
        >
          <boxGeometry args={[1.8, 0.8, 0.95]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Drops the scene to the WebGL fallback when the context is lost. */
function WebGlContextGuard({ onContextLost }: { onContextLost?: () => void }) {
  const gl = useThree((state) => state.gl);
  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event) => {
      event.preventDefault();
      onContextLost?.();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    return () => canvas.removeEventListener("webglcontextlost", onLost);
  }, [gl, onContextLost]);
  return null;
}

/** Static office scene: the only Canvas in the app, loaded as its own async chunk. */
export default function OfficeScene({ onContextLost }: { onContextLost?: () => void } = {}) {
  const bots = useOfficeStore((state) => state.bots);
  const reducedMotion = usePrefersReducedMotion();
  const { packets, settle } = useHandoffPackets(reducedMotion);
  // Only pay for a continuous loop while a character or a packet is moving.
  const continuous = useMemo(
    () =>
      shouldRenderContinuously({
        statuses: DESK_STATIONS.map((station) => bots[station.desk.botId]?.status),
        reducedMotion,
        packetAnimating: packetsAnimating(packets),
      }),
    [bots, reducedMotion, packets],
  );

  return (
    <Canvas
      dpr={CANVAS_DPR}
      frameloop={continuous ? "always" : FRAMELOOP}
      shadows={SHADOWS}
      camera={CAMERA}
      style={{ position: "fixed", inset: 0 }}
      onCreated={({ gl }) => {
        gl.domElement.setAttribute("aria-label", "Office scene");
        gl.domElement.setAttribute("role", "img");
      }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <ambientLight intensity={1.6} />
      <directionalLight position={[6, 10, 8]} intensity={2.2} />
      <SceneInvalidator />
      <WebGlContextGuard onContextLost={onContextLost} />
      <Room />
      <ModelBoundary fallback={<Furniture />}>
        <Suspense fallback={<Furniture />}>
          <FurnitureModels />
        </Suspense>
      </ModelBoundary>
      <DeskVitals />
      <DeskPicker />
      <Characters reducedMotion={reducedMotion} />
      <HandoffPackets packets={packets} settle={settle} reducedMotion={reducedMotion} />
      <OrbitControls
        enableDamping={false}
        enablePan={false}
        target={ORBIT_LIMITS.target}
        minDistance={ORBIT_LIMITS.minDistance}
        maxDistance={ORBIT_LIMITS.maxDistance}
        minPolarAngle={ORBIT_LIMITS.minPolarAngle}
        maxPolarAngle={ORBIT_LIMITS.maxPolarAngle}
        minAzimuthAngle={ORBIT_LIMITS.minAzimuthAngle}
        maxAzimuthAngle={ORBIT_LIMITS.maxAzimuthAngle}
      />
    </Canvas>
  );
}
