// Unicode categories that never belong in a display string: Cc (C0/C1 controls,
// incl. newlines and tabs) and Cf (invisible formatters: ZWSP, RLO, ZWJ, BOM…).
const CONTROL_CHARS = /\p{Cc}/gu;
const FORMAT_CHARS = /\p{Cf}/gu;
const WHITESPACE_RUNS = /\s+/g;

/**
 * Normalizes user text: drops invisible format characters, turns control
 * characters into a space, collapses whitespace runs to one space and trims.
 */
export function sanitizeText(value: string): string {
  return value
    .replace(FORMAT_CHARS, "")
    .replace(CONTROL_CHARS, " ")
    .replace(WHITESPACE_RUNS, " ")
    .trim();
}

export const LABEL_MAX = 80;
export const REF_MAX = 120;
