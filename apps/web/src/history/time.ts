import type { StreamEvent } from "@grokbot-office/shared";

export type DayBounds = { from: string; to: string };

/** Local calendar day key, `YYYY-MM-DD`; history is a local-day experience. */
export function localDayKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

export function addDays(day: string, delta: number): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + delta);
  return localDayKey(date);
}

/** Half-open `[from, to)` range for one local day, as UTC instants. */
export function localDayBounds(day: string): DayBounds {
  return { from: parseDay(day).toISOString(), to: parseDay(addDays(day, 1)).toISOString() };
}

/** The stats window: the last `days` local days ending today, plus a selected day outside it. */
export function statsDayKeys(selectedDay: string, today: string, days = 7): string[] {
  const keys = new Set<string>([selectedDay]);
  for (let offset = days - 1; offset >= 0; offset -= 1) keys.add(addDays(today, -offset));
  return [...keys].toSorted();
}

export function eventDayKey(event: Pick<StreamEvent, "receivedAt" | "at">): string {
  const time = Date.parse(event.receivedAt ?? event.at);
  return localDayKey(new Date(time));
}
