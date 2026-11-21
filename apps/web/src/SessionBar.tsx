import { ConnectionIndicator } from "./ConnectionIndicator";
import { useHistoryStore } from "./history/historyStore";
import { useOfficeStore } from "./store/officeStore";

/** Connection state, the history toggle, and a sign-out control, once a session is live. */
export function SessionBar() {
  const logout = useOfficeStore((state) => state.logout);
  const historyActive = useHistoryStore((state) => state.active);
  const enterHistory = useHistoryStore((state) => state.enter);
  const exitHistory = useHistoryStore((state) => state.exit);

  return (
    <div className="session-bar">
      <ConnectionIndicator />
      <button
        type="button"
        className="history-toggle"
        aria-pressed={historyActive}
        onClick={() => {
          if (historyActive) exitHistory();
          else void enterHistory();
        }}
      >
        {historyActive ? "Back to live" : "History"}
      </button>
      <button type="button" className="logout-button" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}
