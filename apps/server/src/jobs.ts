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

/** One sweep's outcome: what it wrote, and who reads as `away` afterwards. */
export type SweepResult = {
  /** Offline events written this sweep. */
  swept: number;
  /** Bots that are silent but still inside the away window. */
  away: Set<string>;
};

/**
 * Presence housekeeping. A bot silent past `timeoutSec` is `away` (derived in the
 * snapshot, nothing stored); silent past `awaySec` it goes offline exactly like a
 * heartbeat timeout, with an `offline` event and its links cleared. Away is not an
 * event, so a change in the away set asks open streams to refetch the snapshot.
 */
export function sweepStaleBots({
  repo,
  hub,
  timeoutSec,
  awaySec,
  previousAway = new Set<string>(),
  now = nowUtc,
}: {
  repo: Repo;
  hub: StreamHub;
  timeoutSec: number;
  awaySec: number;
  previousAway?: ReadonlySet<string>;
  now?: Clock;
}): SweepResult {
  const at = now();
  const swept = repo.sweepStaleBots(before(at, awaySec * 1000), at);
  // Same notify-then-pull path as `POST /api/events`.
  if (swept > 0) hub.notify();
  // After the sweep, so a bot that just went offline is not reported as away.
  const away = new Set(repo.staleOnlineBotIds(before(at, timeoutSec * 1000)));
  const changed = away.size !== previousAway.size || [...away].some((id) => !previousAway.has(id));
  // Offline already moved its streams through `notify`; away has no event of its own.
  if (changed) hub.refresh();
  return { swept, away };
}

/** Starts the 15 s sweeper; the returned function clears it (shutdown, tests). */
export function startHeartbeatSweeper({
  repo,
  hub,
  timeoutSec,
  awaySec,
  intervalMs = SWEEP_INTERVAL_MS,
  now = nowUtc,
}: {
  repo: Repo;
  hub: StreamHub;
  timeoutSec: number;
  awaySec: number;
  intervalMs?: number;
  now?: Clock;
}): () => void {
  let away: ReadonlySet<string> = new Set<string>();
  const timer = setInterval(() => {
    try {
      away = sweepStaleBots({ repo, hub, timeoutSec, awaySec, previousAway: away, now }).away;
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
