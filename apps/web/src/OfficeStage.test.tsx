import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Simulates a browser without WebGL, before the lazy scene is ever imported.
vi.mock("./webgl", () => ({ isWebGlAvailable: () => false }));

const { OfficeStage } = await import("./App");

describe("OfficeStage", () => {
  it("shows the fallback without mounting the scene when WebGL is missing", () => {
    const html = renderToStaticMarkup(<OfficeStage />);
    expect(html).toContain("WebGL isn");
    expect(html).not.toContain("Loading the office");
  });
});
