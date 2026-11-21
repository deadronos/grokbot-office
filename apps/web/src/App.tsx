import { Suspense, lazy, useCallback, useEffect, useState } from "react";

import { APP_NAME } from "@grokbot-office/shared";

import { HistoryBar } from "./history/HistoryBar";
import { useHistoryStore } from "./history/historyStore";
import { Hud } from "./Hud";
import { BotDetailsPanel } from "./details/BotDetailsPanel";
import { SessionBar } from "./SessionBar";
import { LoginScreen } from "./LoginScreen";
import { useOfficeStore } from "./store/officeStore";
import { isWebGlAvailable } from "./webgl";
import { WebGlErrorBoundary, WebGlFallback } from "./WebGlErrorBoundary";

// The three/R3F code is its own async chunk, so the shell paints first.
const OfficeScene = lazy(() => import("./scene/OfficeScene"));

/** Exported so the no-WebGL path can be tested without mounting the canvas. */
export function OfficeStage() {
  const [unavailable, setUnavailable] = useState(false);
  // Checked before the lazy scene mounts, so three never logs a WebGL error first.
  const [supported] = useState(isWebGlAvailable);
  const handleContextLost = useCallback(() => setUnavailable(true), []);

  if (!supported || unavailable) return <WebGlFallback />;

  return (
    <WebGlErrorBoundary>
      <Suspense fallback={<p className="scene-loading">Loading the office…</p>}>
        <OfficeScene onContextLost={handleContextLost} />
      </Suspense>
    </WebGlErrorBoundary>
  );
}

/** Wall clock for the HUD ages; nothing else needs a timer. */
function useClock(): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function App() {
  const phase = useOfficeStore((state) => state.phase);
  const checkSession = useOfficeStore((state) => state.checkSession);
  const startStream = useOfficeStore((state) => state.startStream);
  const historyActive = useHistoryStore((state) => state.active);
  const exitHistory = useHistoryStore((state) => state.exit);
  const now = useClock();

  // 200 means the session cookie is still good; 401 puts the login form up.
  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (phase !== "ready") return;
    return startStream();
  }, [phase, startStream]);

  // A dropped session (logout or 401) must not leave the replay stranded.
  useEffect(() => {
    if (phase !== "ready" && historyActive) exitHistory();
  }, [phase, historyActive, exitHistory]);

  useEffect(() => {
    const onHide = () => useOfficeStore.getState().onPageHide();
    const onShow = (event: PageTransitionEvent) => {
      void useOfficeStore.getState().onPageShow(event.persisted);
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  return (
    <main className="app">
      <h1 className="app-title">{APP_NAME}</h1>
      <OfficeStage />
      {phase === "ready" ? <SessionBar /> : null}
      {phase === "ready" && now > 0 ? <Hud now={now} /> : null}
      {phase === "ready" && historyActive ? <HistoryBar /> : null}
      {phase === "ready" && !historyActive ? <BotDetailsPanel now={now} /> : null}
      {phase === "login" ? <LoginScreen /> : null}
    </main>
  );
}
