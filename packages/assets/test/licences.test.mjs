import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const LICENSES = readFileSync(`${ROOT}assets/LICENSES.md`, "utf8");
const MODELS = fileURLToPath(new URL("../../../apps/web/public/assets/models/", import.meta.url));
const FILES = [
  "chairDesk.glb",
  "character-worker.glb",
  "computerKeyboard.glb",
  "computerMouse.glb",
  "computerScreen.glb",
  "desk.glb",
];

describe("assets/LICENSES.md", () => {
  it("credits every processed model", () => {
    for (const file of FILES) expect(LICENSES).toContain(file);
  });

  it("records pack, author, licence and official source URL", () => {
    for (const pack of ["furniture-kit", "mini-characters"]) {
      expect(LICENSES).toContain(`https://kenney.nl/assets/${pack}`);
    }
    expect(LICENSES).toContain("Kenney");
    expect(LICENSES).toContain("CC0 1.0");
    expect(LICENSES).toContain("https://creativecommons.org/publicdomain/zero/1.0/");
  });

  it("has no uncredited .glb in the processed model directory", () => {
    for (const file of FILES)
      expect(LICENSES, file).toContain(`apps/web/public/assets/models/${file}`);
  });
});

it("can locate the committed model directory", () => {
  expect(MODELS).toContain("apps/web/public/assets/models/");
});
