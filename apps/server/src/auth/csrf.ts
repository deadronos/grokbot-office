import type { Context } from "hono";

import type { AppEnv } from "./middleware.ts";

/**
 * Cross-site protection for cookie-authenticated mutations.
 *
 * `Sec-Fetch-Site: same-origin` is enough: the browser says this request came from
 * the page's own origin, which a foreign site cannot spoof. Otherwise we compare the
 * Origin's host[:port] to the `Host` header (scheme ignored), so a TLS-terminating
 * proxy — where the browser sends `https://viewer` but Node sees an `http://` URL —
 * still matches. An allowlisted `CORS_ORIGINS` entry also counts.
 *
 * A client that sends neither `Origin` nor `Sec-Fetch-Site` (curl, older tooling)
 * is let through, since it never carries a browser's ambient cookie.
 */
export function isTrustedOrigin({
  origin,
  host,
  allowedOrigins,
}: {
  origin: string;
  host: string | undefined;
  allowedOrigins: readonly string[];
}): boolean {
  if (allowedOrigins.includes(origin)) return true;
  return originHostMatches(origin, host);
}

/** Host only, ignoring scheme: `https://office.example` matches `Host: office.example`. */
export function originHostMatches(origin: string, hostHeader: string | undefined): boolean {
  if (hostHeader === undefined || hostHeader.trim() === "") return false;
  try {
    const url = new URL(origin);
    const header = hostHeader.trim();
    if (url.host.toLowerCase() === header.toLowerCase()) return true;
    const headerHost = header.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    const colon = splitHostPort(headerHost);
    if (colon.hostname !== hostname) return false;
    // A Host without a port (typical behind a TLS proxy on 443) matches the hostname.
    if (colon.port === undefined) return true;
    const originPort = url.port || (url.protocol === "https:" ? "443" : "80");
    return colon.port === originPort;
  } catch {
    return false;
  }
}

function splitHostPort(host: string): { hostname: string; port?: string } {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { hostname: host };
    const rest = host.slice(end + 1);
    return {
      hostname: host.slice(0, end + 1),
      port: rest.startsWith(":") ? rest.slice(1) : undefined,
    };
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return { hostname: host };
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

/** `undefined` when the request may proceed, otherwise the generic 403 to return. */
export function guardCookieMutation(
  c: Context<AppEnv>,
  allowedOrigins: readonly string[],
): Response | undefined {
  const site = c.req.header("sec-fetch-site");
  if (site === "same-origin") return;

  const origin = c.req.header("origin");
  if (origin !== undefined) {
    // Prefer the Host header (what a TLS proxy forwards). Fall back to the
    // request URL's host only when Host is absent, as in some unit tests and curl.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (isTrustedOrigin({ origin, host, allowedOrigins })) return;
    return c.json({ error: "forbidden" }, 403);
  }
  // Absent means a non-browser client; `same-site` is still same site even without Origin.
  if (site === undefined || site === "same-site") return;
  return c.json({ error: "forbidden" }, 403);
}
