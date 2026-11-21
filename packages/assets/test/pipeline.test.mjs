import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { TEXTURE_MAX, processGlb } from "../src/pipeline.mjs";
import { readGlb, textureSize } from "./glb.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/duplicate.glb", import.meta.url));
const MODELS = fileURLToPath(new URL("../../../apps/web/public/assets/models/", import.meta.url));

const temps = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function processFixture(options) {
  const dir = await mkdtemp(join(tmpdir(), "grokbot-assets-"));
  temps.push(dir);
  const output = join(dir, "out.glb");
  await processGlb(FIXTURE, output, options);
  return readGlb(output);
}

describe("processGlb", () => {
  it("dedupes, resizes textures and applies meshopt compression", async () => {
    const input = readGlb(FIXTURE);
    expect(input.json.images).toHaveLength(1);
    expect(textureSize(input).width).toBe(1024);
    // Two meshes worth of duplicate position/index accessors plus distinct UVs.
    expect(input.json.accessors).toHaveLength(6);

    const output = await processFixture({ textureMax: 256 });

    expect(output.json.extensionsUsed).toContain("EXT_meshopt_compression");
    expect(output.json.extensionsUsed).toContain("KHR_mesh_quantization");
    expect(output.json.accessors.length).toBeLessThan(input.json.accessors.length);
    expect(output.json.meshes).toHaveLength(2);
    expect(textureSize(output)).toEqual({ width: 256, height: 256 });
    const compressed = (output.json.bufferViews ?? []).some(
      (view) => view.extensions?.EXT_meshopt_compression,
    );
    expect(compressed).toBe(true);
  });

  it("keeps a usable rig and the animation clips #17 needs", async () => {
    const character = readGlb(join(MODELS, "character-worker.glb"));

    expect(character.json.images).toHaveLength(1);
    expect(character.json.extensionsUsed).toContain("EXT_meshopt_compression");
    expect(character.json.skins.length).toBeGreaterThan(0);
    const clips = character.json.animations.map((animation) => animation.name);
    for (const clip of ["idle", "sit", "interact-right", "interact-left", "holding-right"]) {
      expect(clips).toContain(clip);
    }
    expect(textureSize(character).width).toBeLessThanOrEqual(TEXTURE_MAX);
  });
});
