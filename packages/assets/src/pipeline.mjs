// Shared glTF processing used by both `pnpm assets:build` and the tests.
// Compression choice: meshopt (EXT_meshopt_compression), because three.js and
// @react-three/drei ship a MeshoptDecoder, so #17 can load these in the browser
// after `useGLTF(url, true)` / setting `gltfLoader.setMeshoptDecoder(MeshoptDecoder)`.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, textureCompress } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

/** Maximum texture edge, in pixels. The Kenney palette atlas is 512px. */
export const TEXTURE_MAX = 512;

let meshoptReady;

/** NodeIO with every glTF extension (meshopt included), ready for .glb files. */
export function createIO() {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
}

/**
 * Dedupe -> prune -> texture resize -> meshopt, writing a single .glb.
 * The input .glb may reference external textures; NodeIO resolves them
 * relative to the input path and embeds them in the output.
 */
export async function processGlb(input, output, { textureMax = TEXTURE_MAX } = {}) {
  await (meshoptReady ??= MeshoptEncoder.ready);
  const io = createIO();
  const document = await io.read(input);
  await document.transform(
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: "png", resize: [textureMax, textureMax] }),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  await io.write(output, document);
  return document;
}
