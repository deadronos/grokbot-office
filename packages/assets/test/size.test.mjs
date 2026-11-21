import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const BUDGET = 1024 * 1024 * 5;
const DIR = fileURLToPath(new URL("../../../apps/web/public/assets/models/", import.meta.url));
const EXPECTED = [
  "chairDesk.glb",
  "character-worker.glb",
  "computerKeyboard.glb",
  "computerMouse.glb",
  "computerScreen.glb",
  "desk.glb",
];

it("ships exactly the processed models, under 5 MB in total", () => {
  const files = readdirSync(DIR)
    .filter((name) => name.endsWith(".glb"))
    .toSorted();
  expect(files).toEqual(EXPECTED);
  const total = files.reduce((sum, name) => sum + statSync(`${DIR}${name}`).size, 0);
  expect(total).toBeGreaterThan(0);
  expect(total).toBeLessThan(BUDGET);
});
