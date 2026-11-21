# Runbook: run the office on a Mac

This is the operator guide for running `grokbot-office` on a Mac (for example an M4
Mac mini) under a user LaunchAgent and reaching it through Tailscale Funnel (public
bot API) and Tailscale Serve (private viewer). It is documentation only: nothing here
is installed or enabled by this repository.

All values are placeholders — the repo is public. Replace:

| Placeholder        | Meaning                                                            |
| ------------------ | ------------------------------------------------------------------ |
| `<you>`            | your macOS user name                                               |
| `/Users/<you>/...` | an absolute path on the Mac                                        |
| `<machine>`        | this Mac's Tailscale machine name (MagicDNS)                       |
| `<tailnet>`        | your tailnet name; the public host is `<machine>.<tailnet>.ts.net` |

Do not commit real hostnames, tailnet names, user names, paths, IPs or tokens.

## Before you start

- Node.js 24 or newer (`node --version`; the repo pins 24 in `.nvmrc`), pnpm 12
  (`corepack enable`).
- Tailscale 1.52 or newer, MagicDNS and HTTPS certificates enabled, and Funnel
  allowed for this node in the tailnet policy file. `tailscale funnel status` and
  `tailscale serve status` must work.
- The repo checked out on the Mac, for example `/Users/<you>/git/grokbot-office`.
- The viewer is a static build: `pnpm build` must have produced `apps/web/dist`.

## 1. Build

```bash
cd /Users/<you>/git/grokbot-office
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` bundles the server to `apps/server/dist/index.js` (migrations are copied
next to it) and builds the web app to `apps/web/dist`. The viewer surface only serves
the web app when that directory exists, so rebuild and restart after a web change.

## 2. Environment file, outside the repo

The real env file must not live in the checkout. Put it under your home directory:

```bash
mkdir -p ~/.config/grokbot-office
cp .env.example ~/.config/grokbot-office/.env
chmod 600 ~/.config/grokbot-office/.env
```

Then edit `~/.config/grokbot-office/.env`:

- `ADMIN_TOKEN` — generate with `openssl rand -base64 32`. While it is unset, still
  `change-me`, or shorter than 32 characters after trimming, every `/api/admin/*`
  route answers `503`.
- `DATABASE_PATH` — an absolute path, e.g.
  `/Users/<you>/.local/share/grokbot-office/bot-office.db`. Relative paths resolve
  against `apps/server/`, which is not what you want for a service; an absolute path
  works either way and is required when `NODE_ENV=production`.
- `VIEWER_TAILNET_ONLY=true`, `PORT=8787`, `VIEWER_PORT=8788` — the two-port setup in
  step 4.
- `HSTS=true` — only when every client reaches the app over HTTPS (see step 4).
- `BO_URL=https://<machine>.<tailnet>.ts.net` — what bots on other machines should
  call. `scripts/bo.sh` warns when that is plain `http` to a non-loopback host,
  because the token would travel in the clear.

How it is loaded: the server does **not** read this file by location. `launchd` starts
Node with `--env-file=...` (see the plist). Node keeps any variable already in the
process environment and adds the rest from the file. The server also loads a
repo-root `.env` if one exists, but that loader never overwrites variables that are
already set, so the file passed on the command line always wins. Keep no `.env` in
the checkout on the Mac.

One-off admin commands (`pnpm admin ...`) read the repo-root `.env` only, so point
`DATABASE_PATH` at the same database explicitly:

```bash
DATABASE_PATH=/Users/<you>/.local/share/grokbot-office/bot-office.db \
  pnpm admin token create --kind viewer
```

## 3. launchd agent

The committed example is
[`deploy/launchd/com.example.grokbot-office.plist.example`](../deploy/launchd/com.example.grokbot-office.plist.example).
It runs one Node process, restarts it after a crash, and appends stdout/stderr to
`~/Library/Logs/grokbot-office/server.log`.

Before installing, replace every `<you>` and check the Node path (`command -v node` —
Homebrew on Apple Silicon uses `/opt/homebrew/bin/node`, but nvm and other installs
differ; launchd has no shell `PATH`, so the path must be absolute).

### Install

