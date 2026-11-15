/** Unicode category Cc: C0 controls, DEL and C1 controls. */
const CONTROL_CHARS = /\p{Cc}/gu;

/** Strips control characters (incl. newlines/tabs) and trims. */
export function sanitizeText(value: string): string {
  return value.replace(CONTROL_CHARS, "").trim();
}

export const LABEL_MAX = 80;
export const REF_MAX = 120;
