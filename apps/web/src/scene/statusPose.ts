import type { BotStatus } from "@grokbot-office/shared";
import { AnimationClip } from "three";

/**
 * The rig has no typing, reading or leaning-back clip, so each status layers an
 * upper-body clip over the seated `sit` clip (which owns the legs and root).
 * Merging the tracks into one clip keeps both poses in a single action, so a
 * crossfade never blends a standing pose back in.
 */
/**
 * Hip height in the `sit` clip, in model units: the rig origin is below the
 * seat, not on it, so the character is lowered onto the chair by this amount.
 */
export const SIT_HIP_HEIGHT = 0.026;

export type StatusPose = {
  base: string;
  upper: string;
  loop: boolean;
  /** Radians of backward lean; `0` means the clip already sells the pose. */
  leanBack: number;
  paper: boolean;
};

/** Away only dims the desk: the bot still sits there, so it reuses the idle pose. */
const IDLE: StatusPose = { base: "sit", upper: "idle", loop: true, leanBack: 0, paper: false };

const POSES: Record<BotStatus, StatusPose | null> = {
  idle: IDLE,
  away: IDLE,
  working: { base: "sit", upper: "interact-right", loop: true, leanBack: 0, paper: false },
  waiting: { base: "sit", upper: "idle", loop: true, leanBack: -0.14, paper: false },
  reviewing: { base: "sit", upper: "holding-both", loop: true, leanBack: 0, paper: true },
  offline: null,
};

export function poseForStatus(status: BotStatus | undefined): StatusPose | null {
  if (!status) return null;
  return Object.hasOwn(POSES, status) ? POSES[status] : null;
}

/** Tracks from `upper` win over `base` when both animate the same node. */
export function mergePoseClips(
  base: AnimationClip,
  upper: AnimationClip,
  name: string,
): AnimationClip {
  const overridden = new Set(upper.tracks.map((track) => track.name));
  const tracks = [...base.tracks.filter((track) => !overridden.has(track.name)), ...upper.tracks];
  return new AnimationClip(name, Math.max(base.duration, upper.duration), tracks);
}
