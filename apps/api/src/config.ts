import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readIntegrationSecrets,
  normalizedWebhookDestinations,
  type AppleNotesGrantSecret,
  type HomeAssistantConnectionSecret,
  type TpLinkConnectionSecret,
  type WebhookDestinationSecret,
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
  /** Enables asynchronous Tapo app/private-history fallback after local retention is exhausted. */
  tapoHistoryEnabled?: boolean;
  /** Route-scoped bearer secret shared only with the isolated Appium worker. */
  tapoHistoryWorkerToken?: string | null;
  tapoHistoryExportEmail?: string | null;
  tapoHistoryEmailTagPrefix?: string;
  tapoHistoryExportIntervalMinutes?: 1 | 15 | 30 | 60 | 360 | 720 | 1440;
  /** Conservative app-report span; the public UI has truncated longer requests in practice. */
  tapoHistoryMaxExportDays?: number;
  /** Bounds correlated app exports that have been submitted but not yet ingested. */
  tapoHistoryMaxPendingEmails?: number;
  tapoHistoryMailboxPollIntervalMs?: number;
  /** How long a submitted app export may wait for its correlated email before automatic retry. */
  tapoHistoryEmailTimeoutMs?: number;
  tapoHistoryWorkerLeaseMs?: number;
  /** Gmail OAuth credentials are write-only deployment secrets. */
  /** Primary mailbox identity returned by Gmail /users/me/profile. */
  tapoHistoryGmailAccountEmail?: string | null;
  tapoHistoryGmailClientId?: string | null;
  tapoHistoryGmailClientSecret?: string | null;
  tapoHistoryGmailRefreshToken?: string | null;
  /** Experimental, explicitly configured compatibility endpoint. Never enabled by default. */
  tapoHistoryPrivateEndpoint?: string | null;
  tapoHistoryPrivateToken?: string | null;
  alertWebhookUrl: string | null;
  alertWebhookBearerToken: string | null;
  /** All effective webhook destinations. Legacy singleton fields above project the primary/first entry. */
  alertWebhookDestinations?: WebhookDestinationSecret[];
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
  /** Optional account-scoped Cloudflare Access group synchronized from local members and invitations. */
  cloudflareAccessAccountId?: string | null;
  cloudflareAccessGroupId?: string | null;
  cloudflareAccessGroupName?: string | null;
  /** Cloudflare identities that permanently retain access, independent of local Stuga account email. */
  cloudflareAccessStaticEmails?: string[];
  /** Write-only, least-privilege Access group credential. Never log AppConfig. */
  cloudflareAccessApiToken?: string | null;
  cloudflareAccessSyncIntervalMs?: number;
  /** Explicit opt-in for a deliberately private-network custom electricity feed. */
  electricityAllowPrivateEndpoints?: boolean;
}

