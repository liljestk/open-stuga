import { existsSync } from "node:fs";
import { hasLocalHouseAuthority } from "@climate-twin/contracts";
import type {
  IntegrationDiscoveryResult,
} from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, type AppConfig } from "../../config.js";
import {
  ClimateDatabase,
  type TapoHistoryExportJob,
} from "../../db.js";
import {
  readIntegrationSecrets,
  updateIntegrationSecrets,
  type IntegrationSecrets,
} from "../../integration-secrets.js";
import { IntegrationMetadataStore } from "../../integration-metadata.js";
import {
  type WeatherProvider,
} from "../../weather.js";
import { LocationDiscoveryService } from "../../location-discovery.js";
import {
  type WeatherEventBroker,
} from "../../weather-events.js";
import { TelegramService } from "../../telegram.js";
import {
  type ElectricityEndpointResolver,
} from "../../electricity-prices.js";
import {
  CloudflareSetupService,
} from "../../cloudflare-setup.js";
import { TimeseriesStore } from "../../timeseries/store.js";
import {
  HybridTelemetryReader,
} from "../../timeseries/read-facade.js";
import type { IntegrationDraftTestResult } from "./part-07.js";

export function publicTapoHistoryExportJob(job: TapoHistoryExportJob): Omit<TapoHistoryExportJob,
  "dedupeKey" | "expectedDeviceId" | "rangeStart" | "rangeEnd" | "attempt"
  | "deploymentFingerprint" | "acceptanceRevision" | "expectedSchemaSignature"> {
  const redactRecipient = (value: string | null): string | null => value && job.expectedRecipient
    ? value.replaceAll(job.expectedRecipient, "[redacted export recipient]")
    : value;
  return {
    id: job.id,
    canary: job.canary,
    provider: job.provider,
    sensorId: job.sensorId,
    deviceId: job.deviceId,
    deviceName: job.deviceName,
    timeZone: job.timeZone,
    metric: job.metric,
    // Correlation aliases and mailbox ids are capabilities, not operator UI data.
    expectedRecipient: null,
    from: job.from,
    to: job.to,
    intervalMinutes: job.intervalMinutes,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    submittedAt: job.submittedAt,
    mailboxMessageId: null,
    sourceArtifactSha256: job.sourceArtifactSha256,
    sourceArtifactBytes: job.sourceArtifactBytes,
    parserVersion: job.parserVersion,
    sourceSchemaSignature: job.sourceSchemaSignature,
    stagedSampleCount: job.stagedSampleCount,
    consumedSampleCount: job.consumedSampleCount,
    lastError: redactRecipient(job.lastError),
    attentionReason: redactRecipient(job.attentionReason),
    detail: redactRecipient(job.detail),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

export function workerTapoHistoryExportJob(job: TapoHistoryExportJob): Pick<TapoHistoryExportJob,
  "id" | "sensorId" | "deviceId" | "deviceName" | "metric" | "from" | "to" | "timeZone"
  | "intervalMinutes" | "expectedRecipient" | "status" | "attemptCount" | "leaseExpiresAt"> {
  return {
    id: job.id,
    sensorId: job.sensorId,
    deviceId: job.deviceId,
    deviceName: job.deviceName,
    metric: job.metric,
    from: job.from,
    to: job.to,
    timeZone: job.timeZone,
    intervalMinutes: job.intervalMinutes,
    expectedRecipient: job.expectedRecipient,
    status: job.status,
    attemptCount: job.attemptCount,
    leaseExpiresAt: job.leaseExpiresAt,
  };
}

export interface CreateApiOptions {
  config?: AppConfig;
  database?: ClimateDatabase;
  weatherProvider?: WeatherProvider;
  weatherEventBroker?: WeatherEventBroker;
  locationDiscovery?: LocationDiscoveryService;
  telegram?: TelegramService;
  homeAssistantCredentialTester?: (url: string, token: string) => Promise<IntegrationDraftTestResult>;
  tpLinkCredentialTester?: (host: string, username: string, password: string) => Promise<IntegrationDraftTestResult>;
  integrationDiscoverer?: (
    houseId?: string,
    tpLinkCredentials?: { username: string; password: string },
  ) => Promise<IntegrationDiscoveryResult>;
  electricityPriceFetcher?: typeof fetch;
  cloudflareAccessFetcher?: typeof fetch;
  cloudflareSetupFetcher?: typeof fetch;
  bugReportFetcher?: typeof fetch;
  cloudflareSetup?: CloudflareSetupService;
  stugubyFetcher?: typeof fetch;
  electricityEndpointResolver?: ElectricityEndpointResolver;
  /** Test/embedding hook; normal deployments resolve aliases from live TP-Link discovery. */
  tapoHistoryDeviceNameFor?: (sensorId: string, deviceId: string) => string | null;
  /** Test/embedding clock for durable Tapo history transitions. */
  tapoHistoryNow?: () => Date;
  /** Test/embedding clock for house-local daily peer-period findings. */
  dailyAnalyticsNow?: () => number;
  timeseriesStore?: TimeseriesStore;
  telemetryReader?: HybridTelemetryReader;
  /** Test/embedding admission seam; production defaults to live host health. */
  backgroundWorkAdmission?: () => boolean | Promise<boolean>;
  startBackground?: boolean;
}

export function sameHomeAssistantCredential(
  left: IntegrationSecrets["homeAssistant"],
  right: { url: string | null; token: string | null },
): boolean {
  return Boolean(left && left.url === right.url && left.token === right.token);
}

export function sameTpLinkCredential(
  left: IntegrationSecrets["tpLink"],
  right: { host: string | null; username: string | null; password: string | null },
): boolean {
  return Boolean(left && left.host === right.host && left.username === right.username && left.password === right.password);
}

export function sameTelegramCredential(
  left: IntegrationSecrets["telegram"],
  right: { botToken: string | null; chatId: string | null },
): boolean {
  return Boolean(left && left.botToken === right.botToken && left.chatId === right.chatId);
}

export function mirrorEnvironmentWebhook(config: AppConfig): void {
  const webhookDestinations = configuredAlertWebhookDestinations(config);
  if (config.alertWebhookSource !== "environment" || webhookDestinations.length === 0) return;
  try {
    const fileExists = existsSync(config.integrationSecretsFile);
    const secrets = fileExists ? readIntegrationSecrets(config.integrationSecretsFile) : null;
    const existing = secrets?.webhookDestinations
      ?? (secrets?.webhook ? [{ id: "primary", ...secrets.webhook }] : []);
    if (JSON.stringify(existing) === JSON.stringify(webhookDestinations)) return;
    updateIntegrationSecrets(config.integrationSecretsFile, {
      webhook: null,
      webhookDestinations,
      ...(!fileExists ? { metadataSnapshotIncomplete: true } : {}),
    });
  } catch {
    // Environment configuration remains usable. A missing/unreadable protected
    // store must never trigger metadata pruning or reveal credential details.
  }
}

export function initializeIntegrationMetadata(config: AppConfig, database: ClimateDatabase): IntegrationMetadataStore {
  const store = new IntegrationMetadataStore(database);
  const protectedFileExistedAtStart = existsSync(config.integrationSecretsFile);
  mirrorEnvironmentWebhook(config);
  let protectedSecrets: IntegrationSecrets | null = null;
  let authoritative = false;
  if (existsSync(config.integrationSecretsFile)) {
    try {
      protectedSecrets = readIntegrationSecrets(config.integrationSecretsFile);
      authoritative = protectedFileExistedAtStart && protectedSecrets.metadataSnapshotIncomplete !== true;
    } catch {
      // Fail closed: keep last-known metadata active until a validated snapshot
      // can prove that its credential reference was intentionally removed.
    }
  }
  const metadataSecrets: IntegrationSecrets = protectedSecrets
    ? {
        ...protectedSecrets,
        ...(protectedSecrets.homeAssistantConnections
          ? { homeAssistantConnections: protectedSecrets.homeAssistantConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(protectedSecrets.tpLinkConnections
          ? { tpLinkConnections: protectedSecrets.tpLinkConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(protectedSecrets.appleNotesGrants
          ? { appleNotesGrants: protectedSecrets.appleNotesGrants.map((grant) => ({ ...grant })) }
          : {}),
        ...(protectedSecrets.webhookDestinations
          ? { webhookDestinations: protectedSecrets.webhookDestinations.map((destination) => ({ ...destination })) }
          : {}),
      }
    : {
        version: 1,
        ...(config.homeAssistantConnections
          ? { homeAssistantConnections: config.homeAssistantConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(config.tpLinkConnections
          ? { tpLinkConnections: config.tpLinkConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(config.appleNotesGrants.length
          ? { appleNotesGrants: config.appleNotesGrants.map((grant) => ({ ...grant })) }
          : {}),
      };
  const firstHouseId = database.listHouses().find(hasLocalHouseAuthority)?.id ?? null;
  const homeAssistantFromEnvironment = Boolean(
    firstHouseId && !config.homeAssistantLegacyDisabled && config.haUrl && config.haToken
      && !sameHomeAssistantCredential(protectedSecrets?.homeAssistant, { url: config.haUrl, token: config.haToken }),
  );
  const tpLinkFromEnvironment = Boolean(
    firstHouseId && !config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
      && !sameTpLinkCredential(protectedSecrets?.tpLink, {
        host: config.tpLinkHost, username: config.tpLinkUsername, password: config.tpLinkPassword,
      }),
  );
  const telegramFromEnvironment = Boolean(
    config.telegramBotToken && config.telegramChatId
      && !sameTelegramCredential(protectedSecrets?.telegram, {
        botToken: config.telegramBotToken, chatId: config.telegramChatId,
      }),
  );
  const webhookFromEnvironment = config.alertWebhookSource === "environment"
    && configuredAlertWebhookDestinations(config).length > 0;
  if (homeAssistantFromEnvironment) delete metadataSecrets.homeAssistant;
  if (tpLinkFromEnvironment) delete metadataSecrets.tpLink;
  if (telegramFromEnvironment) delete metadataSecrets.telegram;
  if (webhookFromEnvironment) {
    delete metadataSecrets.webhook;
    delete metadataSecrets.webhookDestinations;
  }
  store.reconcileEnvironment({
    homeAssistant: homeAssistantFromEnvironment && firstHouseId && config.haUrl
      ? { houseId: firstHouseId, url: config.haUrl }
      : null,
    tpLink: tpLinkFromEnvironment && firstHouseId && config.tpLinkHost
      ? { houseId: firstHouseId, host: config.tpLinkHost }
      : null,
    telegramConfigured: telegramFromEnvironment,
    webhookDestinationIds: webhookFromEnvironment
      ? configuredAlertWebhookDestinations(config).map((destination) => destination.id)
      : [],
  });
  store.reconcileProtectedFile({ authoritative, secrets: metadataSecrets, legacyHouseId: firstHouseId });
  return store;
}
