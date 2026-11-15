import type { BotSnapshot, Handoff, StreamEvent } from "@grokbot-office/shared";
import { getDesk } from "@grokbot-office/shared";

import type { Bot, Event, Handoff as HandoffRow, Status } from "../db/repo.ts";

/**
 * Row → shared-schema mapping for the viewer API. Nullable columns are omitted
 * rather than sent as `null`, because the schemas mark them optional.
 */
export function toBotSnapshot(bot: Bot, status: Status | undefined): BotSnapshot {
  const desk = getDesk(bot.id);
  return {
    id: bot.id,
    name: bot.name,
    role: bot.role,
    avatar: bot.avatar,
    pod: bot.pod,
    ...(desk ? { desk } : {}),
    status: status?.status ?? "offline",
    ...(status?.label === null || status?.label === undefined ? {} : { label: status.label }),
    ...(status?.taskId === null || status?.taskId === undefined ? {} : { taskId: status.taskId }),
    since: status?.since ?? bot.createdAt,
    lastHeartbeatAt: status?.lastHeartbeatAt ?? bot.createdAt,
    lastEventSeq: status?.lastEventSeq ?? 0,
  };
}

export function toHandoff(row: HandoffRow): Handoff {
  return {
    id: row.id,
    fromBotId: row.fromBotId,
    toBotId: row.toBotId,
    ...(row.label === null ? {} : { label: row.label }),
    state: row.state,
    sentAt: row.sentAt,
    ...(row.acceptedAt === null ? {} : { acceptedAt: row.acceptedAt }),
  };
}

export function toStreamEvent(event: Event): StreamEvent {
  return {
    seq: event.seq,
    eventId: event.eventId,
    botId: event.botId,
    type: event.type,
    ...(event.status === null ? {} : { status: event.status }),
    ...(event.label === null ? {} : { label: event.label }),
    ...(event.ref === null ? {} : { ref: event.ref }),
    ...(event.taskId === null ? {} : { taskId: event.taskId }),
    ...(event.handoffId === null ? {} : { handoffId: event.handoffId }),
    ...(event.toBotId === null ? {} : { to: event.toBotId }),
    ...(event.result === null ? {} : { result: event.result }),
    ...(event.clientAt === null ? {} : { at: event.clientAt }),
    receivedAt: event.receivedAt,
  };
}