export function configuredAlertWebhookDestinations(
  config: Pick<AppConfig, "alertWebhookDestinations" | "alertWebhookUrl" | "alertWebhookBearerToken" | "alertWebhookSigningSecret">,
): WebhookDestinationSecret[] {
  if (config.alertWebhookDestinations !== undefined) {
    return config.alertWebhookDestinations.map((destination) => ({ ...destination }));
  }
  if (!config.alertWebhookUrl) return [];
  return [{
    id: "primary",
    url: config.alertWebhookUrl,
    ...(config.alertWebhookBearerToken ? { bearerToken: config.alertWebhookBearerToken } : {}),
    ...(config.alertWebhookSigningSecret ? { signingSecret: config.alertWebhookSigningSecret } : {}),
  }];
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizedEmailList(value: string | undefined, name: string): string[] {
  const emails = [...new Set((value ?? "").split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))];
  for (const email of emails) {
    if (email.length > 254 || !/^[^\s@<>,]+@[^\s@<>,]+$/.test(email)) {
      throw new Error(`${name} must contain only valid comma-separated email addresses`);
    }
  }
  return emails;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
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

function optionalFileSecret(
  env: NodeJS.ProcessEnv,
  inlineKey: string,
  fileKey: string,
  label: string,
  minimumBytes = 1,
  allowMissingFile = false,
): string | null {
  const inline = optional(env[inlineKey]);
  const configuredFile = optional(env[fileKey]);
  if (inline && configuredFile) throw new Error(`Configure only one of ${inlineKey} or ${fileKey}`);
  const resolvedFile = configuredFile ? resolve(configuredFile) : null;
  if (!inline && resolvedFile && allowMissingFile && !existsSync(resolvedFile)) return null;
  const value = inline ?? (resolvedFile ? readFileSync(resolvedFile, "utf8").trim() : null);
  if (value !== null && Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${label} must contain at least ${minimumBytes} UTF-8 bytes`);
  }
  return value;
}

function exportIntervalMinutes(value: string | undefined): 1 | 15 | 30 | 60 | 360 | 720 | 1440 {
  const parsed = Number(value ?? 15);
  if (![1, 15, 30, 60, 360, 720, 1440].includes(parsed)) {
    throw new Error("TAPO_HISTORY_EXPORT_INTERVAL_MINUTES must be 1, 15, 30, 60, 360, 720, or 1440");
  }
  return parsed as 1 | 15 | 30 | 60 | 360 | 720 | 1440;
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
  const tapoGmailClientId = optional(env.TAPO_HISTORY_GMAIL_CLIENT_ID);
  const tapoGmailClientSecret = optionalFileSecret(
    env, "TAPO_HISTORY_GMAIL_CLIENT_SECRET", "TAPO_HISTORY_GMAIL_CLIENT_SECRET_FILE", "Tapo Gmail client secret", 1, true,
  );
  const tapoGmailRefreshToken = optionalFileSecret(
    env, "TAPO_HISTORY_GMAIL_REFRESH_TOKEN", "TAPO_HISTORY_GMAIL_REFRESH_TOKEN_FILE", "Tapo Gmail refresh token", 1, true,
  );
  const tapoGmailValues = [tapoGmailClientId, tapoGmailClientSecret, tapoGmailRefreshToken];
  if (tapoGmailValues.some(Boolean) && !tapoGmailValues.every(Boolean)) {
    throw new Error("Tapo Gmail OAuth configuration requires client id, client secret, and refresh token");
  }
  const tapoGmail = tapoGmailValues.every(Boolean) ? tapoGmailValues as string[] : null;
  const tapoPrivateEndpoint = optional(env.TAPO_HISTORY_PRIVATE_ENDPOINT);
  const tapoPrivateToken = optionalFileSecret(
    env, "TAPO_HISTORY_PRIVATE_TOKEN", "TAPO_HISTORY_PRIVATE_TOKEN_FILE", "Experimental Tapo history token", 1, true,
  );
  if (Boolean(tapoPrivateEndpoint) !== Boolean(tapoPrivateToken)) {
    throw new Error("Experimental Tapo history configuration requires endpoint and token");
  }
  const tapoPrivate = tapoPrivateEndpoint && tapoPrivateToken ? [tapoPrivateEndpoint, tapoPrivateToken] : null;
  const tapoHistoryWorkerToken = optionalFileSecret(
    env, "TAPO_HISTORY_WORKER_TOKEN", "TAPO_HISTORY_WORKER_TOKEN_FILE", "TAPO_HISTORY_WORKER_TOKEN", 32, true,
  );
  const telegramEnvironment = environmentTuple(env, "Telegram", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  const alertWebhookEnvironmentDestinationsJson = optional(env.ALERT_WEBHOOK_DESTINATIONS_JSON);
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
  const cloudflareAccessAccountId = optional(env.CLOUDFLARE_ACCESS_ACCOUNT_ID);
  const cloudflareAccessGroupId = optional(env.CLOUDFLARE_ACCESS_GROUP_ID);
  const cloudflareAccessApiToken = optionalFileSecret(
    env,
    "CLOUDFLARE_ACCESS_API_TOKEN",
    "CLOUDFLARE_ACCESS_API_TOKEN_FILE",
    "Cloudflare Access API token",
    32,
    true,
  );
  const cloudflareAccessStaticEmails = normalizedEmailList(
    env.CLOUDFLARE_ACCESS_STATIC_EMAILS,
    "CLOUDFLARE_ACCESS_STATIC_EMAILS",
  );
  const cloudflareAccessValues = [
    cloudflareAccessAccountId,
    cloudflareAccessGroupId,
    cloudflareAccessApiToken,
    cloudflareAccessStaticEmails.length > 0 ? "configured" : null,
  ];
  if (cloudflareAccessValues.some(Boolean) && !cloudflareAccessValues.every(Boolean)) {
    throw new Error(
      "Cloudflare Access synchronization requires CLOUDFLARE_ACCESS_ACCOUNT_ID, CLOUDFLARE_ACCESS_GROUP_ID, CLOUDFLARE_ACCESS_STATIC_EMAILS, and an API token",
    );
  }
  if (cloudflareAccessAccountId && !/^[a-f0-9]{32}$/i.test(cloudflareAccessAccountId)) {
    throw new Error("CLOUDFLARE_ACCESS_ACCOUNT_ID must be a 32-character hexadecimal account ID");
  }
  if (cloudflareAccessGroupId
    && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(cloudflareAccessGroupId)) {
    throw new Error("CLOUDFLARE_ACCESS_GROUP_ID must be a UUID");
  }
  const cloudflareAccessGroupName = cloudflareAccessValues.every(Boolean)
    ? optional(env.CLOUDFLARE_ACCESS_GROUP_NAME) ?? "Stuga managed members"
    : null;
  if (cloudflareAccessGroupName && cloudflareAccessGroupName.length > 255) {
    throw new Error("CLOUDFLARE_ACCESS_GROUP_NAME must contain at most 255 characters");
  }
  if (alertWebhookEnvironmentDestinationsJson && (
    alertWebhookEnvironmentUrl || alertWebhookEnvironmentBearerToken || alertWebhookEnvironmentSigningSecret
  )) {
    throw new Error("ALERT_WEBHOOK_DESTINATIONS_JSON cannot be combined with legacy ALERT_WEBHOOK_* destination credentials");
  }
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
  let environmentWebhookDestinations: WebhookDestinationSecret[] | null = null;
  if (alertWebhookEnvironmentDestinationsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(alertWebhookEnvironmentDestinationsJson);
    } catch {
      throw new Error("ALERT_WEBHOOK_DESTINATIONS_JSON must be valid JSON");
    }
    environmentWebhookDestinations = normalizedWebhookDestinations(parsed, "ALERT_WEBHOOK_DESTINATIONS_JSON");
  } else if (alertWebhookEnvironmentUrl) {
    environmentWebhookDestinations = normalizedWebhookDestinations([{
      id: "primary",
      url: httpEndpoint(alertWebhookEnvironmentUrl, "ALERT_WEBHOOK_URL"),
      ...(alertWebhookEnvironmentBearerToken ? { bearerToken: alertWebhookEnvironmentBearerToken } : {}),
      ...(alertWebhookEnvironmentSigningSecret ? { signingSecret: alertWebhookEnvironmentSigningSecret } : {}),
    }], "Legacy alert webhook configuration");
  }
  const storedWebhookDestinations = stored.webhookDestinations
    ?? (stored.webhook ? normalizedWebhookDestinations([{ id: "primary", ...stored.webhook }], "Stored webhook") : null);
  const webhookDestinations = environmentWebhookDestinations ?? storedWebhookDestinations ?? [];
  const webhookSource: AppConfig["alertWebhookSource"] = environmentWebhookDestinations
    ? "environment"
    : storedWebhookDestinations
      ? "protected-file"
      : null;
  const primaryWebhook = webhookDestinations.find((destination) => destination.id === "primary")
    ?? webhookDestinations[0]
    ?? null;
  const configuredWebhookAllowedHosts = optional(env.ALERT_WEBHOOK_ALLOWED_HOSTS)?.split(",")
    .map((host) => host.trim().toLowerCase()).filter(Boolean);
  const alertWebhookAllowedHosts = [...new Set(configuredWebhookAllowedHosts
    ?? webhookDestinations.map((destination) => new URL(destination.url).hostname.toLowerCase()))];
  const disallowedWebhookHost = webhookDestinations.find((destination) => (
    !alertWebhookAllowedHosts.includes(new URL(destination.url).hostname.toLowerCase())
  ));
  if (disallowedWebhookHost) {
    throw new Error(`ALERT_WEBHOOK_ALLOWED_HOSTS must include every configured webhook destination host (${disallowedWebhookHost.id})`);
  }
  const timeseriesEnabled = booleanValue(env.TIMESERIES_ENABLED, false);
  const timeseriesRequired = booleanValue(env.TIMESERIES_REQUIRED, false);
  if (timeseriesRequired && !timeseriesEnabled) {
    throw new Error("TIMESERIES_REQUIRED=true requires TIMESERIES_ENABLED=true");
  }
  const configuredTimeseriesCa = optional(env.TIMESERIES_SSL_CA_FILE);
  const retentionDays = nonNegativeInteger(env.RETENTION_DAYS, 0);
  if (retentionDays > 0 && retentionDays < 30) throw new Error("RETENTION_DAYS must be 0 or at least 30");
  if (retentionDays > 0 && !timeseriesEnabled) throw new Error("RETENTION_DAYS requires TIMESERIES_ENABLED=true");
  const tapoHistoryExportEmail = optional(env.TAPO_HISTORY_EXPORT_EMAIL)?.toLowerCase() ?? null;
  if (tapoHistoryExportEmail && (tapoHistoryExportEmail.length > 254
    || !/^[^\s@<>]+@[^\s@<>]+$/.test(tapoHistoryExportEmail))) {
    throw new Error("TAPO_HISTORY_EXPORT_EMAIL must be a valid email address");
  }
  if (tapoGmail && !tapoHistoryExportEmail) {
    throw new Error("Tapo Gmail OAuth configuration requires TAPO_HISTORY_EXPORT_EMAIL");
  }
  const implicitGmailAccountEmail = tapoHistoryExportEmail?.replace(
    /^([^+@]+)\+[^@]+@(gmail\.com|googlemail\.com)$/u,
    "$1@$2",
  ) ?? null;
  const tapoHistoryGmailAccountEmail = optional(env.TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL)?.toLowerCase()
    ?? implicitGmailAccountEmail;
  if (tapoHistoryGmailAccountEmail && (tapoHistoryGmailAccountEmail.length > 254
    || !/^[^\s@<>]+@[^\s@<>]+$/.test(tapoHistoryGmailAccountEmail))) {
    throw new Error("TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL must be a valid email address");
  }
  if (tapoPrivate && new URL(httpEndpoint(tapoPrivate[0]!, "TAPO_HISTORY_PRIVATE_ENDPOINT")).protocol !== "https:") {
    throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT must use HTTPS");
  }
  const tapoHistoryEnabled = booleanValue(env.TAPO_HISTORY_ENABLED, false);
  const tapoHistoryEmailTagPrefix = optional(env.TAPO_HISTORY_EMAIL_TAG_PREFIX) ?? "stuga";
  if (tapoHistoryExportEmail) {
    const local = tapoHistoryExportEmail.slice(0, tapoHistoryExportEmail.lastIndexOf("@")).split("+")[0]!;
    const safePrefix = tapoHistoryEmailTagPrefix.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "stuga";
    if (Buffer.byteLength(`${local}+${safePrefix}-${"0".repeat(32)}`, "utf8") > 64) {
      throw new Error("TAPO_HISTORY_EXPORT_EMAIL local part is too long for the per-attempt correlation tag");
    }
  }
  const appHistoryConfigured = Boolean(tapoHistoryWorkerToken && tapoHistoryExportEmail && tapoGmail);
  if (tapoHistoryEnabled && !appHistoryConfigured && !tapoPrivate) {
    throw new Error(
      "TAPO_HISTORY_ENABLED=true requires either the complete app worker/email/Gmail tuple or the private endpoint/token pair",
    );
  }

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
    tpLinkPollIntervalMs: positiveInteger(env.TP_LINK_POLL_INTERVAL_MS, 2_000),
    tpLinkPython: optional(env.TP_LINK_PYTHON) ?? (process.platform === "win32" ? "python" : "python3"),
    tpLinkBridgeScript: resolve(env.TP_LINK_BRIDGE_SCRIPT ?? "./apps/api/python/tp_link_bridge.py"),
    tapoHistoryEnabled,
    tapoHistoryWorkerToken,
    tapoHistoryExportEmail,
    tapoHistoryEmailTagPrefix,
    tapoHistoryExportIntervalMinutes: exportIntervalMinutes(env.TAPO_HISTORY_EXPORT_INTERVAL_MINUTES),
    tapoHistoryMaxExportDays: boundedInteger(
      env.TAPO_HISTORY_MAX_EXPORT_DAYS,
      30,
      1,
      730,
      "TAPO_HISTORY_MAX_EXPORT_DAYS",
    ),
    tapoHistoryMaxPendingEmails: boundedInteger(
      env.TAPO_HISTORY_MAX_PENDING_EMAILS,
      1,
      1,
      10,
      "TAPO_HISTORY_MAX_PENDING_EMAILS",
    ),
    tapoHistoryMailboxPollIntervalMs: positiveInteger(env.TAPO_HISTORY_MAILBOX_POLL_INTERVAL_MS, 60_000),
    tapoHistoryEmailTimeoutMs: positiveInteger(env.TAPO_HISTORY_EMAIL_TIMEOUT_MS, 6 * 60 * 60_000),
    tapoHistoryWorkerLeaseMs: boundedInteger(
      env.TAPO_HISTORY_WORKER_LEASE_MS,
      5 * 60_000,
      5 * 60_000,
      24 * 60 * 60_000,
      "TAPO_HISTORY_WORKER_LEASE_MS",
    ),
    tapoHistoryGmailAccountEmail,
    tapoHistoryGmailClientId: tapoGmail?.[0] ?? null,
    tapoHistoryGmailClientSecret: tapoGmail?.[1] ?? null,
    tapoHistoryGmailRefreshToken: tapoGmail?.[2] ?? null,
    tapoHistoryPrivateEndpoint: tapoPrivate ? httpEndpoint(tapoPrivate[0]!, "TAPO_HISTORY_PRIVATE_ENDPOINT") : null,
    tapoHistoryPrivateToken: tapoPrivate?.[1] ?? null,
    alertWebhookUrl: primaryWebhook?.url ?? null,
    alertWebhookBearerToken: primaryWebhook?.bearerToken ?? null,
    alertWebhookDestinations: webhookDestinations.map((destination) => ({ ...destination })),
    alertWebhookSigningSecret: primaryWebhook?.signingSecret ?? null,
    alertWebhookAllowedHosts,
    alertWebhookSource: webhookSource,
    telegramBotToken: telegram?.botToken ?? null,
    telegramChatId: telegram?.chatId ?? null,
    appleNotesGrants: (stored.appleNotesGrants ?? []).map((grant) => ({ ...grant })),
    corsOrigin: optional(env.CORS_ORIGIN) ?? optional(env.CLOUDFLARE_ACCESS_PUBLIC_ORIGIN),
    localAuthBootstrapSecret,
    localAuthTestBypass,
    localAuthProxyBindAddress,
    localAuthProxySecret: proxySecret,
    cloudflareAccessAccountId,
    cloudflareAccessGroupId,
    cloudflareAccessGroupName,
    cloudflareAccessStaticEmails,
    cloudflareAccessApiToken,
    cloudflareAccessSyncIntervalMs: boundedInteger(
      env.CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS,
      5 * 60_000,
      60_000,
      24 * 60 * 60_000,
      "CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS",
    ),
    electricityAllowPrivateEndpoints: booleanValue(env.ELECTRICITY_ALLOW_PRIVATE_ENDPOINTS, false),
  };
}
