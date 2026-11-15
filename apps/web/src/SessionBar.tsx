import { ConnectionIndicator } from "./ConnectionIndicator";
import { useOfficeStore } from "./store/officeStore";

/** Connection state and a sign-out control, shown once a session is live. */
export function SessionBar() {
  const logout = useOfficeStore((state) => state.logout);

  return (
    <div className="session-bar">
      <ConnectionIndicator />
      <button type="button" className="logout-button" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}
