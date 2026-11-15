import type { Context } from "hono";

import type { AppEnv } from "./middleware.ts";

/**
 * Cross-site protection for cookie-authenticated mutations. A browser sends `Origin`
 * on every POST, so a foreign one is refused; a client that sends neither `Origin`
 * nor `Sec-Fetch-Site` (curl, older tooling) is let through, since it never carries
 * a browser's ambient cookie.
 *
 * The request's own origin counts as trusted: the Vite dev proxy and the Funnel both
 * present the browser's host, and it cannot be forged from a foreign page.
 */
export function isTrustedOrigin({
  origin,
  requestUrl,
  allowedOrigins,
}: {
  origin: string;
  requestUrl: string;
  allowedOrigins: readonly string[];
}): boolean {
  if (allowedOrigins.includes(origin)) return true;
  try {
    return origin === new URL(requestUrl).origin;
  } catch {
    // A malformed request URL cannot be same-origin with anything.
    return false;
  }
}

/** `undefined` when the request may proceed, otherwise the generic 403 to return. */
export function guardCookieMutation(
  c: Context<AppEnv>,
  allowedOrigins: readonly string[],
): Response | undefined {
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    if (isTrustedOrigin({ origin, requestUrl: c.req.url, allowedOrigins })) return;
    return c.json({ error: "forbidden" }, 403);
  }
  const site = c.req.header("sec-fetch-site");
  // Absent means a non-browser client; present means the browser says how it got here.
  if (site === undefined || site === "same-origin" || site === "same-site") return;
  return c.json({ error: "forbidden" }, 403);
}
