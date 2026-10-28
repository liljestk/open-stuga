import { dirname, join } from "node:path";
import type { AppConfig } from "./app-config.js";

/** The AppConfig fields a programmatic caller may leave out; normalizeAppConfig fills them. */
export type ApiDefaultedConfigKey =
  | "telegramBotToken"
  | "telegramChatId"
  | "apnsTeamId"
  | "apnsKeyId"
  | "apnsBundleId"
  | "apnsPrivateKey"
  | "alertWebhookSource"
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

/** AppConfig as a programmatic or test caller may build it, before normalizeAppConfig. */
export type AppConfigInput = Omit<AppConfig, ApiDefaultedConfigKey> & Partial<Pick<AppConfig, ApiDefaultedConfigKey>>;

/** Every constant default; loadConfig falls back to these values as well. */
export const APP_CONFIG_DEFAULTS = {
  telegramBotToken: null,
  telegramChatId: null,
  apnsTeamId: null,
  apnsKeyId: null,
  apnsBundleId: null,
  apnsPrivateKey: null,
  alertWebhookDestinations: [],
  dailyAnalyticsFindingsEnabled: false,
  sensorGapRecoveryEnabled: false,
  appleNotesGrants: [],
  homeAssistantLegacyDisabled: false,
  tpLinkLegacyDisabled: false,
  tapoHistoryEnabled: false,
  tapoHistoryWorkerToken: null,
  tapoHistoryExportEmail: null,
  tapoHistoryEmailTagPrefix: "stugu",
  tapoHistoryExportIntervalMinutes: 15,
  tapoHistoryMaxExportDays: 30,
  tapoHistoryMaxPendingEmails: 1,
  tapoHistoryMailboxPollIntervalMs: 60_000,
  tapoHistoryEmailTimeoutMs: 6 * 60 * 60_000,
  tapoHistoryWorkerLeaseMs: 5 * 60_000,
  tapoHistoryGmailClientId: null,
  tapoHistoryGmailClientSecret: null,
  tapoHistoryGmailRefreshToken: null,
  tapoHistoryPrivateEndpoint: null,
  tapoHistoryPrivateToken: null,
  trackingEnabled: false,
  trackingMobileObserverEnabled: false,
  trackingIosBackgroundEnabled: false,
  trackingAndroidBackgroundEnabled: false,
  trackingAndroidGatewayModeEnabled: false,
  trackingLiveMapEnabled: false,
  trackingMovementTrailsEnabled: false,
  trackingExitAlertsEnabled: false,
  trackingUserLocationSharingEnabled: false,
  localAuthTestBypass: false,
  cloudflareAccessAccountId: null,
  cloudflareAccessGroupId: null,
  cloudflareAccessGroupName: null,
  cloudflareAccessStaticEmails: [],
  cloudflareAccessApiToken: null,
  cloudflareAccessSyncIntervalMs: 5 * 60_000,
  cloudflareSetupDeploymentFile: null,
  cloudflareSetupOAuthClientId: null,
  cloudflareSetupLocalUiPort: 8_080,
  electricityAllowPrivateEndpoints: false,
  systemUpdateOperationsDirectory: null,
  hostCapabilitiesFile: null,
  sourceMqttHost: "127.0.0.1",
  sourceMqttPort: 1_883,
  sourceMqttUser: "stugu-api",
  sourceMqttPasswordFile: null,
  systemUpdateRepository: "liljestk/open-stuga",
  stugubyNodeName: "Stugu",
  stugubySyncIntervalMs: 15_000,
  stugubyPublicOrigin: null,
  timeseriesEnabled: false,
  timeseriesRequired: false,
  timeseriesHost: "127.0.0.1",
  timeseriesPort: 5432,
  timeseriesDatabase: "stuga",
  timeseriesUser: "stuga_app",
  timeseriesPassword: "",
  timeseriesSslMode: "disable",
  timeseriesSslCa: null,
  timeseriesPoolMax: 6,
  timeseriesConnectTimeoutMs: 5_000,
  timeseriesStatementTimeoutMs: 15_000,
  timeseriesBatchSize: 1_000,
  timeseriesColumnstoreAfterDays: 7,
} as const satisfies Partial<AppConfig>;

/**
 * Fills the defaulted fields a caller left out and returns the same object as an
 * AppConfig. It mutates in place on purpose: services keep this object and some
 * routes update it at runtime.
 */
export function normalizeAppConfig(config: AppConfigInput): AppConfig {
  const fields = config as Record<string, unknown>;
  for (const [key, value] of Object.entries(APP_CONFIG_DEFAULTS)) {
    if (fields[key] === undefined) fields[key] = Array.isArray(value) ? [...value] : value;
  }
  config.alertWebhookDestinations ??= [];
  config.alertWebhookSource ??= config.alertWebhookDestinations.length > 0 ? "environment" : null;
  config.alertWebhookAllowedHosts ??= config.alertWebhookDestinations
    .map((destination) => new URL(destination.url).hostname.toLowerCase());
  config.trackingSecretKeyFile ??= config.databasePath === ":memory:"
    ? null
    : join(dirname(config.databasePath), "tracking-secret.key");
  config.systemUpdateImagePrefix ??= `ghcr.io/${(config.systemUpdateRepository ?? APP_CONFIG_DEFAULTS.systemUpdateRepository).toLowerCase()}`;
  config.stugubyIdentityFile ??= config.databasePath === ":memory:" ? null : join(dirname(config.databasePath), "stuguby-identity.json");
  // Every defaulted field is now set.
  return config as AppConfig;
}
