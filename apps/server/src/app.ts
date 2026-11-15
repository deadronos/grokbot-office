import { Hono } from "hono";

import { HEALTH_PATH, type Health } from "@grokbot-office/shared";

export const SERVICE_NAME = "grokbot-office-server";

export const app = new Hono();

app.get(HEALTH_PATH, (c) => c.json({ ok: true, service: SERVICE_NAME } satisfies Health));
