import { dirname, join } from "node:path";
import { configuredAlertWebhookDestinations, type AppConfig } from "./01-app-config-to-system-update-image-prefix.js";

/** The AppConfig fields createApi fills in when a caller leaves them unset. */
export type ApiDefaultedConfigKey =
  | "telegramBotToken"
  | "telegramChatId"
  | "apnsTeamId"
  | "apnsKeyId"
  | "apnsBundleId"
  | "apnsPrivateKey"
  | "alertWebhookSource"
  | "alertWebhookSigningSecret"
  | "alertWebhookDestinations"
  | "alertWebhookAllowedHosts"
  | "dailyAnalyticsFindingsEnabled"
  | "sensorGapRecoveryEnabled"
  | "appleNotesGrants"
  | "homeAssistantLegacyDisabled"
  | "tpLinkLegacyDisabled"
  | "tapoHistoryEnabled"
  | "tapoHistoryWorkerToken"
  | "tapoHistoryExportEmail"
  | "tapoHistoryEmailTagPrefix"
  | "tapoHistoryExportIntervalMinutes"
  | "tapoHistoryMaxExportDays"
  | "tapoHistoryMaxPendingEmails"
  | "tapoHistoryMailboxPollIntervalMs"
  | "tapoHistoryEmailTimeoutMs"
  | "tapoHistoryWorkerLeaseMs"
  | "tapoHistoryGmailClientId"
  | "tapoHistoryGmailClientSecret"
  | "tapoHistoryGmailRefreshToken"
  | "tapoHistoryPrivateEndpoint"
  | "tapoHistoryPrivateToken"
  | "trackingEnabled"
  | "trackingMobileObserverEnabled"
  | "trackingIosBackgroundEnabled"
  | "trackingAndroidBackgroundEnabled"
  | "trackingAndroidGatewayModeEnabled"
  | "trackingLiveMapEnabled"
  | "trackingMovementTrailsEnabled"
  | "trackingExitAlertsEnabled"
  | "trackingUserLocationSharingEnabled"
  | "trackingSecretKeyFile"
  | "localAuthTestBypass"
  | "cloudflareAccessAccountId"
  | "cloudflareAccessGroupId"
  | "cloudflareAccessGroupName"
  | "cloudflareAccessStaticEmails"
  | "cloudflareAccessApiToken"
  | "cloudflareAccessSyncIntervalMs"
  | "cloudflareSetupDeploymentFile"
  | "cloudflareSetupOAuthClientId"
  | "cloudflareSetupLocalUiPort"
  | "electricityAllowPrivateEndpoints"
  | "systemUpdateOperationsDirectory"
  | "hostCapabilitiesFile"
  | "sourceMqttHost"
  | "sourceMqttPort"
  | "sourceMqttUser"
  | "sourceMqttPasswordFile"
  | "systemUpdateRepository"
  | "systemUpdateImagePrefix"
  | "stugubyIdentityFile"
  | "stugubyNodeName"
  | "stugubySyncIntervalMs"
  | "stugubyPublicOrigin"
  | "timeseriesEnabled"
  | "timeseriesRequired"
  | "timeseriesHost"
  | "timeseriesPort"
  | "timeseriesDatabase"
  | "timeseriesUser"
  | "timeseriesPassword"
  | "timeseriesSslMode"
  | "timeseriesSslCa"
  | "timeseriesPoolMax"
  | "timeseriesConnectTimeoutMs"
  | "timeseriesStatementTimeoutMs"
  | "timeseriesBatchSize"
  | "timeseriesColumnstoreAfterDays";

/** AppConfig as the running API sees it: every defaulted field is present. */
export type ApiConfig = AppConfig & { [Key in ApiDefaultedConfigKey]-?: Exclude<AppConfig[Key], undefined> };

/**
 * Fills createApi's defaults and returns the same object typed as ApiConfig.
 * It mutates in place on purpose: services keep this object and some routes
 * update it at runtime. Programmatic callers may still pass configs built
 * against older AppConfig shapes.
 */
