import { APP_CONFIG_DEFAULTS } from "./api-defaults.js";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readIntegrationSecrets,
  normalizedWebhookDestinations,
  type WebhookDestinationSecret,
} from "../integration-secrets.js";
import { AppConfig, booleanValue, boundedInteger, environmentTuple, exportIntervalMinutes, githubRepository, httpEndpoint, inferredStugubyPublicOrigin, localAuthProxySecret, nonNegativeInteger, normalizedEmailList, optional, optionalFileSecret, positiveInteger, requireAllOrNone, stugubyPublicOrigin, systemUpdateImagePrefix, timeseriesPassword, timeseriesSslMode } from "./app-config.js";
import { readCloudExportApps } from "./cloud-export-apps.js";

type Env = NodeJS.ProcessEnv;
type StoredSecrets = ReturnType<typeof readIntegrationSecrets>;

function databasePathFrom(env: Env, port: number): string {
  const databasePath = env.DATABASE_PATH === ":memory:"
    ? ":memory:"
    : resolve(env.DATABASE_PATH ?? "./data/climate-twin.sqlite");
  const temporaryDatabase = databasePath !== ":memory:"
    && databasePath.replaceAll("\\", "/").split("/").includes(".tmp-runtime");
  if (port === 8787 && temporaryDatabase
    && !booleanValue(env.ALLOW_TEMPORARY_DATABASE_ON_PRIMARY_PORT, false)) {
    throw new Error(
      "Refusing to serve a .tmp-runtime database on primary API port 8787; use another port or explicitly set ALLOW_TEMPORARY_DATABASE_ON_PRIMARY_PORT=true",
    );
  }
  return databasePath;
}

function spatialLayersDatabasePathFrom(env: Env, databasePath: string): string {
  const configured = optional(env.SPATIAL_LAYERS_DATABASE_PATH);
  return configured === ":memory:" || (configured === null && databasePath === ":memory:")
    ? ":memory:"
    : resolve(configured ?? join(dirname(databasePath), "experimental-spatial-layers.sqlite"));
}

function readStugubyConfig(env: Env, databasePath: string): Pick<AppConfig,
  | "stugubyIdentityFile" | "stugubyNodeName" | "stugubySyncIntervalMs" | "stugubyPublicOrigin"
  | "stugubySuggestedPublicOrigin" | "stugubyCoordinatorProvisioningRequired"> {
  const stugubyNodeName = optional(env.STUGBY_NODE_NAME) ?? APP_CONFIG_DEFAULTS.stugubyNodeName;
  if (stugubyNodeName.length > 200) throw new Error("STUGBY_NODE_NAME must contain at most 200 characters");
  const configuredPublicOrigin = stugubyPublicOrigin(env.STUGBY_PUBLIC_ORIGIN);
  return {
    stugubyIdentityFile: databasePath === ":memory:"
      ? null
      : resolve(env.STUGBY_IDENTITY_FILE ?? join(dirname(databasePath), "stuguby-identity.json")),
    stugubyNodeName,
    stugubySyncIntervalMs: boundedInteger(env.STUGBY_SYNC_INTERVAL_MS, APP_CONFIG_DEFAULTS.stugubySyncIntervalMs, 2_000, 300_000, "STUGBY_SYNC_INTERVAL_MS"),
    stugubyPublicOrigin: configuredPublicOrigin,
    stugubySuggestedPublicOrigin: configuredPublicOrigin
      ?? inferredStugubyPublicOrigin(env.CORS_ORIGIN, env.CLOUDFLARE_ACCESS_PUBLIC_ORIGIN),
    stugubyCoordinatorProvisioningRequired: !configuredPublicOrigin
      && inferredStugubyPublicOrigin(env.CLOUDFLARE_ACCESS_PUBLIC_ORIGIN) !== null,
  };
}

/** The APNs .p8 key file's contents once it is a P-256 private key. */
function apnsPrivateKeyFrom(path: string | null): string | null {
  if (!path) return null;
  const key = readFileSync(resolve(path), "utf8");
  if (!key.includes("BEGIN PRIVATE KEY")) throw new Error("APNS_PRIVATE_KEY_FILE must contain an Apple .p8 private key");
  try {
    const parsed = createPrivateKey(key);
    if (parsed.asymmetricKeyType !== "ec" || parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("wrong key type");
    }
  } catch {
    throw new Error("APNS_PRIVATE_KEY_FILE must contain a valid P-256 Apple .p8 private key");
  }
  return key;
}

