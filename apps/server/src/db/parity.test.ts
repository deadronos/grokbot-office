import { describe, expect, it } from "vitest";

import type { EventIn } from "@grokbot-office/shared";
import { reduceOfficeEvent, type OfficeReduceState } from "@grokbot-office/shared";

import { openDatabase } from "./database.ts";
import { createSqliteRepo, type Repo, type Status } from "./repo.ts";
import { NOW, botRecord } from "../test-utils.ts";
import { toBotSnapshot, toHandoff, toStreamEvent } from "../routes/mappers.ts";

const ulid = (n: number) => `01J${String(n).padStart(23, "0")}`;

function idle(botId: string): Status {
  return {
    botId,
    status: "idle",
    label: null,
    taskId: null,
    handoffTo: null,
    handoffId: null,
    labelHandoffId: null,
    since: NOW,
    lastHeartbeatAt: NOW,
    lastEventSeq: null,
  };
}

function ev(
  botId: string,
  n: number,
  type: EventIn["type"],
  extra: Partial<EventIn> = {},
): EventIn {
  return { botId, eventId: ulid(n), type, ...extra } as EventIn;
}

function setupRepo(): Repo {
  const repo = createSqliteRepo(openDatabase(":memory:"));
  repo.upsertBot(botRecord("data"));
  repo.upsertBot(botRecord("wesley"));
  repo.setBotStatus(idle("data"));
  repo.setBotStatus(idle("wesley"));
  return repo;
}

function clientState(repo: Repo): OfficeReduceState {
  const rows = repo.getSnapshot();
  const statuses = new Map(rows.statuses.map((status) => [status.botId, status]));
  return {
    bots: Object.fromEntries(
      rows.bots.map((bot) => [bot.id, toBotSnapshot(bot, statuses.get(bot.id))]),
    ),
    openHandoffs: rows.openHandoffs.map(toHandoff),
    lastEventSeq: rows.lastEventSeq,
    events: [],
    handoffFlash: null,
  };
}

function fields(bot: {
  status: string;
  label?: string | null;
  taskId?: string | null;
  handoffId?: string | null;
}) {
  return {
    status: bot.status,
    label: bot.label ?? null,
    taskId: bot.taskId ?? null,
    handoffId: bot.handoffId ?? null,
  };
}

function serverFields(repo: Repo, botId: string) {
  const status = repo.getBotStatus(botId);
  if (!status) throw new Error(`missing status for ${botId}`);
  return {
    status: status.status,
    label: status.label,
    taskId: status.taskId,
    handoffId: status.handoffId,
  };
}

type Sequence = { name: string; batches: Array<{ botId: string; events: EventIn[] }> };

const sequences: Sequence[] = [
  {
    name: "task_started leaves the bot working on that task",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
    ],
  },
  {
    name: "task_finished for a different task leaves the current work alone",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
      {
        botId: "data",
        events: [ev("data", 2, "task_finished", { taskId: "other", result: "done" })],
      },
    ],
  },
  {
    name: "task_finished for the current task clears the work",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
      { botId: "data", events: [ev("data", 2, "task_finished", { taskId: "t1", result: "done" })] },
    ],
  },
  {
    name: "handoff_sent without a taskId while holding a task stays working",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
      {
        botId: "data",
        events: [
          ev("data", 2, "handoff_sent", {
            to: "wesley",
            handoffId: "h-side",
            label: "side packet",
          }),
        ],
      },
    ],
  },
  {
    name: "handoff_sent of the current task waits on that handoff",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
      {
        botId: "data",
        events: [
          ev("data", 2, "handoff_sent", {
            to: "wesley",
            handoffId: "h-main",
            taskId: "t1",
            label: "review packet",
          }),
        ],
      },
    ],
  },
  {
    name: "accepting the waiting handoff rests the sender and starts the receiver",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
      {
        botId: "data",
        events: [
          ev("data", 2, "handoff_sent", {
            to: "wesley",
            handoffId: "h-main",
            taskId: "t1",
            label: "review packet",
          }),
        ],
      },
      {
        botId: "wesley",
        events: [ev("wesley", 3, "handoff_accepted", { handoffId: "h-main", taskId: "t1" })],
      },
    ],
  },
  {
    name: "accepting a side handoff does not rest the sender",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
      {
        botId: "data",
        events: [
          ev("data", 2, "handoff_sent", {
            to: "wesley",
            handoffId: "h-side",
            label: "side packet",
          }),
        ],
      },
      {
        botId: "wesley",
        events: [ev("wesley", 3, "handoff_accepted", { handoffId: "h-side", taskId: "side" })],
      },
    ],
  },
];

describe("server applyEvents vs client reduceOfficeEvent parity", () => {
  it.each(sequences)("$name", ({ batches }) => {
    const repo = setupRepo();
    let client = clientState(repo);

    for (const batch of batches) {
      repo.applyEvents(batch.botId, batch.events, NOW);
    }

    for (const row of repo.listEventsSince(0)) {
      client = reduceOfficeEvent(client, toStreamEvent(row));
    }

    for (const botId of ["data", "wesley"]) {
      expect(fields(client.bots[botId]!), `${botId} client`).toEqual(serverFields(repo, botId));
    }
  });
});
