import { createPrivateKey, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  readIntegrationSecrets,
  normalizedWebhookDestinations,
  type AppleNotesGrantSecret,
  type HomeAssistantConnectionSecret,
  type TpLinkConnectionSecret,
  type WebhookDestinationSecret,
} from "../integration-secrets.js";
import { AppConfig, booleanValue, boundedInteger, environmentTuple, exportIntervalMinutes, githubRepository, httpEndpoint, inferredStugubyPublicOrigin, localAuthProxySecret, nonNegativeInteger, normalizedEmailList, optional, optionalFileSecret, positiveInteger, stugubyPublicOrigin, systemUpdateImagePrefix, timeseriesPassword, timeseriesSslMode } from "./01-app-config-to-system-update-image-prefix.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databasePath = env.DATABASE_PATH === ":memory:"
    ? ":memory:"
    : resolve(env.DATABASE_PATH ?? "./data/climate-twin.sqlite");
  const integrationSecretsFile = resolve(env.INTEGRATION_SECRETS_FILE
    ?? (databasePath === ":memory:" ? "./data/integration-secrets.json" : join(dirname(databasePath), "integration-secrets.json")));
  const stugubyIdentityFile = databasePath === ":memory:"
    ? null
    : resolve(env.STUGBY_IDENTITY_FILE ?? join(dirname(databasePath), "stuguby-identity.json"));
  const stugubyNodeName = optional(env.STUGBY_NODE_NAME) ?? "Stugu";
  if (stugubyNodeName.length > 200) throw new Error("STUGBY_NODE_NAME must contain at most 200 characters");
  const configuredSpatialLayersPath = optional(env.SPATIAL_LAYERS_DATABASE_PATH);
  const spatialLayersDatabasePath = configuredSpatialLayersPath === ":memory:"
    || (configuredSpatialLayersPath === null && databasePath === ":memory:")
    ? ":memory:"
    : resolve(configuredSpatialLayersPath ?? join(dirname(databasePath), "experimental-spatial-layers.sqlite"));
  const systemUpdateRepository = githubRepository(env.SYSTEM_UPDATE_REPOSITORY);
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
  const apnsTeamId = optional(env.APNS_TEAM_ID);
  const apnsKeyId = optional(env.APNS_KEY_ID);
  const apnsBundleId = optional(env.APNS_BUNDLE_ID);
  const apnsPrivateKeyFile = optional(env.APNS_PRIVATE_KEY_FILE);
  const apnsValues = [apnsTeamId, apnsKeyId, apnsBundleId, apnsPrivateKeyFile];
  if (apnsValues.some(Boolean) && !apnsValues.every(Boolean)) {
    throw new Error("APNs configuration requires APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, and APNS_PRIVATE_KEY_FILE");
  }
  if (apnsTeamId && !/^[A-Z0-9]{10}$/u.test(apnsTeamId)) {
    throw new Error("APNS_TEAM_ID must be a 10-character Apple Team ID");
  }
  if (apnsKeyId && !/^[A-Z0-9]{10}$/u.test(apnsKeyId)) {
    throw new Error("APNS_KEY_ID must be a 10-character Apple key ID");
  }
  if (apnsBundleId && !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(apnsBundleId)) {
    throw new Error("APNS_BUNDLE_ID must be a valid bundle identifier");
  }
  const apnsPrivateKey = apnsPrivateKeyFile
    ? readFileSync(resolve(apnsPrivateKeyFile), "utf8")
    : null;
  if (apnsPrivateKey && !apnsPrivateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("APNS_PRIVATE_KEY_FILE must contain an Apple .p8 private key");
  }
  if (apnsPrivateKey) {
    try {
      const key = createPrivateKey(apnsPrivateKey);
      if (key.asymmetricKeyType !== "ec"
        || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new Error("wrong key type");
      }
    } catch {
      throw new Error("APNS_PRIVATE_KEY_FILE must contain a valid P-256 Apple .p8 private key");
    }
  }
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
    ? optional(env.CLOUDFLARE_ACCESS_GROUP_NAME) ?? "Stugu managed members"
    : null;
  if (cloudflareAccessGroupName && cloudflareAccessGroupName.length > 255) {
    throw new Error("CLOUDFLARE_ACCESS_GROUP_NAME must contain at most 255 characters");
  }
  const cloudflareSetupOAuthClientId = optional(env.STUGA_CLOUDFLARE_OAUTH_CLIENT_ID);
  if (cloudflareSetupOAuthClientId
    && (cloudflareSetupOAuthClientId.length < 8
      || cloudflareSetupOAuthClientId.length > 200
      || !/^[A-Za-z0-9._~-]+$/u.test(cloudflareSetupOAuthClientId))) {
    throw new Error("STUGA_CLOUDFLARE_OAUTH_CLIENT_ID is not a valid OAuth client ID");
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
  const tapoHistoryEmailTagPrefix = optional(env.TAPO_HISTORY_EMAIL_TAG_PREFIX) ?? "stugu";
  if (tapoHistoryExportEmail) {
    const local = tapoHistoryExportEmail.slice(0, tapoHistoryExportEmail.lastIndexOf("@")).split("+")[0]!;
    const safePrefix = tapoHistoryEmailTagPrefix.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "stugu";
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
  const configuredStugubyPublicOrigin = stugubyPublicOrigin(env.STUGBY_PUBLIC_ORIGIN);
  const suggestedStugubyPublicOrigin = configuredStugubyPublicOrigin
    ?? inferredStugubyPublicOrigin(env.CORS_ORIGIN, env.CLOUDFLARE_ACCESS_PUBLIC_ORIGIN);
  const stugubyCoordinatorProvisioningRequired = !configuredStugubyPublicOrigin
    && inferredStugubyPublicOrigin(env.CLOUDFLARE_ACCESS_PUBLIC_ORIGIN) !== null;

  return {
    port: positiveInteger(env.PORT, 8787),
    apiHost: optional(env.API_HOST) ?? "127.0.0.1",
    databasePath,
    spatialLayersEnabled: booleanValue(env.SPATIAL_LAYERS_ENABLED, env.NODE_ENV !== "test"),
    spatialLayersDatabasePath,
    spatialLayersIntervalMs: positiveInteger(env.SPATIAL_LAYERS_INTERVAL_MS, 60_000),
    spatialLayersRetentionDays: positiveInteger(env.SPATIAL_LAYERS_RETENTION_DAYS, 30),
    trackingEnabled: booleanValue(env.TRACKING_ENABLED, false),
    trackingMobileObserverEnabled: booleanValue(env.TRACKING_MOBILE_OBSERVER_ENABLED, false),
    trackingIosBackgroundEnabled: booleanValue(env.TRACKING_IOS_BACKGROUND_ENABLED, false),
    trackingAndroidBackgroundEnabled: booleanValue(env.TRACKING_ANDROID_BACKGROUND_ENABLED, false),
    trackingAndroidGatewayModeEnabled: booleanValue(env.TRACKING_ANDROID_GATEWAY_MODE_ENABLED, false),
    trackingLiveMapEnabled: booleanValue(env.TRACKING_LIVE_MAP_ENABLED, false),
    trackingMovementTrailsEnabled: booleanValue(env.TRACKING_MOVEMENT_TRAILS_ENABLED, false),
    trackingExitAlertsEnabled: booleanValue(env.TRACKING_EXIT_ALERTS_ENABLED, false),
    trackingUserLocationSharingEnabled: booleanValue(
      env.TRACKING_USER_LOCATION_SHARING_ENABLED,
      false,
    ),
    trackingSecretKeyFile: databasePath === ":memory:"
      ? null
      : resolve(env.TRACKING_SECRET_KEY_FILE ?? join(dirname(databasePath), "tracking-secret.key")),
    integrationSecretsFile,
    assetDirectory: resolve(env.ASSET_DIRECTORY ?? "./data/assets"),
    stugubyIdentityFile,
    stugubyNodeName,
    stugubySyncIntervalMs: boundedInteger(env.STUGBY_SYNC_INTERVAL_MS, 15_000, 2_000, 300_000, "STUGBY_SYNC_INTERVAL_MS"),
    stugubyPublicOrigin: configuredStugubyPublicOrigin,
    stugubySuggestedPublicOrigin: suggestedStugubyPublicOrigin,
    stugubyCoordinatorProvisioningRequired,
    backupOperationsDirectory: resolve(env.BACKUP_OPERATIONS_DIRECTORY ?? "./data/backup-operations"),
    backupDirectory: resolve(env.BACKUP_DIRECTORY ?? "./backups"),
    systemUpdateOperationsDirectory: resolve(env.SYSTEM_UPDATE_OPERATIONS_DIRECTORY
      ?? (databasePath === ":memory:" ? "./data/update-operations" : join(dirname(databasePath), "update-operations"))),
    systemUpdateRepository,
    systemUpdateImagePrefix: systemUpdateImagePrefix(env.SYSTEM_UPDATE_IMAGE_PREFIX, systemUpdateRepository),
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
    greeConnections: (stored.greeConnections ?? []).map((connection) => ({ ...connection })),
    greePollIntervalMs: boundedInteger(
      env.GREE_POLL_INTERVAL_MS,
      60_000,
      10_000,
      15 * 60_000,
      "GREE_POLL_INTERVAL_MS",
    ),
    greePython: optional(env.GREE_PYTHON)
      ?? optional(env.TP_LINK_PYTHON)
      ?? (process.platform === "win32" ? "python" : "python3"),
    greeBridgeScript: resolve(env.GREE_BRIDGE_SCRIPT ?? "./apps/api/python/gree_bridge.py"),
    greeDiscoveryTargets: [...new Set((optional(env.GREE_DISCOVERY_TARGETS) ?? "")
      .split(",").map((target) => target.trim()).filter(Boolean))],
    tuyaConnections: (stored.tuyaConnections ?? []).map((connection) => ({ ...connection })),
    tuyaPollIntervalMs: boundedInteger(
      env.TUYA_POLL_INTERVAL_MS,
      5_000,
      2_000,
      15 * 60_000,
      "TUYA_POLL_INTERVAL_MS",
    ),
    tuyaPython: optional(env.TUYA_PYTHON)
      ?? optional(env.TP_LINK_PYTHON)
      ?? (process.platform === "win32" ? "python" : "python3"),
    tuyaBridgeScript: resolve(env.TUYA_BRIDGE_SCRIPT ?? "./apps/api/python/tuya_bridge.py"),
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
    apnsTeamId,
    apnsKeyId,
    apnsBundleId,
    apnsPrivateKey,
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
    cloudflareSetupDeploymentFile: resolve(
      env.CLOUDFLARE_SETUP_DEPLOYMENT_FILE ?? "./secrets/cloudflare/deployment.json",
    ),
    cloudflareSetupOAuthClientId,
    cloudflareSetupLocalUiPort: boundedInteger(
      env.STUGA_LOCAL_UI_PORT,
      8_080,
      1_024,
      65_535,
      "STUGA_LOCAL_UI_PORT",
    ),
    electricityAllowPrivateEndpoints: booleanValue(env.ELECTRICITY_ALLOW_PRIVATE_ENDPOINTS, false),
  };
}
