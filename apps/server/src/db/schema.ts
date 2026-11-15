import {
  BOT_STATUSES,
  EVENT_TYPES,
  HANDOFF_STATES,
  PODS,
  TASK_RESULTS,
  TOKEN_KINDS,
} from "@grokbot-office/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * `col in ('a', 'b')`, written out as SQL text so drizzle-kit can put it in a
 * migration. Values come from the shared enum arrays, so a new enum member
 * changes the CHECK with it; `nullable` allows NULL (e.g. `events.result`).
 */
function enumCheck(name: string, column: string, values: readonly string[], nullable = false) {
  const list = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
  const body = `\`${column}\` in (${list})`;
  return check(name, sql.raw(nullable ? `\`${column}\` is null or ${body}` : body));
}

export const bots = sqliteTable(
  "bots",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    avatar: text("avatar").notNull(),
    pod: text("pod", { enum: PODS }).notNull(),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  () => [enumCheck("bots_pod_check", "pod", PODS)],
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
  (t) => [
    index("handoffs_to_bot_id_state_idx").on(t.toBotId, t.state),
    enumCheck("handoffs_state_check", "state", HANDOFF_STATES),
  ],
);

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
    // The handoff a `waiting` bot is waiting on; only its acceptance releases the bot.
    handoffId: text("handoff_id").references(() => handoffs.id),
    since: text("since").notNull(),
    lastHeartbeatAt: text("last_heartbeat_at").notNull(),
    lastEventSeq: integer("last_event_seq"),
  },
  (t) => [
    index("bot_status_last_heartbeat_at_idx").on(t.lastHeartbeatAt),
    enumCheck("bot_status_status_check", "status", BOT_STATUSES),
  ],
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
    // Kept so a `status_changed` event can be replayed over SSE (#8).
    status: text("status", { enum: BOT_STATUSES }),
    label: text("label"),
    ref: text("ref"),
    taskId: text("task_id"),
    handoffId: text("handoff_id").references(() => handoffs.id),
    toBotId: text("to_bot_id").references(() => bots.id),
    result: text("result", { enum: TASK_RESULTS }),
    clientAt: text("client_at"),
    receivedAt: text("received_at").notNull(),
  },
  (t) => [
    uniqueIndex("events_bot_id_event_id_unique").on(t.botId, t.eventId),
    index("events_received_at_idx").on(t.receivedAt),
    index("events_bot_id_seq_idx").on(t.botId, t.seq),
    enumCheck("events_type_check", "type", EVENT_TYPES),
    enumCheck("events_status_check", "status", BOT_STATUSES, true),
    enumCheck("events_result_check", "result", TASK_RESULTS, true),
  ],
);

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: TOKEN_KINDS }).notNull(),
    botId: text("bot_id").references(() => bots.id),
    prefix: text("prefix").notNull(),
    hash: text("hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("tokens_hash_unique").on(t.hash),
    index("tokens_bot_id_idx").on(t.botId),
    enumCheck("tokens_kind_check", "kind", TOKEN_KINDS),
  ],
);

/**
 * Viewer sessions: the cookie carries a random secret, the row keeps only its hash,
 * so a database leak does not hand out live sessions. Sessions belong to a viewer
 * token; revoking the token kills them too (checked at request time).
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.id),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_unique").on(t.tokenHash),
    index("sessions_token_id_idx").on(t.tokenId),
  ],
);
