import { serve } from "@hono/node-server";

import { app } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`grokbot-office server listening on http://127.0.0.1:${info.port}`);
});
