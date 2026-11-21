/** Pointer travel (px, r3f click `delta`) above which a desk press was an orbit drag. */
export const DESK_CLICK_SLOP_PX = 4;

/** A click selects a desk only when the pointer barely moved, so orbit drags never do. */
export function deskClickSelects(delta: number): boolean {
  return delta <= DESK_CLICK_SLOP_PX;
}
