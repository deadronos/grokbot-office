import { DESKS, type Desk } from "@grokbot-office/shared";

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

/** One station per fixed desk: the desk faces the centre, the bot sits behind it. */
export const DESK_STATIONS: readonly DeskStation[] = DESKS.map((desk) => ({
  desk,
  deskBody: place(desk, 0, 0.37, 0),
  screen: place(desk, 0, 1.1, 0.2),
  screenStand: place(desk, 0, 0.9, 0.2),
  chairSeat: place(desk, 0, 0.48, -0.75),
  chairBack: place(desk, 0, 0.7, -1),
  bot: place(desk, 0, 0.75, -0.75),
  namePlate: place(desk, 0, 2.1, -0.75),
}));
