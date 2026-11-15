import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

import type { EventIn } from "@grokbot-office/shared";

import { toUtc } from "../time.ts";
import { botStatus, bots, events, handoffs, sessions, tokens } from "./schema.ts";

export type Bot = typeof bots.$inferSelect;
type BotPatch = Partial<Omit<Bot, "id" | "createdAt">>;
export type Status = typeof botStatus.$inferSelect;
export type Event = typeof events.$inferSelect;
type NewEvent = typeof events.$inferInsert;
export type Handoff = typeof handoffs.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type Session = typeof sessions.$inferSelect;

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
const RELEASED_LINKS = {
  taskId: null,
  label: null,
  labelHandoffId: null,
  handoffTo: null,
  handoffId: null,
} as const;

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
  /**
   * Viewer page, one read transaction: up to `limit + 1` visible events after `seq`,
   * ascending (the extra row tells `hasMore`), plus the global `events.seq`
   * high-water mark (0 when empty). Events of hidden bots, as sender or as handoff
   * target, are skipped.
   */
  getEventsPage(seq: number, limit: number): { rows: Event[]; lastSeq: number };
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
  insertSession(session: Session): void;
  findSessionByHash(hash: string): Session | undefined;
  /** Revocation is idempotent: the first timestamp wins. */
  revokeSession(id: string, revokedAt: string): void;
  /** Lazy cleanup: drops sessions that expired before `before`. */
  deleteExpiredSessions(before: string): void;
  /** Highest `events.seq`, hidden bots included; 0 when empty. */
  lastEventSeq(): number;
  /**
   * Takes every bot whose heartbeat is older than `cutoff` offline in one transaction:
   * `RELEASED_LINKS`, `since` = now, one `offline` event each, `lastHeartbeatAt` kept.
   * Already-offline bots are left alone. Returns how many bots were swept (events added).
   */
  sweepStaleBots(cutoff: string, now: string): number;
  /**
   * Drops events older than `cutoff`, then closed handoffs aged past it that nothing
   * still refers to (events first, then `bot_status`). Returns what was removed.
   */
  pruneRetention(cutoff: string): { events: number; handoffs: number };
}

