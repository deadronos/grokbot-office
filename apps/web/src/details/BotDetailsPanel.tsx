import type { BotSnapshot, Handoff } from "@grokbot-office/shared";
import { useEffect, useRef } from "react";

import { botStatusLabel, describeEvent } from "../Hud";
import { useOfficeStore, type OfficeStore } from "../store/officeStore";
import { botDetails, type BotDetails } from "./botDetails";

/** Escape is the keyboard close path; it works from anywhere on the page. */
export function isCloseKey(key: string): boolean {
  return key === "Escape";
}

/**
 * The panel follows the store selection. A bot that is not in the snapshot has no
 * row, so there is nothing to open (hidden bots stay hidden). Returns the stored
 * bot object itself, so the selector stays referentially stable.
 */
export function panelBot(
  state: Pick<OfficeStore, "bots" | "selectedBotId">,
): BotSnapshot | undefined {
  return state.selectedBotId ? state.bots[state.selectedBotId] : undefined;
}

/**
 * What a focus restore needs from an element; the page body stands in for a
 * HUD row that left the snapshot while the panel was open.
 */
export type FocusTarget = { focus: () => void; isConnected: boolean };

/** Where closing sends focus: the stored row while it exists, else the fallback. */
export function focusRestoreTarget<T extends FocusTarget>(previous: T | null, fallback: T): T {
  return previous?.isConnected ? previous : fallback;
}

/** A bot switch stores whatever holds focus now, so close returns to the new row. */
export function retargetFocus<T extends FocusTarget>(
  previous: T | null,
  active: T | null,
): T | null {
  return active ?? previous;
}

export function BotDetailsPanel({ now }: { now: number }) {
  const bot = useOfficeStore(panelBot);
  const bots = useOfficeStore((state) => state.bots);
  const openHandoffs = useOfficeStore((state) => state.openHandoffs);
  const events = useOfficeStore((state) => state.events);
  const clearSelectedBot = useOfficeStore((state) => state.clearSelectedBot);

  if (!bot) return null;
  return (
    <BotDetailsView
      bot={bot}
      details={botDetails(bot, openHandoffs, events, bots)}
      now={now}
      onClose={clearSelectedBot}
    />
  );
}

function HandoffList({ title, handoffs }: { title: string; handoffs: Handoff[] }) {
  return (
    <section className="details-section">
      <h3 className="details-heading">{title}</h3>
      {handoffs.length === 0 ? (
        <p className="details-empty">None open.</p>
      ) : (
        <ul className="details-list">
          {handoffs.map((handoff) => (
            <li key={handoff.id} className="details-item">
              <span>
                {handoff.fromBotId} → {handoff.toBotId}
              </span>
              {handoff.label ? <span className="details-label">{handoff.label}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Pure view: text only, so every label renders as text, never as markup. */
export function BotDetailsView({
  bot,
  details,
  onClose,
  now,
}: {
  bot: BotSnapshot;
  details: BotDetails;
  onClose: () => void;
  /** Wall clock for the `away` age; injectable so tests do not depend on now. */
  now: number;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // Whatever opened the panel; a switch retargets it to the newly chosen row.
  const previousRef = useRef<FocusTarget | null>(null);
  const shownBotIdRef = useRef(bot.id);

  // Focus moves in on open and returns on close; `onClose` is stable.
  useEffect(() => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousRef.current = active;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCloseKey(event.key)) onClose();
    };
    closeRef.current?.focus();
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      // The HUD entry may be gone (bot left the snapshot); the body is the fallback.
      focusRestoreTarget(previousRef.current, document.body).focus();
    };
  }, [onClose]);

  // Switching bots in place only retargets: the cleanup above must not steal
  // focus back to the row of the bot that was shown before the switch.
  useEffect(() => {
    if (shownBotIdRef.current === bot.id) return;
    shownBotIdRef.current = bot.id;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousRef.current = retargetFocus(previousRef.current, active);
  }, [bot.id]);

  return (
    <section className="details-panel" role="dialog" aria-labelledby="bot-details-name">
      <header className="details-header">
        <h2 className="details-name" id="bot-details-name">
          {bot.name}
        </h2>
        <button type="button" className="details-close" ref={closeRef} onClick={onClose}>
          Close
        </button>
      </header>
      <dl className="details-facts">
        <div className="details-fact">
          <dt>Role</dt>
          <dd>{bot.role}</dd>
        </div>
        <div className="details-fact">
          <dt>Status</dt>
          <dd>{botStatusLabel(bot, now)}</dd>
        </div>
        {bot.label ? (
          <div className="details-fact">
            <dt>Task</dt>
            <dd>{bot.label}</dd>
          </div>
        ) : null}
        {bot.taskId ? (
          <div className="details-fact">
            <dt>Task id</dt>
            <dd>{bot.taskId}</dd>
          </div>
        ) : null}
      </dl>
      <HandoffList title="Handoffs in" handoffs={details.handoffsIn} />
      <HandoffList title="Handoffs out" handoffs={details.handoffsOut} />
      <section className="details-section">
        <h3 className="details-heading">Recent events</h3>
        {details.events.length === 0 ? (
          <p className="details-empty">No events yet.</p>
        ) : (
          <ol className="details-list">
            {details.events.map((event) => (
              <li key={event.seq} className="details-item">
                {describeEvent(event)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
