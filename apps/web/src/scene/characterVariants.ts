import { BOT_COLORS } from "./botColors";

export type AccessoryKind =
  | "halo"
  | "band"
  | "visor"
  | "ears"
  | "earpiece"
  | "hat"
  | "sash"
  | "none";

export type CharacterVariant = {
  /** Raw bot colour; see `materialTint` for what actually reaches the material. */
  tint: string;
  accessory: AccessoryKind;
  /** Bone the accessory is attached to; it follows the animation. */
  bone: "head" | "torso";
};

/** One rig, nine silhouettes: the accessory carries the character, the tint the identity. */
const VARIANTS: Record<string, { accessory: AccessoryKind; bone: "head" | "torso" }> = {
  lumi: { accessory: "halo", bone: "head" },
  data: { accessory: "none", bone: "head" },
  wesley: { accessory: "band", bone: "head" },
  geordi: { accessory: "visor", bone: "head" },
  spock: { accessory: "ears", bone: "head" },
  uhura: { accessory: "earpiece", bone: "head" },
  guinan: { accessory: "hat", bone: "head" },
  quark: { accessory: "ears", bone: "head" },
  worf: { accessory: "sash", bone: "torso" },
};

const DEFAULT_VARIANT = { accessory: "none", bone: "head" } as const;

export function characterVariant(botId: string): CharacterVariant {
  const variant = VARIANTS[botId] ?? DEFAULT_VARIANT;
  return {
    tint: BOT_COLORS[botId] ?? BOT_COLORS.data,
    accessory: variant.accessory,
    bone: variant.bone,
  };
}

/** How far the tint is pulled from white; multiplying the atlas at full strength muddies it. */
const TINT_STRENGTH = 0.45;

/** Blends `tint` from white, so the shared colormap keeps its contrast. */
const blendFromWhite = (channel: number) => Math.round(255 + (channel - 255) * TINT_STRENGTH);

export function materialTint(tint: string): string {
  const rgb = Number.parseInt(tint.slice(1), 16);
  const channels = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff].map(blendFromWhite);
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
