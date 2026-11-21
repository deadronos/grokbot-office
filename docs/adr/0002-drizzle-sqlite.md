# ADR 0002: Drizzle ORM on SQLite

Status: Accepted

## Context

The office stores bots, bot status, events, handoffs, tokens and sessions. The
deployment target is one Mac running one Node.js process, with a viewer reading a
snapshot plus an event log and bots writing small batches. There is no separate
database server to operate, no need for horizontal writes, and the operator must be
able to back up the state by copying a file.

## Decision

Use SQLite via `better-sqlite3` and Drizzle ORM.

- One file (`DATABASE_PATH`), WAL mode and `synchronous = NORMAL`: single-writer,
  crash-safe enough for this workload, and cheap to back up.
- `better-sqlite3` is synchronous, which keeps transactions straightforward: an event
  batch is applied in one transaction and either lands whole or not at all.
- Drizzle's schema (`apps/server/src/db/schema.ts`) is the source of truth;
  `drizzle-kit generate` writes SQL migrations to `apps/server/drizzle/`, which the
  build copies next to the bundle. The migrator runs on server start and runs the
  whole pending set in one transaction with foreign-key enforcement off, because
  SQLite cannot add `CHECK` or foreign-key constraints in place.
- The database file is closed on `SIGTERM`/`SIGINT`, which checkpoints the WAL and
  removes the `-wal`/`-shm` files, so a clean stop leaves a self-contained file.

## Consequences

- One process owns the database. A second instance pointed at the same file (two
  LaunchAgents, two ports in one process) would contend for the write lock; the
  two-listener production mode shares one `Repo` in one process for this reason.
- There is no network database, so the API cannot scale out; that matches the
  single-Mac runbook (see `docs/runbook-mac.md`).
- `DATABASE_PATH` relative paths resolve against `apps/server/`, not the current
  directory, and `NODE_ENV=production` requires an absolute path. That surprises
  people, but it keeps the server and the admin CLI opening the same file from any
  cwd.
- Migrations must stay compatible with SQLite's limited `ALTER TABLE`; some changes
  rebuild the table. Back up before an upgrade that includes a migration.
- Online backups use `sqlite3 .backup`, not `cp`, while the server is running.

See [ADR 0001](0001-hono.md) for the HTTP layer.
