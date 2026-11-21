import type { BotSnapshot, BotStatus } from "@grokbot-office/shared";
import { useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

import { useViewedBots } from "../history/useViewed";
import { BOT_COLORS } from "./botColors";
import { characterVariant, materialTint, type AccessoryKind } from "./characterVariants";
import { DESK_STATIONS, type DeskStation } from "./deskStations";
import { ModelBoundary } from "./ModelBoundary";
import { useModel } from "./models";
import { SIT_HIP_HEIGHT, mergePoseClips, poseForStatus } from "./statusPose";

/** `character-worker.glb` metres → scene units; matched to the desk models. */
export const CHARACTER_SCALE = 1.95;
const FADE_SECONDS = 0.3;

/** Cheap primitives on the shared rig: one silhouette per character, no new assets. */
function buildAccessory(kind: AccessoryKind, color: string): THREE.Group | null {
  if (kind === "none") return null;
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.45 });
  const add = (
    geometry: THREE.BufferGeometry,
    position: [number, number, number],
    rotation?: [number, number, number],
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    if (rotation) mesh.rotation.set(...rotation);
    group.add(mesh);
  };

  switch (kind) {
    case "halo":
      add(new THREE.TorusGeometry(0.17, 0.02, 8, 20), [0, 0.52, 0], [Math.PI / 2, 0, 0]);
      break;
    case "band":
      add(new THREE.TorusGeometry(0.19, 0.02, 8, 20), [0, 0.3, 0], [Math.PI / 2, 0, 0]);
      break;
    case "visor":
      add(new THREE.BoxGeometry(0.34, 0.07, 0.06), [0, 0.3, 0.17]);
      break;
    case "ears":
      for (const side of [-1, 1]) {
        add(
          new THREE.ConeGeometry(0.05, 0.16, 8),
          [side * 0.19, 0.32, 0],
          [0, 0, (side * Math.PI) / 2],
        );
      }
      break;
    case "earpiece":
      add(new THREE.SphereGeometry(0.04, 8, 8), [0.19, 0.28, 0]);
      break;
    case "hat":
      add(new THREE.CylinderGeometry(0.16, 0.18, 0.14, 10), [0, 0.43, 0]);
      add(new THREE.CylinderGeometry(0.27, 0.27, 0.02, 12), [0, 0.37, 0]);
      break;
    case "sash":
      add(new THREE.BoxGeometry(0.46, 0.1, 0.06), [0, 0.02, 0.1], [0, 0, 0.5]);
      break;
  }
  return group;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of [mesh.material].flat()) material.dispose();
  });
}

