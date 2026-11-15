import { afterEach, describe, expect, it } from "vitest";

import { StreamEvent } from "@grokbot-office/shared";

import { issueToken } from "../auth/tokens.ts";
import { NOW, Sse, botRecord, testSetup } from "../test-utils.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

type App = ReturnType<typeof testSetup>["app"];
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const ulid = (n: number) => `01J${String(n).padStart(23, "0")}`;

/** Every string that comes from the hidden side of the handoff. */
const SECRETS = ["h-secret", "classified", "ghost"];

/** Hidden `ghost` hands `h-secret` labelled `classified` to visible `data`. */
function setup() {
  const context = testSetup();
  cleanups.push(context.close);
  context.repo.upsertBot(botRecord("data"));
  context.repo.upsertBot({ ...botRecord("ghost"), hidden: true });
  context.repo.applyEvents(
    "ghost",
    [
      {
        botId: "ghost",
        eventId: ulid(1),
        type: "handoff_sent",
        to: "data",
        handoffId: "h-secret",
        label: "classified",
      },
    ] as never,
    NOW,
  );
  return {
    ...context,
    dataToken: issueToken(context.repo, { kind: "bot", botId: "data" }).token,
    viewerToken: issueToken(context.repo, { kind: "viewer" }).token,
  };
}

const accept = (app: App, token: string, label?: string) =>
  app.request("/api/events", {
    method: "POST",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify({
      events: [
        {
          botId: "data",
          eventId: ulid(2),
          type: "handoff_accepted",
          handoffId: "h-secret",
          ...(label === undefined ? {} : { label }),
        },
      ],
    }),
  });

const replay = (app: App, token: string) =>
  app.request("/api/events?since=0", { headers: auth(token) });

type ReplayBody = { events: { type: string; handoffId?: string; label?: string }[] };

describe("handoff_accepted label", () => {
  it("uses the receiver's own label, never the hidden sender's", async () => {
    const { app, repo, dataToken } = setup();
    expect((await accept(app, dataToken, "mine")).status).toBe(200);
    expect(repo.getBotStatus("data")?.label).toBe("mine");

    // Status is current state: un-hiding the sender does not restore its label.
    repo.updateBot("ghost", { hidden: false });
    expect(repo.getBotStatus("data")?.label).toBe("mine");
  });

  it("leaves no label at all when the receiver sends none", async () => {
    const { app, repo, dataToken } = setup();
    expect((await accept(app, dataToken)).status).toBe(200);
    expect(repo.getBotStatus("data")?.label).toBeNull();

    repo.updateBot("ghost", { hidden: false });
    expect(repo.getBotStatus("data")?.label).toBeNull();
  });
});

describe("hidden handoff scrub", () => {
  it("omits the handoffId from the replay and restores it after un-hiding", async () => {
    const { app, repo, dataToken, viewerToken } = setup();
    await accept(app, dataToken, "mine");

    const raw = await (await replay(app, viewerToken)).text();
    for (const secret of SECRETS) expect(raw).not.toContain(secret);
    const body = JSON.parse(raw) as ReplayBody;
    const accepted = body.events.find((event) => event.type === "handoff_accepted");
    expect(accepted).toBeDefined();
    expect(accepted?.handoffId).toBeUndefined();
    expect(accepted?.label).toBe("mine");

    // Read time: the stored row still names the handoff, so un-hiding shows it again.
    repo.updateBot("ghost", { hidden: false });
    const restored = (await (await replay(app, viewerToken)).json()) as ReplayBody;
    expect(restored.events.find((event) => event.type === "handoff_accepted")?.handoffId).toBe(
      "h-secret",
    );
  });

  it("keeps every hidden string out of the snapshot", async () => {
    const { app, dataToken, viewerToken } = setup();
    await accept(app, dataToken, "mine");

    const res = await app.request("/api/state", { headers: auth(viewerToken) });
    const raw = await res.text();
    for (const secret of SECRETS) expect(raw).not.toContain(secret);
    const body = JSON.parse(raw) as {
      bots: { id: string; label?: string }[];
      openHandoffs: unknown[];
    };
    expect(body.bots.find((bot) => bot.id === "data")?.label).toBe("mine");
    expect(body.openHandoffs).toEqual([]);
  });

  it("streams the accept frame without the hidden handoffId", async () => {
    const { app, dataToken, viewerToken } = setup();
    const sse = new Sse(await app.request("/api/stream", { headers: auth(viewerToken) }));

    await accept(app, dataToken, "mine");
    const frame = await sse.next();
    expect(frame.event).toBe("event");
    for (const secret of SECRETS) expect(frame.data).not.toContain(secret);
    const event = StreamEvent.parse(JSON.parse(frame.data));
    expect(event.type).toBe("handoff_accepted");
    expect(event.handoffId).toBeUndefined();
    expect(event.label).toBe("mine");
    await sse.cancel();
  });
});