function readApnsConfig(env: Env): Pick<AppConfig, "apnsTeamId" | "apnsKeyId" | "apnsBundleId" | "apnsPrivateKey"> {
  const apnsTeamId = optional(env.APNS_TEAM_ID);
  const apnsKeyId = optional(env.APNS_KEY_ID);
  const apnsBundleId = optional(env.APNS_BUNDLE_ID);
  const apnsPrivateKeyFile = optional(env.APNS_PRIVATE_KEY_FILE);
  requireAllOrNone(
    [apnsTeamId, apnsKeyId, apnsBundleId, apnsPrivateKeyFile],
    "APNs configuration requires APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, and APNS_PRIVATE_KEY_FILE",
  );
  if (apnsTeamId && !/^[A-Z0-9]{10}$/u.test(apnsTeamId)) {
    throw new Error("APNS_TEAM_ID must be a 10-character Apple Team ID");
  }
  if (apnsKeyId && !/^[A-Z0-9]{10}$/u.test(apnsKeyId)) {
    throw new Error("APNS_KEY_ID must be a 10-character Apple key ID");
  }
  if (apnsBundleId && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(apnsBundleId)) {
    throw new Error("APNS_BUNDLE_ID must be a valid bundle identifier");
  }
  return { apnsTeamId, apnsKeyId, apnsBundleId, apnsPrivateKey: apnsPrivateKeyFrom(apnsPrivateKeyFile) };
}

function readTapoGmail(env: Env): [string, string, string] | null {
  const values = [
    optional(env.TAPO_HISTORY_GMAIL_CLIENT_ID),
    optionalFileSecret(env, "TAPO_HISTORY_GMAIL_CLIENT_SECRET", "TAPO_HISTORY_GMAIL_CLIENT_SECRET_FILE", "Tapo Gmail client secret", 1, true),
    optionalFileSecret(env, "TAPO_HISTORY_GMAIL_REFRESH_TOKEN", "TAPO_HISTORY_GMAIL_REFRESH_TOKEN_FILE", "Tapo Gmail refresh token", 1, true),
  ];
  requireAllOrNone(values, "Tapo Gmail OAuth configuration requires client id, client secret, and refresh token");
  return values.every(Boolean) ? values as [string, string, string] : null;
}

function readTapoPrivate(env: Env): { endpoint: string; token: string } | null {
  const endpoint = optional(env.TAPO_HISTORY_PRIVATE_ENDPOINT);
  const token = optionalFileSecret(
    env, "TAPO_HISTORY_PRIVATE_TOKEN", "TAPO_HISTORY_PRIVATE_TOKEN_FILE", "Experimental Tapo history token", 1, true,
  );
  requireAllOrNone([endpoint, token], "Experimental Tapo history configuration requires endpoint and token");
  if (!endpoint || !token) return null;
  const url = httpEndpoint(endpoint, "TAPO_HISTORY_PRIVATE_ENDPOINT");
  if (new URL(url).protocol !== "https:") throw new Error("TAPO_HISTORY_PRIVATE_ENDPOINT must use HTTPS");
  return { endpoint: url, token };
}

function validEmail(value: string | null, variable: string): string | null {
  if (value && (value.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/.test(value))) {
    throw new Error(`${variable} must be a valid email address`);
  }
  return value;
}

/** The export mailbox, its Gmail account and tag prefix, checked against the per-attempt tag length. */
function readTapoMailbox(env: Env, gmailConfigured: boolean): Pick<AppConfig,
  "tapoHistoryExportEmail" | "tapoHistoryGmailAccountEmail" | "tapoHistoryEmailTagPrefix"> {
  const exportEmail = validEmail(optional(env.TAPO_HISTORY_EXPORT_EMAIL)?.toLowerCase() ?? null, "TAPO_HISTORY_EXPORT_EMAIL");
  if (gmailConfigured && !exportEmail) {
    throw new Error("Tapo Gmail OAuth configuration requires TAPO_HISTORY_EXPORT_EMAIL");
  }
  const implicitAccountEmail = exportEmail?.replace(/^([^+@]+)\+[^@]+@(gmail\.com|googlemail\.com)$/u, "$1@$2") ?? null;
  const accountEmail = validEmail(
    optional(env.TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL)?.toLowerCase() ?? implicitAccountEmail,
    "TAPO_HISTORY_GMAIL_ACCOUNT_EMAIL",
  );
  const tagPrefix = optional(env.TAPO_HISTORY_EMAIL_TAG_PREFIX) ?? APP_CONFIG_DEFAULTS.tapoHistoryEmailTagPrefix;
  if (exportEmail) {
    const local = exportEmail.slice(0, exportEmail.lastIndexOf("@")).split("+")[0]!;
    const safePrefix = tagPrefix.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || APP_CONFIG_DEFAULTS.tapoHistoryEmailTagPrefix;
    if (Buffer.byteLength(`${local}+${safePrefix}-${"0".repeat(32)}`, "utf8") > 64) {
      throw new Error("TAPO_HISTORY_EXPORT_EMAIL local part is too long for the per-attempt correlation tag");
    }
  }
  return { tapoHistoryExportEmail: exportEmail, tapoHistoryGmailAccountEmail: accountEmail, tapoHistoryEmailTagPrefix: tagPrefix };
}

