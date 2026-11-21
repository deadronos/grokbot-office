import { createAdapter } from "./adapter.ts";
import type { WorkspaceState } from "./adapter.ts";
import { cmuxList, cmuxRunner } from "./cmux.ts";
import { resolveConfig } from "./config.ts";
import { createPost } from "./http.ts";
import type { Post } from "./http.ts";

const DISABLED =
  "cmux-adapter: disabled (set CMUX_ADAPTER_ENABLED=true, BO_URL, BO_TOKEN and BO_BOT_ID)";

export type RunOptions = {
  once?: boolean;
  post?: Post;
  list?: () => Promise<WorkspaceState[]>;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

/** Runs until stopped, or polls once with `once`. A failed poll backs off. */
export async function run(
  env: Record<string, string | undefined>,
  options: RunOptions = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const config = resolveConfig(env);
  if (!config) {
    log(DISABLED);
    return;
  }

  const adapter = createAdapter({
    post: options.post ?? createPost(config.baseUrl, config.token),
    list:
      options.list ??
      cmuxList(cmuxRunner(config.bin), { prefix: config.prefix, allow: config.allow }),
    botId: config.botId,
  });
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // A failed poll doubles the wait, capped at 8× pollSec; a success resets it.
  const capSec = config.pollSec * 8;
  let delaySec = config.pollSec;
  for (;;) {
    let ok = true;
    try {
      await adapter.poll();
    } catch {
      ok = false;
      // No CLI output, prompt or token here: local logs stay safe to share.
      log("cmux-adapter: poll failed; retrying");
    }
    if (options.once) return;
    if (ok) delaySec = config.pollSec;
    await sleep(delaySec * 1000);
    if (!ok) delaySec = Math.min(capSec, delaySec * 2);
  }
}
