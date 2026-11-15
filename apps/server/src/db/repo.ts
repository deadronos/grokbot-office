import type Database from "better-sqlite3";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { EventIn } from "@grokbot-office/shared";

import { toUtc } from "../time.ts";
import { botStatus, bots, events, handoffs, tokens } from "./schema.ts";

export type Bot = typeof bots.$inferSelect;
type BotPatch = Partial<Omit<Bot, "id" | "createdAt">>;
export type Status = typeof botStatus.$inferSelect;
export type Event = typeof events.$inferSelect;
type NewEvent = typeof events.$inferInsert;
export type Handoff = typeof handoffs.$inferSelect;
export type Token = typeof tokens.$inferSelect;

/** One consistent read of everything the viewer snapshot needs. */
export interface SnapshotRows {
  bots: Bot[];
  statuses: Status[];
  openHandoffs: Handoff[];
  lastEventSeq: number;
}

export type ApplyEventsResult = { accepted: number; duplicates: number; lastSeq: number };

/** The client `at` is display-only: anything further away than this is clamped to it. */
export const CLIENT_AT_SKEW_MS = 10 * 60 * 1000;

/** A rule violation in one event; the route turns `index` into a 422 and the batch rolls back. */
export class InvalidEventError extends Error {
  readonly index: number;

  constructor(index: number, reason: string) {
    super(`event ${index}: ${reason}`);
    this.name = "InvalidEventError";
    this.index = index;
  }
}

/** Statuses that end any task or handoff the bot was tied to. */
const RESTING_STATUSES: readonly Status["status"][] = ["idle", "offline"];
/** States derived from task/handoff events; a heartbeat may only override them with `offline`. */
const DERIVED_STATUSES: readonly Status["status"][] = ["working", "waiting"];

/** Fields cleared whenever a bot comes to rest, so an idle bot never holds a task. */
const RELEASED_LINKS = { taskId: null, label: null, handoffTo: null, handoffId: null } as const;

/**
 * The status a heartbeat leaves behind. A heartbeat is a keep-alive, not a task event:
 * it cannot end derived `working`/`waiting` (only events or `offline` can), and moving
 * to `idle`/`offline` releases the task and handoff links.
 */
export function heartbeatPatch(
  current: Pick<Status, "status"> | undefined,
  status: Status["status"] | undefined,
): Partial<Status> | undefined {
  if (status === undefined || status === current?.status) return undefined;
  if (current && DERIVED_STATUSES.includes(current.status) && status !== "offline") {
    return undefined;
  }
  return RESTING_STATUSES.includes(status) ? { status, ...RELEASED_LINKS } : { status };
}

function clampClientAt(at: string | undefined, now: string): string | null {
  if (at === undefined) return null;
  const received = Date.parse(now);
  const clampedAt = Math.min(
    Math.max(Date.parse(at), received - CLIENT_AT_SKEW_MS),
    received + CLIENT_AT_SKEW_MS,
  );
  return toUtc(new Date(clampedAt));
}

export interface Repo {
  upsertBot(bot: Bot): void;
  /** Upserts the bot-owned profile fields and refreshes the heartbeat; one transaction. */
  registerBot(bot: Pick<Bot, "id" | "name" | "role" | "avatar" | "pod">, now: string): void;
  /**
   * Refreshes the heartbeat and applies its status per `heartbeatPatch` (it cannot end
   * derived working/waiting except with `offline`); `since` resets only on a change.
   */
  touchHeartbeat(botId: string, status: Status["status"] | undefined, now: string): void;
  getBot(id: string): Bot | undefined;
  listBots(): Bot[];
  updateBot(id: string, patch: BotPatch): Bot | undefined;
  getBotStatus(botId: string): Status | undefined;
  setBotStatus(status: Status): void;
  insertEvent(event: NewEvent): { duplicate: boolean; seq: number };
  listEventsSince(seq: number): Event[];
  /** Up to `limit + 1` events after `seq`, ascending; the extra row tells `hasMore`. */
  listEventsPage(seq: number, limit: number): Event[];
  /** Highest `events.seq`, or 0 when no event was recorded yet. */
  getLastEventSeq(): number;
  /** Bots, statuses, open handoffs and the event high-water mark in one transaction. */
  getSnapshot(): SnapshotRows;
  /**
   * Applies a validated batch in one transaction: dedupe, event rows, `bot_status`
   * derivation and handoffs. The first duplicate is skipped with its side effects;
   * `InvalidEventError` rolls the whole batch back.
   */
  applyEvents(botId: string, inputs: EventIn[], now: string): ApplyEventsResult;
  createHandoff(handoff: Handoff): void;
  getHandoff(id: string): Handoff | undefined;
  updateHandoffState(id: string, state: Handoff["state"], acceptedAt: string | null): void;
  insertToken(token: Token): void;
  findTokenByHash(hash: string): Token | undefined;
  getToken(id: string): Token | undefined;
  listTokens(): Token[];
  touchToken(id: string, lastUsedAt: string): void;
  revokeToken(id: string, revokedAt: string): void;
}