function readTapoHistoryConfig(env: Env): Pick<AppConfig,
  | "tapoHistoryEnabled" | "tapoHistoryWorkerToken" | "tapoHistoryExportEmail" | "tapoHistoryEmailTagPrefix"
  | "tapoHistoryExportIntervalMinutes" | "tapoHistoryMaxExportDays" | "tapoHistoryMaxPendingEmails"
  | "tapoHistoryMailboxPollIntervalMs" | "tapoHistoryEmailTimeoutMs" | "tapoHistoryWorkerLeaseMs"
  | "tapoHistoryGmailAccountEmail" | "tapoHistoryGmailClientId" | "tapoHistoryGmailClientSecret"
  | "tapoHistoryGmailRefreshToken" | "tapoHistoryPrivateEndpoint" | "tapoHistoryPrivateToken"> {
  const gmail = readTapoGmail(env);
  const privateHistory = readTapoPrivate(env);
  const workerToken = optionalFileSecret(
    env, "TAPO_HISTORY_WORKER_TOKEN", "TAPO_HISTORY_WORKER_TOKEN_FILE", "TAPO_HISTORY_WORKER_TOKEN", 32, true,
  );
  const mailbox = readTapoMailbox(env, gmail !== null);
  const enabled = booleanValue(env.TAPO_HISTORY_ENABLED, false);
  const appHistoryConfigured = Boolean(workerToken && mailbox.tapoHistoryExportEmail && gmail);
  if (enabled && !appHistoryConfigured && !privateHistory) {
    throw new Error(
      "TAPO_HISTORY_ENABLED=true requires either the complete app worker/email/Gmail tuple or the private endpoint/token pair",
    );
  }
  return {
    tapoHistoryEnabled: enabled,
    tapoHistoryWorkerToken: workerToken,
    ...mailbox,
    tapoHistoryExportIntervalMinutes: exportIntervalMinutes(env.TAPO_HISTORY_EXPORT_INTERVAL_MINUTES),
    tapoHistoryMaxExportDays: boundedInteger(
      env.TAPO_HISTORY_MAX_EXPORT_DAYS, APP_CONFIG_DEFAULTS.tapoHistoryMaxExportDays, 1, 730, "TAPO_HISTORY_MAX_EXPORT_DAYS",
    ),
    tapoHistoryMaxPendingEmails: boundedInteger(
      env.TAPO_HISTORY_MAX_PENDING_EMAILS, APP_CONFIG_DEFAULTS.tapoHistoryMaxPendingEmails, 1, 10, "TAPO_HISTORY_MAX_PENDING_EMAILS",
    ),
    tapoHistoryMailboxPollIntervalMs: positiveInteger(env.TAPO_HISTORY_MAILBOX_POLL_INTERVAL_MS, APP_CONFIG_DEFAULTS.tapoHistoryMailboxPollIntervalMs),
    tapoHistoryEmailTimeoutMs: positiveInteger(env.TAPO_HISTORY_EMAIL_TIMEOUT_MS, APP_CONFIG_DEFAULTS.tapoHistoryEmailTimeoutMs),
    tapoHistoryWorkerLeaseMs: boundedInteger(
      env.TAPO_HISTORY_WORKER_LEASE_MS, APP_CONFIG_DEFAULTS.tapoHistoryWorkerLeaseMs, 5 * 60_000, 24 * 60 * 60_000, "TAPO_HISTORY_WORKER_LEASE_MS",
    ),
    tapoHistoryGmailClientId: gmail?.[0] ?? null,
    tapoHistoryGmailClientSecret: gmail?.[1] ?? null,
    tapoHistoryGmailRefreshToken: gmail?.[2] ?? null,
    tapoHistoryPrivateEndpoint: privateHistory?.endpoint ?? null,
    tapoHistoryPrivateToken: privateHistory?.token ?? null,
  };
}

