/**
 * Bridge from "data changed outside the Canvas" to R3F's on-demand renderer.
 * A child inside the Canvas registers `useThree().invalidate`; later issues call
 * `invalidateScene()` when store/HUD data changes. Safe before the Canvas mounts.
 */
type Invalidate = () => void;

let invalidate: Invalidate | null = null;

export function setSceneInvalidator(next: Invalidate | null): void {
  invalidate = next;
}

export function invalidateScene(): void {
  invalidate?.();
}