export function createSqliteRepo(sqlite: Database.Database): Repo {
  const db = drizzle(sqlite);
  return {
    upsertBot: (bot) => {
      db.insert(bots).values(bot).onConflictDoUpdate({ target: bots.id, set: bot }).run();
    },
    registerBot: (bot, now) => {
      db.transaction((tx) => {
        // Admin-owned fields (desk_index, hidden) and created_at survive a re-register.
        tx.insert(bots)
          .values({ ...bot, deskIndex: null, hidden: false, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: bots.id,
            set: {
              name: bot.name,
              role: bot.role,
              avatar: bot.avatar,
              pod: bot.pod,
              updatedAt: now,
            },
          })
          .run();
        // Registering counts as a heartbeat but never resets the current status.
        tx.insert(botStatus)
          .values({ botId: bot.id, status: "idle", since: now, lastHeartbeatAt: now })
          .onConflictDoUpdate({ target: botStatus.botId, set: { lastHeartbeatAt: now } })
          .run();
      });
    },
    touchHeartbeat: (botId, status, now) => {
      db.transaction((tx) => {
        const existing = tx
          .select({ status: botStatus.status })
          .from(botStatus)
          .where(eq(botStatus.botId, botId))
          .get();
        const patch = heartbeatPatch(existing, status);
        if (!existing) {
          tx.insert(botStatus)
            .values({ botId, status: status ?? "idle", since: now, lastHeartbeatAt: now })
            .run();
        } else if (patch) {
          tx.update(botStatus)
            .set({ ...patch, since: now, lastHeartbeatAt: now })
            .where(eq(botStatus.botId, botId))
            .run();
        } else {
          tx.update(botStatus)
            .set({ lastHeartbeatAt: now })
            .where(eq(botStatus.botId, botId))
            .run();
        }
      });
    },
    getBot: (id) => db.select().from(bots).where(eq(bots.id, id)).get(),
    listBots: () => db.select().from(bots).all(),
    updateBot: (id, patch) => db.update(bots).set(patch).where(eq(bots.id, id)).returning().get(),
    getBotStatus: (id) => db.select().from(botStatus).where(eq(botStatus.botId, id)).get(),
    setBotStatus: (status) => {
      db.insert(botStatus)
        .values(status)
        .onConflictDoUpdate({ target: botStatus.botId, set: status })
        .run();
    },
    insertEvent: (event) => {
      const inserted = db
        .insert(events)
        .values(event)
        .onConflictDoNothing({ target: [events.botId, events.eventId] })
        .returning({ seq: events.seq })
        .get();
      if (inserted) return { duplicate: false, seq: inserted.seq };
      const existing = db
        .select({ seq: events.seq })
        .from(events)
        .where(and(eq(events.botId, event.botId), eq(events.eventId, event.eventId)))
        .get();
      if (!existing) throw new Error("Event conflict without an existing event");
      return { duplicate: true, seq: existing.seq };
    },
    listEventsSince: (seq) =>
      db.select().from(events).where(gt(events.seq, seq)).orderBy(events.seq).all(),
    listEventsPage: (seq, limit) =>
      db
        .select()
        .from(events)
        .where(gt(events.seq, seq))
        .orderBy(events.seq)
        .limit(limit + 1)
        .all(),
    getLastEventSeq: () =>
      db.select({ seq: events.seq }).from(events).orderBy(desc(events.seq)).limit(1).get()?.seq ??
      0,
    getSnapshot: () =>
      db.transaction((tx) => ({
        bots: tx
          .select()
          .from(bots)
          .where(eq(bots.hidden, false))
          .orderBy(bots.deskIndex, bots.id)
          .all(),
        statuses: tx.select().from(botStatus).all(),
        openHandoffs: tx
          .select()
          .from(handoffs)
          .where(eq(handoffs.state, "sent"))
          .orderBy(handoffs.sentAt, handoffs.id)
          .all(),
        lastEventSeq:
          tx.select({ seq: events.seq }).from(events).orderBy(desc(events.seq)).limit(1).get()
            ?.seq ?? 0,
      })),
    applyEvents: (botId, inputs, now) =>
      db.transaction((tx) => {
        // A bot always has a row after registration; a token can be older than that.
        tx.insert(botStatus)
          .values({ botId, status: "idle", since: now, lastHeartbeatAt: now })
          .onConflictDoNothing()
          .run();
        let status: Status = tx
          .select()
          .from(botStatus)
          .where(eq(botStatus.botId, botId))
          .get() as Status;

        // `since` only moves when the status itself moves.
        // Coming to rest (idle/offline) always releases task and handoff links;
        // an explicit label in the same patch (status_changed) still applies.
        const change = (patch: Partial<Status>) => {
          const next = patch.status ?? status.status;
          const released = RESTING_STATUSES.includes(next) ? RELEASED_LINKS : {};
          status = {
            ...status,
            ...released,
            ...patch,
            status: next,
            since: next === status.status ? status.since : now,
          };
        };

        let accepted = 0;
        let duplicates = 0;

        for (const [index, input] of inputs.entries()) {
          const seen = tx
            .select({ seq: events.seq })
            .from(events)
            .where(and(eq(events.botId, botId), eq(events.eventId, input.eventId)))
            .get();
          // A duplicate is accepted silently but changes nothing.
          if (seen) {
            duplicates++;
            continue;
          }

          switch (input.type) {
            case "status_changed":
              change({ status: input.status, label: input.label ?? null });
              break;
            case "task_started":
              change({
                status: "working",
                taskId: input.taskId ?? null,
                label: input.label ?? null,
              });
              break;
            case "task_finished": {
              // The result lives on the event only. Finishing a task the bot is not on
              // (both ids known and different) is recorded but leaves the current work alone.
              const otherTask =
                input.taskId !== undefined &&
                status.taskId !== null &&
                input.taskId !== status.taskId;
              if (!otherTask) change({ status: "idle" });
              break;
            }
            case "handoff_sent": {
              if (input.to === botId) throw new InvalidEventError(index, "handoff to self");
              const target = tx
                .select({ id: bots.id })
                .from(bots)
                .where(eq(bots.id, input.to))
                .get();
              if (!target) throw new InvalidEventError(index, "unknown handoff target");
              const taken = tx
                .select({ id: handoffs.id })
                .from(handoffs)
                .where(eq(handoffs.id, input.handoffId))
                .get();
              if (taken) throw new InvalidEventError(index, "duplicate handoff id");
              tx.insert(handoffs)
                .values({
                  id: input.handoffId,
                  fromBotId: botId,
                  toBotId: input.to,
                  label: input.label ?? null,
                  state: "sent",
                  sentAt: now,
                  acceptedAt: null,
                })
                .run();
              // Another open task keeps the sender working; handing off its own task waits.
              const otherTask = status.taskId !== null && status.taskId !== (input.taskId ?? null);
              if (!otherTask) {
                change({
                  status: "waiting",
                  taskId: null,
                  handoffTo: input.to,
                  handoffId: input.handoffId,
                  label: input.label ?? null,
                });
              }
              break;
            }
            case "handoff_accepted": {
              const handoff = tx
                .select()
                .from(handoffs)
                .where(eq(handoffs.id, input.handoffId))
                .get();
              if (!handoff || handoff.toBotId !== botId) {
                throw new InvalidEventError(index, "handoff not addressed to this bot");
              }
              // Accepting twice is not an error, it just changes nothing.
              if (handoff.state === "sent") {
                tx.update(handoffs)
                  .set({ state: "accepted", acceptedAt: now })
                  .where(eq(handoffs.id, handoff.id))
                  .run();
                change({
                  status: "working",
                  // The receiver now works on the handed-off task, not whatever it had before.
                  taskId: input.taskId ?? null,
                  label: handoff.label ?? input.label ?? null,
                  handoffTo: null,
                  handoffId: null,
                });
                const sender = tx
                  .select()
                  .from(botStatus)
                  .where(eq(botStatus.botId, handoff.fromBotId))
                  .get();
                // Only the handoff the sender is waiting on releases it; accepting a
                // side handoff to the same receiver leaves it waiting.
                if (sender && sender.status === "waiting" && sender.handoffId === handoff.id) {
                  tx.update(botStatus)
                    .set({ status: "idle", since: now, ...RELEASED_LINKS })
                    .where(eq(botStatus.botId, sender.botId))
                    .run();
                }
              } else if (handoff.state !== "accepted") {
                throw new InvalidEventError(index, "handoff is not sent");
              }
              break;
            }
          }

          tx.insert(events)
            .values({
              eventId: input.eventId,
              botId,
              type: input.type,
              status: input.type === "status_changed" ? input.status : null,
              label: input.label ?? null,
              ref: input.ref ?? null,
              taskId: input.taskId ?? null,
              handoffId: "handoffId" in input ? input.handoffId : null,
              toBotId: "to" in input ? input.to : null,
              result: input.type === "task_finished" ? input.result : null,
              clientAt: clampClientAt(input.at, now),
              receivedAt: now,
            })
            .run();
          accepted++;
        }

        const lastSeq = tx
          .select({ seq: events.seq })
          .from(events)
          .where(eq(events.botId, botId))
          .orderBy(desc(events.seq))
          .limit(1)
          .get()?.seq;
        tx.update(botStatus)
          .set({
            status: status.status,
            label: status.label,
            taskId: status.taskId,
            handoffTo: status.handoffTo,
            handoffId: status.handoffId,
            since: status.since,
            // Any batch counts as a heartbeat, even one that was entirely duplicates.
            lastHeartbeatAt: now,
            lastEventSeq: lastSeq ?? null,
          })
          .where(eq(botStatus.botId, botId))
          .run();

        return {
          accepted,
          duplicates,
          lastSeq:
            tx.select({ seq: events.seq }).from(events).orderBy(desc(events.seq)).limit(1).get()
              ?.seq ?? 0,
        };
      }),
    createHandoff: (handoff) => {
      db.insert(handoffs).values(handoff).run();
    },
    getHandoff: (id) => db.select().from(handoffs).where(eq(handoffs.id, id)).get(),
    updateHandoffState: (id, state, acceptedAt) => {
      db.update(handoffs).set({ state, acceptedAt }).where(eq(handoffs.id, id)).run();
    },
    insertToken: (token) => {
      db.insert(tokens).values(token).run();
    },
    findTokenByHash: (hash) => db.select().from(tokens).where(eq(tokens.hash, hash)).get(),
    getToken: (id) => db.select().from(tokens).where(eq(tokens.id, id)).get(),
    listTokens: () => db.select().from(tokens).orderBy(tokens.createdAt, tokens.id).all(),
    touchToken: (id, lastUsedAt) => {
      db.update(tokens).set({ lastUsedAt }).where(eq(tokens.id, id)).run();
    },
    revokeToken: (id, revokedAt) => {
      // Revocation is idempotent: keep the first timestamp.
      db.update(tokens)
        .set({ revokedAt })
        .where(and(eq(tokens.id, id), isNull(tokens.revokedAt)))
        .run();
    },
  };
}
