import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../../../apps/web/public/assets/models/", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../models.sha256.json", import.meta.url));

const recorded = JSON.parse(readFileSync(MANIFEST, "utf8"));

describe("committed models", () => {
  it("match the golden hashes", () => {
    for (const [file, hash] of Object.entries(recorded)) {
      const actual = createHash("sha256")
        .update(readFileSync(`${DIR}${file}`))
        .digest("hex");
      expect(actual, `${file} drifted; rerun pnpm assets:build && pnpm assets:hash`).toBe(hash);
    }
  });

  it("have no missing or unrecorded files", () => {
    const files = readdirSync(DIR)
      .filter((name) => name.endsWith(".glb"))
      .toSorted();
    expect(files).toEqual(Object.keys(recorded).toSorted());
    expect(Object.values(recorded).every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });
});
