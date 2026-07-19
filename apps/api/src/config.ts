import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readIntegrationSecrets,
  type AppleNotesGrantSecret,
  type HomeAssistantConnectionSecret,
  type TpLinkConnectionSecret,
} from "./integration-secrets.js";

export interface AppConfig {
  port: number;
  apiHost: string;
  databasePath: string;
  /** Optional local-only research engine. Older programmatic configs may omit these fields. */
  spatialLayersEnabled?: boolean;
  spatialLayersDatabasePath?: string;
  spatialLayersIntervalMs?: number;
  spatialLayersRetentionDays?: number;
  integrationSecretsFile: string;
  assetDirectory: string;
  /** Shared, non-secret coordination directory used by the isolated backup worker. */
  backupOperationsDirectory?: string;
  /** Read-only manifest discovery path for local/non-Compose operation. */
  backupDirectory?: string;
  mockEnabled: boolean;
  mockIntervalMs: number;
  retentionDays: number;
  /** Optional durable time-series store. SQLite remains the local control plane and fallback. */
  timeseriesEnabled?: boolean;
  /** Fail startup when the time-series store cannot be initialized. Off by default for local resilience. */
  timeseriesRequired?: boolean;
  timeseriesHost?: string;
  timeseriesPort?: number;
  timeseriesDatabase?: string;
  timeseriesUser?: string;
  /** Write-only PostgreSQL credential. Never include AppConfig in logs or API responses. */
  timeseriesPassword?: string;
  /** PostgreSQL transport security. Compose's private network uses disable. */
  timeseriesSslMode?: "disable" | "require" | "verify-ca" | "verify-full";
  /** Optional PEM CA bundle contents loaded from TIMESERIES_SSL_CA_FILE. */
  timeseriesSslCa?: string | null;
  timeseriesPoolMax?: number;
  timeseriesConnectTimeoutMs?: number;
  timeseriesStatementTimeoutMs?: number;
  timeseriesBatchSize?: number;
  ingestApiKey: string | null;
  haUrl: string | null;
  haToken: string | null;
  haEntityMapFile: string | null;
  /** House-scoped connections saved through the UI. Legacy HA_* remains one advanced override. */
  homeAssistantConnections?: HomeAssistantConnectionSecret[];
  /** A saved UI migration/disconnect prevents legacy HA_* from reappearing after restart. */
  homeAssistantLegacyDisabled?: boolean;
  tpLinkHost: string | null;
  tpLinkUsername: string | null;
  tpLinkPassword: string | null;
  /** House-scoped connections saved through the UI. Legacy TP_LINK_* remains one advanced override. */
  tpLinkConnections?: TpLinkConnectionSecret[];
  /** A saved UI migration/disconnect prevents legacy TP_LINK_* from reappearing after restart. */
  tpLinkLegacyDisabled?: boolean;
  tpLinkDeviceMapFile: string | null;
  tpLinkPollIntervalMs: number;
  tpLinkPython: string;
  tpLinkBridgeScript: string;
  alertWebhookUrl: string | null;
  alertWebhookBearerToken: string | null;
  /** Optional HMAC-SHA256 signing key. Receivers verify X-Stuga-Timestamp and X-Stuga-Signature. */
  alertWebhookSigningSecret?: string | null;
  /** Exact host allowlist; redirects are never followed. */
  alertWebhookAllowedHosts?: string[];
  /** Effective source, used only to mirror environment credentials into protected backup storage. */
  alertWebhookSource?: "environment" | "protected-file" | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  appleNotesGrants: AppleNotesGrantSecret[];
  corsOrigin: string | null;
  /** Optional high-entropy secret that explicitly permits first-owner setup off loopback. */
  localAuthBootstrapSecret?: string | null;
  /** Unit/integration-test compatibility only; rejected outside NODE_ENV=test. */
  localAuthTestBypass?: boolean;
  /** Browser-visible bind of the bundled private proxy; only an explicit loopback value enables proxy bootstrap. */
  localAuthProxyBindAddress?: string | null;
  /** High-entropy credential used to authenticate the immediate reverse proxy. */
  localAuthProxySecret?: string | null;
  /** Explicit opt-in for a deliberately private-network custom electricity feed. */
  electricityAllowPrivateEndpoints?: boolean;
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

function timeseriesSslMode(value: string | undefined): NonNullable<AppConfig["timeseriesSslMode"]> {
  const normalized = optional(value) ?? "disable";
  if (!["disable", "require", "verify-ca", "verify-full"].includes(normalized)) {
    throw new Error("TIMESERIES_SSL_MODE must be disable, require, verify-ca, or verify-full");
  }
  return normalized as NonNullable<AppConfig["timeseriesSslMode"]>;
}

function timeseriesPassword(env: NodeJS.ProcessEnv): string {
  const inline = env.TIMESERIES_PASSWORD;
  const configuredFile = optional(env.TIMESERIES_PASSWORD_FILE);
  if (inline !== undefined && configuredFile) {
    throw new Error("Configure only one of TIMESERIES_PASSWORD or TIMESERIES_PASSWORD_FILE");
  }
  if (!configuredFile) return inline ?? "";
  const password = readFileSync(resolve(configuredFile), "utf8").trim();
  if (!password) throw new Error("TIMESERIES_PASSWORD_FILE must not be empty");
  return password;
}

function validatedSecret(value: string, label: string): string {
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${label} must contain at least 32 UTF-8 bytes`);
  }
  return value;
}

function localAuthProxySecret(env: NodeJS.ProcessEnv): string | null {
  const inline = optional(env.LOCAL_AUTH_PROXY_SECRET);
  const configuredFile = optional(env.LOCAL_AUTH_PROXY_SECRET_FILE);
  if (inline && configuredFile) {
    throw new Error("Configure only one of LOCAL_AUTH_PROXY_SECRET or LOCAL_AUTH_PROXY_SECRET_FILE");
  }
  if (inline) return validatedSecret(inline, "LOCAL_AUTH_PROXY_SECRET");
  if (!configuredFile) return null;

  const path = resolve(configuredFile);
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dirname(path), { recursive: true });
    value = randomBytes(32).toString("hex");
    try {
      // The proxy mounts this dedicated volume read-only. World-readable mode
      // is intentional within that volume because the two images use distinct UIDs.
      writeFileSync(path, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o444 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      value = readFileSync(path, "utf8").trim();
    }
  }
  if (!value) throw new Error("LOCAL_AUTH_PROXY_SECRET_FILE must not be empty");
  return validatedSecret(value, "LOCAL_AUTH_PROXY_SECRET_FILE contents");
}

function environmentTuple(
  env: NodeJS.ProcessEnv,
  label: string,
  keys: readonly string[],
): string[] | null {
  const values = keys.map((key) => optional(env[key]));
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) {
    throw new Error(`${label} environment configuration requires ${keys.join(", ")}`);
  }
  return values as string[];
}

function httpEndpoint(value: string, label: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a valid HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label} must be an HTTP(S) URL without embedded credentials`);
  }
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databasePath = env.DATABASE_PATH === ":memory:"
    ? ":memory:"
    : resolve(env.DATABASE_PATH ?? "./data/climate-twin.sqlite");
  const integrationSecretsFile = resolve(env.INTEGRATION_SECRETS_FILE
    ?? (databasePath === ":memory:" ? "./data/integration-secrets.json" : join(dirname(databasePath), "integration-secrets.json")));
  const configuredSpatialLayersPath = optional(env.SPATIAL_LAYERS_DATABASE_PATH);
  const spatialLayersDatabasePath = configuredSpatialLayersPath === ":memory:"
    || (configuredSpatialLayersPath === null && databasePath === ":memory:")
    ? ":memory:"
    : resolve(configuredSpatialLayersPath ?? join(dirname(databasePath), "experimental-spatial-layers.sqlite"));
  const stored = env.NODE_ENV === "test" && env.INTEGRATION_SECRETS_FILE === undefined
    ? { version: 1 as const }
    : readIntegrationSecrets(integrationSecretsFile);
  const haEnvironment = environmentTuple(env, "Home Assistant", ["HA_URL", "HA_TOKEN"]);
  const tpLinkEnvironment = environmentTuple(env, "TP-Link", ["TP_LINK_HOST", "TP_LINK_USERNAME", "TP_LINK_PASSWORD"]);
  const telegramEnvironment = environmentTuple(env, "Telegram", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  const alertWebhookEnvironmentUrl = optional(env.ALERT_WEBHOOK_URL);
  const alertWebhookEnvironmentBearerToken = optional(env.ALERT_WEBHOOK_BEARER_TOKEN);
  const alertWebhookEnvironmentSigningSecret = optional(env.ALERT_WEBHOOK_SIGNING_SECRET);
  const localAuthBootstrapSecret = optional(env.LOCAL_AUTH_BOOTSTRAP_SECRET);
  if (localAuthBootstrapSecret && Buffer.byteLength(localAuthBootstrapSecret, "utf8") < 32) {
    throw new Error("LOCAL_AUTH_BOOTSTRAP_SECRET must contain at least 32 UTF-8 bytes");
  }
  const localAuthTestBypass = booleanValue(env.LOCAL_AUTH_TEST_BYPASS, env.NODE_ENV === "test");
  if (localAuthTestBypass && env.NODE_ENV !== "test") {
    throw new Error("LOCAL_AUTH_TEST_BYPASS may only be enabled with NODE_ENV=test");
  }
  const localAuthProxyBindAddress = optional(env.LOCAL_AUTH_PROXY_BIND_ADDRESS);
  const proxySecret = localAuthProxySecret(env);
  if (!alertWebhookEnvironmentUrl && alertWebhookEnvironmentBearerToken) {
    throw new Error("ALERT_WEBHOOK_BEARER_TOKEN requires ALERT_WEBHOOK_URL");
  }
  if (!alertWebhookEnvironmentUrl && alertWebhookEnvironmentSigningSecret) {
    throw new Error("ALERT_WEBHOOK_SIGNING_SECRET requires ALERT_WEBHOOK_URL");
  }
  if (alertWebhookEnvironmentSigningSecret && Buffer.byteLength(alertWebhookEnvironmentSigningSecret, "utf8") < 32) {
    throw new Error("ALERT_WEBHOOK_SIGNING_SECRET must contain at least 32 UTF-8 bytes");
  }
  const ha = haEnvironment
    ? { url: httpEndpoint(haEnvironment[0]!, "HA_URL"), token: haEnvironment[1]! }
    : stored.homeAssistant ?? null;
  const tpLink = tpLinkEnvironment
    ? { host: tpLinkEnvironment[0]!, username: tpLinkEnvironment[1]!, password: tpLinkEnvironment[2]! }
    : stored.tpLink ?? null;
  const telegram = telegramEnvironment
    ? { botToken: telegramEnvironment[0]!, chatId: telegramEnvironment[1]! }
    : stored.telegram ?? null;
  const webhook = alertWebhookEnvironmentUrl
    ? {
        url: httpEndpoint(alertWebhookEnvironmentUrl, "ALERT_WEBHOOK_URL"),
        bearerToken: alertWebhookEnvironmentBearerToken,
        signingSecret: alertWebhookEnvironmentSigningSecret,
        source: "environment" as const,
      }
    : stored.webhook
      ? {
          url: httpEndpoint(stored.webhook.url, "stored webhook URL"),
          bearerToken: stored.webhook.bearerToken ?? null,
          signingSecret: stored.webhook.signingSecret ?? null,
          source: "protected-file" as const,
        }
      : null;
  const timeseriesEnabled = booleanValue(env.TIMESERIES_ENABLED, false);
  const timeseriesRequired = booleanValue(env.TIMESERIES_REQUIRED, false);
  if (timeseriesRequired && !timeseriesEnabled) {
    throw new Error("TIMESERIES_REQUIRED=true requires TIMESERIES_ENABLED=true");
  }
  const configuredTimeseriesCa = optional(env.TIMESERIES_SSL_CA_FILE);
  const retentionDays = nonNegativeInteger(env.RETENTION_DAYS, 0);
  if (retentionDays > 0 && retentionDays < 30) throw new Error("RETENTION_DAYS must be 0 or at least 30");
  if (retentionDays > 0 && !timeseriesEnabled) throw new Error("RETENTION_DAYS requires TIMESERIES_ENABLED=true");

  return {
    port: positiveInteger(env.PORT, 8787),
    apiHost: optional(env.API_HOST) ?? "127.0.0.1",
    databasePath,
    spatialLayersEnabled: booleanValue(env.SPATIAL_LAYERS_ENABLED, env.NODE_ENV !== "test"),
    spatialLayersDatabasePath,
    spatialLayersIntervalMs: positiveInteger(env.SPATIAL_LAYERS_INTERVAL_MS, 60_000),
    spatialLayersRetentionDays: positiveInteger(env.SPATIAL_LAYERS_RETENTION_DAYS, 30),
    integrationSecretsFile,
    assetDirectory: resolve(env.ASSET_DIRECTORY ?? "./data/assets"),
    backupOperationsDirectory: resolve(env.BACKUP_OPERATIONS_DIRECTORY ?? "./data/backup-operations"),
    backupDirectory: resolve(env.BACKUP_DIRECTORY ?? "./backups"),
    mockEnabled: booleanValue(env.MOCK_ENABLED, false),
    mockIntervalMs: positiveInteger(env.MOCK_INTERVAL_MS, 2_000),
    // Zero keeps the complete redundant SQLite copy. A positive value bounds
    // only the hot copy after archive reconciliation; Timescale raw data is
    // deliberately retained without a deletion policy.
    retentionDays,
    timeseriesEnabled,
    timeseriesRequired,
    timeseriesHost: optional(env.TIMESERIES_HOST) ?? "127.0.0.1",
    timeseriesPort: positiveInteger(env.TIMESERIES_PORT, 5432),
    timeseriesDatabase: optional(env.TIMESERIES_DATABASE) ?? "stuga",
    timeseriesUser: optional(env.TIMESERIES_USER) ?? "stuga_app",
    timeseriesPassword: timeseriesPassword(env),
    timeseriesSslMode: timeseriesSslMode(env.TIMESERIES_SSL_MODE),
    timeseriesSslCa: configuredTimeseriesCa ? readFileSync(resolve(configuredTimeseriesCa), "utf8") : null,
    timeseriesPoolMax: positiveInteger(env.TIMESERIES_POOL_MAX, 6),
    timeseriesConnectTimeoutMs: positiveInteger(env.TIMESERIES_CONNECT_TIMEOUT_MS, 5_000),
    timeseriesStatementTimeoutMs: positiveInteger(env.TIMESERIES_STATEMENT_TIMEOUT_MS, 15_000),
    timeseriesBatchSize: positiveInteger(env.TIMESERIES_BATCH_SIZE, 1_000),
    ingestApiKey: optional(env.INGEST_API_KEY),
    haUrl: ha?.url ?? null,
    haToken: ha?.token ?? null,
    haEntityMapFile: optional(env.HA_ENTITY_MAP_FILE),
    homeAssistantConnections: (stored.homeAssistantConnections ?? []).map((connection) => ({
      ...connection,
      url: httpEndpoint(connection.url, `Home Assistant URL for house ${connection.houseId}`),
    })),
    homeAssistantLegacyDisabled: stored.homeAssistantLegacyDisabled === true,
    tpLinkHost: tpLink?.host ?? null,
    tpLinkUsername: tpLink?.username ?? null,
    tpLinkPassword: tpLink?.password ?? null,
    tpLinkConnections: (stored.tpLinkConnections ?? []).map((connection) => ({ ...connection })),
    tpLinkLegacyDisabled: stored.tpLinkLegacyDisabled === true,
    tpLinkDeviceMapFile: optional(env.TP_LINK_DEVICE_MAP_FILE),
    tpLinkPollIntervalMs: positiveInteger(env.TP_LINK_POLL_INTERVAL_MS, 10_000),
    tpLinkPython: optional(env.TP_LINK_PYTHON) ?? (process.platform === "win32" ? "python" : "python3"),
    tpLinkBridgeScript: resolve(env.TP_LINK_BRIDGE_SCRIPT ?? "./apps/api/python/tp_link_bridge.py"),
    alertWebhookUrl: webhook?.url ?? null,
    alertWebhookBearerToken: webhook?.bearerToken ?? null,
    alertWebhookSigningSecret: webhook?.signingSecret ?? null,
    alertWebhookAllowedHosts: [...new Set((optional(env.ALERT_WEBHOOK_ALLOWED_HOSTS)?.split(",")
      .map((host) => host.trim().toLowerCase()).filter(Boolean)
      ?? (webhook?.url ? [new URL(webhook.url).hostname.toLowerCase()] : [])))],
    alertWebhookSource: webhook?.source ?? null,
    telegramBotToken: telegram?.botToken ?? null,
    telegramChatId: telegram?.chatId ?? null,
    appleNotesGrants: (stored.appleNotesGrants ?? []).map((grant) => ({ ...grant })),
    corsOrigin: optional(env.CORS_ORIGIN),
    localAuthBootstrapSecret,
    localAuthTestBypass,
    localAuthProxyBindAddress,
    localAuthProxySecret: proxySecret,
    electricityAllowPrivateEndpoints: booleanValue(env.ELECTRICITY_ALLOW_PRIVATE_ENDPOINTS, false),
  };
}
