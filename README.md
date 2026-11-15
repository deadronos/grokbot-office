# grokbot-office

A low-poly 3D office that shows the Grokbot team live: each bot sits at a desk and
is idle, working, waiting, reviewing or offline, and handoffs are animated as a
packet flying from desk to desk. Bots report in opt-in over small HTTPS calls
(register, heartbeat, events); the browser receives live updates over SSE.

This repository currently contains workspace tooling, CI, the API server and the
web app. The web app renders the static office scene: nine fixed desks in the
shared layout, a placeholder low-poly bot per desk and name plates. Live status,
the HUD and handoff animation come in later issues.

## Stack

- **Runtime:** Node.js 24, TypeScript (strict)
- **Server:** [Hono](https://hono.dev) on `@hono/node-server`
- **Web:** React 19 + Vite + React Three Fiber (three.js) + drei
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
`waiting`, `reviewing`, `offline`; an empty body is fine). A bot with no heartbeat
for `timeoutSec` counts as offline (marked by the heartbeat sweeper, #9):

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

## Viewer API

The viewer is private: there is no public read mode. Both read routes accept a viewer
bearer token (`pnpm admin token create --kind viewer`) or the env `ADMIN_TOKEN` as a
bearer token; anything else gets `401`, and a bot token gets `403`. Responses are
`Cache-Control: no-store`. #10 adds the HttpOnly session cookie the browser needs for
SSE, so this API is header-only for now.

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
per-bot desk field in the database or in `PATCH /api/admin/bots/:id`. A bot without a
status row is `offline` since its registration time with `lastEventSeq: 0`. Optional
fields are omitted rather than sent as `null`.

Hidden bots stay out of both read routes. `hidden` is display-only: a hidden bot can
still register, heartbeat and post events, but viewers never see the bot, its events,
events that hand off to it, or open handoffs from or to it. The flag is read at request
time, so un-hiding a bot shows its history again. `lastSeq` / `lastEventSeq` stay the
global high-water mark, hidden events included, so `seq` has gaps for viewers.

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

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck, test and build on
every push to `main` and every pull request. A single aggregator job named `CI`
depends on all of them and is the one required check. Actions are pinned by
commit SHA; Dependabot keeps npm and GitHub Actions dependencies up to date.

## License

See [LICENSE](./LICENSE).
