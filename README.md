# grokbot-office

A low-poly 3D office that shows the Grokbot team live: each bot sits at a desk and
is idle, working, waiting, reviewing or offline, and handoffs are animated as a
packet flying from desk to desk. Bots report in opt-in over small HTTPS calls
(register, heartbeat, events); the browser receives live updates over SSE.

This repository currently contains workspace tooling, CI, the API server and the
web app. The web app signs a viewer in, keeps a zustand store in sync with the
server (`GET /api/state` plus the SSE stream) and renders the static office scene:
nine fixed desks, a placeholder low-poly bot per desk and name plates. Live status
visuals, the HUD list/feed and handoff animation come in later issues.

## Stack

- **Runtime:** Node.js 24, TypeScript (strict)
- **Server:** [Hono](https://hono.dev) on `@hono/node-server`
- **Web:** React 19 + Vite + React Three Fiber (three.js) + drei + zustand
- **Shared:** `@grokbot-office/shared` – constants and types used by both apps
- **Tooling:** pnpm workspaces, oxlint, oxfmt, Vitest, GitHub Actions

## Repo layout

```text
apps/server        Hono API (GET /api/health), testable app module + boot entry
apps/web           Vite + React Three Fiber office scene
packages/shared    Constants and types shared by server and web
.github/workflows  CI
```

## Prerequisites

- Node.js 24+ (see `.nvmrc`)
- pnpm 12 (pinned via `packageManager`; `corepack enable` is enough)

## Run locally

```bash
pnpm install
cp .env.example .env   # placeholders only; the server reads it if present
pnpm dev               # server on http://127.0.0.1:8787, web on http://127.0.0.1:5173
```

The Vite dev server proxies `/api` to the server, so `http://127.0.0.1:5173/api/health`
works from the browser.

Sign in at that Vite origin (`http://127.0.0.1:5173`), not by opening the API port in
the browser. Chrome treats loopback HTTP as a secure context, so it stores the
`__Secure-bo_session` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/api`)
on `http://127.0.0.1:5173` and on `http://localhost:5173`. There is no separate
dev-TLS setup. The dev server listens on `127.0.0.1` only, so `http://[::1]:5173`
will not connect.

## Web app (viewer)

The web app is private too. On first load it calls `GET /api/state` with
`credentials: "same-origin"`: a `401` shows the viewer sign-in form, a success means
the HttpOnly session cookie is still good so the office scene renders and
`GET /api/stream` opens.

Sign in pastes a viewer token once (`pnpm admin token create --kind viewer`). The
browser sends it as `Authorization: Bearer` to `POST /api/session`; success is `201`
with `{ "expiresAt": <ISO datetime> }` (the client ignores it) and the cookie
`__Secure-bo_session=<secret>; HttpOnly; Secure; SameSite=Strict; Path=/api;
Max-Age=<ttl>`, set by the server and never read or written by the client. Anything
else is a failure: `401` for a missing, unknown or revoked token, `403` for a bot
or admin token (the form says so), and any other status is reported generically.
The token is dropped right after the submit and is never written to `localStorage`,
`sessionStorage`, `document.cookie` or the URL. After that every call uses the cookie
through `credentials: "same-origin"` (the stream uses `withCredentials`), never the
bearer header and never a `?token=`/`?session=` query. `POST /api/session/logout`
always answers `204` (no auth, idempotent) and returns to the login form.

On first open the stream URL is `/api/stream?since=<lastEventSeq>` (canonical digits,
so events between the snapshot and the first frame are not lost). The URL is left
alone afterwards: when the browser reconnects `EventSource` sends `Last-Event-ID`
from the last frame it saw, and the server prefers that header over `?since=`.

The zustand store holds the snapshot, applies stream events immutably (skipping
`seq <= lastEventSeq` so a reconnect replay is idempotent), exposes a per-bot selector
so one desk can re-render on its own, and calls `invalidateScene()` so the on-demand
Canvas redraws. A `bot_registered` event for a bot that was not in the snapshot
refetches `GET /api/state`, because the frame does not carry name, role, avatar or pod.
A `status_changed` event without a `label` keeps the current one (the server omits a
null label on the wire, so an explicit clear never arrives). Top right: a sign-out
button, plus the connection indicator:

- `live` – the stream is open and event frames or 25 s `ping` frames (`data: {}`) arrive
- `reconnecting` – the stream errored; the browser's `EventSource` retries and resumes
  with `Last-Event-ID`. An expired or revoked session ends the open stream at the next
  ping, so each error also probes `GET /api/state`: a `401` there means the cookie is
  gone, the stream is closed and the viewer goes back to the login form
- `office closed` – nothing arrived for 45 s while reconnecting, or the first
  `GET /api/state` could not be reached (Mac asleep, server down); a probe that cannot
  reach the server keeps this timer running

A `pagehide` skips the session probe so a reload after rotation does not drop a
fresh `Set-Cookie`. `pageshow` clears that flag; a back-forward cache restore
(`event.persisted`) re-probes, so a session revoked in the meantime shows the
login form.

## Scripts

| Script              | What it does                      |
| ------------------- | --------------------------------- |
| `pnpm dev`          | Run server and web in parallel    |
| `pnpm build`        | Build all packages                |
| `pnpm lint`         | oxlint across the repo            |
| `pnpm format`       | Format with oxfmt                 |
| `pnpm format:check` | Verify formatting without writing |
| `pnpm typecheck`    | `tsc` for every package           |
| `pnpm test`         | Vitest for every package          |
| `pnpm admin ...`    | Admin token CLI (see below)       |

## Database

The server stores its state in SQLite (better-sqlite3, WAL mode) via Drizzle ORM.
The file comes from `DATABASE_PATH` (default `./data/bot-office.db`, gitignored).
Relative paths resolve against `apps/server/`, not the current directory, so the
default file is `apps/server/data/bot-office.db` no matter where you start the
server. `NODE_ENV=production` requires an absolute path. The database handle is
closed on `SIGTERM`/`SIGINT`, which checkpoints the WAL and removes the `-wal`/`-shm`
files.

Migrations live in `apps/server/drizzle/` and are applied on server start; the build
copies them to `apps/server/dist/drizzle/` so the bundled server and CLI find them.
After changing `apps/server/src/db/schema.ts`, run
`pnpm --filter @grokbot-office/server db:generate` and commit the new migration.
SQLite cannot add `CHECK` or foreign-key constraints in place, so such a migration
rebuilds the table; the migrator runs the whole migration set in one transaction with
foreign-key enforcement off, and every query after startup runs with it on.

## Tokens

Access is per-bot and viewer bearer tokens. The admin token comes from the
`ADMIN_TOKEN` env var only (never committed, never stored in the DB). It must be at
least 32 characters after trimming; while it is unset, still `change-me`, or too
short, every `/api/admin/*` route answers 503. Generate one with
`openssl rand -base64 32`.

- tokens are 32 random bytes (base64url), shown once, stored as a SHA-256 hash plus
  an 8-character prefix; `last_used_at` is updated on every authenticated request
- kinds: `bot` (bound to one bot slug) and `viewer`; admin stays env-only
- routes: `POST`/`GET /api/admin/tokens`, `DELETE /api/admin/tokens/:id`,
  `PATCH /api/admin/bots/:id`
- authorization headers are never logged

The admin CLI talks to the database directly, so it needs no `ADMIN_TOKEN` locally:

```bash
pnpm admin token create --kind bot --bot data   # prints the token once
pnpm admin token list                           # prefix/kind/last used, never plaintext
pnpm admin token revoke <token id>
```

## Bot API

Bots authenticate with their own bot token and may only act for that bot id: a
token bound elsewhere gets `403`, any missing/unknown/revoked token gets `401`.
Auth errors are generic; the server logs the reason, never the token.

Register (idempotent upsert of name, role, avatar and pod; the admin-set `hidden`
flag is kept, and desks come only from the shared layout). The reply carries the heartbeat
cadence the bot should use:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/bots/register \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"data","name":"Data","role":"Code-Orchestrator","avatar":"android-gold","pod":"dev"}'
# 200 {"id":"data","heartbeatIntervalSec":60,"timeoutSec":300}
```

Heartbeat (keep-alive; the optional `status` is one of `idle`, `working`,
`waiting`, `reviewing`, `offline`; an empty body is fine). A heartbeat is only a
keep-alive: work state comes from events, so a live bot is never changed by it.
The server sweeps stale heartbeats every 15 seconds. A bot whose last heartbeat is
older than `timeoutSec` is marked `offline`, its task, label and handoff links are
cleared, its `since` moves, and the server appends an `offline` event that viewers
receive over SSE. A bot that is already offline is left alone, and so is a bot with
no status row (not yet online). A later heartbeat or re-register brings an offline
bot back: an empty heartbeat or a re-register sets `idle`, an explicit non-`offline`
status is honoured, `since` moves to now, and viewers receive a `status_changed`
event. Already-online bots get no extra event. Hidden bots are updated in the
database the same way; the existing hidden-bot filter keeps their events off the
viewer snapshot and stream.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/api/bots/data/heartbeat \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"working"}'
# 204
```

