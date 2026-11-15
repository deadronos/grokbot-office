import type { BotStatus } from "./enums.ts";

/** The persisted/reduced pieces a label rule may touch. */
export type LabelState = {
  status: BotStatus;
  label: string | null;
  taskId: string | null;
};

/**
 * One event, reduced to the fields the rule reads. `handoffLabel` is the label
 * stored on the open handoff an accept refers to.
 */
export type LabelEvent =
  | { type: "status_changed"; status: BotStatus; label?: string }
  | { type: "task_started"; label?: string; taskId?: string }
  | { type: "task_finished" }
  | { type: "handoff_sent"; label?: string }
  | { type: "handoff_accepted"; label?: string; taskId?: string; handoffLabel?: string | null }
  | { type: "offline" };

const RESTING: readonly BotStatus[] = ["idle", "offline"];

/**
 * The single label table shared by the server's event reducer and the web
 * store, so the two cannot drift: an absent label means "none" on the event
 * that starts or sends, but "keep" on a status change that stays busy.
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
      return { status: "idle", label: null, taskId: null };
    case "handoff_sent":
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
