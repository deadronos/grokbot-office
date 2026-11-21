import { useGLTF } from "@react-three/drei";
import { useMemo } from "react";
import type * as THREE from "three";

import { DESK_STATIONS } from "./deskStations";
import { modelUrl, type ModelName } from "./modelUrls";

/** Furniture model size in scene units; the desk keeps the old 1.7 m footprint. */
const MODEL_SCALE = 2.2;
const DESK_TOP = 0.845;
const SCREEN_YAW = Math.PI;

function Piece({
  scene,
  position,
  rotationY = 0,
}: {
  scene: THREE.Object3D;
  position: [number, number, number];
  rotationY?: number;
}) {
  // Static props share geometry/materials with the cached GLTF, so only the
  // object graph is cloned; nothing here is disposed on unmount.
  const object = useMemo(() => scene.clone(true), [scene]);
  return (
    <primitive
      object={object}
      position={position}
      rotation={[0, rotationY, 0]}
      scale={MODEL_SCALE}
    />
  );
}

/** One committed Kenney set per desk; offsets centre each model on its old stand-in. */
/** Every committed model is meshopt-compressed and none is Draco: never fetch a decoder. */
export function useModel(name: ModelName) {
  return useGLTF(modelUrl(name), false, true);
}

export function FurnitureModels() {
  const desk = useModel("desk").scene;
  const chair = useModel("chair").scene;
  const screen = useModel("screen").scene;
  const keyboard = useModel("keyboard").scene;
  const mouse = useModel("mouse").scene;

  return (
    <>
      {DESK_STATIONS.map((station) => (
        <group
          key={station.desk.botId}
          position={[station.deskBody.position[0], 0, station.deskBody.position[2]]}
          rotation={[0, station.deskBody.rotationY, 0]}
        >
          <Piece scene={desk} position={[-0.785, 0, 0.407]} />
          <Piece scene={chair} position={[-0.369, 0, -0.428]} />
          {/* Turned to face the viewer, like the old glowing screen plane. */}
          <Piece scene={screen} position={[0.432, DESK_TOP, 0.086]} rotationY={SCREEN_YAW} />
          <Piece scene={keyboard} position={[-0.31, DESK_TOP, 0.03]} />
          <Piece scene={mouse} position={[0.5, DESK_TOP, -0.007]} />
        </group>
      ))}
    </>
  );
}