`HEARTBEAT_INTERVAL_SEC` (default 60) and `HEARTBEAT_TIMEOUT_SEC` (default 300)
set the cadence; the timeout must be larger than the interval, and invalid
values stop the server at startup. Request bodies on `/api/*` are capped at
16 KB (`413` beyond that).

## Events

Bots report what they do as event batches: 1–20 events per request, all of them for
the token's own bot. A batch is applied in one transaction, so it either lands whole
or not at all. Event ids are ULIDs (or UUIDs); replaying a batch is safe because
`(bot_id, event_id)` is unique.

```bash
curl -sS -X POST http://127.0.0.1:8787/api/events \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"botId":"data","eventId":"01JBQ0M0S5R8D6P4W2G7X9K3ZY","type":"task_started","taskId":"issue-6","label":"events endpoint"}]}'
# 200 {"accepted":1,"duplicates":0,"lastSeq":1}
```

`lastSeq` is the highest event sequence in the database after the batch; clients
can use it to resume. `accepted` counts newly stored events, `duplicates` counts
events that were already there (they change nothing). The batch also counts as a
heartbeat.

The server derives `bot_status` from the events, in order:

| Event              | Status after it                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `status_changed`   | that status, with its `label`                                                                                                 |
| `task_started`     | `working`, `task_id` = the event's                                                                                            |
| `task_finished`    | `idle` (task and handoff links cleared); with a `taskId` that is not the current task it is recorded and the status stays     |
| `handoff_sent`     | `waiting` on that handoff (`handoff_to`, `handoff_id`), unless another task is still open                                     |
| `handoff_accepted` | `working` for the receiver (task = the event's `taskId`); the sender goes `idle` only if this is the handoff it is waiting on |

Whenever a bot comes to rest (`idle` or `offline`, from an event or a heartbeat) its
`task_id`, `label`, `handoff_to` and `handoff_id` are cleared; a `status_changed` label
still applies. A heartbeat `status` cannot end a derived `working`/`waiting` state unless
it is `offline`. `since` only moves when the status itself moves. Handoffs are tracked in `handoffs`
(`sent` → `accepted`). An event the server cannot apply (a handoff to itself or to an
unknown bot, a reused `handoffId`, a handoff the bot may not accept) fails the whole
batch with `422 {"error":"invalid event","index":1}`.

Times are the server's: `received_at` is one timestamp per batch. The client `at`
is display-only and is clamped to ±10 minutes around it.

The event log is pruned: once at startup and then every 24 hours the server deletes
events older than `RETENTION_DAYS` (default 90), then closed handoffs (`accepted` or
`cancelled`) whose accept time (or send time, if never accepted) is older than the
same window. Open (`sent`) handoffs are never pruned, and a closed handoff that a
remaining event or a live bot's `bot_status` links to is kept. `RETENTION_DAYS` must
be a positive integer at most 36500 (100 years), otherwise the server refuses to
start. Pruning leaves gaps in `seq`, like hidden bots' events do.

## Viewer API

The viewer is private: there is no public read mode. The read routes accept a viewer
bearer token (`pnpm admin token create --kind viewer`) or the env `ADMIN_TOKEN` as a
bearer token; anything else gets `401`, and a bot token gets `403`. They also accept
the HttpOnly session cookie the browser gets from `POST /api/session`, which is what
`EventSource` can use. A token in the query string is never accepted. Responses are
`Cache-Control: no-store`.

### Sessions

`EventSource` cannot send an `Authorization` header, so the browser trades its viewer
token for a cookie once. Stored sessions keep only a SHA-256 hash of the cookie secret;
`expires_at` is checked on every request, and revoking the viewer token ends its
sessions too.

```bash
# 201; the cookie holds a 32-byte secret, the database only its hash
curl -sS -X POST http://127.0.0.1:8787/api/session \
  -H "Authorization: Bearer $VIEWER_TOKEN" -c jar.txt

# 204; revokes the session (current or previous cookie hash, at any age) and always clears the cookie
curl -sS -o /dev/null -X POST http://127.0.0.1:8787/api/session/logout -b jar.txt
```

The cookie is `__Secure-bo_session`, `HttpOnly`, `Secure`, `SameSite=Strict`,
`Path=/api`, and expires with the session: `SESSION_TTL_SEC` (default 28800, at most 604800) is validated at startup. Any request body to `POST /api/session` is ignored.

Each viewer token may hold `SESSION_MAX_PER_TOKEN` sessions at once (default 5, at most
50). Creating one past the cap revokes the oldest session of that token, so a leaked
cookie does not accumulate: it is replaced, not joined. Expired rows are dropped in the
same transaction, so dead sessions never count. A session also ends after
`SESSION_IDLE_SEC` without a request (default 3600, at least 60 so it stays above the
25s SSE ping, and never above the TTL). An open tab with a live `GET /api/stream` never
goes idle: pings refresh `last_seen_at` (intended). The cookie secret is replaced after
`SESSION_ROTATE_SEC` (default 900) on the next non-stream request that presents the
current hash: the response carries a fresh `Set-Cookie` with the remaining TTL, and
`created_at` stays the login time so the per-token cap still evicts the oldest login.
The previous hash stays valid for `SESSION_ROTATE_GRACE_SEC` (default 60) and does not
rotate again, so in-flight requests and a reload that drops a `Set-Cookie` still work.
After the grace window the previous hash answers `401` on reads. Logout still finds the
row by current or previous hash at any age and revokes it, so both cookies then get
`401`. Rotation is compare-and-swap on the current hash, so two requests racing at the
boundary cannot lock the client out. An open `GET /api/stream` never rotates (it cannot
read a new cookie) and re-checks the session by id, so a rotation does not kill the
stream; a revoke, expiry or idle still does.

All three failure modes look the same from outside: a generic
`401 {"error":"unauthorized"}`, like any other rejected credential.

Cookie-authenticated writes (`POST /api/session/logout`) are checked for CSRF:
`Sec-Fetch-Site: same-origin` is accepted first. Otherwise a present `Origin` must
either be in `CORS_ORIGINS` or have the same host and port as the `Host` header (scheme
ignored). An omitted port uses the Origin scheme's default (443 for `https`, 80 for
`http`), so `Origin: https://office.example` still matches `Host: office.example` behind
a TLS proxy, but `https://office.example:8443` does not match a Host without a port.
A foreign host or a mismatched port gets `403 {"error":"forbidden"}` and changes nothing.
Requests without `Origin` (curl) and browsers reporting `Sec-Fetch-Site: same-site` are
allowed. Reads never need an origin, so the viewer keeps working.

