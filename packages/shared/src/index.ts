export const APP_NAME = "Grokbot Office";

export const HEALTH_PATH = "/api/health";

export type Health = {
  ok: boolean;
  service: string;
};

export * from "./enums";
export * from "./layout";
export * from "./sanitize";
export * from "./schemas";
