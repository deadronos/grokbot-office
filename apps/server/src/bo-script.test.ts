import { execFile } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";

import { issueToken } from "./auth/tokens.ts";
import { resolveRateLimitConfig } from "./config.ts";
import { createRateLimits } from "./rate-limit.ts";
import { botRecord, testSetup } from "./test-utils.ts";

const exec = promisify(execFile);
/** The reporting helper ships at the repo root; these tests run from apps/server. */
const SCRIPT = fileURLToPath(new URL("../../../scripts/bo.sh", import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

type Setup = ReturnType<typeof testSetup>;

/** Serves the in-memory app on an ephemeral loopback port and returns its URL. */
async function listen({ app }: Setup): Promise<string> {
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

/** Runs `bo.sh` with the three env vars the script reads; nothing goes on argv. */
function bo(url: string, botId: string, token: string, ...args: string[]) {
  return exec("bash", [SCRIPT, ...args], {
    env: { ...process.env, BO_URL: url, BO_TOKEN: token, BO_BOT_ID: botId },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<{ code: number; stderr: string }> {
  try {
    await promise;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    return { code: failure.code ?? 0, stderr: failure.stderr ?? "" };
  }
  throw new Error("expected the script to fail");
}

describe("scripts/bo.sh", () => {
  it("registers, reports a task, hands it off, accepts it and finishes", async () => {
    const context = testSetup();
    cleanups.push(context.close);
    context.repo.upsertBot(botRecord("data"));
    context.repo.upsertBot(botRecord("wesley"));
    const dataToken = issueToken(context.repo, { kind: "bot", botId: "data" }).token;
    const wesleyToken = issueToken(context.repo, { kind: "bot", botId: "wesley" }).token;
    const url = await listen(context);

    const registered = await bo(url, "data", dataToken, "register");
    expect(JSON.parse(registered.stdout)).toEqual({
      id: "data",
      heartbeatIntervalSec: 60,
      timeoutSec: 300,
    });
    expect(context.repo.getBot("data")).toMatchObject({ name: "data", pod: "dev" });
    // Loopback + http is the normal local setup; no warning noise on stderr.
    expect(registered.stderr).toBe("");

    await bo(url, "data", dataToken, "start", "docs", "task-1");
    expect(context.repo.getBotStatus("data")).toMatchObject({
      status: "working",
      label: "docs",
      taskId: "task-1",
    });

    const handedOff = await bo(
      url,
      "data",
      dataToken,
      "handoff",
      "wesley",
      "review docs",
      "task-1",
    );
    const handoffId = /handoffId: (\S+)/.exec(handedOff.stderr)?.[1];
    expect(handoffId).toBeTruthy();
    expect(context.repo.getBotStatus("data")).toMatchObject({ status: "waiting" });
    expect(context.repo.getHandoff(handoffId ?? "")).toMatchObject({
      fromBotId: "data",
      toBotId: "wesley",
      label: "review docs",
      state: "sent",
    });

    await bo(url, "wesley", wesleyToken, "accept", handoffId ?? "");
    expect(context.repo.getBotStatus("wesley")).toMatchObject({
      status: "working",
      label: "review docs",
    });
    // Accepting the handoff the sender is waiting on frees the sender.
    expect(context.repo.getBotStatus("data")).toMatchObject({ status: "idle" });

    await bo(url, "wesley", wesleyToken, "done");
    expect(context.repo.getBotStatus("wesley")).toMatchObject({ status: "idle", taskId: null });

    await bo(url, "data", dataToken, "heartbeat", "reviewing");
    expect(context.repo.getBotStatus("data")).toMatchObject({ status: "reviewing" });

    await bo(url, "data", dataToken, "event", '{"type":"status_changed","status":"idle"}');
    expect(context.repo.getBotStatus("data")).toMatchObject({ status: "idle" });
  });

  it("escapes quotes, backslashes and control characters in labels", async () => {
    const context = testSetup();
    cleanups.push(context.close);
    context.repo.upsertBot(botRecord("data"));
    const token = issueToken(context.repo, { kind: "bot", botId: "data" }).token;
    const url = await listen(context);
    await bo(url, "data", token, "register");

    const label = 'he said "hi" C:\\tmp\ttab';
    const started = await bo(url, "data", token, "start", label);
    // Valid JSON out; the server stores it after its own whitespace sanitizing.
    expect(JSON.parse(started.stdout)).toBeTruthy();
    expect(context.repo.getBotStatus("data")).toMatchObject({
      label: 'he said "hi" C:\\tmp tab',
    });
  });

  it("refuses a raw event that tries to set the envelope ids", async () => {
    const context = testSetup();
    cleanups.push(context.close);
    context.repo.upsertBot(botRecord("data"));
    const token = issueToken(context.repo, { kind: "bot", botId: "data" }).token;
    const url = await listen(context);

    for (const raw of [
      '{"type":"status_changed","botId":"wesley"}',
      '{"type":"status_changed","eventId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    ]) {
      const { code, stderr } = await failureOf(bo(url, "data", token, "event", raw));
      expect(code).toBe(1);
      expect(stderr).toContain("must not set botId or eventId");
    }
  });

  it("warns before sending the token over plain http to a non-loopback host", async () => {
    const context = testSetup();
    cleanups.push(context.close);
    context.repo.upsertBot(botRecord("data"));
    const token = issueToken(context.repo, { kind: "bot", botId: "data" }).token;

    // Port 1 refuses at once, so this stays offline and fast.
    const { code, stderr } = await failureOf(bo("http://0.0.0.0:1", "data", token, "heartbeat"));
    expect(code).toBe(1);
    expect(stderr).toContain("plain http");
  });

  it("refuses working/waiting heartbeats before they reach the server", async () => {
    const context = testSetup();
    cleanups.push(context.close);
    context.repo.upsertBot(botRecord("data"));
    const token = issueToken(context.repo, { kind: "bot", botId: "data" }).token;
    const url = await listen(context);
    await bo(url, "data", token, "register");

    // The script refuses them locally, before spending a request.
    const { code, stderr } = await failureOf(bo(url, "data", token, "heartbeat", "working"));
    expect(code).toBe(1);
    expect(stderr).toContain("idle, reviewing or offline");
    expect(context.repo.getBotStatus("data")).toMatchObject({ status: "idle" });
  });

  it("exits non-zero when the server rejects the token", async () => {
    const context = testSetup();
    cleanups.push(context.close);
    context.repo.upsertBot(botRecord("data"));
    const url = await listen(context);

    const { code, stderr } = await failureOf(bo(url, "data", "not-a-real-token", "start", "docs"));
    expect(code).toBe(1);
    expect(stderr).toContain("HTTP 401");
    expect(context.repo.getBotStatus("data")).toBeUndefined();
  });

  it("waits out Retry-After and retries a rate-limited call", async () => {
    const limits = createRateLimits(
      resolveRateLimitConfig({ RATE_LIMIT_PER_MIN: "60", RATE_LIMIT_BURST: "1" }),
    );
    const context = testSetup({ limits });
    cleanups.push(context.close);
    context.repo.upsertBot(botRecord("data"));
    const token = issueToken(context.repo, { kind: "bot", botId: "data" }).token;
    const url = await listen(context);

    // The first call spends the single token; the second gets 429 + Retry-After: 1.
    await bo(url, "data", token, "register");
    const retried = await bo(url, "data", token, "heartbeat", "idle");
    expect(retried.stderr).toContain("rate limited, retrying in 1s");
    expect(context.repo.getBotStatus("data")).toMatchObject({ status: "idle" });
  });
});