### CORS and rate limits

`CORS_ORIGINS` is a comma-separated list of exact origins (scheme, host, port), empty by
default. Only a listed origin is reflected, always together with
`Access-Control-Allow-Credentials: true`, and `*` never appears next to credentials.
Preflight `OPTIONS` requests are answered before any auth or body read; an unlisted
origin gets a headerless `204` and the browser blocks the real request. The Vite dev
proxy is covered without configuration: the request's own origin is always trusted.

Two plus one token-bucket budgets apply: `RATE_LIMIT_PER_MIN` (default 60) with
`RATE_LIMIT_BURST` (default 20) per authenticated token or session, and
`RATE_LIMIT_IP_PER_MIN` (default 30) with `RATE_LIMIT_IP_BURST` (default 10) per client
address for unauthenticated requests that present no credentials. Failed bearer/token
attempts, and unknown or unparseable session cookies, use a separate bucket with those
same IP numbers, and are counted only after they fail, so a flood of bad tokens or
garbage cookies cannot turn a valid or expired cookie into `429`. A flood of garbage
cookies from the same address can `429` itself.
Logout is not rate-limited: it revokes first (after the CSRF check) so a flood cannot
leave a live cookie in place. In `VIEWER_TAILNET_ONLY` mode each port has its own
buckets. A burst above its per-minute budget is rejected at startup. Over the limit the
answer is `429 {"error":"rate limited"}` with `Retry-After`; `GET /api/health` is exempt.
The address comes from the socket, never from `X-Forwarded-For`, because the server binds
loopback: a local proxy connects from `127.0.0.1`, which is all this limit is for.

