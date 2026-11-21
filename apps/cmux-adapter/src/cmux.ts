import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type CmuxState = "running" | "idle" | "done";
export type Workspace = { ref: string; name: string };
export type CmuxRunner = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

/**
 * Status keys written by cmux's own agent hooks. Any other key is a human
 * `cmux set-status` entry (for example `task=...`) and is not a coding-CLI state.
 */
const AGENT_STATUS_KEYS = new Set([
  "program_status",
  "pi",
  "claude",
  "claude-code",
  "codex",
  "grok",
  "opencode",
  "omp",
  "campfire",
  "amp",
  "cursor",
  "gemini",
  "agy",
  "antigravity",
  "kiro",
  "rovodev",
  "rovo",
  "hermes",
  "hermes-agent",
  "copilot",
  "codebuddy",
  "factory",
  "qoder",
  "kimi",
  "muse",
]);

/** A busy workspace outranks a finished one; a finished one outranks an idle one. */
const STATE_PRIORITY: readonly CmuxState[] = ["running", "done", "idle"];

/**
 * `list-workspaces --json` answers JSON on stdout; older builds print text.
 * Only the ref and the workspace name are kept.
 */
export function parseWorkspaces(stdout: string): Workspace[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) {
      const list = (parsed as { workspaces?: unknown }).workspaces;
      if (Array.isArray(list)) {
        return list.flatMap((entry) => {
          const workspace = entry as { ref?: unknown; title?: unknown; custom_title?: unknown };
          if (typeof workspace.ref !== "string") return [];
          if (workspace.ref === "") return [];
          const name = [workspace.custom_title, workspace.title].find(
            (value): value is string => typeof value === "string" && value !== "",
          );
          return [{ ref: workspace.ref, name: name ?? workspace.ref }];
        });
      }
    }
  } catch {
    // Not JSON: fall through to the text listing.
  }

  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*\*?\s*(workspace:\S+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const [, ref, rawName] = match;
    if (ref === undefined || rawName === undefined) return [];
    const name = rawName.replace(/\s+\[(?:selected|pinned|current)\]\s*$/, "").trim();
    return name === "" ? [] : [{ ref, name }];
  });
}

/**
 * `list-status` prints `<key>=<value> [icon=...] [color=...] [priority=...]`
 * lines. `program_status` carries `agent · State`, so the state is the last
 * segment. Only running/idle/done count.
 */
export function parseStatus(stdout: string): CmuxState | undefined {
  const found = new Set<CmuxState>();
  for (const line of stdout.split("\n")) {
    const match = /^([A-Za-z0-9_.:-]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    const rest = match[2];
    if (key === undefined || rest === undefined) continue;
    if (!AGENT_STATUS_KEYS.has(key)) continue;
    const value = rest.replace(/\s+(?:icon|color|priority)=\S+/g, "");
    const state = value.split("·").at(-1)?.trim().toLowerCase();
    if (state === "running" || state === "idle" || state === "done") found.add(state);
  }
  return STATE_PRIORITY.find((state) => found.has(state));
}

export async function listWorkspaces(run: CmuxRunner): Promise<Workspace[]> {
  return parseWorkspaces(await run(["list-workspaces", "--json"]));
}

export async function workspaceState(run: CmuxRunner, ref: string): Promise<CmuxState | undefined> {
  return parseStatus(await run(["list-status", "--workspace", ref]));
}

/** Resolves each workspace to the one state the adapter is allowed to see. */
export function cmuxList(run: CmuxRunner): () => Promise<{ name: string; state?: CmuxState }[]> {
  return async () => {
    const workspaces = await listWorkspaces(run);
    return Promise.all(
      workspaces.map(async ({ ref, name }) => ({ name, state: await workspaceState(run, ref) })),
    );
  };
}

/** Optional CLI chrome must not reach the stdout that parsing reads. */
export function cmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, CMUX_QUIET: "1" };
}

export function cmuxRunner(bin: string): CmuxRunner {
  return async (args) => {
    const { stdout } = await execFileAsync(bin, args, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: cmuxEnv(),
    });
    return stdout;
  };
}