/** Destinations from ALERT_WEBHOOK_DESTINATIONS_JSON or the legacy single-URL variables, or null. */
function environmentWebhookDestinations(env: Env): WebhookDestinationSecret[] | null {
  const destinationsJson = optional(env.ALERT_WEBHOOK_DESTINATIONS_JSON);
  const url = optional(env.ALERT_WEBHOOK_URL);
  const bearerToken = optional(env.ALERT_WEBHOOK_BEARER_TOKEN);
  const signingSecret = optional(env.ALERT_WEBHOOK_SIGNING_SECRET);
  if (destinationsJson && (url || bearerToken || signingSecret)) {
    throw new Error("ALERT_WEBHOOK_DESTINATIONS_JSON cannot be combined with legacy ALERT_WEBHOOK_* destination credentials");
  }
  if (!url && bearerToken) throw new Error("ALERT_WEBHOOK_BEARER_TOKEN requires ALERT_WEBHOOK_URL");
  if (!url && signingSecret) throw new Error("ALERT_WEBHOOK_SIGNING_SECRET requires ALERT_WEBHOOK_URL");
  if (signingSecret && Buffer.byteLength(signingSecret, "utf8") < 32) {
    throw new Error("ALERT_WEBHOOK_SIGNING_SECRET must contain at least 32 UTF-8 bytes");
  }
  if (destinationsJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(destinationsJson);
    } catch {
      throw new Error("ALERT_WEBHOOK_DESTINATIONS_JSON must be valid JSON");
    }
    return normalizedWebhookDestinations(parsed, "ALERT_WEBHOOK_DESTINATIONS_JSON");
  }
  if (!url) return null;
  return normalizedWebhookDestinations([{
    id: "primary",
    url: httpEndpoint(url, "ALERT_WEBHOOK_URL"),
    ...(bearerToken ? { bearerToken } : {}),
    ...(signingSecret ? { signingSecret } : {}),
  }], "Legacy alert webhook configuration");
}

function readAlertWebhookConfig(env: Env, stored: StoredSecrets): Pick<AppConfig,
  "alertWebhookDestinations" | "alertWebhookAllowedHosts" | "alertWebhookSource"> {
  const fromEnvironment = environmentWebhookDestinations(env);
  const fromFile = stored.webhookDestinations
    ?? (stored.webhook ? normalizedWebhookDestinations([{ id: "primary", ...stored.webhook }], "Stored webhook") : null);
  const destinations = fromEnvironment ?? fromFile ?? [];
  const hostOf = (destination: WebhookDestinationSecret) => new URL(destination.url).hostname.toLowerCase();
  const configuredHosts = optional(env.ALERT_WEBHOOK_ALLOWED_HOSTS)?.split(",")
    .map((host) => host.trim().toLowerCase()).filter(Boolean);
  const allowedHosts = [...new Set(configuredHosts ?? destinations.map(hostOf))];
  const disallowed = destinations.find((destination) => !allowedHosts.includes(hostOf(destination)));
  if (disallowed) {
    throw new Error(`ALERT_WEBHOOK_ALLOWED_HOSTS must include every configured webhook destination host (${disallowed.id})`);
  }
  return {
    alertWebhookDestinations: destinations.map((destination) => ({ ...destination })),
    alertWebhookAllowedHosts: allowedHosts,
    alertWebhookSource: fromEnvironment ? "environment" : fromFile ? "protected-file" : null,
  };
}

function readLocalAuthConfig(env: Env): Pick<AppConfig,
  "localAuthBootstrapSecret" | "localAuthTestBypass" | "localAuthProxyBindAddress" | "localAuthProxySecret"> {
  const bootstrapSecret = optional(env.LOCAL_AUTH_BOOTSTRAP_SECRET);
  if (bootstrapSecret && Buffer.byteLength(bootstrapSecret, "utf8") < 32) {
    throw new Error("LOCAL_AUTH_BOOTSTRAP_SECRET must contain at least 32 UTF-8 bytes");
  }
  const testBypass = booleanValue(env.LOCAL_AUTH_TEST_BYPASS, env.NODE_ENV === "test");
  if (testBypass && env.NODE_ENV !== "test") {
    throw new Error("LOCAL_AUTH_TEST_BYPASS may only be enabled with NODE_ENV=test");
  }
  return {
    localAuthBootstrapSecret: bootstrapSecret,
    localAuthTestBypass: testBypass,
    localAuthProxyBindAddress: optional(env.LOCAL_AUTH_PROXY_BIND_ADDRESS),
    localAuthProxySecret: localAuthProxySecret(env),
  };
}

/** The deployment environment wins, so an operator-owned relay cannot be replaced through the API. */
function readBugReportRelayConfig(env: Env, stored: StoredSecrets): Pick<AppConfig,
  "bugReportRelayUrl" | "bugReportRelayToken" | "bugReportRelaySource" | "bugReportRelayUpdatedAt"> {
  const url = optional(env.BUG_REPORT_RELAY_URL);
  const token = optionalFileSecret(env, "BUG_REPORT_RELAY_TOKEN", "BUG_REPORT_RELAY_TOKEN_FILE", "Bug report relay token", 32, true);
  requireAllOrNone([url, token], "Bug reporting requires both BUG_REPORT_RELAY_URL and BUG_REPORT_RELAY_TOKEN");
  if (url && new URL(url).protocol !== "https:") throw new Error("BUG_REPORT_RELAY_URL must use HTTPS");
  const fromFile = url ? null : stored.bugReportRelay ?? null;
  return {
    bugReportRelayUrl: url ?? fromFile?.url ?? null,
    bugReportRelayToken: token ?? fromFile?.token ?? null,
    bugReportRelaySource: url ? "environment" : fromFile ? "protected-file" : null,
    bugReportRelayUpdatedAt: fromFile?.updatedAt ?? null,
  };
}

