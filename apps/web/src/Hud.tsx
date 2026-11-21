import { DESKS, type BotSnapshot, type StreamEvent } from "@grokbot-office/shared";

import { useOfficeStore } from "./store/officeStore";

const DESK_ORDER = new Map(DESKS.map((desk, index) => [desk.botId, index]));

/** Compact age for the HUD; the clock is injectable so tests do not depend on now. */
export function formatSince(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** One plain-text line per event; React renders it as text, never as markup. */
export function describeEvent(event: StreamEvent): string {
  switch (event.type) {
    case "status_changed":
      return ["status", event.status, event.label].filter(Boolean).join(" · ");
    case "task_started":
      return ["started", event.label ?? event.taskId].filter(Boolean).join(" · ");
    case "task_finished":
      return ["finished", event.result].filter(Boolean).join(" · ");
    case "handoff_sent":
      return ["handoff", event.to && `to ${event.to}`, event.label].filter(Boolean).join(" · ");
    case "handoff_accepted":
      return ["accepted", event.label ?? event.taskId].filter(Boolean).join(" · ");
    case "offline":
      return "went offline";
    case "bot_registered":
      return "registered";
  }
}

function byDeskThenName(a: { id: string; name: string }, b: { id: string; name: string }): number {
  const order = (DESK_ORDER.get(a.id) ?? DESKS.length) - (DESK_ORDER.get(b.id) ?? DESKS.length);
  return order !== 0 ? order : a.name.localeCompare(b.name);
}

/** Sits in the shell, outside the lazy scene chunk: it only needs the store. */
export function Hud({ now }: { now: number }) {
  const bots = useOfficeStore((state) => state.bots);
  const events = useOfficeStore((state) => state.events);
  return <HudView bots={bots} events={events} now={now} />;
}

/** Pure view so the HUD can be rendered without a live store (or a WebGL canvas). */
export function HudView({
  bots,
  events,
  now,
}: {
  bots: Record<string, BotSnapshot>;
  events: StreamEvent[];
  now: number;
}) {
  const list = Object.values(bots).toSorted(byDeskThenName);

  return (
    <aside className="hud" aria-label="Office status">
      <section className="hud-section">
        <h2 className="hud-heading">Bots</h2>
        <ul className="hud-bots">
          {list.map((bot) => (
            <li key={bot.id} className="hud-bot">
              <span className={`status-dot status-${bot.status}`} aria-hidden="true" />
              <span className="hud-name">{bot.name}</span>
              <span className="hud-status">{bot.status}</span>
              {bot.label ? <span className="hud-label">{bot.label}</span> : null}
              <time className="hud-since" dateTime={bot.since}>
                {formatSince(bot.since, now)}
              </time>
            </li>
          ))}
          {list.length === 0 ? <li className="hud-empty">No bots online.</li> : null}
        </ul>
      </section>
      <section className="hud-section">
        <h2 className="hud-heading">Recent events</h2>
        <ol className="hud-events">
          {events
            .slice(-20)
            .toReversed()
            .map((event) => (
              <li key={event.seq} className="hud-event">
                <time className="hud-since" dateTime={event.at ?? event.receivedAt}>
                  {formatSince(event.at ?? event.receivedAt, now)}
                </time>
                <span className="hud-name">{event.botId}</span>
                <span className="hud-status">{describeEvent(event)}</span>
              </li>
            ))}
          {events.length === 0 ? <li className="hud-empty">No events yet.</li> : null}
        </ol>
      </section>
      <footer className="hud-credit">
        Models: <a href="https://kenney.nl">Kenney</a> (CC0)
      </footer>
    </aside>
  );
}
