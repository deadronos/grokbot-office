import type { Repo } from "./db/repo.ts";
import type { StreamHub } from "./stream/hub.ts";
import { nowUtc, toUtc } from "./time.ts";

/** How often the sweeper looks for stale heartbeats. */
export const SWEEP_INTERVAL_MS = 15_000;
/** How often the retention prune runs. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Clock = () => string;

/** A stored timestamp `ms` earlier than `now`. */
const before = (now: string, ms: number): string => toUtc(new Date(Date.parse(now) - ms));

/**
 * Marks bots whose heartbeat is older than `timeoutSec` offline. Events are the only
 * source of work state, so a live bot (even `working`) is never touched; a stale bot
 * loses its links exactly like an `offline` status event. Returns the event count.
 */
export function sweepStaleBots({
  repo,
  hub,
  timeoutSec,
  now = nowUtc,
}: {
  repo: Repo;
  hub: StreamHub;
  timeoutSec: number;
  now?: Clock;
}): number {
  const at = now();
  const swept = repo.sweepStaleBots(before(at, timeoutSec * 1000), at);
  // Same notify-then-pull path as `POST /api/events`.
  if (swept > 0) hub.notify();
  return swept;
}

/** Starts the 15 s sweeper; the returned function clears it (shutdown, tests). */
export function startHeartbeatSweeper({
  repo,
  hub,
  timeoutSec,
  intervalMs = SWEEP_INTERVAL_MS,
  now = nowUtc,
}: {
  repo: Repo;
  hub: StreamHub;
  timeoutSec: number;
  intervalMs?: number;
  now?: Clock;
}): () => void {
  const timer = setInterval(() => {
    try {
      sweepStaleBots({ repo, hub, timeoutSec, now });
    } catch (error) {
      // One bad sweep must not take the server down; the next tick retries.
      console.error("heartbeat sweep failed", error);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Drops events and closed handoffs older than `retentionDays`. Returns what went. */
export function pruneRetention({
  repo,
  retentionDays,
  now = nowUtc,
}: {
  repo: Repo;
  retentionDays: number;
  now?: Clock;
}): { events: number; handoffs: number } {
  return repo.pruneRetention(before(now(), retentionDays * 24 * 60 * 60 * 1000));
}

/**
 * Prunes once at startup (a process that restarts daily still prunes) and then every
 * `intervalMs`. The returned function clears the interval.
 */
export function startRetentionPrune({
  repo,
  retentionDays,
  intervalMs = RETENTION_INTERVAL_MS,
  now = nowUtc,
}: {
  repo: Repo;
  retentionDays: number;
  intervalMs?: number;
  now?: Clock;
}): () => void {
  const prune = () => {
    try {
      pruneRetention({ repo, retentionDays, now });
    } catch (error) {
      console.error("retention prune failed", error);
    }
  };
  prune();
  const timer = setInterval(prune, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
