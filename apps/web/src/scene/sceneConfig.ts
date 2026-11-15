/** Canvas and camera settings for the static office scene, kept as constants so tests can assert them. */
export const CANVAS_DPR: [number, number] = [1, 1.5];

export const FRAMELOOP = "demand" as const;

/** No realtime shadows by default; the room is lit by one directional light plus ambient. */
export const SHADOWS = false;

export const CAMERA: { position: [number, number, number]; fov: number } = {
  position: [5.5, 7.5, 14],
  fov: 40,
};

/** Fixed isometric-ish view: orbit is clamped so the room cannot be flown through. */
export const ORBIT_LIMITS = {
  target: [0, 0.9, 0] as [number, number, number],
  minDistance: 10,
  maxDistance: 24,
  minPolarAngle: 0.5,
  maxPolarAngle: Math.PI / 2 - 0.1,
  minAzimuthAngle: -0.5,
  maxAzimuthAngle: 1.7,
};
