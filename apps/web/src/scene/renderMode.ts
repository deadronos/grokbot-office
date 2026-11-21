import type { BotStatus } from "@grokbot-office/shared";

/**
 * The stage only needs a continuous render loop while a character is visible and
 * moving, or while handoff packets are in the air. Reduced motion (or everyone
 * offline with nothing in flight) keeps the on-demand loop.
 */
export function shouldRenderContinuously(input: {
  statuses: readonly (BotStatus | undefined)[];
  reducedMotion: boolean;
  packetAnimating?: boolean;
}): boolean {
  if (input.reducedMotion) return false;
  if (input.packetAnimating) return true;
  return input.statuses.some((status) => status !== undefined && status !== "offline");
}
