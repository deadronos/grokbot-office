import { Suspense, lazy } from "react";

import { APP_NAME } from "@grokbot-office/shared";

// The three/R3F code is its own async chunk, so the shell paints first.
const OfficeScene = lazy(() => import("./scene/OfficeScene"));

export function App() {
  return (
    <main className="app">
      <h1 className="app-title">{APP_NAME}</h1>
      <Suspense fallback={<p className="scene-loading">Loading the office…</p>}>
        <OfficeScene />
      </Suspense>
    </main>
  );
}
