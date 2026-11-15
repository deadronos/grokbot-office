import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_SESSION_TTL_SEC } from "../config.ts";
import { hashToken, issueToken } from "../auth/tokens.ts";
import { SESSION_COOKIE_NAME } from "../auth/session.ts";
import { botRecord, TEST_ADMIN_TOKEN, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

type Context = ReturnType<typeof testSetup>;
type App = Context["app"];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function setup() {
  const context = testSetup();
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  return {
    ...context,
    botToken: issueToken(context.repo, { kind: "bot", botId: "data" }).token,
    viewer: issueToken(context.repo, { kind: "viewer" }),
  };
}

const postSession = (app: App, token?: string) =>
  app.request(
    "/api/session",
    token === undefined ? { method: "POST" } : { method: "POST", headers: auth(token) },
  );

const logout = (app: App, cookie?: string) =>
  app.request(
    "/api/session/logout",
    cookie === undefined ? { method: "POST" } : { method: "POST", headers: { cookie } },
  );

/** The `__Secure-bo_session` Set-Cookie header and the secret inside it. */
function sessionCookie(res: Response) {
  const raw = res.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (raw === undefined) throw new Error("session cookie missing");
  const pair = raw.split(";")[0];
  return { raw, secret: decodeURIComponent(pair.slice(SESSION_COOKIE_NAME.length + 1)) };
}

const cookieHeader = (secret: string) => `${SESSION_COOKIE_NAME}=${secret}`;

const sessionRows = (db: Context["db"]) =>
  db.prepare("select * from sessions").all() as {
    id: string;
    token_hash: string;
    token_id: string;
    expires_at: string;
    revoked_at: string | null;
  }[];

describe("POST /api/session", () => {
  it("exchanges a viewer token for an HttpOnly cookie and stores only its hash", async () => {
    const { app, db, viewer } = setup();
    const res = await postSession(app, viewer.token);

    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { expiresAt: string };
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(
      (DEFAULT_SESSION_TTL_SEC - 5) * 1000,
    );
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(
      DEFAULT_SESSION_TTL_SEC * 1000,
    );

    const { raw, secret } = sessionCookie(res);
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("Secure");
    expect(raw).toContain("SameSite=Strict");
    expect(raw).toContain("Path=/api");
    expect(raw).toContain(`Max-Age=${DEFAULT_SESSION_TTL_SEC}`);

    const rows = sessionRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(secret));
    expect(rows[0].token_hash).not.toBe(secret);
    expect(rows[0].token_id).toBe(viewer.id);
    expect(rows[0].expires_at).toBe(body.expiresAt);
  });

  it("ignores any request body", async () => {
    const { app, viewer } = setup();
    const res = await app.request("/api/session", {
      method: "POST",
      headers: { ...auth(viewer.token), "content-type": "application/json" },
      body: JSON.stringify({ sessionTtlSec: 999999, kind: "admin" }),
    });
    expect(res.status).toBe(201);
  });

  it("honours a configured ttl", async () => {
    const context = testSetup({ sessionTtlSec: 60 });
    cleanups.push(context.close);
    const viewer = issueToken(context.repo, { kind: "viewer" });
    const res = await postSession(context.app, viewer.token);

    expect(sessionCookie(res).raw).toContain("Max-Age=60");
  });

  it("refuses a bot token", async () => {
    const { app, botToken } = setup();
    expect((await postSession(app, botToken)).status).toBe(403);
  });

  it("refuses the env admin token with 403, not a session", async () => {
    const { app, db } = setup();
    const res = await postSession(app, TEST_ADMIN_TOKEN);
    expect(res.status).toBe(403);
    expect(sessionRows(db)).toHaveLength(0);
  });

  it("refuses missing, unknown and revoked viewer tokens", async () => {
    const { app, repo, viewer } = setup();
    expect((await postSession(app)).status).toBe(401);
    expect((await postSession(app, "not-a-real-token")).status).toBe(401);

    repo.revokeToken(viewer.id, new Date().toISOString());
    expect((await postSession(app, viewer.token)).status).toBe(401);
  });

  it("lazily deletes sessions that expired over a day ago", async () => {
    const { app, db, viewer, repo } = setup();
    repo.insertSession({
      id: "old-session",
      tokenHash: hashToken("old-secret"),
      tokenId: viewer.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      revokedAt: null,
    });
    expect(sessionRows(db)).toHaveLength(1);

    expect((await postSession(app, viewer.token)).status).toBe(201);
    const ids = sessionRows(db).map((row) => row.id);
    expect(ids).not.toContain("old-session");
    expect(ids).toHaveLength(1);
  });
});

