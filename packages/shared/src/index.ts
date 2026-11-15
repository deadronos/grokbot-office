export const APP_NAME = "Grokbot Office";

export const HEALTH_PATH = "/api/health";

export type Health = {
  ok: boolean;
  service: string;
};
