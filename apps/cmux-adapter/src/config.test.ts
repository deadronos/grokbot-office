import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_CMUX_BIN, DEFAULT_POLL_SEC, resolveConfig } from "./config.ts";

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
