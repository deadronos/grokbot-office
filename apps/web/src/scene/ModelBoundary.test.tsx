import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModelBoundary } from "./ModelBoundary";

function ThrowingChild(): never {
  throw new Error("simulated GLB decode failure");
}

describe("ModelBoundary", () => {
  it("keeps the procedural fallback when a model fails", () => {
    // Same technique as WebGlErrorBoundary.test.tsx: feed the throwing child as
    // props, apply getDerivedStateFromError, and render — no WebGL needed.
    const boundary = new ModelBoundary({
      fallback: <p>placeholder</p>,
      children: createElement(ThrowingChild),
    });
    boundary.state = ModelBoundary.getDerivedStateFromError();
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toContain("placeholder");
  });

  it("renders the models when nothing throws", () => {
    const boundary = new ModelBoundary({ fallback: <p>placeholder</p>, children: <p>models</p> });
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toContain("models");
  });
});
