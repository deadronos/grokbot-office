import { afterEach, describe, expect, it, vi } from "vitest";

import { hashToken } from "../auth/tokens.ts";
import { adminHeaders, botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.restoreAllMocks();
});

function setup(options?: { adminToken?: string }) {
  const context = testSetup(options);
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot(botRecord("wesley"));
  return context;
}

const createToken = (
  app: ReturnType<typeof setup>["app"],
  body: unknown,
  headers = adminHeaders(),
) =>
  app.request("/api/admin/tokens", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("admin auth", () => {
  it("refuses to serve the admin API without a configured token", async () => {
    const { app } = setup({ adminToken: "" });
    expect((await app.request("/api/admin/tokens")).status).toBe(503);
  });

  it("refuses the .env.example placeholder", async () => {
    const { app } = setup({ adminToken: "change-me" });
    expect(
      (await app.request("/api/admin/tokens", { headers: adminHeaders("change-me") })).status,
    ).toBe(503);
  });

  it("rejects missing and wrong admin tokens", async () => {
    const { app } = setup();
    expect((await app.request("/api/admin/tokens")).status).toBe(401);
    expect((await app.request("/api/admin/tokens", { headers: adminHeaders("nope") })).status).toBe(
      401,
    );
  });

  it("rejects a bot token on admin routes", async () => {
    const { app } = setup();
    const created = await createToken(app, { kind: "bot", botId: "data" });
    const { token } = (await created.json()) as { token: string };
    expect((await app.request("/api/admin/tokens", { headers: adminHeaders(token) })).status).toBe(
      401,
    );
  });

  it("never logs the authorization header", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined),
    );
    const { app } = setup();
    const created = await createToken(app, { kind: "viewer" });
    const { token } = (await created.json()) as { token: string };
    await app.request("/api/admin/tokens", { headers: adminHeaders(token) });
    await app.request("/api/admin/tokens", { headers: adminHeaders() });

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(token);
      }
    }
  });
});

describe("admin token endpoints", () => {
  it("issues a bot token once and lists only safe fields", async () => {
    const { app } = setup();
    const res = await createToken(app, { kind: "bot", botId: "data" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      kind: string;
      botId: string;
      prefix: string;
      token: string;
    };
    expect(created).toMatchObject({ kind: "bot", botId: "data" });
    expect(created.prefix).toHaveLength(8);
    expect(created.token.startsWith(created.prefix)).toBe(true);

    const list = await app.request("/api/admin/tokens", { headers: adminHeaders() });
    const body = (await list.json()) as { tokens: Record<string, unknown>[] };
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({
      id: created.id,
      kind: "bot",
      botId: "data",
      prefix: created.prefix,
      lastUsedAt: null,
      revokedAt: null,
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(created.token);
    expect(serialized).not.toContain(hashToken(created.token));
    expect(Object.keys(body.tokens[0] ?? {})).toEqual([
      "id",
      "kind",
      "botId",
      "prefix",
      "createdAt",
      "lastUsedAt",
      "revokedAt",
    ]);
  });

  it("issues viewer tokens without a bot", async () => {
    const { app } = setup();
    const res = await createToken(app, { kind: "viewer" });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ kind: "viewer", botId: null });
  });

  it("validates the request body", async () => {
    const { app } = setup();
    expect((await createToken(app, { kind: "bot" })).status).toBe(400);
    expect((await createToken(app, { kind: "bot", botId: "nobody" })).status).toBe(404);
    expect((await createToken(app, { kind: "bot", botId: "Not A Slug" })).status).toBe(400);
    expect((await createToken(app, { kind: "viewer", botId: "data" })).status).toBe(400);
    expect((await createToken(app, { kind: "admin" })).status).toBe(400);
  });

  it("revokes tokens idempotently and 404s unknown ids", async () => {
    const { app, repo } = setup();
    const created = (await (await createToken(app, { kind: "bot", botId: "data" })).json()) as {
      id: string;
    };
    const revoke = await app.request(`/api/admin/tokens/${created.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(revoke.status).toBe(200);
    const revokedAt = repo.getToken(created.id)?.revokedAt;

    const again = await app.request(`/api/admin/tokens/${created.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(again.status).toBe(200);
    expect(repo.getToken(created.id)?.revokedAt).toBe(revokedAt);

    const missing = await app.request("/api/admin/tokens/unknown", {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it("patches bots partially and rejects bad input", async () => {
    const { app, repo } = setup();
    const patch = (id: string, body: unknown) =>
      app.request(`/api/admin/bots/${id}`, {
        method: "PATCH",
        headers: { ...adminHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const res = await patch("data", { name: "Data II", deskIndex: 3, hidden: true });
    expect(res.status).toBe(200);
    expect(repo.getBot("data")).toMatchObject({ name: "Data II", deskIndex: 3, hidden: true });

    expect((await patch("data", { pod: "ops" })).status).toBe(200);
    expect(repo.getBot("data")?.pod).toBe("ops");

    expect((await patch("nobody", { name: "x" })).status).toBe(404);
    expect((await patch("data", { pod: "moon" })).status).toBe(400);
    expect((await patch("data", { name: "" })).status).toBe(400);
    expect((await patch("data", { colour: "red" })).status).toBe(400);
    expect((await patch("Bad Slug", { name: "x" })).status).toBe(400);
  });
});