/** Provider app IDs that let the owner connect a cloud drive, plus any drive they already connected. */
function readCloudExportConfig(env: Env, stored: StoredSecrets): Pick<AppConfig,
  "dropboxAppKey" | "googleDriveClientId" | "googleDriveClientSecret" | "exportDestinations"> {
  return { ...readCloudExportApps(env), exportDestinations: stored.exportDestinations ?? null };
}

function validCloudflareIds(accountId: string | null, groupId: string | null): void {
  if (accountId && !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCESS_ACCOUNT_ID must be a 32-character hexadecimal account ID");
  }
  if (groupId && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(groupId)) {
    throw new Error("CLOUDFLARE_ACCESS_GROUP_ID must be a UUID");
  }
}

function readCloudflareAccessConfig(env: Env): Pick<AppConfig,
  | "cloudflareAccessAccountId" | "cloudflareAccessGroupId" | "cloudflareAccessGroupName"
  | "cloudflareAccessStaticEmails" | "cloudflareAccessApiToken" | "cloudflareAccessSyncIntervalMs"> {
  const accountId = optional(env.CLOUDFLARE_ACCESS_ACCOUNT_ID);
  const groupId = optional(env.CLOUDFLARE_ACCESS_GROUP_ID);
  const apiToken = optionalFileSecret(env, "CLOUDFLARE_ACCESS_API_TOKEN", "CLOUDFLARE_ACCESS_API_TOKEN_FILE", "Cloudflare Access API token", 32, true);
  const staticEmails = normalizedEmailList(env.CLOUDFLARE_ACCESS_STATIC_EMAILS, "CLOUDFLARE_ACCESS_STATIC_EMAILS");
  const values = [accountId, groupId, apiToken, staticEmails.length > 0 ? "configured" : null];
  requireAllOrNone(
    values,
    "Cloudflare Access synchronization requires CLOUDFLARE_ACCESS_ACCOUNT_ID, CLOUDFLARE_ACCESS_GROUP_ID, CLOUDFLARE_ACCESS_STATIC_EMAILS, and an API token",
  );
  validCloudflareIds(accountId, groupId);
  const groupName = values.every(Boolean) ? optional(env.CLOUDFLARE_ACCESS_GROUP_NAME) ?? "Stugu managed members" : null;
  if (groupName && groupName.length > 255) throw new Error("CLOUDFLARE_ACCESS_GROUP_NAME must contain at most 255 characters");
  return {
    cloudflareAccessAccountId: accountId,
    cloudflareAccessGroupId: groupId,
    cloudflareAccessGroupName: groupName,
    cloudflareAccessStaticEmails: staticEmails,
    cloudflareAccessApiToken: apiToken,
    cloudflareAccessSyncIntervalMs: boundedInteger(
      env.CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS, APP_CONFIG_DEFAULTS.cloudflareAccessSyncIntervalMs, 60_000, 24 * 60 * 60_000, "CLOUDFLARE_ACCESS_SYNC_INTERVAL_MS",
    ),
  };
}

function readCloudflareSetupConfig(env: Env): Pick<AppConfig,
  "cloudflareSetupDeploymentFile" | "cloudflareSetupOAuthClientId" | "cloudflareSetupLocalUiPort"> {
  const oauthClientId = optional(env.STUGA_CLOUDFLARE_OAUTH_CLIENT_ID);
  if (oauthClientId && (oauthClientId.length < 8 || oauthClientId.length > 200 || !/^[A-Za-z0-9._~-]+$/u.test(oauthClientId))) {
    throw new Error("STUGA_CLOUDFLARE_OAUTH_CLIENT_ID is not a valid OAuth client ID");
  }
  return {
    cloudflareSetupDeploymentFile: resolve(env.CLOUDFLARE_SETUP_DEPLOYMENT_FILE ?? "./secrets/cloudflare/deployment.json"),
    cloudflareSetupOAuthClientId: oauthClientId,
    cloudflareSetupLocalUiPort: boundedInteger(
      env.STUGA_LOCAL_UI_PORT, APP_CONFIG_DEFAULTS.cloudflareSetupLocalUiPort, 1_024, 65_535, "STUGA_LOCAL_UI_PORT",
    ),
  };
}

