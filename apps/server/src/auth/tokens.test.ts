import { describe, expect, it } from "vitest";

import {
  ADMIN_TOKEN_MIN_LENGTH,
  extractBearerToken,
  generateToken,
  hashToken,
  issueToken,
  isAdminTokenUsable,
  secretsEqual,
  TOKEN_PREFIX_LENGTH,
  tokenPrefix,
} from "./tokens.ts";
import { botRecord, testSetup } from "../test-utils.ts";

describe("token primitives", () => {
  it("generates 32 random bytes that differ every time", () => {
    const first = generateToken();
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    expect(first).not.toBe(generateToken());
  });

  it("caps the prefix at 8 characters", () => {
    expect(TOKEN_PREFIX_LENGTH).toBe(8);
    expect(tokenPrefix(generateToken())).toHaveLength(8);
    expect(tokenPrefix("x".repeat(100))).toBe("x".repeat(8));
    expect(tokenPrefix("short")).toHaveLength(5);
  });

  it("hashes tokens as 64 hex chars and rejects the plaintext as a hash", () => {
    const token = generateToken();
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(token);
  });

  it("compares secrets in constant time", () => {
    expect(secretsEqual("same", "same")).toBe(true);
    expect(secretsEqual("same", "other")).toBe(false);
    expect(secretsEqual("short", "a-much-longer-value")).toBe(false);
  });

  it("refuses to treat a short or placeholder admin token as usable", () => {
    expect(ADMIN_TOKEN_MIN_LENGTH).toBe(32);
    expect(isAdminTokenUsable("change-me")).toBe(false);
    expect(isAdminTokenUsable("")).toBe(false);
    expect(isAdminTokenUsable("   ")).toBe(false);
    expect(isAdminTokenUsable(undefined)).toBe(false);
    expect(isAdminTokenUsable("x".repeat(ADMIN_TOKEN_MIN_LENGTH - 1))).toBe(false);
    expect(isAdminTokenUsable("x".repeat(ADMIN_TOKEN_MIN_LENGTH))).toBe(true);
    expect(isAdminTokenUsable("  " + "x".repeat(ADMIN_TOKEN_MIN_LENGTH) + "  ")).toBe(true);
  });

  it("never issues admin tokens", () => {
    const { repo, close } = testSetup();
    try {
      expect(() => issueToken(repo, { kind: "admin" })).toThrow(/admin tokens cannot be issued/);
      expect(repo.listTokens()).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("parses only Bearer headers", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer  abc ")).toBe("abc");
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it("gives two issued tokens different hashes", () => {
    const { repo, close } = testSetup();
    try {
      repo.upsertBot(botRecord("data"));
      const first = issueToken(repo, { kind: "bot", botId: "data" });
      const second = issueToken(repo, { kind: "bot", botId: "data" });
      expect(hashToken(first.token)).not.toBe(hashToken(second.token));
      expect(repo.listTokens()).toHaveLength(2);
    } finally {
      close();
    }
  });

  it("rejects a duplicate hash at the database level", () => {
    const { db, repo, close } = testSetup();
    try {
      repo.upsertBot(botRecord("data"));
      const issued = issueToken(repo, { kind: "bot", botId: "data" });
      const stored = repo.getToken(issued.id)!;
      expect(() => repo.insertToken({ ...stored, id: "second" })).toThrow();
      expect(db.prepare("select count(*) as n from tokens").get()).toEqual({ n: 1 });
    } finally {
      close();
    }
  });
});
