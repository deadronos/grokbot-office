import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { CAMERA, ORBIT_LIMITS } from "./sceneConfig";
import { DESK_STATIONS, NAME_PLATE_SIZE } from "./deskStations";

/** The default camera and the 16:9 viewport a desktop viewer gets. */
function defaultCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16 / 9, 0.1, 100);
  camera.position.set(...CAMERA.position);
  camera.lookAt(new THREE.Vector3(...ORBIT_LIMITS.target));
  camera.updateMatrixWorld();
  return camera;
}

function project(camera: THREE.Camera, position: readonly [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(...position).project(camera);
}

function station(botId: string) {
  const found = DESK_STATIONS.find((entry) => entry.desk.botId === botId);
  if (!found) throw new Error(`no station for ${botId}`);
  return found;
}

describe("name plates", () => {
  it("keep every plate above the desk in front", () => {
    const camera = defaultCamera();
    // Lumi's desk top sits at the centre of the room, in front of Geordi's desk.
    const lumiDeskTop = project(camera, [0, 1.1, 0]);
    const geordi = station("geordi");

    const plateBottomY = geordi.namePlate.position[1] - NAME_PLATE_SIZE[1] / 2;
    const plateBottom = project(camera, [
      geordi.namePlate.position[0],
      plateBottomY,
      geordi.namePlate.position[2],
    ]);

    // A regression to the old low plates lands the plate on Lumi's desk again.
    expect(plateBottom.y - lumiDeskTop.y).toBeGreaterThan(0.01);
  });

  it("stay small enough not to cover a neighbouring desk", () => {
    expect(NAME_PLATE_SIZE[0]).toBeLessThanOrEqual(1.2);
    expect(NAME_PLATE_SIZE[1]).toBeLessThanOrEqual(0.28);
  });

  it("sit above every screen and bot", () => {
    for (const entry of DESK_STATIONS) {
      expect(entry.namePlate.position[1]).toBeGreaterThan(3);
      expect(entry.namePlate.position[1]).toBeGreaterThan(entry.screen.position[1]);
      expect(entry.namePlate.position[1]).toBeGreaterThan(entry.bot.position[1]);
    }
  });
});
