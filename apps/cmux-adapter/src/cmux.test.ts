import { describe, expect, it } from "vitest";

import { cmuxEnv, cmuxList, parseStatus, parseWorkspaces } from "./cmux.ts";

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
  ],
});

describe("parseWorkspaces", () => {
  it("takes the custom title, then the title, then the ref", () => {
    expect(parseWorkspaces(WORKSPACES_JSON)).toEqual([
      { ref: "workspace:1000100030", name: "gbo #21 cmux-adapter" },
      { ref: "workspace:1000100031", name: "scratch" },
      { ref: "workspace:1000100032", name: "workspace:1000100032" },
    ]);
  });

  it("falls back to the text listing", () => {
    const text = [
      "* workspace:1000100030  grokbot-office deploy  [selected]",
      "  workspace:1000100031  scratch",
      "no workspaces",
    ].join("\n");
    expect(parseWorkspaces(text)).toEqual([
      { ref: "workspace:1000100030", name: "grokbot-office deploy" },
      { ref: "workspace:1000100031", name: "scratch" },
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
  it("forces quiet mode and keeps the rest of the environment", () => {
    expect(cmuxEnv({ PATH: "/usr/bin", CMUX_QUIET: "0" })).toEqual({
      PATH: "/usr/bin",
      CMUX_QUIET: "1",
    });
  });
});

describe("cmuxList", () => {
  it("asks list-status once per workspace and keeps only the state", async () => {
    const calls: string[][] = [];
    const list = cmuxList(async (args) => {
      calls.push(args);
      if (args[0] === "list-workspaces") return WORKSPACES_JSON;
      return "pi=Running";
    });

    expect(await list()).toEqual([
      { name: "gbo #21 cmux-adapter", state: "running" },
      { name: "scratch", state: "running" },
      { name: "workspace:1000100032", state: "running" },
    ]);
    expect(calls).toHaveLength(1 + 3);
    expect(calls).toContainEqual(["list-status", "--workspace", "workspace:1000100030"]);
  });
});
