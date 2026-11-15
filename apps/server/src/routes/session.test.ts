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
    created_at: string;
    last_seen_at: string;
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

  it("prunes every expired session when it creates a new one", async () => {
    const { app, db, viewer, repo } = setup();
    repo.insertSession({
      id: "old-session",
      tokenHash: hashToken("old-secret"),
      tokenId: viewer.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      revokedAt: null,
    });
    expect(sessionRows(db)).toHaveLength(1);

    expect((await postSession(app, viewer.token)).status).toBe(201);
    const ids = sessionRows(db).map((row) => row.id);
    expect(ids).not.toContain("old-session");
    expect(ids).toHaveLength(1);
  });

  it("caps sessions per token and evicts the oldest, leaving other tokens alone", async () => {
    const context = testSetup({ session: { maxPerToken: 2 } });
    cleanups.push(context.close);
    const { app, db, repo } = context;
    const viewer = issueToken(repo, { kind: "viewer" });
    const other = issueToken(repo, { kind: "viewer" });

    const first = await sessionOf(app, viewer.token);
    const second = await sessionOf(app, viewer.token);
    const otherSession = await sessionOf(app, other.token);
    const third = await sessionOf(app, viewer.token);

    const state = (cookie: string) => app.request("/api/state", { headers: { cookie } });
    // The oldest cookie is revoked; the two newer ones still work, and so does the other token.
    expect((await state(cookieHeader(first))).status).toBe(401);
    expect((await state(cookieHeader(second))).status).toBe(200);
    expect((await state(cookieHeader(third))).status).toBe(200);
    expect((await state(cookieHeader(otherSession))).status).toBe(200);

    const revoked = sessionRows(db).filter((row) => row.revoked_at !== null);
    expect(revoked).toHaveLength(1);
  });

  it("does not count revoked sessions against the cap", async () => {
    const context = testSetup({ session: { maxPerToken: 2 } });
    cleanups.push(context.close);
    const { app, db, repo } = context;
    const viewer = issueToken(repo, { kind: "viewer" });

    const first = await sessionOf(app, viewer.token);
    const second = await sessionOf(app, viewer.token);
    repo.revokeSession(sessionRows(db)[0].id, new Date().toISOString());

    const third = await sessionOf(app, viewer.token);

    const state = (cookie: string) => app.request("/api/state", { headers: { cookie } });
    expect((await state(cookieHeader(first))).status).toBe(401);
    expect((await state(cookieHeader(second))).status).toBe(200);
    expect((await state(cookieHeader(third))).status).toBe(200);
  });

  it("keeps five sessions by default", async () => {
    const { app, viewer } = setup();
    const cookies: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      cookies.push(cookieHeader(await sessionOf(app, viewer.token)));
    }

    const state = (cookie: string) => app.request("/api/state", { headers: { cookie } });
    expect((await state(cookies[0])).status).toBe(401);
    expect((await state(cookies[5])).status).toBe(200);
  });
});

async function sessionOf(app: App, viewerToken: string) {
  const res = await postSession(app, viewerToken);
  expect(res.status).toBe(201);
  return sessionCookie(res).secret;
}

describe("session cookie auth", () => {
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

describe("session idle timeout", () => {
  it("refuses a session whose last_seen_at is older than the idle window", async () => {
    const { app, db, viewer } = setup();
    const cookie = cookieHeader(await sessionOf(app, viewer.token));
    db.prepare("update sessions set last_seen_at = ?").run("2000-01-01T00:00:00.000Z");

    const res = await app.request("/api/state", { headers: { cookie } });
    expect(res.status).toBe(401);
    expect((await res.json()) as object).toEqual({ error: "unauthorized" });
  });

  it("refreshes last_seen_at on every authenticated read", async () => {
    const { app, db, viewer } = setup();
    const cookie = cookieHeader(await sessionOf(app, viewer.token));
    // Half an hour old: inside the idle window, so the request goes through and refreshes it.
    const stale = new Date(Date.now() - 1_800_000).toISOString();
    db.prepare("update sessions set last_seen_at = ?").run(stale);

    expect((await app.request("/api/state", { headers: { cookie } })).status).toBe(200);
    expect(Date.parse(sessionRows(db)[0].last_seen_at)).toBeGreaterThan(Date.parse(stale));
  });

  it("honours a configured idle window", async () => {
    const context = testSetup({ session: { idleSec: 10 } });
    cleanups.push(context.close);
    const viewer = issueToken(context.repo, { kind: "viewer" });
    const cookie = cookieHeader(await sessionOf(context.app, viewer.token));
    context.db
      .prepare("update sessions set last_seen_at = ?")
      .run(new Date(Date.now() - 11_000).toISOString());

    expect((await context.app.request("/api/state", { headers: { cookie } })).status).toBe(401);
  });
});

describe("session rotation", () => {
  it("swaps in a new secret on a request once the cookie is old enough", async () => {
    const { app, db, viewer } = setup();
    const oldSecret = await sessionOf(app, viewer.token);
    // Older than SESSION_ROTATE_SEC, still inside the idle window and the TTL.
    db.prepare("update sessions set created_at = ?").run(
      new Date(Date.now() - 3_600_000).toISOString(),
    );

    const res = await app.request("/api/state", { headers: { cookie: cookieHeader(oldSecret) } });
    expect(res.status).toBe(200);

    const raw = res.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(raw).toBeDefined();
    const rotated = decodeURIComponent(raw!.split(";")[0].slice(SESSION_COOKIE_NAME.length + 1));
    expect(rotated).not.toBe(oldSecret);
    // Same row: the cap is untouched and the old secret is now just a dead cookie.
    expect(sessionRows(db)).toHaveLength(1);
    expect(sessionRows(db)[0].token_hash).toBe(hashToken(rotated));
    expect(
      (await app.request("/api/state", { headers: { cookie: cookieHeader(oldSecret) } })).status,
    ).toBe(401);
    expect(
      (await app.request("/api/state", { headers: { cookie: cookieHeader(rotated) } })).status,
    ).toBe(200);
  });

  it("leaves a young cookie alone", async () => {
    const { app, viewer } = setup();
    const secret = await sessionOf(app, viewer.token);
    const res = await app.request("/api/state", { headers: { cookie: cookieHeader(secret) } });

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

const postLogout = (app: App, headers: Record<string, string>) =>
  app.request("/api/session/logout", { method: "POST", headers });

describe("POST /api/session/logout cross-site guard", () => {
  it("refuses a foreign Origin without revoking the session", async () => {
    const { app, db, viewer } = setup();
    const { secret } = sessionCookie(await postSession(app, viewer.token));

    const res = await postLogout(app, { cookie: cookieHeader(secret), origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()) as object).toEqual({ error: "forbidden" });
    expect(sessionRows(db)[0].revoked_at).toBeNull();
  });

  it("accepts its own Origin, a same-site fetch, and a client that sends neither", async () => {
    const { app, viewer } = setup();
    const trusted: Record<string, string>[] = [
      { origin: "http://localhost" },
      { "sec-fetch-site": "same-origin" },
      {},
    ];
    for (const headers of trusted) {
      const { secret } = sessionCookie(await postSession(app, viewer.token));
      const res = await postLogout(app, { cookie: cookieHeader(secret), ...headers });
      expect(res.status).toBe(204);
    }
  });

  it("refuses a cross-site fetch without an Origin", async () => {
    const { app, db, viewer } = setup();
    const { secret } = sessionCookie(await postSession(app, viewer.token));

    const res = await postLogout(app, { cookie: cookieHeader(secret), "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(sessionRows(db)[0].revoked_at).toBeNull();
  });
});
