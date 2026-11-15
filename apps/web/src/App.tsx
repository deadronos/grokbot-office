import { Suspense, lazy, useCallback, useEffect, useState } from "react";

import { APP_NAME } from "@grokbot-office/shared";

import { ConnectionIndicator } from "./ConnectionIndicator";
import { LoginScreen } from "./LoginScreen";
import { useOfficeStore } from "./store/officeStore";
import { WebGlErrorBoundary, WebGlFallback } from "./WebGlErrorBoundary";

// The three/R3F code is its own async chunk, so the shell paints first.
const OfficeScene = lazy(() => import("./scene/OfficeScene"));

function OfficeStage() {
  const [unavailable, setUnavailable] = useState(false);
  const handleContextLost = useCallback(() => setUnavailable(true), []);

  if (unavailable) return <WebGlFallback />;

  return (
    <WebGlErrorBoundary>
      <Suspense fallback={<p className="scene-loading">Loading the office…</p>}>
        <OfficeScene onContextLost={handleContextLost} />
      </Suspense>
    </WebGlErrorBoundary>
  );
}

export function App() {
  const phase = useOfficeStore((state) => state.phase);
  const checkSession = useOfficeStore((state) => state.checkSession);
  const startStream = useOfficeStore((state) => state.startStream);

  // 200 means the session cookie is still good; 401 puts the login form up.
  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (phase !== "ready") return;
    return startStream();
  }, [phase, startStream]);

  return (
    <main className="app">
      <h1 className="app-title">{APP_NAME}</h1>
      <OfficeStage />
      {phase === "ready" ? <ConnectionIndicator /> : null}
      {phase === "login" ? <LoginScreen /> : null}
    </main>
  );
}