export function createSqliteRepo(sqlite: Database.Database): Repo {
  const db = drizzle(sqlite);
  /** `db` or a transaction: both read the same way. */
  type Reader = Pick<typeof db, "select">;
  /** Highest `events.seq` (0 when empty): a global mark, hidden bots' events included. */
  const lastEventSeq = (reader: Reader): number =>
    reader.select({ seq: events.seq }).from(events).orderBy(desc(events.seq)).limit(1).get()?.seq ??
    0;
  /**
   * Read-time label scrub: a label taken from a handoff whose sender is hidden *now* is
   * replaced by the receiver's own accept label (or none). Hidden before or after the
   * accept, same result, and un-hiding the sender restores the label.
   */
  const scrubHiddenLabels = (reader: Reader, statuses: Status[]): Status[] => {
    const sourced = [
      ...new Set(statuses.flatMap((s) => (s.labelHandoffId === null ? [] : [s.labelHandoffId]))),
    ];
    if (sourced.length === 0) return statuses;
    const hidden = new Set(
      reader
        .select({ id: handoffs.id })
        .from(handoffs)
        .where(
          and(inArray(handoffs.id, sourced), inArray(handoffs.fromBotId, hiddenBotIds(reader))),
        )
        .all()
        .map((row) => row.id),
    );
    // One lookup for every scrubbed bot instead of one accept lookup per bot.
    const targets = statuses.filter(
      (s) => s.labelHandoffId !== null && hidden.has(s.labelHandoffId),
    );
    const ownLabels = new Map<string, string | null>();
    if (targets.length > 0) {
      for (const row of reader
        .select({ botId: events.botId, handoffId: events.handoffId, label: events.label })
        .from(events)
        .where(
          and(
            inArray(events.botId, [...new Set(targets.map((s) => s.botId))]),
            eq(events.type, "handoff_accepted"),
            inArray(events.handoffId, [...new Set(targets.map((s) => s.labelHandoffId as string))]),
          ),
        )
        .orderBy(asc(events.seq))
        .all()) {
        const key = `${row.botId}\u0000${row.handoffId}`;
        if (!ownLabels.has(key)) ownLabels.set(key, row.label);
      }
    }
    return statuses.map((s) => {
      if (s.labelHandoffId === null || !hidden.has(s.labelHandoffId)) return s;
      // One lookup covers every scrubbed bot: earliest accept label per (bot, handoff).
      const key = `${s.botId}\u0000${s.labelHandoffId}`;
      return { ...s, label: ownLabels.get(key) ?? null };
    });
  };
  /** Subquery of hidden bot ids, read live: un-hiding a bot shows its history again. */
  const hiddenBotIds = (reader: Reader) =>
    reader.select({ id: bots.id }).from(bots).where(eq(bots.hidden, true));
  return {
    upsertBot: (bot) => {
      db.insert(bots).values(bot).onConflictDoUpdate({ target: bots.id, set: bot }).run();
    },
    registerBot: (bot, now) => {
      db.transaction((tx) => {
        // The admin-owned `hidden` flag and created_at survive a re-register.
        tx.insert(bots)
          .values({ ...bot, hidden: false, createdAt: now, updatedAt: now })
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
    getEventsPage: (seq, limit) =>
      db.transaction((tx) => {
        const hiddenIds = hiddenBotIds(tx);
        const rows = tx
          .select()
          .from(events)
          .where(
            and(
              gt(events.seq, seq),
              notInArray(events.botId, hiddenIds),
              or(isNull(events.toBotId), notInArray(events.toBotId, hiddenIds)),
            ),
          )
          .orderBy(events.seq)
          .limit(limit + 1)
          .all();
        // A handoff id names the hidden sender's handoff, so scrub it at read time:
        // un-hiding the sender brings it back, and the stored row stays untouched.
        const pageHandoffIds = [
          ...new Set(rows.flatMap((row) => (row.handoffId === null ? [] : [row.handoffId]))),
        ];
        const hiddenHandoffIds = new Set(
          pageHandoffIds.length === 0
            ? []
            : tx
                .select({ id: handoffs.id })
                .from(handoffs)
                .where(
                  and(inArray(handoffs.id, pageHandoffIds), inArray(handoffs.fromBotId, hiddenIds)),
                )
                .all()
                .map((handoff) => handoff.id),
        );
        return {
          rows: rows.map((row) =>
            row.handoffId !== null && hiddenHandoffIds.has(row.handoffId)
              ? { ...row, handoffId: null }
              : row,
          ),
          lastSeq: lastEventSeq(tx),
        };
      }),
    getSnapshot: () =>
      db.transaction((tx) => ({
        bots: tx
          .select()
          .from(bots)
          .where(eq(bots.hidden, false))
          // Layout order is applied by the route; the DB only gives a stable base order.
          .orderBy(asc(bots.id))
          .all(),
        statuses: scrubHiddenLabels(tx, tx.select().from(botStatus).all()),
        // A handoff from or to a hidden bot stays out, like the bot itself.
        openHandoffs: tx
          .select()
          .from(handoffs)
          .where(
            and(
              eq(handoffs.state, "sent"),
              notInArray(handoffs.fromBotId, hiddenBotIds(tx)),
              notInArray(handoffs.toBotId, hiddenBotIds(tx)),
            ),
          )
          .orderBy(handoffs.sentAt, handoffs.id)
          .all(),
        lastEventSeq: lastEventSeq(tx),
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
          // A new label has a new source: only an accept names a handoff for it.
          const source =
            "label" in patch && !("labelHandoffId" in patch) ? { labelHandoffId: null } : {};
          status = {
            ...status,
            ...released,
            ...source,
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
                  // Remember where the label came from: while the sender is hidden, viewers
                  // see the accept event's own label instead (read time, see getSnapshot).
                  labelHandoffId: handoff.label === null ? null : handoff.id,
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
            labelHandoffId: status.labelHandoffId,
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
    insertSession: (session) => {
      db.insert(sessions).values(session).run();
    },
    findSessionByHash: (hash) =>
      db.select().from(sessions).where(eq(sessions.tokenHash, hash)).get(),
    revokeSession: (id, revokedAt) => {
      // `expires_at` is the stored ISO text, so time order is text order.
      db.update(sessions)
        .set({ revokedAt })
        .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)))
        .run();
    },
    deleteExpiredSessions: (before) => {
      db.delete(sessions).where(lt(sessions.expiresAt, before)).run();
    },
    lastEventSeq: () => lastEventSeq(db),
    sweepStaleBots: (cutoff, now) =>
      db.transaction((tx) => {
        const stale = tx
          .select({ botId: botStatus.botId })
          .from(botStatus)
          .where(and(lt(botStatus.lastHeartbeatAt, cutoff), ne(botStatus.status, "offline")))
          .all();
        for (const { botId } of stale) {
          const inserted = tx
            .insert(events)
            .values({
              eventId: randomUUID(),
              botId,
              type: "offline",
              status: "offline",
              receivedAt: now,
            })
            .returning({ seq: events.seq })
            .get();
          tx.update(botStatus)
            .set({
              status: "offline",
              ...RELEASED_LINKS,
              since: now,
              lastEventSeq: inserted?.seq ?? null,
            })
            .where(eq(botStatus.botId, botId))
            .run();
        }
        return stale.length;
      }),
    pruneRetention: (cutoff) =>
      db.transaction((tx) => {
        const removedEvents = tx.delete(events).where(lt(events.receivedAt, cutoff)).run().changes;
        const aged = tx
          .select({ id: handoffs.id })
          .from(handoffs)
          .where(
            and(
              inArray(handoffs.state, ["accepted", "cancelled"]),
              // Age a closed handoff from its accept, else from when it was sent.
              lt(sql`coalesce(${handoffs.acceptedAt}, ${handoffs.sentAt})`, cutoff),
            ),
          )
          .all();
        let removedHandoffs = 0;
        for (const { id } of aged) {
          const referencedByEvent = tx
            .select({ seq: events.seq })
            .from(events)
            .where(eq(events.handoffId, id))
            .limit(1)
            .get();
          const referencedByStatus = tx
            .select({ botId: botStatus.botId })
            .from(botStatus)
            .where(or(eq(botStatus.handoffId, id), eq(botStatus.labelHandoffId, id)))
            .limit(1)
            .get();
          // A live bot's current links outrank the retention window.
          if (referencedByEvent || referencedByStatus) continue;
          tx.delete(handoffs).where(eq(handoffs.id, id)).run();
          removedHandoffs++;
        }
        return { events: removedEvents, handoffs: removedHandoffs };
      }),
  };
}
