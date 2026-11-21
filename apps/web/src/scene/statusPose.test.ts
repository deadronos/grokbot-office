import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BOT_STATUSES, type BotStatus } from "@grokbot-office/shared";
import { AnimationClip, NumberKeyframeTrack } from "three";
import { describe, expect, it } from "vitest";

import { mergePoseClips, poseForStatus } from "./statusPose";

/** The clip list straight from the committed GLB's JSON chunk: no three, no network. */
function committedClips(): Map<string, number> {
  const path = fileURLToPath(
    new URL("../../public/assets/models/character-worker.glb", import.meta.url),
  );
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as {
    animations: { name: string; samplers: { input: number }[] }[];
    accessors: { max?: number[] }[];
  };
  return new Map(
    json.animations.map((clip) => [
      clip.name,
      json.accessors[clip.samplers[0]!.input]!.max?.[0] ?? 0,
    ]),
  );
}

const CLIPS = committedClips();

describe("poseForStatus", () => {
  it("maps every status, hiding the character when offline", () => {
    for (const status of BOT_STATUSES.filter((entry) => entry !== "offline")) {
      expect(poseForStatus(status)).toBeTruthy();
    }
    expect(poseForStatus("offline")).toBeNull();
  });

  it("ignores an unknown or missing status", () => {
    expect(poseForStatus("sleeping" as BotStatus)).toBeNull();
    expect(poseForStatus(undefined)).toBeNull();
  });

  it("only names clips that exist in the committed character", () => {
    for (const status of BOT_STATUSES) {
      const pose = poseForStatus(status);
      if (!pose) continue;
      expect(CLIPS.has(pose.base)).toBe(true);
      expect(CLIPS.has(pose.upper)).toBe(true);
    }
  });

  it("keeps every seated pose on the sit base", () => {
    for (const status of BOT_STATUSES) {
      const pose = poseForStatus(status);
      if (!pose) continue;
      expect(pose.base).toBe("sit");
      expect(pose.loop).toBe(true);
    }
  });

  it("leans a waiting bot back and gives a reviewer a paper", () => {
    expect(poseForStatus("waiting")?.leanBack).toBeLessThan(0);
    expect(poseForStatus("reviewing")?.paper).toBe(true);
    expect(poseForStatus("waiting")?.paper).toBe(false);
  });
});

const track = (name: string, value: number) =>
  new NumberKeyframeTrack(name, [0, 1], [value, value]);

describe("mergePoseClips", () => {
  const base = new AnimationClip("sit", 0.5, [
    track("root.position", 0),
    track("arm-left.quaternion", 1),
  ]);
  const upper = new AnimationClip("idle", 1.5, [
    track("torso.quaternion", 2),
    track("arm-left.quaternion", 3),
  ]);

  it("keeps the seated tracks and takes the upper-body ones", () => {
    const merged = mergePoseClips(base, upper, "sit+idle");
    const names = merged.tracks.map((entry) => entry.name).toSorted();
    expect(names).toEqual(["arm-left.quaternion", "root.position", "torso.quaternion"]);
    expect(merged.name).toBe("sit+idle");
    // The upper-body clip wins where both animate the same node.
    const arm = merged.tracks.find((entry) => entry.name === "arm-left.quaternion");
    expect(Array.from(arm!.values)).toEqual([3, 3]);
  });

  it("lasts as long as the longer clip so a loop never jumps", () => {
    expect(mergePoseClips(base, upper, "x").duration).toBe(1.5);
    expect(mergePoseClips(upper, base, "x").duration).toBe(1.5);
  });
});
