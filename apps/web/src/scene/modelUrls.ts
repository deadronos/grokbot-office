/**
 * Committed Kenney models, fetched at runtime so they stay out of the JS bundle.
 * Base-aware: a Vite `base` (e.g. a sub-path deploy) keeps the asset URLs valid.
 */
export const MODEL_FILES = {
  desk: "desk.glb",
  chair: "chairDesk.glb",
  screen: "computerScreen.glb",
  keyboard: "computerKeyboard.glb",
  mouse: "computerMouse.glb",
  character: "character-worker.glb",
} as const;

export type ModelName = keyof typeof MODEL_FILES;

export function modelUrl(name: ModelName, base = import.meta.env.BASE_URL): string {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return `${prefix}assets/models/${MODEL_FILES[name]}`;
}
