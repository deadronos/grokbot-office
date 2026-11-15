import { z } from "zod";

import {
  botStatusSchema,
  eventTypeSchema,
  handoffStateSchema,
  podSchema,
  taskResultSchema,
} from "./enums";
import { LABEL_MAX, REF_MAX, sanitizeText } from "./sanitize";

/** Lowercase slug, e.g. `data` or `wesley`. */
export const BotId = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "must be a lowercase slug");
export type BotId = z.infer<typeof BotId>;

// Crockford base32 (no I, L, O, U) ULID, or a canonical UUID.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EventId = z
  .string()
  .refine(
    (value) => ULID_PATTERN.test(value) || UUID_PATTERN.test(value),
    "must be a ULID or UUID",
  );
export type EventId = z.infer<typeof EventId>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Sanitizes, then length-checks the cleaned text. */
function sanitizedString(max: number) {
  return z
    .string()
    .transform(sanitizeText)
    .pipe(z.string().max(max, `must be at most ${max} characters`));
}

export const Label = sanitizedString(LABEL_MAX);
export type Label = z.infer<typeof Label>;

export const Ref = sanitizedString(REF_MAX);
export type Ref = z.infer<typeof Ref>;

export const TaskId = z.string().min(1).max(REF_MAX);
export type TaskId = z.infer<typeof TaskId>;

export const RegisterBody = z.object({
  id: BotId,
  name: sanitizedString(40),
  role: sanitizedString(60),
  avatar: sanitizedString(60),
  pod: podSchema,
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const HeartbeatBody = z.object({
  status: botStatusSchema.optional(),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;

const eventFields = {
  eventId: EventId,
  botId: BotId,
  at: IsoDateTime.optional(),
  label: Label.optional(),
  ref: Ref.optional(),
  taskId: TaskId.optional(),
};

const handoffId = z.string().min(1).max(REF_MAX);

/** A client-submitted event; server-only types are rejected. */
export const EventIn = z.discriminatedUnion("type", [
  z.object({ ...eventFields, type: z.literal("status_changed"), status: botStatusSchema }),
  z.object({ ...eventFields, type: z.literal("task_started") }),
  z.object({ ...eventFields, type: z.literal("task_finished"), result: taskResultSchema }),
  z.object({ ...eventFields, type: z.literal("handoff_sent"), to: BotId, handoffId }),
  z.object({ ...eventFields, type: z.literal("handoff_accepted"), handoffId }),
]);
export type EventIn = z.infer<typeof EventIn>;

export const EVENTS_BATCH_MIN = 1;
export const EVENTS_BATCH_MAX = 20;

export const EventsBatch = z.object({
  events: z
    .array(EventIn)
    .min(EVENTS_BATCH_MIN, `at least ${EVENTS_BATCH_MIN} event`)
    .max(EVENTS_BATCH_MAX, `at most ${EVENTS_BATCH_MAX} events`),
});
export type EventsBatch = z.infer<typeof EventsBatch>;

export const DeskSchema = z.object({
  botId: BotId,
  name: z.string().max(40),
  pod: podSchema,
  index: z.number().int().nonnegative(),
  x: z.number(),
  z: z.number(),
  facing: z.number(),
});
export type DeskSchema = z.infer<typeof DeskSchema>;

export const Handoff = z.object({
  id: z.string().min(1).max(REF_MAX),
  fromBotId: BotId,
  toBotId: BotId,
  label: Label.optional(),
  state: handoffStateSchema,
  sentAt: IsoDateTime,
  acceptedAt: IsoDateTime.optional(),
});
export type Handoff = z.infer<typeof Handoff>;

export const BotSnapshot = z.object({
  id: BotId,
  name: z.string().max(40),
  role: z.string().max(60),
  avatar: z.string().max(60),
  pod: podSchema,
  desk: DeskSchema.optional(),
  status: botStatusSchema,
  label: Label.optional(),
  taskId: TaskId.optional(),
  since: IsoDateTime,
  lastHeartbeatAt: IsoDateTime,
  lastEventSeq: z.number().int().nonnegative(),
});
export type BotSnapshot = z.infer<typeof BotSnapshot>;

export const StateSnapshot = z.object({
  bots: z.array(BotSnapshot),
  openHandoffs: z.array(Handoff),
  lastEventSeq: z.number().int().nonnegative(),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

/** A stored event as broadcast over SSE (includes server-only types). */
export const StreamEvent = z.object({
  seq: z.number().int().positive(),
  eventId: EventId.optional(),
  botId: BotId,
  type: eventTypeSchema,
  status: botStatusSchema.optional(),
  label: Label.optional(),
  ref: Ref.optional(),
  taskId: TaskId.optional(),
  handoffId: handoffId.optional(),
  to: BotId.optional(),
  result: taskResultSchema.optional(),
  at: IsoDateTime.optional(),
  receivedAt: IsoDateTime,
});
export type StreamEvent = z.infer<typeof StreamEvent>;