```bash
mkdir -p ~/Library/Logs/grokbot-office
cp deploy/launchd/com.example.grokbot-office.plist.example \
  ~/Library/LaunchAgents/com.example.grokbot-office.plist
# edit the copy, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.grokbot-office.plist
```

`bootstrap` loads and starts the job because of `RunAtLoad`. The older
`launchctl load` / `unload` pair still works but is deprecated.

### Start, stop, restart, status

```bash
launchctl print gui/$(id -u)/com.example.grokbot-office   # status and last exit code
launchctl kickstart -k gui/$(id -u)/com.example.grokbot-office   # restart now
launchctl bootout gui/$(id -u)/com.example.grokbot-office        # stop and unload
```

`launchctl kickstart -k` is the normal restart: it stops the process and starts it
again, and the server's `SIGTERM` handler closes SSE streams and checkpoints the WAL.
With `KeepAlive` on a failed exit only, a clean stop stays stopped.

### Logs

```bash
tail -f ~/Library/Logs/grokbot-office/server.log
```

The server logs the listening ports on start and the reason for an auth failure
(never the credential). Startup errors — invalid env values, a relative
`DATABASE_PATH` in production, a port clash in two-port mode — appear here and the
job exits immediately, so an empty `GET /api/health` is the first thing to check.

### Upgrade

```bash
cd /Users/<you>/git/grokbot-office
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
launchctl kickstart -k gui/$(id -u)/com.example.grokbot-office
```

Migrations in `apps/server/drizzle/` run on every start; a failed migration stops the
process instead of serving a half-migrated database. Back up first (step 8).

## 4. Tailscale: public bot API, private viewer

Both server listeners bind `127.0.0.1` only. Tailscale decides what leaves the
machine, so never change the bind address.

### Two-port mode (recommended)

`VIEWER_TAILNET_ONLY=true` starts two apps:

| Process | Listener             | Routes                                                                                           |
| ------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| bot API | `PORT`, default 8787 | `POST /api/bots/register`, `POST /api/bots/:id/heartbeat`, `POST /api/events`, `GET /api/health` |
| viewer  | `VIEWER_PORT`, 8788  | viewer, session, admin and stream routes, plus the built web app                                 |

Everything else answers `404` on the bot port. So expose only `PORT` publicly, and
keep `VIEWER_PORT` inside the tailnet:

```bash
# public: https://<machine>.<tailnet>.ts.net -> 127.0.0.1:8787
tailscale funnel --bg 8787

# tailnet only: https://<machine>.<tailnet>.ts.net:8443 -> 127.0.0.1:8788
tailscale serve --bg --https=8443 8788
```

Funnel may only listen on 443, 8443 or 10000; `--bg` keeps the configuration across
reboots and Tailscale restarts. Check both with `tailscale funnel status` and
`tailscale serve status`. The viewer URL is then
`https://<machine>.<tailnet>.ts.net:8443`; the API base for bots is
`https://<machine>.<tailnet>.ts.net`.

Bots only need the bot port (register, heartbeat, events). The viewer needs the viewer
port and must be opened in a browser on a device in the tailnet. There is no public
read mode: keep the viewer behind Serve, not behind Funnel.

### Single-port mode

Leave `VIEWER_TAILNET_ONLY` unset or `false` (the default). One app serves API and web
app on `PORT` (8787), so a single `tailscale funnel --bg 8787` exposes the viewer too.
Only do this if you accept a public viewer; the login is still required.

### Ports and privacy recap

- Expose one port publicly: `PORT` (8787). Never point Funnel at `VIEWER_PORT`.
- Serve the viewer on a different HTTPS port (8443) so Funnel's 443 stays the bot API.
- The web app is served only when `apps/web/dist` exists (override with `WEB_DIST`).
- `GET /api/health` exists on both ports, so a Serve/Funnel probe has something to hit.

### HSTS

`HSTS` is off by default. With it off, the server sends
`Strict-Transport-Security: max-age=31536000` only when the request already looks like
HTTPS: an `https` `Origin`/`Referer`, or `X-Forwarded-Proto: https`. A typed HTTPS URL
does not provide that hint, so a fresh browser may get no HSTS header until it sends
one. Behind Funnel/Serve, set `HSTS=true` (or `1`) — the deployment is always HTTPS
from the client's point of view, and every response then carries the header on every
surface, including the Funnel-facing bot port. An unparseable value stops the server at
startup.

