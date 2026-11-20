import type { BotStatus } from "./enums.ts";

/** The persisted/reduced pieces a label rule may touch. */
export type LabelState = {
  status: BotStatus;
  label: string | null;
  taskId: string | null;
};

/**
 * One event, reduced to the fields the rule reads. `handoffLabel` is the label
 * stored on the open handoff an accept refers to. `taskId` on finish/sent is
 * the event's id, compared to the current task so a side-task cannot clobber
 * work in progress.
 */
export type LabelEvent =
  | { type: "status_changed"; status: BotStatus; label?: string }
  | { type: "task_started"; label?: string; taskId?: string }
  | { type: "task_finished"; taskId?: string }
  | { type: "handoff_sent"; label?: string; taskId?: string }
  | { type: "handoff_accepted"; label?: string; taskId?: string; handoffLabel?: string | null }
  | { type: "offline" };

const RESTING: readonly BotStatus[] = ["idle", "offline"];

/** True when the event names a task other than the one the bot is currently on. */
export function isOtherTask(
  currentTaskId: string | null,
  eventTaskId: string | undefined,
): boolean {
  return eventTaskId !== undefined && currentTaskId !== null && eventTaskId !== currentTaskId;
}

/**
 * A side handoff (no task id, or a different task) while the bot still holds
 * work must not move it to waiting.
 */
export function isSideHandoff(
  currentTaskId: string | null,
  eventTaskId: string | undefined,
): boolean {
  return currentTaskId !== null && currentTaskId !== (eventTaskId ?? null);
}

/** The sender rests only if it was waiting on this exact handoff. */
export function shouldRestSender(
  sender: { status: BotStatus; handoffId?: string | null },
  acceptedHandoffId: string | undefined,
): boolean {
  return (
    sender.status === "waiting" &&
    acceptedHandoffId !== undefined &&
    sender.handoffId === acceptedHandoffId
  );
}

/**
 * The single label table shared by the server's event reducer and the web
 * store, so the two cannot drift: an absent label means "none" on the event
 * that starts or sends, but "keep" on a status change that stays busy.
 * Other-task guards live here too, so both sides apply the same status and label.
 */
export function applyLabelRule(current: LabelState, event: LabelEvent): LabelState {
  switch (event.type) {
    case "status_changed": {
      const resting = RESTING.includes(event.status);
      return {
        status: event.status,
        label: resting ? (event.label ?? null) : (event.label ?? current.label),
        taskId: resting ? null : current.taskId,
      };
    }
    case "task_started":
      return { status: "working", label: event.label ?? null, taskId: event.taskId ?? null };
    case "task_finished":
      if (isOtherTask(current.taskId, event.taskId)) return current;
      return { status: "idle", label: null, taskId: null };
    case "handoff_sent":
      if (isSideHandoff(current.taskId, event.taskId)) return current;
      return { status: "waiting", label: event.label ?? null, taskId: null };
    case "handoff_accepted":
      return {
        status: "working",
        label: event.handoffLabel ?? event.label ?? null,
        taskId: event.taskId ?? null,
      };
    case "offline":
      return { status: "offline", label: null, taskId: null };
    default:
      return current;
  }
}
