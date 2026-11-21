import { DESKS, type BotStatus, type Desk } from "@grokbot-office/shared";

export type Placement = {
  position: [number, number, number];
  /** Radians around Y, same orientation as the desk. */
  rotationY: number;
};

export type DeskStation = {
  desk: Desk;
  deskBody: Placement;
  screen: Placement;
  screenStand: Placement;
  chairSeat: Placement;
  chairBack: Placement;
  bot: Placement;
  namePlate: Placement;
};

/** Desk-local (x, z) to world, rotated by the desk facing around its own position. */
function place(desk: Desk, localX: number, localY: number, localZ: number): Placement {
  const sin = Math.sin(desk.facing);
  const cos = Math.cos(desk.facing);
  return {
    position: [desk.x + localX * cos + localZ * sin, localY, desk.z - localX * sin + localZ * cos],
    rotationY: desk.facing,
  };
}

/** Plate size in world units; kept small so it cannot cover the desk in front. */
export const NAME_PLATE_SIZE: readonly [number, number] = [1.2, 0.28];

/** Chair seat top of the committed `chairDesk.glb` at `MODEL_SCALE`. */
export const SEAT_TOP = 0.418;

/** One station per fixed desk: the desk faces the centre, the bot sits behind it. */
export const DESK_STATIONS: readonly DeskStation[] = DESKS.map((desk) => ({
  desk,
  deskBody: place(desk, 0, 0.37, 0),
  // Centre of the `computerScreen.glb` panel: the status overlay sits on it.
  screen: place(desk, 0, 1.222, 0.2),
  screenStand: place(desk, 0, 0.9, 0.2),
  chairSeat: place(desk, 0, 0.48, -0.75),
  chairBack: place(desk, 0, 0.7, -1),
  // The character rig's origin is the seat surface in its `sit` pose.
  bot: place(desk, 0, SEAT_TOP, -0.75),
  // High above the desk front, clear of its screen and every other desk
  // (see the projected coverage check in deskStations.test.ts).
  namePlate: place(desk, 0, 3.6, 0.9),
}));

/** An absent or offline bot has no character, so it gets no floating label either. */
export function plateVisible(status: BotStatus | undefined): boolean {
  return status !== undefined && status !== "offline";
}