### Security headers

Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer` and
`Permissions-Policy: camera=(), microphone=(), geolocation=()`. The viewer surface (and
the single-port app that also serves it) adds `Strict-Transport-Security: max-age=31536000`
with no `preload` only when the request already looks like https: an `Origin` or `Referer`
that is https, or `X-Forwarded-Proto: https`. Node behind the Tailscale TLS proxy still
sees `http`, and a plain `http://127.0.0.1:5173` Vite session must not be HSTS-pinned.
`X-Forwarded-For` stays untrusted; a forged proto hint can only add this header, and
browsers ignore HSTS on a plain http response. The Funnel/bot surface never sends it.
`/api` responses add a closed CSP (`default-src 'none'; frame-ancestors
'none'; base-uri 'none'`); the web app is served with a CSP that allows only same-origin
scripts and styles, with no `unsafe-eval` (`style-src` keeps `'unsafe-inline'` for React's
style attributes), and `frame-ancestors 'none'`, so the viewer cannot be framed either.
Unknown `/api/*` paths always return `404 {"error":"not found"}`, never the SPA
`index.html`.

### Public bot API, private viewer

`VIEWER_TAILNET_ONLY=true` splits the two surfaces onto two loopback listeners: `PORT`
(default 8787) then serves only `POST /api/bots/register`, `POST /api/bots/:id/heartbeat`,
`POST /api/events` and `GET /api/health`; the viewer, session, admin and stream routes
answer `404` there. `VIEWER_PORT` (default 8788) serves everything else plus the built web
app from `apps/web/dist` (or `WEB_DIST`). Both bind `127.0.0.1`, so only Tailscale
Funnel/serve decides what leaves the machine: point the funnel at `PORT` and reach the
viewer over the tailnet at `VIEWER_PORT`. Leave it unset or `false` for the single-port
development setup. Shutdown closes both listeners.

