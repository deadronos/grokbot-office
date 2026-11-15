/** True when the browser can create a WebGL context; checked before mounting the scene. */
export function isWebGlAvailable(): boolean {
  // Server rendering has no canvas; let the browser decide after hydration.
  if (typeof document === "undefined") return true;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
