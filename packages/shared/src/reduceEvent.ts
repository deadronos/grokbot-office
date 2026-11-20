import type { BotSnapshot, Handoff, StreamEvent } from "./schemas.ts";
import { applyLabelRule, shouldRestSender, type LabelEvent } from "./labelRules.ts";

/** The office store's reduced fields; the HUD feed is capped by the caller. */
export type OfficeReduceState = {
  bots: Record<string, BotSnapshot>;
  openHandoffs: Handoff[];
  lastEventSeq: number;
  events: StreamEvent[];
  handoffFlash: { seq: number; from: string; to: string } | null;
};

function patchBot(
  bots: Record<string, BotSnapshot>,
  botId: string,
  patch: Partial<BotSnapshot>,
): Record<string, BotSnapshot> {
  const bot = bots[botId];
  if (!bot) return bots;
  return { ...bots, [botId]: { ...bot, ...patch } };
}

/**
 * Applies one stream event immutably. Status, label, task and the sender-rest
 * decision come from the shared label table, so a server apply and this
 * reducer cannot drift.
 */
export function reduceOfficeEvent(data: OfficeReduceState, event: StreamEvent): OfficeReduceState {
  const { botId } = event;
  const bot = data.bots[botId];
  const at = event.at ?? event.receivedAt;
  let bots = data.bots;
  let openHandoffs = data.openHandoffs;
  let handoffFlash = data.handoffFlash;

  const update = (patch: Partial<BotSnapshot>) => {
    bots = patchBot(bots, botId, { ...patch, lastEventSeq: event.seq });
  };

  const rule = (input: LabelEvent) => {
    if (!bot) return undefined;
    const next = applyLabelRule(
      { status: bot.status, label: bot.label ?? null, taskId: bot.taskId ?? null },
      input,
    );
    const resting = next.status === "idle" || next.status === "offline";
    return {
      status: next.status,
      label: next.label ?? undefined,
      taskId: next.taskId ?? undefined,
      // Resting clears the handoff link; a waiting send sets it below.
      ...(resting ? { handoffId: undefined } : {}),
    };
  };

  switch (event.type) {
    case "status_changed": {
      const next = rule({
        type: "status_changed",
        status: event.status ?? bot?.status ?? "idle",
        label: event.label,
      });
      if (next) update({ ...next, since: at });
      break;
    }
    case "task_started": {
      const next = rule({ type: "task_started", label: event.label, taskId: event.taskId });
      if (next) update({ ...next, since: at });
      break;
    }
    case "task_finished": {
      const next = rule({ type: "task_finished", taskId: event.taskId });
      if (next) update({ ...next, since: at });
      break;
    }
    case "handoff_sent": {
      const next = rule({ type: "handoff_sent", label: event.label, taskId: event.taskId });
      if (next) {
        update({
          ...next,
          since: at,
          ...(next.status === "waiting" && event.handoffId ? { handoffId: event.handoffId } : {}),
        });
      }
      if (bot && event.handoffId && event.to) {
        const handoff: Handoff = {
          id: event.handoffId,
          fromBotId: botId,
          toBotId: event.to,
          label: event.label,
          state: "sent",
          sentAt: at,
        };
        openHandoffs = [...openHandoffs.filter((entry) => entry.id !== handoff.id), handoff];
        handoffFlash = { seq: event.seq, from: botId, to: event.to };
      }
      break;
    }
    case "handoff_accepted": {
      const handoff = openHandoffs.find((entry) => entry.id === event.handoffId);
      openHandoffs = openHandoffs.filter((entry) => entry.id !== event.handoffId);
      const next = rule({
        type: "handoff_accepted",
        label: event.label,
        taskId: event.taskId,
        handoffLabel: handoff?.label ?? null,
      });
      if (next) update({ ...next, since: at });
      if (handoff && handoff.fromBotId !== botId) {
        const sender = bots[handoff.fromBotId];
        if (sender && shouldRestSender(sender, event.handoffId)) {
          bots = patchBot(bots, sender.id, {
            status: "idle",
            label: undefined,
            taskId: undefined,
            handoffId: undefined,
            since: at,
          });
        }
      }
      break;
    }
    case "offline": {
      const next = rule({ type: "offline" });
      if (next) update({ ...next, since: at });
      break;
    }
    case "bot_registered": {
      // The snapshot already carries the registration fields; only the sequence moves.
      if (bot) update({});
      break;
    }
  }

  return {
    bots,
    openHandoffs,
    lastEventSeq: event.seq,
    events: [...data.events, event],
    handoffFlash,
  };
}
