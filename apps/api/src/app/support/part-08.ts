import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, hasLocalHouseAuthority, resolvePlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AreaEquipment,
  EquipmentAttachmentUploadInput,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybookInput,
  ActionRunStartInput,
  DataExportPrivacyLevel,
  AlertRule,
  AlertDeliveryPolicy,
  AppSession,
  AppleNotesMaintenanceCaptureResult,
  AppleNotesSnapshot,
  Floor,
  GeoCoordinate,
  GuestAccessGrant,
  HouseWeather,
  HouseLocation,
  HouseMapPlacement,
  HomeElectricityPricePoint,
  IntegrationStatus,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTask,
  ManualObservationInput,
  ManualObservationPatch,
  OpeningStateObservation,
  OpeningStateObservationInput,
  MeasurementDefinition,
  MeasurementSample,
  PropertyAreaInput,
  PropertyAreaPatch,
  Property,
  PropertyArea,
  PropertyCreateInput,
  PropertyInventorySnapshot,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyNote,
  PropertyPatch,
  PropertyElectricityConfigInput,
  Reading,
  Sensor,
  StaticParameter,
  TelemetryEvent,
  TenantMemberRole,
  TrackingFeatureFlags,
} from "@climate-twin/contracts";
import { configuredAlertWebhookDestinations, loadConfig, type AppConfig } from "../../config.js";
import {
  ClimateDatabase,
  ClimateDataValidationError,
  outdoorLocationKey,
  type SecurityAuditEventInput,
  type SensorUpdate,
  type TapoHistoryExportJob,
  type TelemetryCascadeScope,
} from "../../db.js";
import { TelemetryBus } from "../../events.js";
import { HomeAssistantBridge, testHomeAssistantCredentials } from "../../home-assistant.js";
import { mergeTpLinkHistoryRecovery, TpLinkBridge } from "../../tp-link.js";
import { discoverHomeAssistant } from "../../discovery.js";
import {
  readIntegrationSecrets,
  updateIntegrationSecrets,
  type AppleNotesGrantSecret,
  type IntegrationSecrets,
  type TpLinkConnectionSecret,
} from "../../integration-secrets.js";
import { IntegrationMetadataStore } from "../../integration-metadata.js";
import { openApiV1Document, openApiV2Document } from "../../openapi.js";
import {
  FmiWeatherProvider,
  WeatherRequestSupersededError,
  WeatherService,
  WeatherUnavailableError,
  type WeatherProvider,
} from "../../weather.js";
import {
  AlertEngine,
  DataModeCoordinator,
  forecast,
  forecastMeasurement,
  MeasurementService,
  MeasurementValidationError,
  MockEngine,
  MOCK_SCENARIOS,
  ReplayEngine,
  RuntimeStatus,
  TelemetryValidationError,
  TelemetryService,
} from "../../services.js";
import { runThermalSimulation } from "../../thermal-simulation.js";
import { runThermalIsolation } from "../../thermal-isolation.js";
import { SYSTEM_VERSION } from "../../version.js";
import { SystemUpdateError, SystemUpdateService } from "../../system-updates.js";
import { LocationDiscoveryService } from "../../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider, prefersFmi } from "../../open-meteo.js";
import { WeatherMonitor } from "../../weather-monitor.js";
import { DailyAnalyticsFindingsWorker } from "../../daily-analytics-findings.js";
import { WeatherRecoveryCoordinator } from "../../weather-recovery.js";
import { SensorGapRecoveryCoordinator } from "../../sensor-gap-recovery.js";
import {
  TAPO_CANARY_APPROVAL_MAX_AGE_MS,
  TapoHistoryCanaryError,
  TapoHistoryExportService,
} from "../../tapo-history-export.js";
import {
  InMemoryWeatherEventBroker,
  WeatherEventSupersededError,
  type WeatherEventBroker,
} from "../../weather-events.js";
import { TelegramService, TelegramServiceError } from "../../telegram.js";
import { NotificationOutboxWorker } from "../../outbox.js";
import { apnsConfigured } from "../../apns.js";
import { normalizeAlertDeliveryPolicy } from "../../notification-policy.js";
import {
  ElectricityEndpointPolicyError,
  ElectricityPriceService,
  publicElectricityConfiguration,
  validateElectricityEndpointUrl,
  type ElectricityEndpointResolver,
} from "../../electricity-prices.js";
import {
  LocalAuthError,
  LocalAuthStore,
  type LocalAuthIdentity,
  type LocalAuthSession,
} from "../../local-auth.js";
import { CloudflareAccessGroupSynchronizer } from "../../cloudflare-access.js";
import {
  CloudflareSetupError,
  CloudflareSetupService,
  cloudflareSetupCallbackPath,
  type CloudflareSetupStartInput,
} from "../../cloudflare-setup.js";
import {
  createLocalSpatialLayerRuntime,
  registerSpatialLayerRoutes,
  type LocalSpatialLayerRuntime,
} from "../../spatial-layers/index.js";
import { LruTtlCache } from "../../cache.js";
import { DataOperationsService } from "../../data-operations.js";
import { EnergyOptimizer } from "../../energy-optimizer.js";
import { EnergyCostService } from "../../energy-cost.js";
import { SetupDoctor } from "../../setup-doctor.js";
import { TimeseriesStore } from "../../timeseries/store.js";
import {
  TelemetryArchiveWorker,
} from "../../timeseries/archive-worker.js";
import {
  HybridTelemetryReader,
  bucketLegacyReadings,
  bucketMeasurementSamples,
  IncompleteTelemetryHistoryError,
} from "../../timeseries/read-facade.js";
import { TelemetryRetentionWorker } from "../../timeseries/retention-worker.js";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
  parseAnalyticsCoverageRequest,
  parseAnalyticsQueryRequest,
} from "../../analytics.js";
import { loadOrCreateStugubyNodeKeys } from "../../stuguby/identity.js";
import { registerStugubyLocalRoutes, registerStugubyProtocolRoutes } from "../../stuguby/routes.js";
import { StugubyError, StugubyService } from "../../stuguby/service.js";
import { StugubyStore } from "../../stuguby/store.js";
import { TrackingSecretBox, loadOrCreateTrackingKey } from "../../tracking/crypto.js";
import { registerTrackingRoutes } from "../../tracking/routes.js";
import { TrackingService } from "../../tracking/service.js";
import {
  TrackingError,
  TrackingStore,
  type AuthenticatedTrackingObserver,
} from "../../tracking/store.js";
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
  electricityPriceFetcher?: typeof fetch;
  cloudflareAccessFetcher?: typeof fetch;
  cloudflareSetupFetcher?: typeof fetch;
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
