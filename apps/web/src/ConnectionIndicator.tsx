import { useOfficeStore, type Connection } from "./store/officeStore";

export const CONNECTION_LABELS: Record<Connection, string> = {
  live: "live",
  reconnecting: "reconnecting",
  closed: "office closed",
};

/** Top-of-screen link state: the only HUD element #11 adds. */
export function ConnectionIndicator() {
  const connection = useOfficeStore((state) => state.connection);
  return (
    <p className={`connection connection-${connection}`} role="status" aria-live="polite">
      {CONNECTION_LABELS[connection]}
    </p>
  );
}
