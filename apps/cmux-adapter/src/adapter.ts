import { randomUUID } from "node:crypto";

import { LABEL_MAX, sanitizeText } from "@grokbot-office/shared";

import type { CmuxState } from "./cmux.ts";
import type { Post } from "./http.ts";

export type WorkspaceState = { name: string; state?: CmuxState };
export type Aggregate = { state: CmuxState; label: string };

export type EventPlan =
  | { type: "task_started"; label: string }
  | { type: "task_finished"; result: "done" }
  | { type: "status_changed"; status: "idle" };

export type Adapter = { poll: () => Promise<void> };
export type AdapterDeps = {
  list: () => Promise<WorkspaceState[]>;
  post: Post;
  botId: string;
};

const STATE_RANK = { running: 0, done: 1, idle: 2 } satisfies Record<CmuxState, number>;

function compareLabels(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A title that looks like a credential must not travel as a label. */
const SECRET_LIKE =
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.)/;

/** Sanitizes like every other label, then truncates rather than rejecting the report. */
export function labelFor(name: string): string | undefined {
  const label = sanitizeText(name).slice(0, LABEL_MAX).trim();
  if (label === "" || SECRET_LIKE.test(label)) return undefined;
  return label;
}

/**
 * Aggregates all workspaces into the one state a bot can display. Busy wins,
 * and among equals the lexicographically first name is the deterministic label.
 */
export function aggregate(workspaces: readonly WorkspaceState[]): Aggregate | undefined {
  const candidates = workspaces.flatMap(({ name, state }) => {
    if (state === undefined) return [];
    const label = labelFor(name);
    return label === undefined ? [] : [{ state, label }];
  });
  const [best] = candidates.toSorted(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || compareLabels(a.label, b.label),
  );
  return best;
}

/** Only a transition produces an event; a repeated state is silent. */
export function transition(
  previous: Aggregate | undefined,
  next: Aggregate | undefined,
): EventPlan | undefined {
  if (next === undefined) {
    // The last coding-CLI status vanished: rest the desk instead of staying waiting.
    return previous?.state === "running" ? { type: "status_changed", status: "idle" } : undefined;
  }
  if (previous?.state === next.state) {
    if (next.state !== "running" || previous.label === next.label) return undefined;
  }
  switch (next.state) {
    case "running":
      return { type: "task_started", label: next.label };
    case "done":
      return { type: "task_finished", result: "done" };
    case "idle":
      return { type: "status_changed", status: "idle" };
  }
}

/**
 * Polls cmux, reports transitions as one event, then heartbeats. The previous
 * state moves only after the event landed, so a failed post is retried.
 */
export function createAdapter({ list, post, botId }: AdapterDeps): Adapter {
  let previous: Aggregate | undefined;
  return {
    async poll() {
      const next = aggregate(await list());
      const plan = transition(previous, next);
      if (plan) {
        await post("/api/events", { events: [{ botId, eventId: randomUUID(), ...plan }] });
      }
      previous = next;
      await post(`/api/bots/${encodeURIComponent(botId)}/heartbeat`, {});
    },
  };
}