Warning: HSTS is sticky. Only enable it if the same hostname is always reached over
HTTPS. If you later serve that hostname over plain HTTP, browsers refuse to connect
until their HSTS entry expires or is cleared. Local `http://127.0.0.1:8788` checks are
unaffected (browsers ignore HSTS on plain-HTTP responses and for IP-address hosts),
but do not build a plain-HTTP workflow around the real hostname.

There is no `TRUST_PROXY` setting and nothing to enable. The server ignores
`X-Forwarded-For` entirely and ignores `X-Forwarded-Proto` except as the HSTS hint
above. The client address used for rate limits is always the socket address, and
behind Serve/Funnel that is `127.0.0.1` for every client.

## 5. Cookies and CSRF behind Serve/Funnel

The viewer trades a bearer token for one cookie on `POST /api/session`:

`__Secure-bo_session=<secret>; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=<ttl>`

- `Secure` and the `__Secure-` prefix require HTTPS. The browser sees HTTPS from
  Tailscale, so the cookie is stored; there is no insecure fallback. Do not test the
  sign-in flow over plain HTTP to a non-loopback host.
- `Path=/api` keeps the cookie off the static viewer assets.
- `SameSite=Strict` means the cookie is not sent on cross-site navigations or
  subresource requests. Opening the viewer URL directly is fine; a link from another
  site will show the login form once.
- `HttpOnly` keeps the cookie away from scripts. The web app never reads or writes it.
- Lifetime is `SESSION_TTL_SEC` (default 28800 = 8 h, maximum 604800), with idle and
  rotation values in `.env.example`. Rotation replaces the secret on a normal request;
  an open `GET /api/stream` neither rotates nor ends (its 25 s pings count as activity).

Cookie-authenticated writes (`POST /api/session/logout`) are CSRF-checked. The server
accepts `Sec-Fetch-Site: same-origin` first; otherwise an `Origin` must match the
`Host` header by host and port (scheme ignored) or be listed in `CORS_ORIGINS`.
Browsers send `Sec-Fetch-Site: same-origin` for the viewer's own fetches, so the
default setup needs no extra configuration behind Serve/Funnel. Leave `CORS_ORIGINS`
empty for the two-port production setup; it is only for a web app served from a
different origin (for example the Vite dev server on `http://127.0.0.1:5173`). Reads
never need an origin.

The bot API does not use cookies: bots send `Authorization: Bearer <token>`, which a
cross-site page cannot set without a preflight the allowlist refuses.

## 6. Rate limits behind the shared loopback address

Every client arrives from `127.0.0.1` (the Tailscale proxy), and the server never
trusts `X-Forwarded-For`. Consequences in two-port mode (each port has its own
buckets):

- Authenticated bot and viewer requests are budgeted per token/session
  (`RATE_LIMIT_PER_MIN=60`, `RATE_LIMIT_BURST=20`), so one noisy bot cannot exhaust
  another's budget; each bot has its own token.
- Unauthenticated requests share one per-address bucket
  (`RATE_LIMIT_IP_PER_MIN=30`, `RATE_LIMIT_IP_BURST=10`), because they all look like
  `127.0.0.1`. Failed bearer attempts use a separate bucket with the same numbers.
- Cookies that match no live session spend their own ceiling,
  `RATE_LIMIT_COOKIE_PER_MIN` (default 600). It is the backstop that keeps a garbage
  cookie flood from turning an honest stale cookie into `429`; the flood pays that
  many hash/lookups per minute, while a stale cookie still gets its `401` and a
  cleared cookie.
- `GET /api/health` is exempt; over the limit is `429` with `Retry-After`.

If you raise a budget, keep `RATE_LIMIT_BURST <= RATE_LIMIT_PER_MIN` and
`RATE_LIMIT_IP_BURST <= RATE_LIMIT_IP_PER_MIN`; a larger burst stops the server at
startup. Budgets are in memory: a restart clears every bucket.

