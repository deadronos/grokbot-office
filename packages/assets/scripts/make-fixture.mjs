// Regenerates test/fixtures/duplicate.glb: two meshes with identical (but
// separately stored) geometry, plus a 1024px texture, so the pipeline test can
// observe dedupe and texture resizing without network access.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/duplicate.glb");

const document = new Document();
const buffer = document.createBuffer();
const scene = document.createScene();

// Non-solid pixels: prune() removes solid-color textures, which would hide
// whether the texture resize step actually ran.
const pixels = Buffer.alloc(1024 * 1024 * 4);
for (let y = 0; y < 1024; y++) {
  for (let x = 0; x < 1024; x++) {
    const i = (y * 1024 + x) * 4;
    pixels[i] = x & 0xff;
    pixels[i + 1] = y & 0xff;
    pixels[i + 2] = (x ^ y) & 0xff;
    pixels[i + 3] = 255;
  }
}
const png = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 4 } })
  .png()
  .toBuffer();
const texture = document.createTexture("palette").setImage(png).setMimeType("image/png");
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const indices = new Uint16Array([0, 1, 2]);

const material = document.createMaterial("fixture").setBaseColorTexture(texture);

for (const [name, v] of [
  ["a", 0],
  ["b", 0.5],
]) {
  const position = document
    .createAccessor(`${name}-position`)
    .setType("VEC3")
    .setArray(positions.slice())
    .setBuffer(buffer);
  const index = document
    .createAccessor(`${name}-index`)
    .setType("SCALAR")
    .setArray(indices.slice())
    .setBuffer(buffer);
  // A distinct TEXCOORD_0 keeps the primitives from being merged wholesale,
  // so the duplicate POSITION/index accessors are what dedupe has to collapse.
  const uv = document
    .createAccessor(`${name}-uv`)
    .setType("VEC2")
    .setArray(new Float32Array([v, v, v, v, v, v]))
    .setBuffer(buffer);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("TEXCOORD_0", uv)
    .setIndices(index)
    .setMaterial(material);
  const mesh = document.createMesh(name).addPrimitive(primitive);
  scene.addChild(document.createNode(name).setMesh(mesh));
}

document.getRoot().setDefaultScene(scene);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document));
console.log(`wrote ${OUT}`);
