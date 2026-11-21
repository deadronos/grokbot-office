import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_ADAPTER_PREFIX,
  DEFAULT_CMUX_BIN,
  DEFAULT_POLL_SEC,
  resolveConfig,
} from "./config.ts";

const base = {
  CMUX_ADAPTER_ENABLED: "true",
  BO_URL: "https://office.test",
  BO_TOKEN: "bot-token",
  BO_BOT_ID: "cmux",
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  it("is disabled without the explicit flag", () => {
    expect(resolveConfig({ ...base, CMUX_ADAPTER_ENABLED: undefined })).toBeUndefined();
    expect(resolveConfig({ ...base, CMUX_ADAPTER_ENABLED: "1" })).toBeUndefined();
  });

  it("is disabled when a credential is missing", () => {
    expect(resolveConfig({ ...base, BO_URL: undefined })).toBeUndefined();
    expect(resolveConfig({ ...base, BO_TOKEN: undefined })).toBeUndefined();
    expect(resolveConfig({ ...base, BO_BOT_ID: undefined })).toBeUndefined();
    expect(resolveConfig({ ...base, BO_URL: "   " })).toBeUndefined();
  });

  it("keeps the defaults and trims the credentials", () => {
    expect(
      resolveConfig({ ...base, BO_URL: " https://office.test/ ", BO_BOT_ID: " cmux " }),
    ).toEqual({
      baseUrl: "https://office.test/",
      token: "bot-token",
      botId: "cmux",
      bin: DEFAULT_CMUX_BIN,
      pollSec: DEFAULT_POLL_SEC,
      prefix: DEFAULT_ADAPTER_PREFIX,
      allow: [],
    });
  });

  it("reads the bin and poll interval overrides, falling back on garbage", () => {
    expect(
      resolveConfig({ ...base, CMUX_BIN: "/opt/cmux", CMUX_ADAPTER_POLL_SEC: "15" }),
    ).toMatchObject({ bin: "/opt/cmux", pollSec: 15 });
    expect(resolveConfig({ ...base, CMUX_ADAPTER_POLL_SEC: "soon" })).toMatchObject({
      pollSec: DEFAULT_POLL_SEC,
    });
    expect(resolveConfig({ ...base, CMUX_ADAPTER_POLL_SEC: "0" })).toMatchObject({
      pollSec: DEFAULT_POLL_SEC,
    });
  });

  it("reads the prefix and the allow list", () => {
    expect(resolveConfig({ ...base, CMUX_ADAPTER_PREFIX: "bot " })).toMatchObject({
      prefix: "bot ",
    });
    // An empty prefix stays empty: it does not mean "allow all".
    expect(resolveConfig({ ...base, CMUX_ADAPTER_PREFIX: "" })).toMatchObject({ prefix: "" });
    expect(
      resolveConfig({ ...base, CMUX_ADAPTER_ALLOW: " scratch , workspace:1 ,, " }),
    ).toMatchObject({ allow: ["scratch", "workspace:1"] });
    expect(resolveConfig({ ...base, CMUX_ADAPTER_ALLOW: "  " })).toMatchObject({ allow: [] });
  });

  it("warns on a loose token file mode and stays enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-adapter-"));
    tempDirs.push(dir);
    const file = join(dir, "cmux.token");
    writeFileSync(file, "file-token");
    const warnings: string[] = [];
    const warn = (line: string) => void warnings.push(line);

    chmodSync(file, 0o644);
    expect(
      resolveConfig({ ...base, BO_TOKEN: undefined, BO_TOKEN_FILE: file }, warn),
    ).toMatchObject({ token: "file-token" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/0644|644|mode/i);
    expect(warnings[0]).not.toContain("file-token");

    warnings.length = 0;
    chmodSync(file, 0o600);
    expect(
      resolveConfig({ ...base, BO_TOKEN: undefined, BO_TOKEN_FILE: file }, warn),
    ).toMatchObject({ token: "file-token" });
    expect(warnings).toEqual([]);
  });

  it("reads the token from a file when BO_TOKEN is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmux-adapter-"));
    tempDirs.push(dir);
    const file = join(dir, "cmux.token");
    writeFileSync(file, "  file-token\n");

    expect(resolveConfig({ ...base, BO_TOKEN: undefined, BO_TOKEN_FILE: file })).toMatchObject({
      token: "file-token",
    });
    // The environment wins over the file, so a rotated file cannot override it.
    expect(resolveConfig({ ...base, BO_TOKEN: "env-token", BO_TOKEN_FILE: file })).toMatchObject({
      token: "env-token",
    });
    expect(
      resolveConfig({ ...base, BO_TOKEN: undefined, BO_TOKEN_FILE: join(dir, "missing") }),
    ).toBeUndefined();
  });
});
