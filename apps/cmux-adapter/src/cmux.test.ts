import { describe, expect, it } from "vitest";

import { cmuxEnv, cmuxList, isAllowed, parseStatus, parseWorkspaces } from "./cmux.ts";

const WORKSPACES_JSON = JSON.stringify({
  window_ref: "window:1",
  workspaces: [
    {
      ref: "workspace:1000100030",
      title: "~/Github/grokbot-office",
      custom_title: "gbo #21 cmux-adapter",
    },
    { ref: "workspace:1000100031", title: "scratch", custom_title: null },
    { ref: "workspace:1000100032", title: "", custom_title: "" },
    { ref: "workspace:1000100033", title: "…/org/demo-repo/dist", custom_title: "" },
    { ref: "workspace:1000100034", title: "~/projects/demo-app" },
  ],
});

describe("parseWorkspaces", () => {
  it("takes the custom title, else only the basename of the auto title", () => {
    expect(parseWorkspaces(WORKSPACES_JSON)).toEqual([
      { ref: "workspace:1000100030", name: "gbo #21 cmux-adapter" },
      { ref: "workspace:1000100031", name: "scratch" },
      { ref: "workspace:1000100033", name: "dist" },
      { ref: "workspace:1000100034", name: "demo-app" },
    ]);
  });

  it("never sends a path or a workspace ref as the name", () => {
    const names = parseWorkspaces(WORKSPACES_JSON).map(({ name }) => name);
    for (const name of names) {
      expect(name).not.toContain("/");
      expect(name).not.toContain("~");
      expect(name).not.toContain("…");
      expect(name).not.toMatch(/^workspace:/);
    }
  });

  it("skips a workspace with no usable title", () => {
    expect(parseWorkspaces(WORKSPACES_JSON)).not.toContainEqual({
      ref: "workspace:1000100032",
      name: "workspace:1000100032",
    });
    expect(parseWorkspaces(JSON.stringify({ workspaces: [{ ref: "workspace:1" }] }))).toEqual([]);
  });

  it("falls back to the text listing and basenames a path-like name", () => {
    const text = [
      "* workspace:1000100030  grokbot-office deploy  [selected]",
      "  workspace:1000100031  scratch",
      "  workspace:1000100033  ~/projects/demo-app",
      "no workspaces",
    ].join("\n");
    expect(parseWorkspaces(text)).toEqual([
      { ref: "workspace:1000100030", name: "grokbot-office deploy" },
      { ref: "workspace:1000100031", name: "scratch" },
      { ref: "workspace:1000100033", name: "demo-app" },
    ]);
  });

  it("ignores a malformed JSON payload", () => {
    expect(parseWorkspaces("[]")).toEqual([]);
    expect(parseWorkspaces("null")).toEqual([]);
  });
});

describe("parseStatus", () => {
  it("maps the coding-CLI states", () => {
    expect(parseStatus("pi=Running icon=bolt.fill color=#4C8DFF")).toBe("running");
    expect(parseStatus("pi=Idle")).toBe("idle");
    expect(parseStatus("pi=Done")).toBe("done");
  });

  it("reads the state after the agent name in program_status", () => {
    expect(parseStatus("program_status=pi · Running icon=bolt.fill priority=2")).toBe("running");
    expect(parseStatus("program_status=claude · Done")).toBe("done");
    // This build reports Working, which is not one of the three states.
    expect(parseStatus("program_status=pi · Working icon=bolt.fill priority=2")).toBeUndefined();
  });

  it("ignores human set-status keys, even when the value says Running", () => {
    expect(parseStatus("task=Running")).toBeUndefined();
    expect(parseStatus("task=Live deploy of Running service color=#ff9500")).toBeUndefined();
    expect(parseStatus("note=Done")).toBeUndefined();
  });

  it("prefers running over done over idle", () => {
    const status = ["pi=Idle", "claude=Done", "program_status=pi · Running"].join("\n");
    expect(parseStatus(status)).toBe("running");
    expect(parseStatus("claude=Idle\npi=Done")).toBe("done");
  });

  it("answers undefined when there is no status entry", () => {
    expect(parseStatus("No status entries")).toBeUndefined();
    expect(parseStatus("")).toBeUndefined();
  });
});

