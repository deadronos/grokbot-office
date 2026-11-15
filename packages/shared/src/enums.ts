import { z } from "zod";

export const BOT_STATUSES = ["idle", "working", "waiting", "reviewing", "offline"] as const;
export const botStatusSchema = z.enum(BOT_STATUSES);
export type BotStatus = z.infer<typeof botStatusSchema>;

/** Client-submittable event types; the server-only ones are never accepted from a bot. */
export const CLIENT_EVENT_TYPES = [
  "status_changed",
  "task_started",
  "task_finished",
  "handoff_sent",
  "handoff_accepted",
] as const;

export const SERVER_EVENT_TYPES = ["offline", "bot_registered", "bot_hidden"] as const;

export const EVENT_TYPES = [...CLIENT_EVENT_TYPES, ...SERVER_EVENT_TYPES] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export const clientEventTypeSchema = z.enum(CLIENT_EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;
export type ClientEventType = z.infer<typeof clientEventTypeSchema>;

export const TASK_RESULTS = ["done", "failed", "cancelled"] as const;
export const taskResultSchema = z.enum(TASK_RESULTS);
export type TaskResult = z.infer<typeof taskResultSchema>;

export const PODS = ["command", "dev", "ops"] as const;
export const podSchema = z.enum(PODS);
export type Pod = z.infer<typeof podSchema>;

/** Token kinds; `admin` is env-only (`ADMIN_TOKEN`) and is never issued or stored. */
export const TOKEN_KINDS = ["admin", "bot", "viewer"] as const;
export const tokenKindSchema = z.enum(TOKEN_KINDS);
export type TokenKind = z.infer<typeof tokenKindSchema>;

export const HANDOFF_STATES = ["sent", "accepted", "cancelled"] as const;
export const handoffStateSchema = z.enum(HANDOFF_STATES);
export type HandoffState = z.infer<typeof handoffStateSchema>;
