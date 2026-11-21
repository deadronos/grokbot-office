import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

/** The repo root, where the shared `.env` lives. */
const root = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  // Same PORT as the server (root `.env`), so changing it does not break the proxy.
  const port = loadEnv(mode, root, "").PORT?.trim() || "8787";

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": `http://127.0.0.1:${port}`,
      },
    },
    test: {
      environment: "node",
    },
  };
});
