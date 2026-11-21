import { readFileSync, statSync } from "node:fs";

export const DEFAULT_CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
export const DEFAULT_POLL_SEC = 60;
/** Trailing space is deliberate: `gbo` and `gbother` are not bot names. */
export const DEFAULT_ADAPTER_PREFIX = "gbo ";

export type Config = {
  baseUrl: string;
  token: string;
  botId: string;
  bin: string;
  pollSec: number;
  prefix: string;
  allow: string[];
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** A comma-separated allow list; blanks are dropped. */
function nameList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** A token file keeps the token out of the launchd plist and `ps`. */
function readToken(
  env: Record<string, string | undefined>,
  warn: (line: string) => void,
): string | undefined {
  const direct = env.BO_TOKEN?.trim();
  if (direct) return direct;
  const path = env.BO_TOKEN_FILE?.trim();
  if (!path) return undefined;
  try {
    const mode = statSync(path).mode & 0o777;
    // A warning, not a failure: a loose file still lets the adapter start.
    if (mode !== 0o600) {
      warn(`cmux-adapter: token file mode ${mode.toString(8).padStart(4, "0")} is not 0600`);
    }
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The adapter is opt-in: without the flag and all three bot credentials it is
 * disabled and sends nothing. A token file is read only when BO_TOKEN is unset.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (line: string) => void = console.warn,
): Config | undefined {
  if (env.CMUX_ADAPTER_ENABLED !== "true") return undefined;
  const baseUrl = env.BO_URL?.trim();
  const botId = env.BO_BOT_ID?.trim();
  const token = readToken(env, warn);
  if (!baseUrl || !botId || !token) return undefined;
  return {
    baseUrl,
    botId,
    token,
    bin: env.CMUX_BIN?.trim() || DEFAULT_CMUX_BIN,
    pollSec: positiveInt(env.CMUX_ADAPTER_POLL_SEC, DEFAULT_POLL_SEC),
    // Not trimmed: the trailing space in the default is part of the match.
    prefix: env.CMUX_ADAPTER_PREFIX ?? DEFAULT_ADAPTER_PREFIX,
    allow: nameList(env.CMUX_ADAPTER_ALLOW),
  };
}
