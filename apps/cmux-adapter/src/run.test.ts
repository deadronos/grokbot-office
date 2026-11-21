import { describe, expect, it } from "vitest";

import { run } from "./run.ts";
import type { WorkspaceState } from "./adapter.ts";

const alpha: WorkspaceState[] = [{ name: "alpha", state: "running" }];

const enabled = {
  CMUX_ADAPTER_ENABLED: "true",
  BO_URL: "https://office.test",
  BO_TOKEN: "bot-token",
  BO_BOT_ID: "cmux",
};

describe("run", () => {
  it("stays disabled without the flag and posts nothing", async () => {
    const posts: string[] = [];
    const logs: string[] = [];
    await run(
      { ...enabled, CMUX_ADAPTER_ENABLED: undefined },
      { post: async (path) => void posts.push(path), log: (line) => void logs.push(line) },
    );

    expect(posts).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("disabled");
  });

  it("posts one event and a heartbeat for a single poll", async () => {
    const posts: string[] = [];
    await run(enabled, {
      once: true,
      post: async (path) => void posts.push(path),
      list: async () => alpha,
      log: () => {},
    });

    expect(posts).toEqual(["/api/events", "/api/bots/cmux/heartbeat"]);
  });

  it("keeps polling and logging a generic failure", async () => {
    const posts: string[] = [];
    const logs: string[] = [];
    let sleeps = 0;
    await run(enabled, {
      post: async (path) => {
        posts.push(path);
        if (posts.length === 1) throw new Error("office down");
      },
      list: async () => alpha,
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) throw new Error("stop the loop");
      },
      log: (line) => void logs.push(line),
    }).catch(() => {});

    expect(sleeps).toBe(2);
    expect(logs).toEqual(["cmux-adapter: poll failed; retrying"]);
    expect(logs.join("\n")).not.toContain("office down");
  });
});