The cookie flags stay as they are under Funnel: `Secure` is required for
`__Secure-` to be honoured at all, `SameSite=Strict` stops any other site from driving
the viewer with the cookie, and `HttpOnly` keeps it away from scripts. There is no
`Secure=false` escape hatch; a plain-HTTP deployment is out of scope. The bot API needs
none of this: it uses bearer tokens in an `Authorization` header, which cross-site
requests cannot set without a preflight the allowlist would refuse.

`GET /api/state` is the initial snapshot: visible bots (`hidden = false`) in shared
desk-layout order (bots outside the layout follow, by id), their current status, the
open (`sent`) handoffs, and the highest event sequence:

```bash
curl -sS http://127.0.0.1:8787/api/state -H "Authorization: Bearer $VIEWER_TOKEN"
```

```json
{
  "bots": [
    {
      "id": "data",
      "name": "Data",
      "role": "Code-Orchestrator",
      "avatar": "android-gold",
      "pod": "dev",
      "desk": {
        "botId": "data",
        "name": "Data",
        "pod": "dev",
        "index": 0,
        "x": -4.5,
        "z": 3,
        "facing": 3.14159
      },
      "status": "working",
      "label": "issue-7",
      "taskId": "issue-7",
      "since": "2026-01-01T00:00:00.000Z",
      "lastHeartbeatAt": "2026-01-01T00:00:00.000Z",
      "lastEventSeq": 42
    }
  ],
  "openHandoffs": [
    {
      "id": "h1",
      "fromBotId": "data",
      "toBotId": "wesley",
      "label": "review",
      "state": "sent",
      "sentAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "lastEventSeq": 42
}
```

The shared fixed layout (`DESKS` / `getDesk` in `packages/shared`) is the only source
of desks: only its bots carry `desk` (the others are HUD-list only), and there is no
per-bot desk field in the database or in `PATCH /api/admin/bots/:id`. For a bot in the
layout, `pod` is the desk's pod (the layout is canonical); other bots keep the pod they
registered with. A bot without a status row is `offline` since its registration time
with `lastEventSeq: 0`. Optional fields are omitted rather than sent as `null`.

Hidden bots stay out of both read routes. `hidden` is display-only: a hidden bot can
still register, heartbeat and post events, but viewers never see the bot, its events,
events that hand off to it, or open handoffs from or to it. The flag is read at request
time, so un-hiding a bot shows its history again. `lastSeq` / `lastEventSeq` stay the
global high-water mark, hidden events included, so `seq` has gaps for viewers.

