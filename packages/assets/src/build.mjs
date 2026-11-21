// Downloads the pinned CC0 Kenney packs, processes the selected models with
// glTF-Transform and writes committed .glb files for the web app.
//
// Reproducibility: pack zips are pinned by SHA-256 below. If Kenney re-releases
// a pack the hash check fails loudly instead of silently changing the assets.
// Transform steps (see src/pipeline.mjs): dedupe, prune, resize textures to at
// most 512px, meshopt compression (EXT_meshopt_compression).
//
// Source packs are cached in the gitignored assets/cache/. Requires `unzip`.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { processGlb } from "./pipeline.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CACHE = join(ROOT, "assets/cache");
const OUT = join(ROOT, "apps/web/public/assets/models");
const BUDGET = 5 * 1024 * 1024;
const USER_AGENT = "grokbot-office-assets/1.0 (+https://github.com/deadronos/grokbot-office)";

const PACKS = [
  {
    slug: "furniture-kit",
    sha256: "e67652d0932cee41683f74711c03d3e192a2af9979ef8e6b237711f5482d46b0",
  },
  {
    slug: "mini-characters",
    sha256: "add348e98ab9e23d9973c4740ef2c5cceb229c742106aca2d56b30a8f1241bb7",
  },
];

const MODELS = [
  { pack: "furniture-kit", source: "Models/GLTF format/desk.glb" },
  { pack: "furniture-kit", source: "Models/GLTF format/chairDesk.glb" },
  { pack: "furniture-kit", source: "Models/GLTF format/computerScreen.glb" },
  { pack: "furniture-kit", source: "Models/GLTF format/computerKeyboard.glb" },
  { pack: "furniture-kit", source: "Models/GLTF format/computerMouse.glb" },
  { pack: "mini-characters", source: "Models/GLB format/character-worker.glb" },
];

/** Kenney serves zips behind a signed link handed out by a per-page cookie. */
async function download({ slug }) {
  const page = await fetch(`https://kenney.nl/assets/${slug}`, {
    headers: { "user-agent": USER_AGENT },
  });
  if (!page.ok) throw new Error(`GET ${slug} page failed: ${page.status}`);
  const cookie = page.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const id = Buffer.from(`assets/${slug}`).toString("hex");
  const link = await fetch(`https://kenney.nl/download-link/${id}`, {
    headers: {
      "user-agent": USER_AGENT,
      referer: `https://kenney.nl/assets/${slug}`,
      "x-requested-with": "XMLHttpRequest",
      ...(cookie ? { cookie } : {}),
    },
  });
  if (!link.ok) throw new Error(`GET ${slug} download link failed: ${link.status}`);
  const { url } = await link.json();
  const zip = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!zip.ok) throw new Error(`GET ${slug} zip failed: ${zip.status}`);
  return Buffer.from(await zip.arrayBuffer());
}

async function ensurePack(pack) {
  const zipPath = join(CACHE, `${pack.slug}.zip`);
  const dir = join(CACHE, pack.slug);
  // Written inside the extract dir after a successful unzip, so a stale extract
  // (or one made from an older zip) is detected and redone.
  const marker = join(dir, ".sha256");
  let downloaded = false;
  try {
    const actual = createHash("sha256")
      .update(await readFile(zipPath))
      .digest("hex");
    if (actual !== pack.sha256) throw new Error("checksum mismatch");
  } catch {
    console.log(`fetching ${pack.slug} from kenney.nl ...`);
    await mkdir(CACHE, { recursive: true });
    const bytes = await download(pack);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== pack.sha256) {
      throw new Error(
        `${pack.slug}: SHA-256 ${actual} does not match pinned ${pack.sha256}. ` +
          "Kenney changed the pack; review the new contents and licence, then update PACKS.",
      );
    }
    await writeFile(zipPath, bytes);
    downloaded = true;
  }
  const extracted =
    !downloaded &&
    (await readFile(marker, "utf8").then(
      (value) => value.trim() === pack.sha256,
      () => false,
    ));
  if (!extracted) {
    await rm(dir, { recursive: true, force: true });
    await run("unzip", ["-q", "-o", zipPath, "-d", dir]);
    await writeFile(marker, `${pack.sha256}\n`);
  }
}

await mkdir(OUT, { recursive: true });
await Promise.all(PACKS.map(ensurePack));

for (const { pack, source } of MODELS) {
  const input = join(CACHE, pack, source);
  const output = join(OUT, source.split("/").at(-1));
  await processGlb(input, output);
}

const files = (await readdir(OUT)).filter((name) => name.endsWith(".glb")).toSorted();
let total = 0;
for (const name of files) {
  const { size } = await stat(join(OUT, name));
  total += size;
  console.log(`${name}\t${size} bytes`);
}
console.log(`total\t${total} bytes (budget ${BUDGET})`);
if (total > BUDGET) throw new Error(`processed assets exceed the 5 MB budget: ${total} bytes`);
