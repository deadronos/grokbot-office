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

## Database

The server stores its state in SQLite (better-sqlite3, WAL mode) via Drizzle ORM.
The file comes from `DATABASE_PATH` (default `./data/bot-office.db`, gitignored).
Migrations live in `apps/server/drizzle/` and are applied on server start; after
changing `apps/server/src/db/schema.ts`, run `pnpm --filter @grokbot-office/server db:generate`
and commit the new migration.

## CI

`.github/workflows/ci.yml` runs lint, format check, typecheck, test and build on
every push to `main` and every pull request. A single aggregator job named `CI`
depends on all of them and is the one required check. Actions are pinned by
commit SHA; Dependabot keeps npm and GitHub Actions dependencies up to date.

## License

See [LICENSE](./LICENSE).
