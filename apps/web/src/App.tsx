import { Suspense, lazy, useCallback, useState } from "react";

import { APP_NAME } from "@grokbot-office/shared";

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
  return (
    <main className="app">
      <h1 className="app-title">{APP_NAME}</h1>
      <OfficeStage />
    </main>
  );
}
