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
  /** Multiplies the shared `colormap` atlas, so one rig still reads as nine bots. */
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
