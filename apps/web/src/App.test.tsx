import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { LoginForm, LoginScreen } from "./LoginScreen";
import { SessionBar } from "./SessionBar";
import { BAD_TOKEN_MESSAGE } from "./store/officeStore";

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
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
  });

  it("wires a login error to the token input", () => {
    const html = renderToStaticMarkup(
      <LoginForm pending={false} error={BAD_TOKEN_MESSAGE} onSubmit={() => {}} />,
    );
    expect(html).toContain("aria-invalid");
    expect(html).toContain('aria-describedby="login-error"');
    expect(html).toContain('id="login-error"');
    expect(html).toContain(BAD_TOKEN_MESSAGE);
  });

  it("labels the connection state", () => {
    expect(renderToStaticMarkup(<ConnectionIndicator />)).toContain("reconnecting");
  });

  it("shows a sign out control once the session is ready", () => {
    const html = renderToStaticMarkup(<SessionBar />);
    expect(html).toContain("Sign out");
    expect(html).toContain('type="button"');
  });
});
