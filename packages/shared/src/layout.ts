import type { Pod } from "./enums";

export type Desk = {
  botId: string;
  name: string;
  pod: Pod;
  /** Index within the pod's row, left to right. */
  index: number;
  x: number;
  z: number;
  /** Radians around Y; 0 faces +z (towards the centre desk). */
  facing: number;
};

// Placeholder positions: the scene issue tunes these. Dev pod sits in front of
// the centre desk (facing -z), the ops/personal pod behind it (facing +z).
const DESK_LIST: Desk[] = [
  { botId: "lumi", name: "Lumi", pod: "command", index: 0, x: 0, z: 0, facing: 0 },

  { botId: "data", name: "Data", pod: "dev", index: 0, x: -4.5, z: 3, facing: Math.PI },
  { botId: "wesley", name: "Wesley", pod: "dev", index: 1, x: -1.5, z: 3, facing: Math.PI },
  { botId: "geordi", name: "Geordi", pod: "dev", index: 2, x: 1.5, z: 3, facing: Math.PI },
  { botId: "spock", name: "Spock", pod: "dev", index: 3, x: 4.5, z: 3, facing: Math.PI },

  { botId: "uhura", name: "Uhura", pod: "ops", index: 0, x: -4.5, z: -3, facing: 0 },
  { botId: "guinan", name: "Guinan", pod: "ops", index: 1, x: -1.5, z: -3, facing: 0 },
  { botId: "quark", name: "Quark", pod: "ops", index: 2, x: 1.5, z: -3, facing: 0 },
  { botId: "worf", name: "Worf", pod: "ops", index: 3, x: 4.5, z: -3, facing: 0 },
];

/** Fixed desk layout: only these bots get a desk in the scene. */
export const DESKS: readonly Desk[] = Object.freeze(DESK_LIST.map((desk) => Object.freeze(desk)));

const desksByBotId = new Map(DESKS.map((desk) => [desk.botId, desk]));

/** The desk for a bot, or `undefined` for bots that are HUD-list only. */
export function getDesk(botId: string): Desk | undefined {
  return desksByBotId.get(botId);
}