export function applyApiConfigDefaults(config: AppConfig): ApiConfig {
  // Keep programmatic callers built against older AppConfig shapes compatible.
  config.telegramBotToken ??= null;
  config.telegramChatId ??= null;
  config.apnsTeamId ??= null;
  config.apnsKeyId ??= null;
  config.apnsBundleId ??= null;
  config.apnsPrivateKey ??= null;
  config.alertWebhookSource ??= config.alertWebhookUrl ? "environment" : null;
  config.alertWebhookSigningSecret ??= null;
  config.alertWebhookDestinations ??= configuredAlertWebhookDestinations(config);
  config.alertWebhookAllowedHosts ??= config.alertWebhookDestinations
    .map((destination) => new URL(destination.url).hostname.toLowerCase());
  config.dailyAnalyticsFindingsEnabled ??= false;
  config.sensorGapRecoveryEnabled ??= false;
  config.appleNotesGrants ??= [];
  config.homeAssistantLegacyDisabled ??= false;
  config.tpLinkLegacyDisabled ??= false;
  config.tapoHistoryEnabled ??= false;
  config.tapoHistoryWorkerToken ??= null;
  config.tapoHistoryExportEmail ??= null;
  config.tapoHistoryEmailTagPrefix ??= "stugu";
  config.tapoHistoryExportIntervalMinutes ??= 15;
  config.tapoHistoryMaxExportDays ??= 30;
  config.tapoHistoryMaxPendingEmails ??= 1;
  config.tapoHistoryMailboxPollIntervalMs ??= 60_000;
  config.tapoHistoryEmailTimeoutMs ??= 6 * 60 * 60_000;
  config.tapoHistoryWorkerLeaseMs ??= 5 * 60_000;
  config.tapoHistoryGmailClientId ??= null;
  config.tapoHistoryGmailClientSecret ??= null;
  config.tapoHistoryGmailRefreshToken ??= null;
  config.tapoHistoryPrivateEndpoint ??= null;
  config.tapoHistoryPrivateToken ??= null;
  config.trackingEnabled ??= false;
  config.trackingMobileObserverEnabled ??= false;
  config.trackingIosBackgroundEnabled ??= false;
  config.trackingAndroidBackgroundEnabled ??= false;
  config.trackingAndroidGatewayModeEnabled ??= false;
  config.trackingLiveMapEnabled ??= false;
  config.trackingMovementTrailsEnabled ??= false;
  config.trackingExitAlertsEnabled ??= false;
  config.trackingUserLocationSharingEnabled ??= false;
  config.trackingSecretKeyFile ??= config.databasePath === ":memory:"
    ? null
    : join(dirname(config.databasePath), "tracking-secret.key");
  // Older in-memory test fixtures predate local authentication. Preserve their
  // trusted harness behavior without ever enabling the bypass outside tests.
  config.localAuthTestBypass ??= process.env.NODE_ENV === "test";
  config.cloudflareAccessAccountId ??= null;
  config.cloudflareAccessGroupId ??= null;
  config.cloudflareAccessGroupName ??= null;
  config.cloudflareAccessStaticEmails ??= [];
  config.cloudflareAccessApiToken ??= null;
  config.cloudflareAccessSyncIntervalMs ??= 5 * 60_000;
  config.cloudflareSetupDeploymentFile ??= null;
  config.cloudflareSetupOAuthClientId ??= null;
  config.cloudflareSetupLocalUiPort ??= 8_080;
  config.electricityAllowPrivateEndpoints ??= false;
  config.systemUpdateOperationsDirectory ??= null;
  config.hostCapabilitiesFile ??= null;
  config.sourceMqttHost ??= "127.0.0.1";
  config.sourceMqttPort ??= 1_883;
  config.sourceMqttUser ??= "stugu-api";
  config.sourceMqttPasswordFile ??= null;
  config.systemUpdateRepository ??= "liljestk/open-stuga";
  config.systemUpdateImagePrefix ??= `ghcr.io/${config.systemUpdateRepository.toLowerCase()}`;
  config.stugubyIdentityFile ??= config.databasePath === ":memory:" ? null : join(dirname(config.databasePath), "stuguby-identity.json");
  config.stugubyNodeName ??= "Stugu";
  config.stugubySyncIntervalMs ??= 15_000;
  config.stugubyPublicOrigin ??= null;
  config.timeseriesEnabled ??= false;
  config.timeseriesRequired ??= false;
  config.timeseriesHost ??= "127.0.0.1";
  config.timeseriesPort ??= 5432;
  config.timeseriesDatabase ??= "stugu";
  config.timeseriesUser ??= "stuga_app";
  config.timeseriesPassword ??= "";
  config.timeseriesSslMode ??= "disable";
  config.timeseriesSslCa ??= null;
  config.timeseriesPoolMax ??= 6;
  config.timeseriesConnectTimeoutMs ??= 5_000;
  config.timeseriesStatementTimeoutMs ??= 15_000;
  config.timeseriesBatchSize ??= 1_000;
  config.timeseriesColumnstoreAfterDays ??= 7;
  return config as ApiConfig;
}
