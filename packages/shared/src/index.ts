export const APP_NAME = "Grokbot Office";

export const HEALTH_PATH = "/api/health";

export type Health = {
  ok: boolean;
  service: string;
};

export * from "./enums.ts";
export * from "./layout.ts";
export * from "./sanitize.ts";
export * from "./schemas.ts";
