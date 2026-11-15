import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WEBGL_UNAVAILABLE, WebGlErrorBoundary, WebGlFallback } from "./WebGlErrorBoundary";

function ThrowingChild(): never {
  throw new Error("simulated WebGL failure");
}

function markupText(html: string): string {
  return html.replaceAll("&#x27;", "'").replaceAll("&apos;", "'");
}

describe("WebGlErrorBoundary", () => {
  it("shows the WebGL fallback when a child throws", () => {
    // Error boundaries do not run under renderToStaticMarkup, so this test
    // feeds the throwing child as props, applies getDerivedStateFromError,
    // and renders the fallback — no Canvas or DOM environment required.
    const children = createElement(ThrowingChild);
    const nextState = WebGlErrorBoundary.getDerivedStateFromError(
      new Error("simulated WebGL failure"),
    );
    const boundary = new WebGlErrorBoundary({ children });
    boundary.state = nextState;
    expect(markupText(renderToStaticMarkup(boundary.render() as ReactElement))).toContain(
      WEBGL_UNAVAILABLE,
    );
  });

  it("renders the short fallback copy", () => {
    expect(markupText(renderToStaticMarkup(<WebGlFallback />))).toContain(WEBGL_UNAVAILABLE);
  });
});
