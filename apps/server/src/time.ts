/**
 * The one timestamp format the server writes: `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, ms).
 * Text comparison equals time order for this format, which the DB relies on.
 */
export function toUtc(date: Date): string {
  return date.toISOString();
}

/** Current time in the stored format. */
export function nowUtc(): string {
  return toUtc(new Date());
}
