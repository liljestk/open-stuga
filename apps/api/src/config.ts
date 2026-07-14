import { dirname, join, resolve } from "node:path";
import { readIntegrationSecrets } from "./integration-secrets.js";

export interface AppConfig {
  port: number;
  apiHost: string;
  databasePath: string;
  integrationSecretsFile: string;
  assetDirectory: string;
  mockEnabled: boolean;
  mockIntervalMs: number;
  retentionDays: number;
  ingestApiKey: string | null;
  haUrl: string | null;
  haToken: string | null;
  haEntityMapFile: string | null;
  tpLinkHost: string | null;
  tpLinkUsername: string | null;
  tpLinkPassword: string | null;
  tpLinkDeviceMapFile: string | null;
  tpLinkPollIntervalMs: number;
  tpLinkPython: string;
  tpLinkBridgeScript: string;
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
  const integrationSecretsFile = resolve(env.INTEGRATION_SECRETS_FILE
    ?? (databasePath === ":memory:" ? "./data/integration-secrets.json" : join(dirname(databasePath), "integration-secrets.json")));
  const stored = env.NODE_ENV === "test" && env.INTEGRATION_SECRETS_FILE === undefined
    ? { version: 1 as const }
    : readIntegrationSecrets(integrationSecretsFile);

  return {
    port: positiveInteger(env.PORT, 8787),
    apiHost: optional(env.API_HOST) ?? "127.0.0.1",
    databasePath,
    integrationSecretsFile,
    assetDirectory: resolve(env.ASSET_DIRECTORY ?? "./data/assets"),
    mockEnabled: booleanValue(env.MOCK_ENABLED, env.NODE_ENV !== "test"),
    mockIntervalMs: positiveInteger(env.MOCK_INTERVAL_MS, 2_000),
    retentionDays: positiveInteger(env.RETENTION_DAYS, 730),
    ingestApiKey: optional(env.INGEST_API_KEY),
    haUrl: optional(env.HA_URL) ?? stored.homeAssistant?.url ?? null,
    haToken: optional(env.HA_TOKEN) ?? stored.homeAssistant?.token ?? null,
    haEntityMapFile: optional(env.HA_ENTITY_MAP_FILE),
    tpLinkHost: optional(env.TP_LINK_HOST) ?? stored.tpLink?.host ?? null,
    tpLinkUsername: optional(env.TP_LINK_USERNAME) ?? stored.tpLink?.username ?? null,
    tpLinkPassword: optional(env.TP_LINK_PASSWORD) ?? stored.tpLink?.password ?? null,
    tpLinkDeviceMapFile: optional(env.TP_LINK_DEVICE_MAP_FILE),
    tpLinkPollIntervalMs: positiveInteger(env.TP_LINK_POLL_INTERVAL_MS, 10_000),
    tpLinkPython: optional(env.TP_LINK_PYTHON) ?? (process.platform === "win32" ? "python" : "python3"),
    tpLinkBridgeScript: resolve(env.TP_LINK_BRIDGE_SCRIPT ?? "./apps/api/python/tp_link_bridge.py"),
    alertWebhookUrl: optional(env.ALERT_WEBHOOK_URL),
    alertWebhookBearerToken: optional(env.ALERT_WEBHOOK_BEARER_TOKEN),
    corsOrigin: optional(env.CORS_ORIGIN),
  };
}
