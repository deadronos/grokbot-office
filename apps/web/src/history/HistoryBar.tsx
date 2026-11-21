import { useEffect, useState, type CSSProperties } from "react";

import { HUD_LAYOUT, historyBarBox } from "../hudLayout";
import { describeEvent } from "../Hud";
import { useHistoryStore } from "./historyStore";
import { formatDuration, type HistoryStats } from "./stats";

const PLAYBACK_INTERVAL_MS = 400;

function barStyle(box: { x0: number; x1: number; y0: number; y1: number }): CSSProperties {
  return {
    left: box.x0,
    top: box.y0,
    width: box.x1 - box.x0,
    height: box.y1 - box.y0,
  };
}

export type HistoryBarViewProps = {
  day: string;
  today: string;
  dayEvents: readonly import("@grokbot-office/shared").StreamEvent[];
  playhead: number;
  playing: boolean;
  loading: boolean;
  error: string | null;
  stats: HistoryStats;
  onSelectDay: (day: string) => void;
  onTogglePlay: () => void;
  onScrub: (index: number) => void;
  onStep: (delta: number) => void;
  onExit: () => void;
  onReload: () => void;
  style?: CSSProperties;
};

/** Pure view: the connected bar adds playback timing and viewport placement. */
export function HistoryBarView({
  day,
  today,
  dayEvents,
  playhead,
  playing,
  loading,
  error,
  stats,
  onSelectDay,
  onTogglePlay,
  onScrub,
  onStep,
  onExit,
  onReload,
  style,
}: HistoryBarViewProps) {
  const current = playhead >= 0 ? dayEvents[playhead] : undefined;
  const position =
    dayEvents.length === 0
      ? "No events on this day."
      : `${playhead + 1} / ${dayEvents.length} events`;
  const busiest = stats.busiest;

  return (
    <aside className="history-bar" style={style} aria-label="History replay">
      <div className="history-controls">
        <label className="history-day">
          <span>Day</span>
          <input
            type="date"
            aria-label="History day"
            value={day}
            max={today}
            disabled={loading}
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (next) onSelectDay(next);
            }}
          />
        </label>
        <button
          type="button"
          className="history-button history-play"
          aria-label={playing ? "Pause" : "Play"}
          onClick={onTogglePlay}
          disabled={loading || dayEvents.length === 0}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          className="history-button"
          aria-label="Previous event"
          onClick={() => onStep(-1)}
          disabled={loading || dayEvents.length === 0 || playhead <= 0}
        >
          ‹
        </button>
        <button
          type="button"
          className="history-button"
          aria-label="Next event"
          onClick={() => onStep(1)}
          disabled={loading || playhead >= dayEvents.length - 1}
        >
          ›
        </button>
        <input
          className="history-scrubber"
          type="range"
          aria-label="Timeline"
          aria-valuetext={position}
          min={0}
          max={Math.max(dayEvents.length - 1, 0)}
          step={1}
          value={Math.max(playhead, 0)}
          disabled={loading || dayEvents.length === 0}
          onChange={(event) => onScrub(Number(event.currentTarget.value))}
        />
        <span className="history-position">{position}</span>
        {current ? <span className="history-current">{describeEvent(current)}</span> : null}
        <button
          type="button"
          className="history-button"
          aria-label="Reload history"
          onClick={onReload}
          disabled={loading}
        >
          Reload
        </button>
        <button type="button" className="history-button" aria-label="Back to live" onClick={onExit}>
          Back to live
        </button>
      </div>
      {error ? (
        <p className="history-error" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="history-loading">Loading history…</p> : null}
      <section className="history-stats" aria-label="History stats">
        <h3 className="history-heading">Tasks per day</h3>
        <ol className="history-days">
          {stats.days.map((entry) => (
            <li key={entry.day} title={entry.day}>
              <span>{entry.day.slice(5)}</span>
              <span>{entry.count}</span>
            </li>
          ))}
        </ol>
        <p className="history-latency">
          Handoff latency: median {formatDuration(stats.latency.medianMs)} · average{" "}
          {formatDuration(stats.latency.averageMs)} · {stats.latency.open} open
        </p>
        <p className="history-busiest">
          Busiest bot: {busiest ? `${busiest.name} · ${busiest.count} tasks` : "none"}
        </p>
      </section>
    </aside>
  );
}

function useViewport() {
  const [viewport, setViewport] = useState(() =>
    typeof window === "undefined"
      ? { width: HUD_LAYOUT.wideMinWidth, height: 720 }
      : { width: window.innerWidth, height: window.innerHeight },
  );
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return viewport;
}

/** Steps the playhead while Play is on; discrete steps keep reduced motion respected. */
function usePlayback() {
  const playing = useHistoryStore((state) => state.playing);
  const setPlaying = useHistoryStore((state) => state.setPlaying);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const state = useHistoryStore.getState();
      if (state.playhead >= state.dayEvents.length - 1) {
        state.setPlaying(false);
        return;
      }
      state.setPlayhead(state.playhead + 1);
    }, PLAYBACK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      // A day switch or unmount must not leave the timer marked as playing.
      if (useHistoryStore.getState().playing) setPlaying(false);
    };
  }, [playing, setPlaying]);
}

export function HistoryBar() {
  const day = useHistoryStore((state) => state.day);
  const today = useHistoryStore((state) => state.today);
  const dayEvents = useHistoryStore((state) => state.dayEvents);
  const playhead = useHistoryStore((state) => state.playhead);
  const playing = useHistoryStore((state) => state.playing);
  const loading = useHistoryStore((state) => state.loading);
  const error = useHistoryStore((state) => state.error);
  const stats = useHistoryStore((state) => state.stats);
  const loadDay = useHistoryStore((state) => state.loadDay);
  const togglePlay = useHistoryStore((state) => state.togglePlay);
  const scrubTo = useHistoryStore((state) => state.scrubTo);
  const stepBy = useHistoryStore((state) => state.stepBy);
  const exit = useHistoryStore((state) => state.exit);
  const viewport = useViewport();
  usePlayback();

  return (
    <HistoryBarView
      day={day}
      today={today}
      dayEvents={dayEvents}
      playhead={playhead}
      playing={playing}
      loading={loading}
      error={error}
      stats={stats}
      style={barStyle(historyBarBox(viewport))}
      onSelectDay={(next) => void loadDay(next)}
      onTogglePlay={togglePlay}
      onScrub={scrubTo}
      onStep={stepBy}
      onExit={exit}
      onReload={() => void loadDay(day)}
    />
  );
}
