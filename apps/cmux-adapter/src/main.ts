import { run } from "./run.ts";

// launchd stops the job with SIGTERM; a zero exit keeps KeepAlive from restarting it.
process.once("SIGTERM", () => process.exit(0));

await run(process.env, { once: process.argv.includes("--once") });
