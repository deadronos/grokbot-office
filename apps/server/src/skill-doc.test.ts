import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** The bot-facing skill ships with the repo; these tests run from apps/server. */
const SKILL = fileURLToPath(new URL("../../../docs/skill/bot-office-report.md", import.meta.url));

const text = existsSync(SKILL) ? readFileSync(SKILL, "utf8") : "";
const lower = text.toLowerCase();

describe("docs/skill/bot-office-report.md", () => {
  it("exists", () => {
    expect(existsSync(SKILL)).toBe(true);
  });

  it("covers when to report and when not to", () => {
    for (const word of ["task start", "handoff"]) expect(lower).toContain(word);
    expect(lower).toMatch(/trivial|chatter|greeting/);
  });

  it("names the reporting helper and its environment", () => {
    expect(text).toContain("bo.sh");
    for (const name of ["BO_URL", "BO_TOKEN", "BO_BOT_ID"]) expect(text).toContain(name);
  });

  it("tells a bot to skip when it is not set up", () => {
    expect(lower).toMatch(/skip/);
    expect(lower).toMatch(/unset|missing|not set/);
  });

  it("says failures never block the task", () => {
    expect(lower).toMatch(/never (block|abort|fail the task)|must not (block|abort)/);
  });

  it("states the label rules", () => {
    expect(text).toContain("80");
    expect(lower).toMatch(/no secrets|never.*secrets/);
    expect(lower).toMatch(/personal|pii/);
  });

  it("leaks no tokens, hosts or personal data", () => {
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
    expect(text).not.toMatch(/\.ts\.net\b/);
    expect(text).not.toMatch(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/);
    const hosts = text.match(/https?:\/\/[^\s`)"']+/g) ?? [];
    for (const host of hosts) expect(host).toMatch(/^https:\/\/office\.example(\/|$)/);
  });
});
