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

/** Only the last path segment is a safe public label; `~` alone has none. */
function basename(text: string): string {
  const last = text.trim().replace(/\/+$/, "").split("/").at(-1) ?? "";
  return last === "~" || last === "…" ? "" : last;
}

/**
 * `list-workspaces --json` answers JSON on stdout; older builds print text.
 * Only the ref and the workspace name are kept. An auto title is path-derived,
 * so only its basename is kept; a custom title is taken as written.
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
          const customTitle =
            typeof workspace.custom_title === "string" ? workspace.custom_title.trim() : "";
          const title = typeof workspace.title === "string" ? workspace.title.trim() : "";
          const name = customTitle !== "" ? customTitle : basename(title);
          return name === "" ? [] : [{ ref: workspace.ref, name }];
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
    const displayed = rawName.replace(/\s+\[(?:selected|pinned|current)\]\s*$/, "").trim();
    // A displayed custom title is kept; a path-like one is reduced to its basename.
    const looksLikePath =
      displayed.startsWith("~") || displayed.startsWith("…") || displayed.includes("/");
    const name = looksLikePath ? basename(displayed) : displayed;
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

export type WorkspaceFilter = { prefix: string; allow: readonly string[] };

/** Skip-by-default: only bot-owned workspaces pass, before any state is read. */
export function isAllowed({ ref, name }: Workspace, { prefix, allow }: WorkspaceFilter): boolean {
  if (allow.includes(name) || allow.includes(ref)) return true;
  // An empty prefix allows nothing; the allow list is the only other way in.
  return prefix !== "" && name.startsWith(prefix);
}

/** Resolves each allowed workspace to the one state the adapter is allowed to see. */
export function cmuxList(
  run: CmuxRunner,
  filter: WorkspaceFilter,
): () => Promise<{ name: string; state?: CmuxState }[]> {
  return async () => {
    const workspaces = (await listWorkspaces(run)).filter((workspace) =>
      isAllowed(workspace, filter),
    );
    return Promise.all(
      workspaces.map(async ({ ref, name }) => ({ name, state: await workspaceState(run, ref) })),
    );
  };
}

/**
 * Optional CLI chrome must not reach the stdout that parsing reads, and the bot
 * token must not reach the cmux child at all.
 */
export function cmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { BO_TOKEN: _token, BO_TOKEN_FILE: _tokenFile, ...rest } = env;
  return { ...rest, CMUX_QUIET: "1" };
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