## 7. Sleep, or accept "office closed"

A sleeping Mac drops Funnel/Serve and the viewer shows `office closed` after 45 s of
failed reconnects. If the office should stay up:

- System Settings → Energy (or Battery) → prevent automatic sleep while on power.
  On a laptop, closing the lid still sleeps the machine.
- A desktop Mac stays awake with that setting; alternatively run `caffeinate -i` in a
  terminal for as long as the office should be reachable. Do not rely on
  `caffeinate` from a closing terminal window.
- `caffeinate -s` only holds off system sleep while on AC power.

Otherwise accept the semantics: bots that cannot reach the API go offline after
`HEARTBEAT_TIMEOUT_SEC` (default 300), the office looks empty, and everything resumes
on wake. The database is safe across sleep; SQLite WAL recovery runs on the next
open.

## 8. Back up the SQLite database

The database is a single SQLite file in WAL mode. A plain `cp` while the server runs
can miss the `-wal` contents, so use SQLite's online backup:

```bash
mkdir -p ~/Backups/grokbot-office
sqlite3 /Users/<you>/.local/share/grokbot-office/bot-office.db \
  ".backup '/Users/<you>/Backups/grokbot-office/bot-office-$(date +%F).db'"
```

For a cold copy, stop the agent first, then copy `bot-office.db`, `bot-office.db-wal`
and `bot-office.db-shm` together. The server checkpoints the WAL on `SIGTERM`, so a
clean `launchctl bootout` normally leaves just the `.db` file.

Restore: stop the agent, put the backup file at `DATABASE_PATH`, start the agent.
Migrations from the running build are applied on start, so a backup older than the
current schema is upgraded in place; a backup from a newer build may not open. Copy a
backup off the machine (Time Machine, another disk, a private location), and remember
tokens live in the database — the backup is as sensitive as the token file.

## 9. Rollback / disable

Undo the exposure first, then the service:

```bash
tailscale funnel reset
tailscale serve reset
launchctl bootout gui/$(id -u)/com.example.grokbot-office
rm ~/Library/LaunchAgents/com.example.grokbot-office.plist
```

`tailscale funnel reset` and `tailscale serve reset` clear all Serve/Funnel
configuration on that node, not just this service — check `tailscale serve status`
first if the node serves anything else, and otherwise turn off only these routes with
the `off` suffix on the original command:

```bash
tailscale funnel --bg 8787 off
tailscale serve --bg --https=8443 8788 off
```

Then remove or disable the LaunchAgent. The env file and the database stay where they
are; delete `~/.config/grokbot-office/.env` only if you also intend to revoke tokens.
Revoke tokens through the admin CLI while the database still exists:

```bash
DATABASE_PATH=/Users/<you>/.local/share/grokbot-office/bot-office.db pnpm admin token list
DATABASE_PATH=/Users/<you>/.local/share/grokbot-office/bot-office.db pnpm admin token revoke <id>
```

## 10. Troubleshooting

| Symptom                                       | Check                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `launchctl print` shows a non-zero exit       | `server.log`: bad env value, relative `DATABASE_PATH`, or `VIEWER_PORT` equal to `PORT`                                                          |
| `curl http://127.0.0.1:8787/api/health` fails | the job is not running, or the port was changed in the env file                                                                                  |
| Funnel URL answers `502`                      | the server is down or on another port; `tailscale funnel status` shows the target                                                                |
| Viewer shows the login form in a loop         | the viewer URL must be HTTPS and the cookie needs `Secure`; plain HTTP to the real hostname fails                                                |
| Sign-in works, logout answers `403`           | `Origin` arrives but its host/port differs from `Host` (for example a proxy rewrite); `Sec-Fetch-Site: same-origin` normally short-circuits this |
| `429 rate limited`                            | client address buckets are shared on loopback; raise the relevant budget or wait for `Retry-After`                                               |
| Admin routes answer `503`                     | `ADMIN_TOKEN` is unset, the placeholder, or under 32 characters                                                                                  |
| Viewer is blank but the API works             | `apps/web/dist` is missing; run `pnpm build` and restart                                                                                         |
