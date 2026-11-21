import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** The bot-facing skill ships with the repo; these tests run from apps/server. */
const SKILL = fileURLToPath(new URL("../../../docs/skill/bot-office-report.md", import.meta.url));

const text = existsSync(SKILL) ? readFileSync(SKILL, "utf8") : "";
/** Same text with line breaks collapsed, so multi-line sentences can be matched exactly. */
const flat = text.replace(/\s+/g, " ");

describe("docs/skill/bot-office-report.md", () => {
  it("exists", () => {
    expect(existsSync(SKILL)).toBe(true);
  });

  it("covers when to report and when not to", () => {
    expect(flat).toContain("- **task start** — you begin a task.");
    expect(flat).toContain("- **task end** — done, failed or cancelled.");
    expect(flat).toContain("- **handoff out** — you hand work to another bot.");
    expect(flat).toContain("- **handoff in** — you accept a handoff addressed to you.");
    expect(flat).toContain(
      "Do not report trivial chat turns, greetings, short questions and answers, or chatter that is not a unit of work.",
    );
  });

  it("names the reporting helper and its environment", () => {
    expect(text).toContain("Prefer `scripts/bo.sh`");
    for (const name of ["BO_URL", "BO_TOKEN", "BO_BOT_ID"]) expect(text).toContain(name);
  });

  it("lists the bo.sh commands in argument order", () => {
    expect(text).toContain('scripts/bo.sh start "<label>" [taskId]');
    expect(text).toContain("scripts/bo.sh done [taskId] [done|failed|cancelled]");
    expect(text).toContain('scripts/bo.sh handoff <bot> "<label>" [taskId]');
    expect(text).toContain("scripts/bo.sh accept <handoffId> [taskId]");
  });

  it("says handoff takes the receiver's lowercase bot id, not a display name", () => {
    expect(flat).toContain(
      "`handoff <bot>` takes the receiver's lowercase bot id/slug; a display name such as `Wesley` returns a 400 because `to` is a `BotId`.",
    );
  });

  it("keeps the token off argv and caps the request", () => {
    expect(flat).toContain(
      "Pass the authorization header through a curl config on stdin (`--config -`)",
    );
    expect(text).toContain("--max-time 5");
  });

  it("states the label rules", () => {
    expect(flat).toContain("Short and generic, max 80 characters:");
    expect(flat).toContain(
      "Never secrets: tokens, keys, URLs with credentials, personal data (PII), customer names, ticket contents, or anything you could not show on a screen in a shared room.",
    );
    expect(flat).toContain(
      "Hidden bots stay hidden: never put a hidden bot's id, name or label into a report.",
    );
  });

  it("tells a bot to skip when it is not set up", () => {
    expect(flat).toContain(
      "If `BO_URL`, `BO_TOKEN` or `BO_BOT_ID` is unset or missing, skip this skill entirely — do not call `bo.sh`, which would exit with an error.",
    );
  });

  it("says failures never block the task", () => {
    expect(flat).toContain(
      "Catch or ignore that status, never abort the user's task over it, and do not retry in a tight loop.",
    );
  });

  it("leaks no tokens, hosts or personal data", () => {
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
    expect(text).not.toMatch(/\.ts\.net\b/);
    expect(text).not.toMatch(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/);
    const hosts = text.match(/https?:\/\/[^\s`)"']+/g) ?? [];
    for (const host of hosts) expect(host).toMatch(/^https:\/\/office\.example(\/|$)/);
  });
});
