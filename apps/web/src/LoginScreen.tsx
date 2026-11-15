import { useState, type FormEvent } from "react";

import { useOfficeStore } from "./store/officeStore";

/**
 * Viewer sign in. The token lives in local state just long enough for the
 * submit; the server answers with an HttpOnly cookie and the token is dropped.
 */
export function LoginScreen() {
  const login = useOfficeStore((state) => state.login);
  const pending = useOfficeStore((state) => state.pending);
  const error = useOfficeStore((state) => state.error);
  const [token, setToken] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = token.trim();
    setToken("");
    if (value) void login(value);
  };

  return (
    <section className="login-overlay" aria-labelledby="login-title">
      <form className="login-form" onSubmit={handleSubmit}>
        <h2 id="login-title" className="login-title">
          Viewer sign in
        </h2>
        <p className="login-hint">
          Paste a viewer token. It becomes a session cookie and is never stored in the browser.
        </p>
        <label className="login-label" htmlFor="viewer-token">
          Viewer token
        </label>
        <input
          id="viewer-token"
          className="login-input"
          name="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          disabled={pending}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="login-submit" type="submit" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