A visible bot accepting a handoff from a hidden sender leaks nothing from that side, and
both scrubs happen at read time, so it does not matter whether the sender was hidden
before or after the accept, and un-hiding restores everything:

- the `handoff_accepted` event keeps its `handoffId` in the database, but the replay and
  the live stream omit it while the sender is hidden;
- the receiver's status remembers which handoff its label came from
  (`bot_status.label_handoff_id`). While that handoff's sender is hidden, the snapshot
  shows the accept event's own `label` instead, or no label: never the hidden handoff's
  label and never a placeholder. Any later label change clears the link. Migration 0005
  backfills the link for accepts stored before it by matching the label text against
  handoffs the bot accepted (it can only over-attribute, which hides exactly that text).

A visible sender's own handoff label stays visible on the receiver: it is that sender's
own work.

`GET /api/events?since={seq}&limit={n}` replays the log: events with `seq > since`
ascending, at most `limit` of them (`since` defaults to 0, `limit` to 100, maximum
500). Values are plain decimal integers without leading zeros (`since=00` and
`limit=03` are refused). Unknown, repeated or malformed parameters get
`400 {"error":"invalid query"}`.
Each event is a `StreamEvent`: `to` is a handoff's target bot, `at` the clamped client
time and `receivedAt` the server time.

```bash
curl -sS 'http://127.0.0.1:8787/api/events?since=42&limit=100' \
  -H "Authorization: Bearer $VIEWER_TOKEN"
```

```json
{
  "events": [
    {
      "seq": 43,
      "eventId": "01JBQ0M0S5R8D6P4W2G7X9K3ZY",
      "botId": "data",
      "type": "task_started",
      "taskId": "issue-7",
      "receivedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextSince": 43,
  "hasMore": false,
  "lastSeq": 43
}
```

`nextSince` is the `since` for the next call; `hasMore` says whether more visible
events exist after it; `lastSeq` is the highest sequence in the database. While
`hasMore` is true, `nextSince` is the last returned seq. On the last page it is
`lastSeq` (or the request's `since`, if that is larger), so a trailing run of hidden
events is skipped instead of re-read on every poll. The page and `lastSeq` come from
one read transaction. A `since` past the end returns an empty page.

`GET /api/stream` is the live stream (`text/event-stream`) for the same visible events,
behind the same viewer auth (bearer token or session cookie):

```bash
curl -sS -N http://127.0.0.1:8787/api/stream -H "Authorization: Bearer $VIEWER_TOKEN"
```

```
id: 43
event: event
data: {"seq":43,"eventId":"01JBQ0M0S5R8D6P4W2G7X9K3ZY","botId":"data","type":"task_started","taskId":"issue-7","receivedAt":"2026-01-01T00:00:00.000Z"}

event: ping
data: {}
```

The frame `id` is the event `seq`, so `EventSource` resends it as `Last-Event-ID` on a
reconnect and the stream resumes after it; `?since={seq}` does the same for clients that
cannot set the header (`Last-Event-ID` wins when both are present). Without a cursor the
stream is live only and starts at the current high-water mark. Cursor values follow the
same rule as `/api/events`; unknown or malformed parameters and a malformed
`Last-Event-ID` get `400 {"error":"invalid query"}` before the stream opens. A cursor past
the newest event (for example after a database reset) is clamped to the newest event, so
the stream goes live instead of waiting for ids that will never come.

Every stream starts with `retry: 3000` and a `: open` comment, so `EventSource` fires
`onopen` (and dev proxies flush the response) right away even when nothing is replayed.
Stream responses carry `Connection: close`; on `SIGTERM`/`SIGINT` the server ends every
stream, closes idle keep-alive connections as they appear, and exits without waiting for
the keep-alive timeout.

Events use the same hidden-bot filter as the replay, so a hidden run in between is
skipped rather than re-read. A ping every 25 seconds keeps proxies from idling the
connection out and re-checks the credential: a revoked session or token ends the stream
at the next ping, as does a server shutdown. At most 200 streams run at once; beyond
that the answer is `503 {"error":"too many streams"}`.

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck, test and build on
every push to `main` and every pull request. A single aggregator job named `CI`
depends on all of them and is the one required check. Actions are pinned by
commit SHA; Dependabot keeps npm and GitHub Actions dependencies up to date.

## License

See [LICENSE](./LICENSE).
