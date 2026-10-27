import { dirname, join } from "node:path";
import { configuredAlertWebhookDestinations, loadConfig } from "../config.js";
import type { CreateApiOptions } from "./support/index.js";


export function configureApiPart01(context: { options: CreateApiOptions }) {
  const config = context.options.config ?? loadConfig();
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
  const cloudflareAccessRuntimeValues = [
      config.cloudflareAccessAccountId,
      config.cloudflareAccessGroupId,
      config.cloudflareAccessGroupName,
      config.cloudflareAccessApiToken,
      config.cloudflareAccessStaticEmails.length > 0 ? "configured" : null,
    ];
  if (cloudflareAccessRuntimeValues.some(Boolean) && !cloudflareAccessRuntimeValues.every(Boolean)) {
      throw new Error("Cloudflare Access synchronization requires a group identity, a static operator email, and an API token");
    }
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
  const extended = Object.assign(context, { config, cloudflareAccessRuntimeValues });
  return extended;
}