describe("session cookie auth", () => {
  async function sessionOf(app: App, viewerToken: string) {
    const res = await postSession(app, viewerToken);
    expect(res.status).toBe(201);
    return sessionCookie(res).secret;
  }

  it("authenticates viewer reads on state and events", async () => {
    const { app, viewer } = setup();
    const cookie = cookieHeader(await sessionOf(app, viewer.token));

    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(200);
    expect((await app.request("/api/events?since=0", { headers: { cookie } })).status).toBe(200);
  });

  it("refuses an unknown cookie", async () => {
    const { app } = setup();
    const res = await app.request("/api/state", {
      headers: { cookie: cookieHeader("not-a-real-secret") },
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toEqual({ error: "unauthorized" });
  });

  it("refuses an expired session", async () => {
    const { app, db, viewer } = setup();
    const cookie = cookieHeader(await sessionOf(app, viewer.token));
    db.prepare("update sessions set expires_at = ?").run("2000-01-01T00:00:00.000Z");

    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(401);
  });

  it("refuses a revoked session", async () => {
    const { app, db, viewer } = setup();
    const cookie = cookieHeader(await sessionOf(app, viewer.token));
    db.prepare("update sessions set revoked_at = ?").run(new Date().toISOString());

    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(401);
  });

  it("dies with its viewer token", async () => {
    const { app, repo, viewer } = setup();
    const cookie = cookieHeader(await sessionOf(app, viewer.token));
    repo.revokeToken(viewer.id, new Date().toISOString());

    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(401);
  });

  it("never accepts a token in the query string", async () => {
    const { app, viewer } = setup();
    const token = encodeURIComponent(viewer.token);
    // Auth runs before query parsing, so an unauthenticated request stops at 401.
    expect((await app.request(`/api/state?token=${token}`)).status).toBe(401);
    expect((await app.request(`/api/events?access_token=${token}`)).status).toBe(401);
    expect((await app.request(`/api/stream?token=${token}`)).status).toBe(401);
  });
});

describe("POST /api/session/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const { app, db, viewer } = setup();
    const { secret } = sessionCookie(await postSession(app, viewer.token));
    const cookie = cookieHeader(secret);

    const res = await logout(app, cookie);
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const cleared = res.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(cleared).toBeDefined();
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("Path=/api");

    expect(sessionRows(db)[0].revoked_at).not.toBeNull();
    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(401);
  });

  it("still clears the cookie without one, and keeps the first revocation time", async () => {
    const { app, db, viewer } = setup();
    const { secret } = sessionCookie(await postSession(app, viewer.token));
    const cookie = cookieHeader(secret);

    expect((await logout(app)).status).toBe(204);
    expect(sessionRows(db)[0].revoked_at).toBeNull();

    expect((await logout(app, cookie)).status).toBe(204);
    const first = sessionRows(db)[0].revoked_at;
    expect(first).not.toBeNull();

    expect((await logout(app, cookie)).status).toBe(204);
    expect(sessionRows(db)[0].revoked_at).toBe(first);
  });

  it("ignores an unknown cookie", async () => {
    const { app } = setup();
    expect((await logout(app, cookieHeader("not-a-real-secret"))).status).toBe(204);
  });
});
