import { describe, expect, it } from "vitest";

import { MODEL_FILES, modelUrl } from "./modelUrls";

describe("model URLs", () => {
  it("points every committed model at the public assets folder", () => {
    for (const file of Object.values(MODEL_FILES)) {
      expect(file.endsWith(".glb")).toBe(true);
    }
    expect(modelUrl("desk")).toBe("/assets/models/desk.glb");
    expect(modelUrl("character")).toBe("/assets/models/character-worker.glb");
  });

  it("honours a Vite base path", () => {
    expect(modelUrl("screen", "/office/")).toBe("/office/assets/models/computerScreen.glb");
    expect(modelUrl("screen", "/office")).toBe("/office/assets/models/computerScreen.glb");
  });
});
