import type { BotStatus } from "@grokbot-office/shared";

/**
 * The stage only needs a continuous render loop while a character is visible and
 * moving. Reduced motion (or everyone offline) keeps the on-demand loop.
 */
export function shouldRenderContinuously(input: {
  statuses: readonly (BotStatus | undefined)[];
  reducedMotion: boolean;
}): boolean {
  if (input.reducedMotion) return false;
  return input.statuses.some((status) => status !== undefined && status !== "offline");
}
