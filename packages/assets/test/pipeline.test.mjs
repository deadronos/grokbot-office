import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { TEXTURE_MAX, processGlb } from "../src/pipeline.mjs";
import { readGlb, textureSize } from "./glb.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/make-fixture.mjs", import.meta.url));
const FIXTURE_EDGE = 128;
const MODELS = fileURLToPath(new URL("../../../apps/web/public/assets/models/", import.meta.url));

const temps = [];
let fixtureDir;
let FIXTURE;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "grokbot-fixture-"));
  FIXTURE = join(fixtureDir, "duplicate.glb");
  await promisify(execFile)(process.execPath, [SCRIPT, FIXTURE]);
});

afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
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
    expect(textureSize(input).width).toBe(FIXTURE_EDGE);
    // Two meshes worth of duplicate position/index accessors plus distinct UVs.
    expect(input.json.accessors).toHaveLength(6);

    const output = await processFixture({ textureMax: 64 });

    expect(output.json.extensionsUsed).toContain("EXT_meshopt_compression");
    expect(output.json.extensionsUsed).toContain("KHR_mesh_quantization");
    expect(output.json.accessors.length).toBeLessThan(input.json.accessors.length);
    expect(output.json.meshes).toHaveLength(2);
    expect(textureSize(output)).toEqual({ width: 64, height: 64 });
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