function readTimeseriesConfig(env: Env): Pick<AppConfig,
  | "retentionDays" | "timeseriesEnabled" | "timeseriesRequired" | "timeseriesHost" | "timeseriesPort"
  | "timeseriesDatabase" | "timeseriesUser" | "timeseriesPassword" | "timeseriesSslMode" | "timeseriesSslCa"
  | "timeseriesPoolMax" | "timeseriesConnectTimeoutMs" | "timeseriesStatementTimeoutMs" | "timeseriesBatchSize"
  | "timeseriesColumnstoreAfterDays" | "timeseriesStoragePath"> {
  const enabled = booleanValue(env.TIMESERIES_ENABLED, false);
  const required = booleanValue(env.TIMESERIES_REQUIRED, false);
  if (required && !enabled) throw new Error("TIMESERIES_REQUIRED=true requires TIMESERIES_ENABLED=true");
  const retentionDays = nonNegativeInteger(env.RETENTION_DAYS, 0);
  if (retentionDays > 0 && retentionDays < 30) throw new Error("RETENTION_DAYS must be 0 or at least 30");
  if (retentionDays > 0 && !enabled) throw new Error("RETENTION_DAYS requires TIMESERIES_ENABLED=true");
  const caFile = optional(env.TIMESERIES_SSL_CA_FILE);
  const storagePath = optional(env.TIMESERIES_STORAGE_PATH);
  return {
    // Zero keeps the complete redundant SQLite copy. A positive value bounds
    // only the hot copy after archive reconciliation; Timescale raw data is
    // deliberately retained without a deletion policy.
    retentionDays,
    timeseriesEnabled: enabled,
    timeseriesRequired: required,
    timeseriesHost: optional(env.TIMESERIES_HOST) ?? APP_CONFIG_DEFAULTS.timeseriesHost,
    timeseriesPort: positiveInteger(env.TIMESERIES_PORT, APP_CONFIG_DEFAULTS.timeseriesPort),
    timeseriesDatabase: optional(env.TIMESERIES_DATABASE) ?? APP_CONFIG_DEFAULTS.timeseriesDatabase,
    timeseriesUser: optional(env.TIMESERIES_USER) ?? APP_CONFIG_DEFAULTS.timeseriesUser,
    timeseriesPassword: timeseriesPassword(env),
    timeseriesSslMode: timeseriesSslMode(env.TIMESERIES_SSL_MODE),
    timeseriesSslCa: caFile ? readFileSync(resolve(caFile), "utf8") : null,
    timeseriesPoolMax: positiveInteger(env.TIMESERIES_POOL_MAX, APP_CONFIG_DEFAULTS.timeseriesPoolMax),
    timeseriesConnectTimeoutMs: positiveInteger(env.TIMESERIES_CONNECT_TIMEOUT_MS, APP_CONFIG_DEFAULTS.timeseriesConnectTimeoutMs),
    timeseriesStatementTimeoutMs: positiveInteger(env.TIMESERIES_STATEMENT_TIMEOUT_MS, APP_CONFIG_DEFAULTS.timeseriesStatementTimeoutMs),
    timeseriesBatchSize: positiveInteger(env.TIMESERIES_BATCH_SIZE, APP_CONFIG_DEFAULTS.timeseriesBatchSize),
    timeseriesColumnstoreAfterDays: positiveInteger(env.TIMESERIES_COLUMNSTORE_AFTER_DAYS, APP_CONFIG_DEFAULTS.timeseriesColumnstoreAfterDays),
    timeseriesStoragePath: storagePath ? resolve(storagePath) : null,
  };
}

function readTrackingConfig(env: Env, databasePath: string): Pick<AppConfig,
  | "trackingEnabled" | "trackingMobileObserverEnabled" | "trackingIosBackgroundEnabled" | "trackingAndroidBackgroundEnabled"
  | "trackingAndroidGatewayModeEnabled" | "trackingLiveMapEnabled" | "trackingMovementTrailsEnabled"
  | "trackingExitAlertsEnabled" | "trackingUserLocationSharingEnabled" | "trackingSecretKeyFile"> {
  return {
    trackingEnabled: booleanValue(env.TRACKING_ENABLED, false),
    trackingMobileObserverEnabled: booleanValue(env.TRACKING_MOBILE_OBSERVER_ENABLED, false),
    trackingIosBackgroundEnabled: booleanValue(env.TRACKING_IOS_BACKGROUND_ENABLED, false),
    trackingAndroidBackgroundEnabled: booleanValue(env.TRACKING_ANDROID_BACKGROUND_ENABLED, false),
    trackingAndroidGatewayModeEnabled: booleanValue(env.TRACKING_ANDROID_GATEWAY_MODE_ENABLED, false),
    trackingLiveMapEnabled: booleanValue(env.TRACKING_LIVE_MAP_ENABLED, false),
    trackingMovementTrailsEnabled: booleanValue(env.TRACKING_MOVEMENT_TRAILS_ENABLED, false),
    trackingExitAlertsEnabled: booleanValue(env.TRACKING_EXIT_ALERTS_ENABLED, false),
    trackingUserLocationSharingEnabled: booleanValue(env.TRACKING_USER_LOCATION_SHARING_ENABLED, false),
    trackingSecretKeyFile: databasePath === ":memory:"
      ? null
      : resolve(env.TRACKING_SECRET_KEY_FILE ?? join(dirname(databasePath), "tracking-secret.key")),
  };
}

