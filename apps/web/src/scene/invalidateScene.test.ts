import { describe, expect, it, vi } from "vitest";

import { invalidateScene, setSceneInvalidator } from "./invalidateScene";

describe("invalidateScene", () => {
  it("is safe to call before the canvas mounts", () => {
    setSceneInvalidator(null);
    expect(() => invalidateScene()).not.toThrow();
  });

  it("forwards to the registered invalidator until it unregisters", () => {
    const invalidate = vi.fn();
    setSceneInvalidator(invalidate);
    invalidateScene();
    expect(invalidate).toHaveBeenCalledTimes(1);

    setSceneInvalidator(null);
    invalidateScene();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
