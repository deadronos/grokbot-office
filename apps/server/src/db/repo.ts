import type Database from "better-sqlite3";
import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { botStatus, bots, events, handoffs, tokens } from "./schema.ts";

type Bot = typeof bots.$inferSelect;
type Status = typeof botStatus.$inferSelect;
type Event = typeof events.$inferSelect;
type NewEvent = typeof events.$inferInsert;
type Handoff = typeof handoffs.$inferSelect;
type Token = typeof tokens.$inferSelect;

export interface Repo {
  upsertBot(bot: Bot): void;
  getBot(id: string): Bot | undefined;
  listBots(): Bot[];
  getBotStatus(botId: string): Status | undefined;
  setBotStatus(status: Status): void;
  insertEvent(event: NewEvent): { duplicate: boolean; seq: number };
  listEventsSince(seq: number): Event[];
  createHandoff(handoff: Handoff): void;
  getHandoff(id: string): Handoff | undefined;
  updateHandoffState(id: string, state: Handoff["state"], acceptedAt: string | null): void;
  insertToken(token: Token): void;
  findTokenByHash(hash: string): Token | undefined;
  revokeToken(id: string, revokedAt: string): void;
}

export function createSqliteRepo(sqlite: Database.Database): Repo {
  const db = drizzle(sqlite);
  return {
    upsertBot: (bot) => {
      db.insert(bots).values(bot).onConflictDoUpdate({ target: bots.id, set: bot }).run();
    },
    getBot: (id) => db.select().from(bots).where(eq(bots.id, id)).get(),
    listBots: () => db.select().from(bots).all(),
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
    revokeToken: (id, revokedAt) => {
      db.update(tokens).set({ revokedAt }).where(eq(tokens.id, id)).run();
    },
  };
}
