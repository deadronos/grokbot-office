# ADR 0004: Tailscale Funnel for the bot API, private viewer

Status: Accepted

## Context

Bots run on several machines and must reach the office API from the public internet
with small HTTPS calls. The viewer must stay private: it shows who is working on what,
and a public read endpoint would leak the team's activity. The server itself must not
be exposed directly, and the operator wants no certificate management, no port
forwarding on the router and no extra reverse proxy to maintain. The deployment target
is one Mac that may sleep.

## Decision

Run one server process that binds `127.0.0.1` only, and let Tailscale decide what
leaves the machine.

- `VIEWER_TAILNET_ONLY=true` builds two apps in one process: the bot API on `PORT`
  (default 8787) and the viewer on `VIEWER_PORT` (default 8788), each with its own
  route allowlist and rate-limit buckets. The bot surface serves only register,
  heartbeat, events and health; viewer, session, admin and stream routes answer `404`
  there.
- `tailscale funnel` exposes only `PORT`, publicly, as
  `https://<machine>.<tailnet>.ts.net`. `tailscale serve` exposes `VIEWER_PORT` to the
  tailnet on a separate HTTPS port (8443, since Funnel owns 443).
- Tailscale terminates TLS with a certificate for the tailnet name. The server keeps
  seeing plain HTTP on loopback, so HSTS is explicit (`HSTS=true`) rather than guessed
  from the request, and `X-Forwarded-Proto` is only ever a hint.
- The viewer cookie stays `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/api`. The bot
  API uses `Authorization: Bearer` tokens, so no cookie or CSRF surface is public.
- There is no `TRUST_PROXY` switch: the client address is the socket address, and
  `X-Forwarded-For` is ignored. Every Funnel client therefore shares the loopback
  address for unauthenticated budgets, with `RATE_LIMIT_COOKIE_PER_MIN` as the
  garbage-cookie backstop.

## Consequences

- No public viewer, no public admin surface, no self-managed certificates, and the
  bot API is still reachable from anywhere that can call HTTPS.
- Everyone who watches the office needs Tailscale on their device; bots do not.
- Funnel requires MagicDNS, tailnet HTTPS certificates and a Funnel node attribute
  in the tailnet policy. These are tailnet-level prerequisites, not code.
- Because all traffic arrives from `127.0.0.1`, per-address rate limits cannot
  distinguish external clients; per-token and per-session budgets carry the real
  load. The Funnel port is limited to the bot routes, so the shared bucket only sees
  unauthenticated probes and failed auth.
- A sleeping Mac makes both surfaces unreachable; the viewer reports `office closed`
  and bots go offline after the heartbeat timeout. Keeping it awake is an operator
  choice (`caffeinate` or Energy settings), documented in the runbook, not a server
  feature.
- Two ports in one process share one SQLite handle, which keeps the single-writer
  assumption from [ADR 0002](0002-drizzle-sqlite.md) intact.

Operator steps are in [`docs/runbook-mac.md`](../runbook-mac.md). See
[ADR 0003](0003-sse.md) for the stream these surfaces carry.
