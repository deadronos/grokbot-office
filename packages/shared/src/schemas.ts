import { z } from "zod/mini";

import {
  botStatusSchema,
  eventTypeSchema,
  handoffStateSchema,
  podSchema,
  taskResultSchema,
} from "./enums.ts";
import { LABEL_MAX, REF_MAX, sanitizeText } from "./sanitize.ts";

/** Lowercase slug, e.g. `data` or `wesley`. */
export const BotId = z
  .string()
  .check(
    z.maxLength(64, "must be at most 64 characters"),
    z.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "must be a lowercase slug"),
  );
export type BotId = z.infer<typeof BotId>;

// Crockford base32 (no I, L, O, U) ULID, or a canonical UUID.
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EventId = z
  .string()
  .check(
    z.refine(
      (value) => ULID_PATTERN.test(value) || UUID_PATTERN.test(value),
      "must be a ULID or UUID",
    ),
  );
export type EventId = z.infer<typeof EventId>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Sanitizes, then length-checks the cleaned text; empty is rejected. */
function requiredText(max: number) {
  return z
    .string()
    .check(
      z.overwrite(sanitizeText),
      z.minLength(1, "must not be empty"),
      z.maxLength(max, `must be at most ${max} characters`),
    );
}

/** Sanitizes; text that is empty afterwards counts as omitted. */
function optionalText(max: number) {
  return z.pipe(
    z.pipe(
      z.string().check(z.overwrite(sanitizeText)),
      z.transform((value) => (value === "" ? undefined : value)),
    ),
    z.optional(z.string().check(z.maxLength(max, `must be at most ${max} characters`))),
  );
}

export const Label = optionalText(LABEL_MAX);
export type Label = z.infer<typeof Label>;

export const Ref = optionalText(REF_MAX);
export type Ref = z.infer<typeof Ref>;

/**
 * Ids are stored verbatim, so they are never cleaned up: any Cc/Cf character or
 * leading/trailing whitespace is a 400 rather than a silent `task\u200B1` = `task1`.
 */
const REF_ID_PATTERN = /^(?!.*[\p{Cc}\p{Cf}])\S(?:[\s\S]*\S)?$/u;

function refId(max: number) {
  return z
    .string()
    .check(
      z.regex(REF_ID_PATTERN, "must be non-empty, unpadded, and free of control chars"),
      z.maxLength(max, `must be at most ${max} characters`),
    );
}

export const TaskId = refId(REF_MAX);
export type TaskId = z.infer<typeof TaskId>;

export const HandoffId = refId(REF_MAX);
export type HandoffId = z.infer<typeof HandoffId>;

export const RegisterBody = z.strictObject({
  id: BotId,
  name: requiredText(40),
  role: requiredText(60),
  avatar: requiredText(60),
  pod: podSchema,
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const HeartbeatBody = z.strictObject({
  status: z.optional(botStatusSchema),
});
export type HeartbeatBody = z.infer<typeof HeartbeatBody>;

const eventFields = {
  eventId: EventId,
  botId: BotId,
  at: z.optional(IsoDateTime),
  label: z.optional(Label),
  ref: z.optional(Ref),
  taskId: z.optional(TaskId),
};

/** A client-submitted event; server-only types and unknown keys are rejected. */
export const EventIn = z.discriminatedUnion("type", [
  z.strictObject({ ...eventFields, type: z.literal("status_changed"), status: botStatusSchema }),
  z.strictObject({ ...eventFields, type: z.literal("task_started") }),
  z.strictObject({ ...eventFields, type: z.literal("task_finished"), result: taskResultSchema }),
  z.strictObject({
    ...eventFields,
    type: z.literal("handoff_sent"),
    to: BotId,
    handoffId: HandoffId,
  }),
  z.strictObject({ ...eventFields, type: z.literal("handoff_accepted"), handoffId: HandoffId }),
]);
export type EventIn = z.infer<typeof EventIn>;

export const EVENTS_BATCH_MIN = 1;
export const EVENTS_BATCH_MAX = 20;

export const EventsBatch = z.strictObject({
  events: z
    .array(EventIn)
    .check(
      z.minLength(EVENTS_BATCH_MIN, `at least ${EVENTS_BATCH_MIN} event`),
      z.maxLength(EVENTS_BATCH_MAX, `at most ${EVENTS_BATCH_MAX} events`),
    ),
});
export type EventsBatch = z.infer<typeof EventsBatch>;

export const DeskSchema = z.object({
  botId: BotId,
  name: z.string().check(z.maxLength(40)),
  pod: podSchema,
  index: z.number().check(z.int(), z.nonnegative()),
  x: z.number(),
  z: z.number(),
  facing: z.number(),
});
export type DeskSchema = z.infer<typeof DeskSchema>;

export const Handoff = z.object({
  id: HandoffId,
  fromBotId: BotId,
  toBotId: BotId,
  label: z.optional(Label),
  state: handoffStateSchema,
  sentAt: IsoDateTime,
  acceptedAt: z.optional(IsoDateTime),
});
export type Handoff = z.infer<typeof Handoff>;

export const BotSnapshot = z.object({
  id: BotId,
  name: z.string().check(z.maxLength(40)),
  role: z.string().check(z.maxLength(60)),
  avatar: z.string().check(z.maxLength(60)),
  pod: podSchema,
  desk: z.optional(DeskSchema),
  status: botStatusSchema,
  label: z.optional(Label),
  taskId: z.optional(TaskId),
  handoffId: z.optional(HandoffId),
  since: IsoDateTime,
  lastHeartbeatAt: IsoDateTime,
  lastEventSeq: z.number().check(z.int(), z.nonnegative()),
});
export type BotSnapshot = z.infer<typeof BotSnapshot>;

export const StateSnapshot = z.object({
  bots: z.array(BotSnapshot),
  openHandoffs: z.array(Handoff),
  lastEventSeq: z.number().check(z.int(), z.nonnegative()),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

/** A stored event as broadcast over SSE (includes server-only types). */
export const StreamEvent = z.object({
  seq: z.number().check(z.int(), z.positive()),
  eventId: z.optional(EventId),
  botId: BotId,
  type: eventTypeSchema,
  status: z.optional(botStatusSchema),
  label: z.optional(Label),
  ref: z.optional(Ref),
  taskId: z.optional(TaskId),
  handoffId: z.optional(HandoffId),
  to: z.optional(BotId),
  result: z.optional(taskResultSchema),
  at: z.optional(IsoDateTime),
  receivedAt: IsoDateTime,
});
export type StreamEvent = z.infer<typeof StreamEvent>;
