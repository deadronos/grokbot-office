import { afterEach, describe, expect, it, vi } from "vitest";

import { isWebGlAvailable } from "./webgl";

function stubCanvas(getContext: () => unknown): void {
  vi.stubGlobal("document", { createElement: () => ({ getContext }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWebGlAvailable", () => {
  it("is true for a webgl2 context", () => {
    stubCanvas(() => ({}));
    expect(isWebGlAvailable()).toBe(true);
  });

  it("falls back to webgl when webgl2 is missing", () => {
    const calls: string[] = [];
    stubCanvas((type?: unknown) => {
      calls.push(String(type));
      return type === "webgl" ? {} : null;
    });
    expect(isWebGlAvailable()).toBe(true);
    expect(calls).toEqual(["webgl2", "webgl"]);
  });

  it("is false without a context", () => {
    stubCanvas(() => null);
    expect(isWebGlAvailable()).toBe(false);
  });

  it("is false when the canvas throws", () => {
    stubCanvas(() => {
      throw new Error("blocked");
    });
    expect(isWebGlAvailable()).toBe(false);
  });

  it("assumes availability where there is no document", () => {
    vi.stubGlobal("document", undefined);
    expect(isWebGlAvailable()).toBe(true);
  });
});
