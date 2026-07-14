import { resolve } from "node:path";

export interface AppConfig {
  port: number;
  apiHost: string;
  databasePath: string;
  assetDirectory: string;
  mockEnabled: boolean;
  mockIntervalMs: number;
  retentionDays: number;
  ingestApiKey: string | null;
  haUrl: string | null;
  haToken: string | null;
  haEntityMapFile: string | null;
  alertWebhookUrl: string | null;
  alertWebhookBearerToken: string | null;
  corsOrigin: string | null;
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databasePath = env.DATABASE_PATH === ":memory:"
    ? ":memory:"
    : resolve(env.DATABASE_PATH ?? "./data/climate-twin.sqlite");

  return {
    port: positiveInteger(env.PORT, 8787),
    apiHost: optional(env.API_HOST) ?? "127.0.0.1",
    databasePath,
    assetDirectory: resolve(env.ASSET_DIRECTORY ?? "./data/assets"),
    mockEnabled: booleanValue(env.MOCK_ENABLED, env.NODE_ENV !== "test"),
    mockIntervalMs: positiveInteger(env.MOCK_INTERVAL_MS, 2_000),
    retentionDays: positiveInteger(env.RETENTION_DAYS, 730),
    ingestApiKey: optional(env.INGEST_API_KEY),
    haUrl: optional(env.HA_URL),
    haToken: optional(env.HA_TOKEN),
    haEntityMapFile: optional(env.HA_ENTITY_MAP_FILE),
    alertWebhookUrl: optional(env.ALERT_WEBHOOK_URL),
    alertWebhookBearerToken: optional(env.ALERT_WEBHOOK_BEARER_TOKEN),
    corsOrigin: optional(env.CORS_ORIGIN),
  };
}
