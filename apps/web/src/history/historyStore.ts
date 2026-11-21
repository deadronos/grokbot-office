import type { BotSnapshot, StreamEvent } from "@grokbot-office/shared";
import { create } from "zustand";

import { invalidateScene } from "../scene/invalidateScene";
import { useOfficeStore } from "../store/officeStore";
import { fetchEventsWindow } from "./historyApi";
import { replayState, type ReplayState } from "./replay";
import { computeStats, type HistoryStats } from "./stats";
import { eventDayKey, localDayBounds, localDayKey, statsDayKeys, type DayBounds } from "./time";

export const HISTORY_ERROR_MESSAGE = "Can't load the history. Check that the server is running.";

function mergeBySeq(batches: readonly StreamEvent[][]): StreamEvent[] {
  const bySeq = new Map<number, StreamEvent>();
  for (const batch of batches) for (const event of batch) bySeq.set(event.seq, event);
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}

const emptyStats = (dayKeys: readonly string[]): HistoryStats =>
  computeStats({ events: [], dayKeys, bots: {} });

export type HistoryStore = {
  active: boolean;
  /** Selected local day, `YYYY-MM-DD`. */
  day: string;
  /** Local day at the moment history was opened; the stats window ends here. */
  today: string;
  /** Bots known when history opened; the replay roster never changes mid-session. */
  roster: readonly BotSnapshot[];
  /** Loaded stats window: the last seven days plus the selected day when outside it. */
  events: StreamEvent[];
  /** Selected day's events, the timeline the playhead indexes into. */
  dayEvents: StreamEvent[];
  /** Loaded events before the selected day (oldest first); seeds its replay. */
  dayStartEvents: StreamEvent[];
  /** Index into `dayEvents`; `-1` is before the day's first event. */
  playhead: number;
  playing: boolean;
  loading: boolean;
  error: string | null;
  replay: ReplayState;
  stats: HistoryStats;
  enter: () => Promise<void>;
  exit: () => void;
  loadDay: (day: string) => Promise<void>;
  setPlayhead: (index: number) => void;
  scrubTo: (index: number) => void;
  stepBy: (delta: number) => void;
  togglePlay: () => void;
  setPlaying: (playing: boolean) => void;
};

// A day switch aborts the previous read and invalidates its late settlement.
let loadToken = 0;
let inFlight: AbortController | null = null;

export const useHistoryStore = create<HistoryStore>()((set, get) => {
  return {
    active: false,
    day: "",
    today: "",
    roster: [],
    events: [],
    dayEvents: [],
    dayStartEvents: [],
    playhead: -1,
    playing: false,
    loading: false,
    error: null,
    replay: { bots: {}, openHandoffs: [], events: [], lastEventSeq: 0 },
    stats: emptyStats([]),

    enter: async () => {
      if (get().active) return;
      const roster = Object.values(useOfficeStore.getState().bots);
      const today = localDayKey(new Date());
      set({
        active: true,
        today,
        day: today,
        roster,
        events: [],
        dayEvents: [],
        dayStartEvents: [],
        playhead: -1,
        playing: false,
        loading: true,
        error: null,
        replay: replayState({
          roster,
          events: [],
          playhead: -1,
          dayStart: localDayBounds(today).from,
        }),
        stats: emptyStats(statsDayKeys(today, today)),
      });
      invalidateScene();
      await get().loadDay(today);
    },

    exit: () => {
      inFlight?.abort();
      inFlight = null;
      loadToken += 1;
      set({ active: false, playing: false, loading: false, error: null });
      invalidateScene();
    },

    loadDay: async (day) => {
      const { today, roster } = get();
      if (!get().active) return;
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const token = ++loadToken;
      set({ day, loading: true, error: null, playing: false });

      const recentDays = statsDayKeys(today, today);
      const selectedOutsideWindow = !recentDays.includes(day);
      const read = (bounds: DayBounds) => fetchEventsWindow(bounds, controller.signal);

      try {
        const recent = await read({
          from: localDayBounds(recentDays[0]).from,
          to: localDayBounds(today).to,
        });
        const selected = selectedOutsideWindow ? await read(localDayBounds(day)) : [];
        if (token !== loadToken || !get().active) return;

        const events = mergeBySeq([recent, selected]);
        // The scrubber order is (receivedAt, seq): the persisted arrival time is
        // authoritative, seq only breaks ties.
        const dayEvents = events
          .filter((event) => eventDayKey(event) === day)
          .toSorted(
            (a, b) =>
              Date.parse(a.receivedAt ?? a.at) - Date.parse(b.receivedAt ?? b.at) || a.seq - b.seq,
          );
        // Earlier days in the loaded window seed the roster; the day itself
        // starts from its own first event.
        const dayStartEvents = events.filter((event) => eventDayKey(event) < day);
        const playhead = dayEvents.length - 1;
        set({
          events,
          dayEvents,
          dayStartEvents,
          playhead,
          loading: false,
          replay: replayState({
            roster,
            events: dayEvents,
            playhead,
            dayStart: localDayBounds(day).from,
            before: dayStartEvents,
          }),
          stats: computeStats({
            events,
            dayKeys: statsDayKeys(day, today),
            bots: Object.fromEntries(roster.map((bot) => [bot.id, bot])),
          }),
        });
        invalidateScene();
      } catch (error) {
        if (token !== loadToken || !get().active || controller.signal.aborted) return;
        set({
          loading: false,
          error: error instanceof Error ? error.message : HISTORY_ERROR_MESSAGE,
        });
      }
    },

    setPlayhead: (index) => {
      const { dayEvents, dayStartEvents, roster, day } = get();
      const playhead =
        dayEvents.length === 0 ? -1 : Math.min(Math.max(index, 0), dayEvents.length - 1);
      if (playhead === get().playhead) return;
      // Build the replay from the clamped index directly: a selector-style read
      // would still see the old playhead before `set` lands.
      set({
        playhead,
        replay: replayState({
          roster,
          events: dayEvents,
          playhead,
          dayStart: localDayBounds(day).from,
          before: dayStartEvents,
        }),
      });
      invalidateScene();
    },

    scrubTo: (index) => {
      if (get().playing) set({ playing: false });
      get().setPlayhead(index);
    },

    stepBy: (delta) => get().setPlayhead(get().playhead + delta),

    togglePlay: () => {
      const { dayEvents, playhead, playing } = get();
      if (dayEvents.length === 0) return;
      if (playing) {
        set({ playing: false });
        return;
      }
      // Replay from the start when Play is pressed at the end.
      const start = playhead >= dayEvents.length - 1 ? 0 : playhead;
      set({ playing: true });
      get().setPlayhead(start);
    },

    setPlaying: (playing) => set({ playing }),
  };
});
