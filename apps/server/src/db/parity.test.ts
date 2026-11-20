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
  {
    name: "re-accepting an already-accepted handoff is a no-op for both sides",
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
      {
        botId: "wesley",
        events: [ev("wesley", 4, "status_changed", { status: "reviewing" })],
      },
      {
        botId: "wesley",
        events: [
          ev("wesley", 5, "handoff_accepted", {
            handoffId: "h-main",
            taskId: "other",
            label: "no",
          }),
        ],
      },
    ],
  },
  {
    name: "accepting a handoff clears the receiver's waiting handoffId",
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
            handoffId: "h-out",
            taskId: "t1",
            label: "review packet",
          }),
        ],
      },
      {
        botId: "wesley",
        events: [
          ev("wesley", 3, "handoff_sent", {
            to: "data",
            handoffId: "h-in",
            label: "return packet",
          }),
        ],
      },
      {
        botId: "data",
        events: [ev("data", 4, "handoff_accepted", { handoffId: "h-in", taskId: "t-return" })],
      },
    ],
  },
  {
    name: "a side handoff_sent while already waiting does not overwrite handoffId",
    batches: [
      {
        botId: "data",
        events: [ev("data", 1, "task_started", { taskId: "t1", label: "issue-13" })],
      },
      {
        botId: "data",
        events: [ev("data", 2, "status_changed", { status: "waiting" })],
      },
      {
        botId: "data",
        events: [
          ev("data", 3, "handoff_sent", {
            to: "wesley",
            handoffId: "h-first",
            taskId: "t1",
            label: "main packet",
          }),
        ],
      },
      {
        botId: "data",
        events: [
          ev("data", 4, "handoff_sent", {
            to: "wesley",
            handoffId: "h-side",
            label: "side packet",
          }),
        ],
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

  it("holds under a deterministic seeded fuzz of mixed events", () => {
    // 150 short sequences is enough to catch the known handoffId / re-accept gaps
    // without a long CI run. A larger seed was used to find them.
    const rng = mulberry32(20261120);
    const bots = ["data", "wesley"] as const;
    const statuses = ["idle", "working", "waiting", "reviewing", "offline"] as const;
    const results = ["done", "failed", "cancelled"] as const;

    for (let sequence = 0; sequence < 150; sequence++) {
      const repo = setupRepo();
      let client = clientState(repo);
      let n = 0;
      const open: Array<{ id: string; to: string }> = [];

      for (let step = 0; step < 12; step++) {
        const botId = bots[Math.floor(rng() * bots.length)]!;
        const other = botId === "data" ? "wesley" : "data";
        const incoming = open.filter((handoff) => handoff.to === botId);
        const roll = rng();
        const next = ev(botId, ++n, "task_started", {
          taskId: `t-${sequence}-${step}`,
          label: `label-${step}`,
        });
        let event: EventIn;
        if (incoming.length > 0 && roll < 0.25) {
          event = ev(botId, n, "handoff_accepted", {
            handoffId: incoming[Math.floor(rng() * incoming.length)]!.id,
            taskId: `accept-${step}`,
          });
        } else if (roll < 0.45) {
          event = ev(botId, n, "status_changed", {
            status: statuses[Math.floor(rng() * statuses.length)]!,
          });
        } else if (roll < 0.6) {
          event = ev(botId, n, "task_finished", {
            taskId: rng() < 0.5 ? `t-${sequence}-${step}` : `t-${sequence}-0`,
            result: results[Math.floor(rng() * results.length)]!,
          });
        } else if (roll < 0.8) {
          const handoffId = `h-${sequence}-${step}`;
          event = ev(botId, n, "handoff_sent", {
            to: other,
            handoffId,
            ...(rng() < 0.5 ? { taskId: `t-${sequence}-${step}` } : {}),
            label: `handoff-${step}`,
          });
          open.push({ id: handoffId, to: other });
        } else {
          event = next;
        }

        repo.applyEvents(botId, [event], NOW);
        if (event.type === "handoff_accepted") {
          const id = event.handoffId;
          const at = open.findIndex((handoff) => handoff.id === id && handoff.to === botId);
          if (at >= 0) open.splice(at, 1);
        }
        for (const row of repo.listEventsSince(client.lastEventSeq)) {
          client = reduceOfficeEvent(client, toStreamEvent(row));
        }
        for (const id of bots) {
          expect(fields(client.bots[id]!), `seq ${sequence} step ${step} ${id}`).toEqual(
            serverFields(repo, id),
          );
        }
      }
    }
  });
});

/** Deterministic 32-bit PRNG so a failing case is reproducible. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
