import { OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { BOT_COLORS } from "./botColors";
import { DESK_STATIONS, type Placement } from "./deskStations";
import { setSceneInvalidator } from "./invalidateScene";
import { CAMERA, CANVAS_DPR, FRAMELOOP, ORBIT_LIMITS, SHADOWS } from "./sceneConfig";

const ROOM = { width: 12.5, depth: 10.5, wallHeight: 3.2, wall: 0.2 };
const BACKGROUND = "#141821";
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const PLATE_ROTATION: [number, number, number] = [-0.3, 0.6, 0];

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
  const texture = useMemo(() => createNameTexture(text), [text]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={placement.position} rotation={PLATE_ROTATION}>
      <planeGeometry args={[1.5, 0.38]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

function DeskOccupants() {
  return (
    <group>
      {DESK_STATIONS.map((station) => (
        <group key={station.desk.botId}>
          <mesh position={station.bot.position} rotation={[0, station.bot.rotationY, 0]}>
            <capsuleGeometry args={[0.22, 0.5, 4, 8]} />
            <meshLambertMaterial color={BOT_COLORS[station.desk.botId]} flatShading />
          </mesh>
          <NamePlate text={station.desk.name} placement={station.namePlate} />
        </group>
      ))}
    </group>
  );
}

/** Static office scene: the only Canvas in the app, loaded as its own async chunk. */
export default function OfficeScene() {
  return (
    <Canvas
      dpr={CANVAS_DPR}
      frameloop={FRAMELOOP}
      shadows={SHADOWS}
      camera={CAMERA}
      style={{ position: "fixed", inset: 0 }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <ambientLight intensity={1.6} />
      <directionalLight position={[6, 10, 8]} intensity={2.2} />
      <SceneInvalidator />
      <Room />
      <Furniture />
      <DeskOccupants />
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
