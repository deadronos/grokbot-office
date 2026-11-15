import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { LoginScreen } from "./LoginScreen";

describe("App", () => {
  it("renders the app heading", () => {
    expect(renderToStaticMarkup(<App />)).toContain("Grokbot Office");
  });

  it("renders an accessible viewer login form", () => {
    const html = renderToStaticMarkup(<LoginScreen />);
    expect(html).toContain("Viewer sign in");
    expect(html).toContain('for="viewer-token"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Sign in");
  });

  it("labels the connection state", () => {
    expect(renderToStaticMarkup(<ConnectionIndicator />)).toContain("reconnecting");
  });
});
