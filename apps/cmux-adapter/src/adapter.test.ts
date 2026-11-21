import { describe, expect, it } from "vitest";

import { aggregate, createAdapter, labelFor, transition, type WorkspaceState } from "./adapter.ts";
import { parseStatus } from "./cmux.ts";

type Call = { path: string; body: unknown };

function recorder() {
  const calls: Call[] = [];
  return { calls, post: async (path: string, body: unknown) => void calls.push({ path, body }) };
}

const events = (calls: Call[]) => calls.filter((call) => call.path === "/api/events");
const bodies = (calls: Call[]) => calls.map((call) => JSON.stringify(call.body));

describe("labelFor", () => {
  it("sanitizes and truncates to the label limit", () => {
    expect(labelFor("  fix\tflaky   test  ")).toBe("fix flaky test");
    expect(labelFor("x".repeat(200))).toHaveLength(80);
  });

  it("skips empty and credential-looking titles", () => {
    expect(labelFor("   ")).toBeUndefined();
    expect(labelFor(`ghp_${"a".repeat(30)}`)).toBeUndefined();
    expect(labelFor("sk-" + "a".repeat(30))).toBeUndefined();
  });
});

describe("aggregate", () => {
  it("keeps the lexicographically first name among running workspaces", () => {
    expect(
      aggregate([
        { name: "zeta", state: "running" },
        { name: "alpha", state: "running" },
        { name: "beta", state: "idle" },
      ]),
    ).toEqual({ state: "running", label: "alpha" });
  });

  it("orders running before done before idle", () => {
    expect(
      aggregate([
        { name: "b", state: "idle" },
        { name: "c", state: "done" },
        { name: "a", state: "running" },
      ]),
    ).toMatchObject({ state: "running" });
    expect(
      aggregate([
        { name: "a", state: "idle" },
        { name: "b", state: "done" },
      ]),
    ).toMatchObject({ state: "done" });
  });

  it("ignores workspaces without a coding-CLI state or with a secret-looking name", () => {
    expect(aggregate([{ name: "plain" }])).toBeUndefined();
    expect(aggregate([{ name: `ghp_${"a".repeat(30)}`, state: "running" }])).toBeUndefined();
  });
});

describe("transition", () => {
  const running = { state: "running", label: "alpha" } as const;
  const idle = { state: "idle", label: "alpha" } as const;
  const done = { state: "done", label: "alpha" } as const;

  it("starts a task when running appears or the selected workspace changes", () => {
    expect(transition(undefined, running)).toEqual({ type: "task_started", label: "alpha" });
    expect(transition(idle, running)).toEqual({ type: "task_started", label: "alpha" });
    expect(transition(running, { ...running, label: "beta" })).toEqual({
      type: "task_started",
      label: "beta",
    });
  });

  it("is silent when nothing changed", () => {
    expect(transition(undefined, undefined)).toBeUndefined();
    expect(transition(running, running)).toBeUndefined();
    expect(transition(idle, { ...idle, label: "beta" })).toBeUndefined();
  });

  it("maps finishing and idling", () => {
    expect(transition(running, done)).toEqual({ type: "task_finished", result: "done" });
    expect(transition(running, idle)).toEqual({ type: "status_changed", status: "idle" });
    expect(transition(done, idle)).toEqual({ type: "status_changed", status: "idle" });
  });

  it("rests when the last coding-CLI status disappears, and only then", () => {
    expect(transition(running, undefined)).toEqual({ type: "status_changed", status: "idle" });
    expect(transition(idle, undefined)).toBeUndefined();
    expect(transition(done, undefined)).toBeUndefined();
  });
});

