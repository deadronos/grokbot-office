export type HeartbeatConfig = {
  intervalSec: number;
  timeoutSec: number;
};

export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;
export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 300;

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
