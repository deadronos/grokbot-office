export type HeartbeatConfig = {
  intervalSec: number;
  timeoutSec: number;
};

export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 60;
export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 300;

export const DEFAULT_SESSION_TTL_SEC = 28800;
/** A week: beyond this a viewer cookie outlives any reason to keep it. */
export const SESSION_TTL_MAX_SEC = 604800;

/** How many live sessions one viewer token may hold; beyond 50 nobody can track them. */
export const DEFAULT_SESSION_MAX_PER_TOKEN = 5;
export const SESSION_MAX_PER_TOKEN_LIMIT = 50;
/** An hour without a request ends the session; a rotation every 15 minutes refreshes it. */
export const DEFAULT_SESSION_IDLE_SEC = 3600;
export const DEFAULT_SESSION_ROTATE_SEC = 900;

/** Event and closed-handoff retention; the nightly prune drops older rows. */
export const DEFAULT_RETENTION_DAYS = 90;
/** A century: beyond this the prune cutoff overflows a JS Date. */
export const RETENTION_DAYS_MAX = 36500;

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
  const days = positiveInt(env.RETENTION_DAYS, DEFAULT_RETENTION_DAYS, "RETENTION_DAYS");
  if (days > RETENTION_DAYS_MAX) {
    throw new Error(`RETENTION_DAYS must be at most ${RETENTION_DAYS_MAX}, got "${days}"`);
  }
  return days;
}

export type SessionConfig = {
  ttlSec: number;
  maxPerToken: number;
  idleSec: number;
  rotateSec: number;
};

/** Sessions per viewer token. Out-of-range values stop the server at startup. */
export function resolveSessionMaxPerToken(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = positiveInt(
    env.SESSION_MAX_PER_TOKEN,
    DEFAULT_SESSION_MAX_PER_TOKEN,
    "SESSION_MAX_PER_TOKEN",
  );
  if (value > SESSION_MAX_PER_TOKEN_LIMIT) {
    throw new Error(
      `SESSION_MAX_PER_TOKEN must be at most ${SESSION_MAX_PER_TOKEN_LIMIT}, got "${value}"`,
    );
  }
  return value;
}

/** An idle session (no request for this long) is dead, even inside its absolute TTL. */
export function resolveSessionIdleSec(
  env: Record<string, string | undefined> = process.env,
  ttlSec: number = resolveSessionTtlSec(env),
): number {
  const idleSec = positiveInt(
    env.SESSION_IDLE_SEC,
    // A short ttl must not force a matching idle setting: the default follows it down.
    Math.min(DEFAULT_SESSION_IDLE_SEC, ttlSec),
    "SESSION_IDLE_SEC",
  );
  if (idleSec > ttlSec) {
    throw new Error(`SESSION_IDLE_SEC (${idleSec}) must not exceed SESSION_TTL_SEC (${ttlSec})`);
  }
  return idleSec;
}

/** How often a live session's cookie secret is replaced. */
export function resolveSessionRotateSec(
  env: Record<string, string | undefined> = process.env,
  ttlSec: number = resolveSessionTtlSec(env),
): number {
  const rotateSec = positiveInt(
    env.SESSION_ROTATE_SEC,
    Math.min(DEFAULT_SESSION_ROTATE_SEC, ttlSec),
    "SESSION_ROTATE_SEC",
  );
  if (rotateSec > ttlSec) {
    throw new Error(
      `SESSION_ROTATE_SEC (${rotateSec}) must not exceed SESSION_TTL_SEC (${ttlSec})`,
    );
  }
  return rotateSec;
}

/** All session knobs together, each validated against the resolved TTL. */
export function resolveSessionConfig(
  env: Record<string, string | undefined> = process.env,
): SessionConfig {
  const ttlSec = resolveSessionTtlSec(env);
  return {
    ttlSec,
    maxPerToken: resolveSessionMaxPerToken(env),
    idleSec: resolveSessionIdleSec(env, ttlSec),
    rotateSec: resolveSessionRotateSec(env, ttlSec),
  };
}

export type RateLimitConfig = {
  perMin: number;
  burst: number;
  ipPerMin: number;
  ipBurst: number;
};

export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
export const DEFAULT_RATE_LIMIT_BURST = 20;
export const DEFAULT_RATE_LIMIT_IP_PER_MIN = 30;
export const DEFAULT_RATE_LIMIT_IP_BURST = 10;

/** Per-token and per-IP request budgets; a burst larger than the minute budget is refused. */
export function resolveRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
): RateLimitConfig {
  const perMin = positiveInt(
    env.RATE_LIMIT_PER_MIN,
    DEFAULT_RATE_LIMIT_PER_MIN,
    "RATE_LIMIT_PER_MIN",
  );
  const burst = positiveInt(env.RATE_LIMIT_BURST, DEFAULT_RATE_LIMIT_BURST, "RATE_LIMIT_BURST");
  const ipPerMin = positiveInt(
    env.RATE_LIMIT_IP_PER_MIN,
    DEFAULT_RATE_LIMIT_IP_PER_MIN,
    "RATE_LIMIT_IP_PER_MIN",
  );
  const ipBurst = positiveInt(
    env.RATE_LIMIT_IP_BURST,
    DEFAULT_RATE_LIMIT_IP_BURST,
    "RATE_LIMIT_IP_BURST",
  );
  if (burst > perMin) {
    throw new Error(`RATE_LIMIT_BURST (${burst}) must not exceed RATE_LIMIT_PER_MIN (${perMin})`);
  }
  if (ipBurst > ipPerMin) {
    throw new Error(
      `RATE_LIMIT_IP_BURST (${ipBurst}) must not exceed RATE_LIMIT_IP_PER_MIN (${ipPerMin})`,
    );
  }
  return { perMin, burst, ipPerMin, ipBurst };
}

/**
 * Exact browser origins allowed to call the API with credentials (the viewer on a
 * dev Vite port, say). Unset means no cross-origin browser access at all; `*` is
 * refused because credentials and a wildcard cannot be combined.
 */
export function resolveCorsOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.CORS_ORIGINS?.trim() ?? "";
  if (raw === "") return [];
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  for (const origin of origins) {
    if (origin === "*" || !/^https?:\/\/[^\s/]+$/.test(origin)) {
      throw new Error(`CORS_ORIGINS must be exact http(s) origins, got "${origin}"`);
    }
  }
  return origins;
}

export const DEFAULT_PORT = 8787;
export const DEFAULT_VIEWER_PORT = 8788;

/** Loopback ports for the API (`PORT`) and, in tailnet-only mode, the viewer. */
export function resolvePort(
  env: Record<string, string | undefined> = process.env,
  name = "PORT",
  fallback = DEFAULT_PORT,
): number {
  const port = positiveInt(env[name], fallback, name);
  if (port > 65535) throw new Error(`${name} must be a port number, got "${port}"`);
  return port;
}

/**
 * `VIEWER_TAILNET_ONLY`: run two loopback listeners, so a Funnel only reaches the bot
 * API and `tailscale serve` fronts the viewer. Unset/false/0 keeps today's single port.
 */
export function resolveViewerTailnetOnly(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.VIEWER_TAILNET_ONLY?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  throw new Error(`VIEWER_TAILNET_ONLY must be true, 1, false or 0, got "${raw}"`);
}
