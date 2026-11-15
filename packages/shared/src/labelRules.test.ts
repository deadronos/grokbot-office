import { describe, expect, it } from "vitest";

import { applyLabelRule, type LabelEvent, type LabelState } from "./labelRules.ts";

const bot = (over: Partial<LabelState> = {}): LabelState => ({
  status: "idle",
  label: null,
  taskId: null,
  ...over,
});
const workingOn = bot({ status: "working", label: "issue-13", taskId: "t1" });

const cases: { name: string; current: LabelState; event: LabelEvent; next: LabelState }[] = [
  {
    name: "idle with no label clears the label and task link",
    current: workingOn,
    event: { type: "status_changed", status: "idle" },
    next: bot(),
  },
  {
    name: "offline with no label clears the label and task link",
    current: workingOn,
    event: { type: "status_changed", status: "offline" },
    next: bot({ status: "offline" }),
  },
  {
    name: "a non-resting status with no label keeps the current label and task",
    current: workingOn,
    event: { type: "status_changed", status: "reviewing" },
    next: { status: "reviewing", label: "issue-13", taskId: "t1" },
  },
  {
    name: "an idle status with a label uses the label and still clears the task",
    current: workingOn,
    event: { type: "status_changed", status: "idle", label: "coffee" },
    next: bot({ label: "coffee" }),
  },
  {
    name: "a reviewing status with a label replaces it and keeps the task",
    current: workingOn,
    event: { type: "status_changed", status: "reviewing", label: "PR 42" },
    next: { status: "reviewing", label: "PR 42", taskId: "t1" },
  },
  {
    name: "task_started without a label clears an older label",
    current: workingOn,
    event: { type: "task_started", taskId: "t2" },
    next: { status: "working", label: null, taskId: "t2" },
  },
  {
    name: "task_started uses its label and task id",
    current: bot(),
    event: { type: "task_started", taskId: "t2", label: "issue-2" },
    next: { status: "working", label: "issue-2", taskId: "t2" },
  },
  {
    name: "handoff_sent without a label clears an older label",
    current: workingOn,
    event: { type: "handoff_sent" },
    next: { status: "waiting", label: null, taskId: null },
  },
  {
    name: "handoff_sent uses its label",
    current: bot(),
    event: { type: "handoff_sent", label: "review packet" },
    next: { status: "waiting", label: "review packet", taskId: null },
  },
  {
    name: "handoff_accepted prefers the handoff label over the event label",
    current: bot(),
    event: {
      type: "handoff_accepted",
      label: "sent label",
      handoffLabel: "stored label",
      taskId: "t3",
    },
    next: { status: "working", label: "stored label", taskId: "t3" },
  },
  {
    name: "handoff_accepted falls back to the event label",
    current: bot(),
    event: { type: "handoff_accepted", label: "event label", handoffLabel: null, taskId: "t3" },
    next: { status: "working", label: "event label", taskId: "t3" },
  },
  {
    name: "handoff_accepted without either label leaves none",
    current: workingOn,
    event: { type: "handoff_accepted" },
    next: { status: "working", label: null, taskId: null },
  },
  {
    name: "task_finished clears the label and task link",
    current: workingOn,
    event: { type: "task_finished" },
    next: bot(),
  },
  {
    name: "a server offline event clears the label and task link",
    current: workingOn,
    event: { type: "offline" },
    next: bot({ status: "offline" }),
  },
];

describe("applyLabelRule", () => {
  it.each(cases)("$name", ({ current, event, next }) => {
    expect(applyLabelRule(current, event)).toEqual(next);
  });
});