describe("cmuxEnv", () => {
  it("forces quiet mode, drops the bot credentials and keeps the rest", () => {
    expect(
      cmuxEnv({
        PATH: "/usr/bin",
        CMUX_QUIET: "0",
        BO_TOKEN: "bot-token",
        BO_TOKEN_FILE: "/tmp/token",
      }),
    ).toEqual({ PATH: "/usr/bin", CMUX_QUIET: "1" });
    expect(cmuxEnv({ BO_TOKEN: "x" })).not.toHaveProperty("BO_TOKEN");
    expect(cmuxEnv({ BO_TOKEN_FILE: "x" })).not.toHaveProperty("BO_TOKEN_FILE");
  });
});

describe("isAllowed", () => {
  const gobo = { prefix: "gbo ", allow: [] };

  it("keeps the default prefix and drops personal workspaces", () => {
    expect(isAllowed({ ref: "workspace:1", name: "gbo #21 nits" }, gobo)).toBe(true);
    expect(isAllowed({ ref: "workspace:1", name: "personal notes" }, gobo)).toBe(false);
    expect(isAllowed({ ref: "workspace:1", name: "demo-app" }, gobo)).toBe(false);
    expect(isAllowed({ ref: "workspace:1", name: "gbo" }, gobo)).toBe(false);
    expect(isAllowed({ ref: "workspace:1", name: "gbother" }, gobo)).toBe(false);
    expect(isAllowed({ ref: "workspace:1", name: "GBO #21 nits" }, gobo)).toBe(false);
  });

  it("allows exact names and refs from the allow list", () => {
    const filter = { prefix: "gbo ", allow: ["scratch", "workspace:1000100031"] };
    expect(isAllowed({ ref: "workspace:1000100030", name: "scratch" }, filter)).toBe(true);
    expect(isAllowed({ ref: "workspace:1000100031", name: "personal notes" }, filter)).toBe(true);
    expect(isAllowed({ ref: "workspace:1000100032", name: "personal notes" }, filter)).toBe(false);
  });

  it("treats an empty prefix as allow-nothing unless the allow list matches", () => {
    expect(isAllowed({ ref: "workspace:1", name: "gbo #21 nits" }, { prefix: "", allow: [] })).toBe(
      false,
    );
    expect(
      isAllowed(
        { ref: "workspace:1", name: "gbo #21 nits" },
        { prefix: "", allow: ["gbo #21 nits"] },
      ),
    ).toBe(true);
  });
});

describe("cmuxList", () => {
  const filter = { prefix: "gbo ", allow: [] };

  it("asks list-status once per allowed workspace and keeps only the state", async () => {
    const calls: string[][] = [];
    const list = cmuxList(async (args) => {
      calls.push(args);
      if (args[0] === "list-workspaces") return WORKSPACES_JSON;
      return "pi=Running";
    }, filter);

    expect(await list()).toEqual([{ name: "gbo #21 cmux-adapter", state: "running" }]);
    expect(calls).toEqual([
      ["list-workspaces", "--json"],
      ["list-status", "--workspace", "workspace:1000100030"],
    ]);
  });

  it("never lets a filtered-out Running workspace steal the state", async () => {
    const workspaces = JSON.stringify({
      workspaces: [
        { ref: "workspace:1", title: "…/org/personal", custom_title: "personal notes" },
        { ref: "workspace:2", title: "…/org/gbo", custom_title: "gbo #21 nits" },
      ],
    });
    const list = cmuxList(
      async (args) => (args[0] === "list-workspaces" ? workspaces : "pi=Running"),
      filter,
    );

    expect(await list()).toEqual([{ name: "gbo #21 nits", state: "running" }]);
  });

  it("reports nothing when the prefix and allow list are both empty", async () => {
    const calls: string[][] = [];
    const list = cmuxList(
      async (args) => {
        calls.push(args);
        return WORKSPACES_JSON;
      },
      { prefix: "", allow: [] },
    );

    expect(await list()).toEqual([]);
    expect(calls).toEqual([["list-workspaces", "--json"]]);
  });
});
