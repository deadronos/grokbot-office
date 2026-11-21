import type { Desk } from "@grokbot-office/shared";
import * as THREE from "three";

import { NAME_PLATE_SIZE, type Placement } from "./deskStations";
import { CAMERA, ORBIT_LIMITS } from "./sceneConfig";

export type Viewport = { width: number; height: number };

export type ScreenRect = { x0: number; x1: number; y0: number; y1: number };

/** Committed desk model at `MODEL_SCALE`: top 0.845, footprint 1.6 x 0.86. */
const DESK_TOP = 0.845;
const DESK_HALF_WIDTH = 0.8;
const DESK_HALF_DEPTH = 0.43;
/** Computer screen panel: 0.86 wide, top at 1.49, just behind the desk centre. */
const SCREEN_HALF_WIDTH = 0.43;
const SCREEN_BOTTOM = DESK_TOP;
const SCREEN_TOP = 1.49;
const SCREEN_Z = [0.086, 0.315] as const;

/** The default camera and orbit target, exactly as the scene creates them. */
export function defaultCamera({ width, height }: Viewport): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, width / height, 0.1, 100);
  camera.position.set(...CAMERA.position);
  camera.lookAt(new THREE.Vector3(...ORBIT_LIMITS.target));
  camera.updateMatrixWorld();
  return camera;
}

/** Desk-local (x, z) to world, matching `deskStations.ts`. */
function deskPoint(desk: Desk, x: number, y: number, z: number): THREE.Vector3 {
  const sin = Math.sin(desk.facing);
  const cos = Math.cos(desk.facing);
  return new THREE.Vector3(desk.x + x * cos + z * sin, y, desk.z - x * sin + z * cos);
}

export function projectRect(
  camera: THREE.Camera,
  points: readonly THREE.Vector3[],
  { width, height }: Viewport,
): ScreenRect {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const point of points) {
    const projected = point.clone().project(camera);
    const x = ((projected.x + 1) / 2) * width;
    const y = ((1 - projected.y) / 2) * height;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { x0, x1, y0, y1 };
}

/** The whole fitted desk: top surface plus the screen standing on it. */
export function deskScreenRect(camera: THREE.Camera, desk: Desk, viewport: Viewport): ScreenRect {
  const points: THREE.Vector3[] = [];
  for (const x of [-DESK_HALF_WIDTH, DESK_HALF_WIDTH]) {
    for (const z of [-DESK_HALF_DEPTH, DESK_HALF_DEPTH]) {
      points.push(deskPoint(desk, x, DESK_TOP, z));
    }
  }
  for (const x of [-SCREEN_HALF_WIDTH, SCREEN_HALF_WIDTH]) {
    for (const z of SCREEN_Z) {
      for (const y of [SCREEN_BOTTOM, SCREEN_TOP]) {
        points.push(deskPoint(desk, x, y, z));
      }
    }
  }
  return projectRect(camera, points, viewport);
}

/** The billboard's screen rectangle: the plate faces whichever camera renders it. */
export function plateScreenRect(
  camera: THREE.Camera,
  placement: Placement,
  viewport: Viewport,
): ScreenRect {
  const centre = new THREE.Vector3(...placement.position);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const halfWidth = NAME_PLATE_SIZE[0] / 2;
  const halfHeight = NAME_PLATE_SIZE[1] / 2;
  const points: THREE.Vector3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      points.push(
        centre
          .clone()
          .addScaledVector(right, halfWidth * sx)
          .addScaledVector(up, halfHeight * sy),
      );
    }
  }
  return projectRect(camera, points, viewport);
}

export function rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}
