export type HeartbeatConfig = {
  intervalSec: number;
  timeoutSec: number;
};

export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;
export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 300;

export const DEFAULT_SESSION_TTL_SEC = 28800;
/** A week: beyond this a viewer cookie outlives any reason to keep it. */
export const SESSION_TTL_MAX_SEC = 604800;

/** Event and closed-handoff retention; the nightly prune drops older rows. */
export const DEFAULT_RETENTION_DAYS = 90;

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Heartbeat intervals from the environment. A bot is offline after
 * `timeoutSec` without a heartbeat, so the timeout must exceed the interval.
 * Invalid values throw, which stops the server at startup.
 */
export function resolveHeartbeatConfig(
  env: Record<string, string | undefined> = process.env,
): HeartbeatConfig {
  const intervalSec = positiveInt(
    env.HEARTBEAT_INTERVAL_SEC,
    DEFAULT_HEARTBEAT_INTERVAL_SEC,
    "HEARTBEAT_INTERVAL_SEC",
  );
  const timeoutSec = positiveInt(
    env.HEARTBEAT_TIMEOUT_SEC,
    DEFAULT_HEARTBEAT_TIMEOUT_SEC,
    "HEARTBEAT_TIMEOUT_SEC",
  );
  if (timeoutSec <= intervalSec) {
    throw new Error(
      `HEARTBEAT_TIMEOUT_SEC (${timeoutSec}) must be greater than HEARTBEAT_INTERVAL_SEC (${intervalSec})`,
    );
  }
  return { intervalSec, timeoutSec };
}

/**
 * Viewer session lifetime in seconds. Validated like the heartbeat values: a
 * malformed or out-of-range value stops the server at startup.
 */
export function resolveSessionTtlSec(
  env: Record<string, string | undefined> = process.env,
): number {
  const ttlSec = positiveInt(env.SESSION_TTL_SEC, DEFAULT_SESSION_TTL_SEC, "SESSION_TTL_SEC");
  if (ttlSec > SESSION_TTL_MAX_SEC) {
    throw new Error(`SESSION_TTL_SEC must be at most ${SESSION_TTL_MAX_SEC}, got "${ttlSec}"`);
  }
  return ttlSec;
}

/**
 * How long events and closed handoffs are kept, in days. Validated like the other
 * env knobs: an invalid value stops the server at startup.
 */
export function resolveRetentionDays(
  env: Record<string, string | undefined> = process.env,
): number {
  return positiveInt(env.RETENTION_DAYS, DEFAULT_RETENTION_DAYS, "RETENTION_DAYS");
}