function bridgePython(env: Env, variable: string): string {
  return optional(env[variable]) ?? optional(env.TP_LINK_PYTHON) ?? (process.platform === "win32" ? "python" : "python3");
}

/** Home Assistant, TP-Link, Gree, Tuya and Telegram: environment credentials win over the protected file. */
function readIntegrationConfig(env: Env, stored: StoredSecrets): Pick<AppConfig,
  | "haUrl" | "haToken" | "haEntityMapFile" | "homeAssistantConnections" | "homeAssistantLegacyDisabled"
  | "tpLinkHost" | "tpLinkUsername" | "tpLinkPassword" | "tpLinkConnections" | "tpLinkLegacyDisabled"
  | "tpLinkDeviceMapFile" | "tpLinkPollIntervalMs" | "tpLinkPython" | "tpLinkBridgeScript" | "tpLinkDiscoveryTargets"
  | "greeConnections" | "greePollIntervalMs" | "greePython" | "greeBridgeScript" | "greeDiscoveryTargets"
  | "tuyaConnections" | "tuyaPollIntervalMs" | "tuyaPython" | "tuyaBridgeScript"
  | "telegramBotToken" | "telegramChatId" | "appleNotesGrants"> {
  const haEnvironment = environmentTuple(env, "Home Assistant", ["HA_URL", "HA_TOKEN"]);
  const tpLinkEnvironment = environmentTuple(env, "TP-Link", ["TP_LINK_HOST", "TP_LINK_USERNAME", "TP_LINK_PASSWORD"]);
  const telegramEnvironment = environmentTuple(env, "Telegram", ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]);
  const ha = haEnvironment ? { url: httpEndpoint(haEnvironment[0]!, "HA_URL"), token: haEnvironment[1]! } : stored.homeAssistant ?? null;
  const tpLink = tpLinkEnvironment
    ? { host: tpLinkEnvironment[0]!, username: tpLinkEnvironment[1]!, password: tpLinkEnvironment[2]! }
    : stored.tpLink ?? null;
  const telegram = telegramEnvironment ? { botToken: telegramEnvironment[0]!, chatId: telegramEnvironment[1]! } : stored.telegram ?? null;
  return {
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
    tpLinkPython: bridgePython(env, "TP_LINK_PYTHON"),
    tpLinkBridgeScript: resolve(env.TP_LINK_BRIDGE_SCRIPT ?? "./apps/api/python/tp_link_bridge.py"),
    tpLinkDiscoveryTargets: discoveryTargetList(env.TP_LINK_DISCOVERY_TARGETS),
    greeConnections: (stored.greeConnections ?? []).map((connection) => ({ ...connection })),
    greePollIntervalMs: boundedInteger(env.GREE_POLL_INTERVAL_MS, 60_000, 10_000, 15 * 60_000, "GREE_POLL_INTERVAL_MS"),
    greePython: bridgePython(env, "GREE_PYTHON"),
    greeBridgeScript: resolve(env.GREE_BRIDGE_SCRIPT ?? "./apps/api/python/gree_bridge.py"),
    greeDiscoveryTargets: discoveryTargetList(env.GREE_DISCOVERY_TARGETS),
    tuyaConnections: (stored.tuyaConnections ?? []).map((connection) => ({ ...connection })),
    tuyaPollIntervalMs: boundedInteger(env.TUYA_POLL_INTERVAL_MS, 5_000, 2_000, 15 * 60_000, "TUYA_POLL_INTERVAL_MS"),
    tuyaPython: bridgePython(env, "TUYA_PYTHON"),
    tuyaBridgeScript: resolve(env.TUYA_BRIDGE_SCRIPT ?? "./apps/api/python/tuya_bridge.py"),
    telegramBotToken: telegram?.botToken ?? null,
    telegramChatId: telegram?.chatId ?? null,
    appleNotesGrants: (stored.appleNotesGrants ?? []).map((grant) => ({ ...grant })),
  };
}

