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

/** Runs until stopped, or polls once with `once`. A failed poll retries next tick. */
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
    list: options.list ?? cmuxList(cmuxRunner(config.bin)),
    botId: config.botId,
  });
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (;;) {
    try {
      await adapter.poll();
    } catch {
      // No CLI output, prompt or token here: local logs stay safe to share.
      log("cmux-adapter: poll failed; retrying");
    }
    if (options.once) return;
    await sleep(config.pollSec * 1000);
  }
}
