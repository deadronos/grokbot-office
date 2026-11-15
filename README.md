# grokbot-office

A low-poly 3D office that shows the Grokbot team live: each bot sits at a desk and
is idle, working, waiting, reviewing or offline, and handoffs are animated as a
packet flying from desk to desk. Bots report in opt-in over small HTTPS calls
(register, heartbeat, events); the browser receives live updates over SSE.

This repository currently contains the scaffold: workspace tooling, CI, a minimal
API server and a minimal web page. The office scene comes in later issues.

## Stack

- **Runtime:** Node.js 24, TypeScript (strict)
- **Server:** [Hono](https://hono.dev) on `@hono/node-server`
- **Web:** React 19 + Vite
- **Shared:** `@grokbot-office/shared` – constants and types used by both apps
- **Tooling:** pnpm workspaces, oxlint, oxfmt, Vitest, GitHub Actions

## Repo layout

```text
apps/server        Hono API (GET /api/health), testable app module + boot entry
apps/web           Vite + React page
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

Register (idempotent upsert of name, role, avatar and pod; the server keeps
desk assignment and visibility for admins). The reply carries the heartbeat
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
for `timeoutSec` counts as offline:

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

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck, test and build on
every push to `main` and every pull request. A single aggregator job named `CI`
depends on all of them and is the one required check. Actions are pinned by
commit SHA; Dependabot keeps npm and GitHub Actions dependencies up to date.

## License

See [LICENSE](./LICENSE).
