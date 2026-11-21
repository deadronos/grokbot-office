import { readFileSync } from "node:fs";

/** Minimal GLB reader for tests: JSON chunk plus the BIN chunk, no dependencies. */
export function readGlb(path) {
  const bytes = readFileSync(path);
  if (bytes.toString("ascii", 0, 4) !== "glTF") throw new Error(`${path}: not a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  let bin = null;
  let offset = 20 + jsonLength;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "BIN\0") bin = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;
    offset += (4 - (offset % 4)) % 4;
  }
  return { json, bin };
}

/** Width/height from an embedded PNG's IHDR, for textures stored in the BIN chunk. */
export function textureSize({ json, bin }) {
  const image = json.images?.[0];
  if (image?.bufferView == null) throw new Error("no embedded image");
  const view = json.bufferViews[image.bufferView];
  const png = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  if (png.toString("ascii", 1, 4) !== "PNG") throw new Error("image is not PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
