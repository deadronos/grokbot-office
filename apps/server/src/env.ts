import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The repo-root `.env`, from `src/` or the bundled `dist/`, whatever the cwd is. */
export const ROOT_ENV_PATH = fileURLToPath(new URL("../../../.env", import.meta.url));

/**
 * Loads the root `.env` (existing process env wins). Node's `--env-file-if-exists`
 * is relative to the cwd, so it only worked through the pnpm scripts.
 */
export function loadRootEnv(hint = false): void {
  if (existsSync(ROOT_ENV_PATH)) process.loadEnvFile(ROOT_ENV_PATH);
  else if (hint) console.warn(`No ${ROOT_ENV_PATH}; copy .env.example to .env to configure it.`);
}
