import { StreamEvent, type StreamEvent as StreamEventType } from "@grokbot-office/shared";
import { z } from "zod";

import { EVENTS_PATH } from "../store/officeStore";
import type { DayBounds } from "./time";

export const EVENTS_URL = EVENTS_PATH;
export const HISTORY_PAGE_LIMIT = 500;
/** Stop runaway paging if the server keeps claiming `hasMore`. */
const MAX_PAGES = 40;

const HistoryPageSchema = z.object({
  events: z.array(StreamEvent),
  nextSince: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  lastSeq: z.number().int().nonnegative(),
});
export type HistoryPage = z.infer<typeof HistoryPageSchema>;

/** Every visible event in one half-open local-day window, oldest first. */
export async function fetchEventsWindow(
  bounds: DayBounds,
  signal?: AbortSignal,
): Promise<StreamEventType[]> {
  const bySeq = new Map<number, StreamEventType>();
  let since = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      since: String(since),
      limit: String(HISTORY_PAGE_LIMIT),
      from: bounds.from,
      to: bounds.to,
    });
    const response = await fetch(`${EVENTS_URL}?${query}`, {
      signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`History request failed (${response.status}).`);
    const body = HistoryPageSchema.parse(await response.json());
    for (const event of body.events) bySeq.set(event.seq, event);
    if (!body.hasMore) {
      return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
    }
    since = body.nextSince;
  }
  throw new Error("History request did not finish.");
}
