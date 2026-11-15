import {
  BOT_STATUSES,
  EVENT_TYPES,
  HANDOFF_STATES,
  PODS,
  TASK_RESULTS,
} from "@grokbot-office/shared";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const bots = sqliteTable("bots", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  avatar: text("avatar").notNull(),
  pod: text("pod", { enum: PODS }).notNull(),
  deskIndex: integer("desk_index"),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
export const botStatus = sqliteTable(
  "bot_status",
  {
    botId: text("bot_id")
      .primaryKey()
      .references(() => bots.id),
    status: text("status", { enum: BOT_STATUSES }).notNull(),
    label: text("label"),
    taskId: text("task_id"),
    handoffTo: text("handoff_to").references(() => bots.id),
    since: text("since").notNull(),
    lastHeartbeatAt: text("last_heartbeat_at").notNull(),
    lastEventSeq: integer("last_event_seq"),
  },
  (t) => [index("bot_status_last_heartbeat_at_idx").on(t.lastHeartbeatAt)],
);
export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    botId: text("bot_id")
      .notNull()
      .references(() => bots.id),
    type: text("type", { enum: EVENT_TYPES }).notNull(),
    label: text("label"),
    ref: text("ref"),
    taskId: text("task_id"),
    handoffId: text("handoff_id"),
    toBotId: text("to_bot_id").references(() => bots.id),
    result: text("result", { enum: TASK_RESULTS }),
    clientAt: text("client_at"),
    receivedAt: text("received_at").notNull(),
  },
  (t) => [
    uniqueIndex("events_bot_id_event_id_unique").on(t.botId, t.eventId),
    index("events_received_at_idx").on(t.receivedAt),
    index("events_bot_id_seq_idx").on(t.botId, t.seq),
  ],
);
export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    fromBotId: text("from_bot_id")
      .notNull()
      .references(() => bots.id),
    toBotId: text("to_bot_id")
      .notNull()
      .references(() => bots.id),
    label: text("label"),
    state: text("state", { enum: HANDOFF_STATES }).notNull(),
    sentAt: text("sent_at").notNull(),
    acceptedAt: text("accepted_at"),
  },
  (t) => [index("handoffs_to_bot_id_state_idx").on(t.toBotId, t.state)],
);
export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["admin", "bot", "viewer"] }).notNull(),
    botId: text("bot_id").references(() => bots.id),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("tokens_hash_unique").on(t.hash), index("tokens_bot_id_idx").on(t.botId)],
);