/** Reads and validates the whole configuration from the environment and the protected secrets file. */
export function loadConfig(env: Env = process.env): AppConfig {
  const port = positiveInteger(env.PORT, 8787);
  const databasePath = databasePathFrom(env, port);
  const integrationSecretsFile = resolve(env.INTEGRATION_SECRETS_FILE
    ?? (databasePath === ":memory:" ? "./data/integration-secrets.json" : join(dirname(databasePath), "integration-secrets.json")));
  const stored = env.NODE_ENV === "test" && env.INTEGRATION_SECRETS_FILE === undefined
    ? { version: 1 as const }
    : readIntegrationSecrets(integrationSecretsFile);
  const systemUpdateRepository = githubRepository(env.SYSTEM_UPDATE_REPOSITORY);
  const sourceMqttPasswordFile = optional(env.SOURCE_MQTT_PASSWORD_FILE);
  return {
    port,
    apiHost: optional(env.API_HOST) ?? "127.0.0.1",
    databasePath,
    spatialLayersEnabled: booleanValue(env.SPATIAL_LAYERS_ENABLED, false),
    spatialLayersDatabasePath: spatialLayersDatabasePathFrom(env, databasePath),
    spatialLayersIntervalMs: positiveInteger(env.SPATIAL_LAYERS_INTERVAL_MS, 60_000),
    spatialLayersRetentionDays: positiveInteger(env.SPATIAL_LAYERS_RETENTION_DAYS, 30),
    dailyAnalyticsFindingsEnabled: booleanValue(env.DAILY_ANALYTICS_FINDINGS_ENABLED, false),
    sensorGapRecoveryEnabled: booleanValue(env.SENSOR_GAP_RECOVERY_ENABLED, false),
    ...readTrackingConfig(env, databasePath),
    integrationSecretsFile,
    assetDirectory: resolve(env.ASSET_DIRECTORY ?? "./data/assets"),
    ...readStugubyConfig(env, databasePath),
    backupOperationsDirectory: resolve(env.BACKUP_OPERATIONS_DIRECTORY ?? "./data/backup-operations"),
    backupDirectory: resolve(env.BACKUP_DIRECTORY ?? "./backups"),
    systemUpdateOperationsDirectory: resolve(env.SYSTEM_UPDATE_OPERATIONS_DIRECTORY
      ?? (databasePath === ":memory:" ? "./data/update-operations" : join(dirname(databasePath), "update-operations"))),
    systemUpdateRepository,
    systemUpdateImagePrefix: systemUpdateImagePrefix(env.SYSTEM_UPDATE_IMAGE_PREFIX, systemUpdateRepository),
    hostCapabilitiesFile: resolve(env.STUGA_HOST_CAPABILITIES_FILE ?? "./config/host-capabilities.json"),
    sourceMqttHost: optional(env.SOURCE_MQTT_HOST) ?? APP_CONFIG_DEFAULTS.sourceMqttHost,
    sourceMqttPort: boundedInteger(env.SOURCE_MQTT_PORT, APP_CONFIG_DEFAULTS.sourceMqttPort, 1, 65_535, "SOURCE_MQTT_PORT"),
    sourceMqttUser: optional(env.SOURCE_MQTT_USER) ?? APP_CONFIG_DEFAULTS.sourceMqttUser,
    sourceMqttPasswordFile: sourceMqttPasswordFile ? resolve(sourceMqttPasswordFile) : null,
    mockEnabled: booleanValue(env.MOCK_ENABLED, false),
    mockIntervalMs: positiveInteger(env.MOCK_INTERVAL_MS, 2_000),
    ...readTimeseriesConfig(env),
    ingestApiKey: optional(env.INGEST_API_KEY),
    ...readIntegrationConfig(env, stored),
    ...readTapoHistoryConfig(env),
    ...readAlertWebhookConfig(env, stored),
    ...readApnsConfig(env),
    corsOrigin: optional(env.CORS_ORIGIN) ?? optional(env.CLOUDFLARE_ACCESS_PUBLIC_ORIGIN),
    ...readLocalAuthConfig(env),
    ...readBugReportRelayConfig(env, stored),
    ...readCloudExportConfig(env, stored),
    ...readCloudflareAccessConfig(env),
    ...readCloudflareSetupConfig(env),
    electricityAllowPrivateEndpoints: booleanValue(env.ELECTRICITY_ALLOW_PRIVATE_ENDPOINTS, false),
  };
}

/** A comma-separated list of discovery addresses, trimmed and de-duplicated. */
function discoveryTargetList(value: string | undefined): string[] {
  return [...new Set((optional(value) ?? "").split(",").map((target) => target.trim()).filter(Boolean))];
}
