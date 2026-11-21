import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run after an intentional `pnpm assets:build`; the test compares this record.
const here = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(here, "../../../apps/web/public/assets/models");
const manifest = resolve(here, "../models.sha256.json");

const files = (await readdir(modelsDir)).filter((name) => name.endsWith(".glb")).toSorted();
const hashes = {};
for (const file of files) {
  hashes[file] = createHash("sha256")
    .update(await readFile(join(modelsDir, file)))
    .digest("hex");
}

await writeFile(manifest, `${JSON.stringify(hashes, null, 2)}\n`);
console.log(`Recorded ${files.length} model hashes in ${manifest}`);
