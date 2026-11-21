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
  `tailscale serve status` must work. Funnel needs a free HTTPS port on the node:
  check `tailscale serve status --json` before enabling it (step 4).
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
umask 077
mkdir -p ~/.local/share/grokbot-office ~/.config/grokbot-office
cp .env.example ~/.config/grokbot-office/.env
chmod 600 ~/.config/grokbot-office/.env
```

Create both directories with mode `700`: the config directory holds the admin and
bot tokens, and the data directory holds the SQLite database, which stores token
hashes. SQLite creates its files as `644`, so create the directory private first
rather than relying on the file mode.

Then edit `~/.config/grokbot-office/.env`:

- `ADMIN_TOKEN` — generate with `openssl rand -base64 32`. While it is unset, still
  `change-me`, or shorter than 32 characters after trimming, every `/api/admin/*`
  route answers `503`.
- `NODE_ENV=production` — set it. The only effect in the server is that
  `DATABASE_PATH` must then be absolute (see the next bullet); it invents no other
  behavior.
- `DATABASE_PATH` — an absolute path, e.g.
  `/Users/<you>/.local/share/grokbot-office/bot-office.db`. Relative paths resolve
  against `apps/server/`, which is not what you want for a service; an absolute path
  works either way and is required when `NODE_ENV=production` (the server throws
  `DATABASE_PATH must be an absolute path in production` at startup otherwise).
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
the checkout on the Mac. Because the loader looks for that file at a fixed path, each
start then logs `No .../.env; copy .env.example to .env to configure it.` — expected
and harmless here: `--env-file` has already loaded the same settings.

One-off admin commands (`pnpm admin ...`) read the repo-root `.env` only, so point
`DATABASE_PATH` at the same database explicitly:

```bash
DATABASE_PATH=/Users/<you>/.local/share/grokbot-office/bot-office.db \
  pnpm admin token create --kind viewer
```

Without that prefix the command silently uses `apps/server/data/bot-office.db` and
creates a second, empty database: the token or bot it prints never reaches the
running service, and nothing warns you. Always pass the absolute path.

## 3. launchd agent

The committed example is
[`deploy/launchd/com.example.grokbot-office.plist.example`](../deploy/launchd/com.example.grokbot-office.plist.example).
It runs one Node process, restarts it after a crash, and appends stdout/stderr to
`~/Library/Logs/grokbot-office/server.log`.

Before installing, replace every `<you>`. Then resolve the Node path:
`command -v node` may return a version-manager shim (volta, fnm, asdf, vite-plus and
similar), and launchd fails or starts the wrong Node when `ProgramArguments` points
at a shim. Resolve it to a real binary — for example `/opt/homebrew/bin/node` on
Apple Silicon — and confirm it with `<path> --version` before putting that path in
the plist. launchd has no shell `PATH`, so the path must be absolute. The committed
example already uses `/opt/homebrew/bin/node`.

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
job exits immediately, so check that `GET /api/health` answers `{"ok":true,"service":...}`.

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
keep `VIEWER_PORT` inside the tailnet.

First check what the node already serves. Plain `tailscale serve status` and
`tailscale funnel status` hide foreground serves; `--json` shows them:

```bash
tailscale serve status --json
```

If another app has a foreground `tailscale serve --bg=false` on 443, Funnel fails
with `foreground listener already exists for port 443` and the plain status
commands do not show why. Funnel may only use 443, 8443 or 10000, so pick a free
one. With 443 free (the default):

```bash
# public: https://<machine>.<tailnet>.ts.net -> 127.0.0.1:8787
tailscale funnel --bg 8787

# tailnet only: https://<machine>.<tailnet>.ts.net:8443 -> 127.0.0.1:8788
tailscale serve --bg --https=8443 8788
```

If 443 is already taken, put Funnel on 10000 (or 8443) and the viewer elsewhere:

```bash
tailscale funnel --bg --https=10000 8787
tailscale serve --bg --https=8443 8788
```

In that case point bots' `BO_URL` at `https://<machine>.<tailnet>.ts.net:10000`,
including the port. `--bg` keeps the configuration across reboots and Tailscale
restarts. Check both with `tailscale funnel status` and `tailscale serve status`.
The viewer URL is then `https://<machine>.<tailnet>.ts.net:8443`; the API base for
bots is `https://<machine>.<tailnet>.ts.net`, or the Funnel port URL above.

**Never** run `tailscale serve reset` (or treat `funnel reset` / `serve reset` as the
normal undo). Those clear every app's Serve/Funnel entry on the node. Turn off only
these routes with `off` on the same port (step 9).

Testing Funnel from the Mac itself is not a public-path check: the MagicDNS
hostname resolves over the tailnet. Test from another network, or use
`curl --resolve` against the hostname's public DNS answer.

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

`HSTS` is off by default. With it off, the viewer surface (and the single-port app)
sends `Strict-Transport-Security: max-age=31536000` only when the request already looks
like HTTPS: an `https` `Origin`/`Referer`, or `X-Forwarded-Proto: https`. The
Funnel-facing bot port never sends it on a hint, only with `HSTS` enabled. A typed
HTTPS URL does not provide that hint, so a fresh browser may get no HSTS header until
it sends one. Behind Funnel/Serve, set `HSTS=true` (or `1`) — the deployment is always HTTPS
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

Restore, in this order:

1. `launchctl bootout gui/$(id -u)/com.example.grokbot-office` — never replace the
   database under a running server.
2. Move aside the old `bot-office.db-wal` and `bot-office.db-shm` next to
   `DATABASE_PATH`. A leftover WAL from the previous file would be replayed into the
   restored database and corrupt it.
3. Put the backup at `DATABASE_PATH` (an online `.backup` copy is self-contained, so
   its `.db` is enough). Restoring a cold copy means restoring all three files —
   `.db`, `-wal`, `-shm` — together, from the same moment.
4. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.grokbot-office.plist`.
   Step 1 unloaded the job, so reload it the same way as the install section;
   `kickstart` would fail on an unloaded job.

Migrations from the running build are applied on start, so a backup older than the
current schema is upgraded in place; a backup from a newer build may not open. Copy a
backup off the machine (Time Machine, another disk, a private location), and remember
tokens live in the database — the backup is as sensitive as the token file.

## 9. Rollback / disable

Undo the exposure first, then the service. Do not use `tailscale funnel reset` or
`tailscale serve reset`: those clear every Serve/Funnel entry on the node, not just
this service. Turn off only these routes, on the HTTPS ports actually enabled:

```bash
tailscale funnel --https=443 off     # or --https=10000 if 443 was taken
tailscale serve --https=8443 off
```

If that is not the setup you installed, check `tailscale serve status --json` first.
Then stop and remove the LaunchAgent:

```bash
launchctl bootout gui/$(id -u)/com.example.grokbot-office
rm ~/Library/LaunchAgents/com.example.grokbot-office.plist
```

The env file and the database stay where they are; delete
`~/.config/grokbot-office/.env` only if you also intend to revoke tokens.
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

## 11. cmux status adapter (Mac only, opt-in)

The office can show what cmux workspaces are doing, but only through a small adapter
that runs on the Mac as your user. The server never calls cmux, and the adapter is
disabled unless you enable it.

It polls `cmux list-workspaces`, then `cmux list-status` for each workspace, and
maps the coding-agent state:

| cmux state | event sent                             |
| ---------- | -------------------------------------- |
| `Running`  | `task_started`, label = workspace name |
| `Idle`     | `status_changed` with `idle`           |
| `Done`     | `task_finished` with `done`            |

When every coding-CLI status disappears after one was `Running`, the adapter sends
`status_changed` with `idle` so the desk does not stay at work. Only state
transitions produce an event; an unchanged workspace stays silent. If
several workspaces are running, the lexicographically first name wins, so the
label is deterministic. A workspace with no coding-agent status entry is ignored,
and human `cmux set-status` keys (for example `task=...`) are never treated as a
state or used as a label.

The adapter sends only the workspace name. Program status text, prompts,
`list-log` and sidebar log lines, set-status values, git branches and cwd paths are
never sent or written to its log. Workspace names go through the normal label
sanitizer and are truncated or skipped, never sent raw. A workspace with a custom
title sends that title. A workspace without one sends only the basename of cmux's
auto title (`~/projects/demo-app` becomes `demo-app`, `…/org/demo-repo/dist`
becomes `dist`); a full or home-relative path, or a `workspace:…` ref, is never
sent as a label. A workspace whose title yields no basename is skipped. Give a
workspace a custom title if you want a specific public label.

Only bot-owned workspaces are reported; everything else is skipped by default.
A workspace is reported when its custom title (or the basename that would be sent)
starts with `CMUX_ADAPTER_PREFIX` (default `gbo `, trailing space included, so
`gbo #21 nits` matches but `gbother` does not), or when its name or ref appears in
the comma-separated `CMUX_ADAPTER_ALLOW` list. That filter runs before aggregation,
so a personal Running workspace can neither become the label nor change the desk
state. An empty `CMUX_ADAPTER_PREFIX` is not "allow all": with the allow list empty
too, nothing is reported. Bots should keep naming their workspaces `gbo …`, or the
operator lists them in `CMUX_ADAPTER_ALLOW`. If nothing matches, the adapter sends
no workspace events and only heartbeats.

Use a dedicated `cmux` bot, not a second token on an existing bot: one bot is one
desk row, and the adapter only knows Running/Idle/Done, so it would fight that
bot's own reports. Create it once, on the Mac, against the real database:

```bash
DATABASE_PATH=/Users/<you>/.local/share/grokbot-office/bot-office.db \
  pnpm admin bot create --id cmux --name Cmux
DATABASE_PATH=/Users/<you>/.local/share/grokbot-office/bot-office.db \
  pnpm admin token create --kind bot --bot cmux
```

The token is printed once. Put it in a file outside the repository:

```bash
install -m 600 /dev/null ~/.config/grokbot-office/cmux.token
# paste the printed token into that file, then:
chmod 600 ~/.config/grokbot-office/cmux.token
```

Run it by hand first (Node 24+ strips the TypeScript, no build step):

```bash
export CMUX_ADAPTER_ENABLED=true
export BO_URL=http://127.0.0.1:8787   # the bot API PORT; keep them in step
export BO_BOT_ID=cmux
export BO_TOKEN_FILE=/Users/<you>/.config/grokbot-office/cmux.token
pnpm --filter @grokbot-office/cmux-adapter start        # every 60 s
pnpm --filter @grokbot-office/cmux-adapter start -- --once   # one poll, then exit
```

`BO_TOKEN` works too; the file is read only when it is empty, which keeps the token
out of a launchd plist. The adapter runs on the same Mac as the server, so it talks
to loopback: do not point it at the Funnel or tailnet URL, and nothing new needs to
be exposed by Funnel or Serve. The flag must be exactly `true`; without it, or with
`BO_URL`, `BO_TOKEN`/`BO_TOKEN_FILE` or `BO_BOT_ID` missing, the adapter logs that
it is disabled, posts nothing and exits 0. Optional settings:
`CMUX_BIN` (default `/Applications/cmux.app/Contents/Resources/bin/cmux`) and
`CMUX_ADAPTER_POLL_SEC` (default `60`), `CMUX_ADAPTER_PREFIX` (default `gbo `) and
`CMUX_ADAPTER_ALLOW` (default empty).

For a permanent adapter, install a separate user LaunchAgent; do not add it to the
office service's plist. `deploy/launchd/com.example.grokbot-office.cmux-adapter.plist.example`
is a template with placeholders; launchd expands no `~` or variables, so every path
must be absolute. cmux is a GUI app, so the job must run in your GUI session:

```bash
cp deploy/launchd/com.example.grokbot-office.cmux-adapter.plist.example \
  ~/Library/LaunchAgents/com.example.grokbot-office.cmux-adapter.plist
# edit every <placeholder>, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.grokbot-office.cmux-adapter.plist
```

Its log is `~/Library/Logs/grokbot-office/cmux-adapter.log`. A failing poll logs
`cmux-adapter: poll failed; retrying` and backs off: the wait doubles from
`CMUX_ADAPTER_POLL_SEC` on each consecutive failure (60 s, 120 s, 240 s, …), capped
at 8× that interval (8 minutes by default). A successful poll resets the wait to
`CMUX_ADAPTER_POLL_SEC`. `--once` still makes a single attempt. Stop it with
`launchctl bootout gui/$(id -u)/com.example.grokbot-office.cmux-adapter`.

If nothing appears in the office, check that the workspace has a coding-agent
status entry: a workspace whose only entry is a human `task=...` is ignored on
purpose. `401` or `403` in the log means the token does not match `BO_BOT_ID`.