describe("createAdapter", () => {
  it("emits one event per transition and heartbeats every poll", async () => {
    const { calls, post } = recorder();
    let current: WorkspaceState[] = [{ name: "Fix flaky test", state: "running" }];
    const adapter = createAdapter({ list: async () => current, post, botId: "cmux" });

    await adapter.poll();
    await adapter.poll();
    current = [{ name: "Fix flaky test", state: "idle" }];
    await adapter.poll();
    current = [{ name: "Fix flaky test", state: "done" }];
    await adapter.poll();

    expect(events(calls).map((call) => call.body)).toEqual([
      {
        events: [
          {
            botId: "cmux",
            eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            type: "task_started",
            label: "Fix flaky test",
          },
        ],
      },
      {
        events: [
          { botId: "cmux", eventId: expect.any(String), type: "status_changed", status: "idle" },
        ],
      },
      {
        events: [
          { botId: "cmux", eventId: expect.any(String), type: "task_finished", result: "done" },
        ],
      },
    ]);
    expect(calls.filter((call) => call.path.endsWith("/heartbeat"))).toHaveLength(4);
    expect(calls.filter((call) => call.path === "/api/bots/cmux/heartbeat")).toHaveLength(4);
  });

  it("sends only the workspace name, never prompt, program_status or set-status text", async () => {
    const { calls, post } = recorder();
    const status = [
      "pi=Running icon=bolt.fill",
      "program_status=pi · Working prompt: deploy prod with ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
      "task=secret plan: rotate token color=#ff9500",
    ].join("\n");
    const adapter = createAdapter({
      // The parser is the only path from CLI output to a state.
      list: async () => [{ name: "Fix flaky test", state: parseStatus(status) }],
      post,
      botId: "cmux",
    });

    await adapter.poll();

    const sent = bodies(calls).join("\n");
    expect(sent).toContain("Fix flaky test");
    for (const leak of ["program_status", "secret plan", "ghp_", "prompt:", "color=", "cwd"]) {
      expect(sent).not.toContain(leak);
    }
    const event = (events(calls)[0]!.body as { events: Record<string, unknown>[] }).events[0]!;
    expect(Object.keys(event).toSorted()).toEqual(["botId", "eventId", "label", "type"]);
  });

  it("idles when every workspace stops reporting and stays quiet afterwards", async () => {
    const { calls, post } = recorder();
    let current: WorkspaceState[] = [{ name: "alpha", state: "running" }];
    const adapter = createAdapter({ list: async () => current, post, botId: "cmux" });

    await adapter.poll();
    current = [];
    await adapter.poll();
    await adapter.poll();

    expect(events(calls).map((call) => call.body)).toEqual([
      expect.objectContaining({
        events: [expect.objectContaining({ type: "task_started", label: "alpha" })],
      }),
      { events: [expect.objectContaining({ type: "status_changed", status: "idle" })] },
    ]);
  });

  it("retries the rest event after a failed post", async () => {
    let fail = false;
    const calls: Call[] = [];
    const post = async (path: string, body: unknown) => {
      if (path === "/api/events" && fail) throw new Error("office down");
      calls.push({ path, body });
    };
    let current: WorkspaceState[] = [{ name: "alpha", state: "running" }];
    const adapter = createAdapter({ list: async () => current, post, botId: "cmux" });

    await adapter.poll();
    current = [];
    fail = true;
    await expect(adapter.poll()).rejects.toThrow("office down");
    fail = false;
    await adapter.poll();

    expect(events(calls).map((call) => call.body)).toEqual([
      expect.objectContaining({ events: [expect.objectContaining({ type: "task_started" })] }),
      { events: [expect.objectContaining({ type: "status_changed", status: "idle" })] },
    ]);
  });

  it("retries a failed event post instead of losing the transition", async () => {
    let attempts = 0;
    const calls: Call[] = [];
    const post = async (path: string, body: unknown) => {
      if (path === "/api/events" && attempts++ === 0) throw new Error("office down");
      calls.push({ path, body });
    };
    const adapter = createAdapter({
      list: async () => [{ name: "alpha", state: "running" }],
      post,
      botId: "cmux",
    });

    await expect(adapter.poll()).rejects.toThrow("office down");
    await adapter.poll();

    expect(events(calls)).toHaveLength(1);
    expect(events(calls)[0]!.body).toMatchObject({
      events: [{ type: "task_started", label: "alpha" }],
    });
  });
});
