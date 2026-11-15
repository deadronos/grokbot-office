import type { BotStatus } from "@grokbot-office/shared";

/** Grey screen for a desk with no task; the bot colour is used while busy. */
export const IDLE_MONITOR = "#3a4250";
/** Reviewing gets one fixed colour, so the magnifier and screen agree. */
export const REVIEW_MONITOR = "#e0a94f";

export type DeskVisual = {
  /** Base screen colour before the pulse is applied. */
  monitor: string;
  /** Static brightness of the screen, 0–1. */
  monitorIntensity: number;
  /** Multiplier for the dimming overlay on the desk and chair, 1 = not dimmed. */
  dim: number;
  /** Offline desks keep the chair empty. */
  occupant: boolean;
  thoughtBubble: boolean;
  magnifier: boolean;
  pulsing: boolean;
};

/** One status-to-props table, so the scene visuals stay testable without a canvas. */
export function deskVisual(status: BotStatus | undefined, botColor: string): DeskVisual {
  switch (status) {
    case "working":
      return {
        monitor: botColor,
        monitorIntensity: 1,
        dim: 1,
        occupant: true,
        thoughtBubble: false,
        magnifier: false,
        pulsing: true,
      };
    case "waiting":
      return {
        monitor: botColor,
        monitorIntensity: 0.55,
        dim: 1,
        occupant: true,
        thoughtBubble: true,
        magnifier: false,
        pulsing: false,
      };
    case "reviewing":
      return {
        monitor: REVIEW_MONITOR,
        monitorIntensity: 0.9,
        dim: 1,
        occupant: true,
        thoughtBubble: false,
        magnifier: true,
        pulsing: false,
      };
    case "offline":
      return {
        monitor: IDLE_MONITOR,
        monitorIntensity: 0.05,
        dim: 0.45,
        occupant: false,
        thoughtBubble: false,
        magnifier: false,
        pulsing: false,
      };
    case "idle":
    default:
      return {
        monitor: IDLE_MONITOR,
        monitorIntensity: 0.35,
        dim: 1,
        occupant: true,
        thoughtBubble: false,
        magnifier: false,
        pulsing: false,
      };
  }
}

/** Brightness multiplier for the working pulse; between 0.55 and 1. */
export function pulseFactor(elapsedSeconds: number): number {
  return 0.775 + 0.225 * Math.sin(elapsedSeconds * 4);
}