function CharacterRig({
  station,
  status,
  reducedMotion,
}: {
  station: DeskStation;
  status: BotStatus;
  reducedMotion: boolean;
}) {
  const variant = characterVariant(station.desk.botId);
  const { scene, animations } = useModel("character");

  // Ours to dispose: the skeleton and materials are cloned per bot.
  const model = useMemo(() => {
    const object = cloneSkeleton(scene);
    const materials: THREE.Material[] = [];
    object.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Skinned bounds come from the bind pose, so culling would pop mid-animation.
      mesh.frustumCulled = false;
      const material = (mesh.material as THREE.MeshStandardMaterial).clone();
      material.color.set(materialTint(variant.tint));
      mesh.material = material;
      materials.push(material);
    });
    return { object, materials };
  }, [scene, variant.tint]);

  useEffect(() => () => model.materials.forEach((material) => material.dispose()), [model]);

  useEffect(() => {
    const bone = model.object.getObjectByName(variant.bone);
    const accessory = buildAccessory(variant.accessory, variant.tint);
    if (!bone || !accessory) return;
    bone.add(accessory);
    return () => {
      bone.remove(accessory);
      disposeObject(accessory);
    };
  }, [model, variant.accessory, variant.bone, variant.tint]);

  // No reading clip in the rig: a sheet in the hands sells `holding-both`.
  const paper = poseForStatus(status)?.paper ?? false;
  useEffect(() => {
    if (!paper) return;
    const bone = model.object.getObjectByName("torso");
    if (!bone) return;
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(0.26, 0.34),
      new THREE.MeshStandardMaterial({ color: "#efe9dc", roughness: 0.9, side: THREE.DoubleSide }),
    );
    sheet.position.set(0, 0.02, 0.2);
    sheet.rotation.x = -1.3;
    bone.add(sheet);
    return () => {
      bone.remove(sheet);
      sheet.geometry.dispose();
      (sheet.material as THREE.Material).dispose();
    };
  }, [model, paper]);

  const mixer = useMemo(() => new THREE.AnimationMixer(model.object), [model]);
  const actions = useRef(new Map<BotStatus, THREE.AnimationAction>());
  const current = useRef<THREE.AnimationAction | null>(null);

  useEffect(() => {
    const pose = poseForStatus(status);
    if (!pose) return;

    let action = actions.current.get(status);
    if (!action) {
      const base = animations.find((clip) => clip.name === pose.base);
      const upper = animations.find((clip) => clip.name === pose.upper);
      if (!base || !upper) return;
      action = mixer.clipAction(mergePoseClips(base, upper, `${pose.base}+${pose.upper}`));
      action.setLoop(THREE.LoopRepeat, Infinity);
      actions.current.set(status, action);
    }

    const previous = current.current;
    if (previous === action) {
      action.paused = reducedMotion;
      mixer.update(0);
      return;
    }

    action.reset().setEffectiveWeight(1).play();
    if (previous) {
      if (reducedMotion) previous.stop();
      else previous.crossFadeTo(action, FADE_SECONDS, false);
    }
    action.paused = reducedMotion;
    current.current = action;
    mixer.update(0);
  }, [status, reducedMotion, animations, mixer]);

  useEffect(
    () => () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(model.object);
      actions.current.clear();
      current.current = null;
    },
    [mixer, model],
  );

  useFrame((_, delta) => {
    if (!reducedMotion) mixer.update(delta);
  });

  // The seat surface is `station.bot`; the rig origin in `sit` is below the hips.
  const [x, y, z] = station.bot.position;

  return (
    <group
      position={[x, y - SIT_HIP_HEIGHT * CHARACTER_SCALE, z]}
      rotation-y={station.bot.rotationY}
    >
      <group rotation-x={poseForStatus(status)?.leanBack ?? 0}>
        <primitive object={model.object} scale={CHARACTER_SCALE} />
      </group>
    </group>
  );
}

function Character({
  station,
  status,
  reducedMotion,
}: {
  station: DeskStation;
  status: BotStatus | undefined;
  reducedMotion: boolean;
}) {
  if (!status || status === "offline") return null;
  return <CharacterRig station={station} status={status} reducedMotion={reducedMotion} />;
}

/** The old capsules: visible while the GLB loads and if it fails. */
function Capsules({ bots }: { bots: Record<string, BotSnapshot> }) {
  return (
    <>
      {DESK_STATIONS.map((station) => {
        const bot = bots[station.desk.botId];
        if (!bot || bot.status === "offline") return null;
        const [x, y, z] = station.bot.position;
        return (
          <mesh
            key={station.desk.botId}
            position={[x, y + 0.5, z]}
            rotation-y={station.bot.rotationY}
          >
            <capsuleGeometry args={[0.22, 0.5, 4, 8]} />
            <meshLambertMaterial color={BOT_COLORS[station.desk.botId] ?? "#8b93a1"} flatShading />
          </mesh>
        );
      })}
    </>
  );
}

export function Characters({ reducedMotion }: { reducedMotion: boolean }) {
  const bots = useViewedBots();
  const fallback = <Capsules bots={bots} />;

  return (
    <ModelBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        {DESK_STATIONS.map((station) => (
          <Character
            key={station.desk.botId}
            station={station}
            status={bots[station.desk.botId]?.status}
            reducedMotion={reducedMotion}
          />
        ))}
      </Suspense>
    </ModelBoundary>
  );
}
