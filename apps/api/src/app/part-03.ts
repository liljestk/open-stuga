import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, resolvePlanElementOpeningState } from "@climate-twin/contracts";
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
import { configuredAlertWebhookDestinations, loadConfig, type AppConfig } from "../config.js";
import {
  ClimateDatabase,
  ClimateDataValidationError,
  outdoorLocationKey,
  type SecurityAuditEventInput,
  type SensorUpdate,
  type TapoHistoryExportJob,
  type TelemetryCascadeScope,
} from "../db.js";
import { TelemetryBus } from "../events.js";
import { HomeAssistantBridge, testHomeAssistantCredentials } from "../home-assistant.js";
import { mergeTpLinkHistoryRecovery, TpLinkBridge, type TpLinkConnectionUpdate } from "../tp-link.js";
import { GreeBridge } from "../gree.js";
import { HeatPumpStateStore } from "../heat-pump-state.js";
import { ConnectedDeviceStore } from "../connected-device-store.js";
import { TuyaBridge } from "../tuya.js";
import { discoverHomeAssistant } from "../discovery.js";
import {
  readIntegrationSecrets,
  updateIntegrationSecrets,
  type AppleNotesGrantSecret,
  type GreeConnectionSecret,
  type IntegrationSecrets,
  type TpLinkConnectionSecret,
  type TuyaConnectionSecret,
} from "../integration-secrets.js";
import { IntegrationMetadataStore } from "../integration-metadata.js";
import { openApiV1Document, openApiV2Document } from "../openapi.js";
import {
  FmiWeatherProvider,
  WeatherRequestSupersededError,
  WeatherService,
  WeatherUnavailableError,
  type WeatherProvider,
} from "../weather.js";
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
} from "../services.js";
import { runThermalSimulation } from "../thermal-simulation.js";
import { runThermalIsolation } from "../thermal-isolation.js";
import { SYSTEM_VERSION } from "../version.js";
import { SystemUpdateError, SystemUpdateService } from "../system-updates.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider, prefersFmi } from "../open-meteo.js";
import { WeatherMonitor } from "../weather-monitor.js";
import { DailyAnalyticsFindingsWorker } from "../daily-analytics-findings.js";
import { WeatherRecoveryCoordinator } from "../weather-recovery.js";
import { SensorGapRecoveryCoordinator } from "../sensor-gap-recovery.js";
import {
  TAPO_CANARY_APPROVAL_MAX_AGE_MS,
  TapoHistoryCanaryError,
  TapoHistoryExportService,
} from "../tapo-history-export.js";
import {
  InMemoryWeatherEventBroker,
  WeatherEventSupersededError,
  type WeatherEventBroker,
} from "../weather-events.js";
import { TelegramService, TelegramServiceError } from "../telegram.js";
import { NotificationOutboxWorker } from "../outbox.js";
import { enqueueHostSystemAlertNotifications } from "../host-system-notifications.js";
import { apnsConfigured } from "../apns.js";
import { normalizeAlertDeliveryPolicy } from "../notification-policy.js";
import {
  ElectricityEndpointPolicyError,
  ElectricityPriceService,
  publicElectricityConfiguration,
  validateElectricityEndpointUrl,
  type ElectricityEndpointResolver,
} from "../electricity-prices.js";
import {
  LocalAuthError,
  LocalAuthStore,
  type LocalAuthIdentity,
  type LocalAuthSession,
} from "../local-auth.js";
import { CloudflareAccessGroupSynchronizer } from "../cloudflare-access.js";
import {
  CloudflareSetupError,
  CloudflareSetupService,
  cloudflareSetupCallbackPath,
  type CloudflareSetupStartInput,
} from "../cloudflare-setup.js";
import {
  createLocalSpatialLayerRuntime,
  registerSpatialLayerRoutes,
  type LocalSpatialLayerRuntime,
} from "../spatial-layers/index.js";
import { LruTtlCache } from "../cache.js";
import { DataOperationsService } from "../data-operations.js";
import { EnergyOptimizer } from "../energy-optimizer.js";
import { EnergyCostService } from "../energy-cost.js";
import { SetupDoctor } from "../setup-doctor.js";
import { ScheduledDataExportService } from "../scheduled-data-exports.js";
import { TimeseriesStore } from "../timeseries/store.js";
import {
  TelemetryArchiveWorker,
} from "../timeseries/archive-worker.js";
import {
  HybridTelemetryReader,
  bucketLegacyReadings,
  bucketMeasurementSamples,
  IncompleteTelemetryHistoryError,
  isLocalTelemetryHistoryComplete,
} from "../timeseries/read-facade.js";
import { TelemetryRetentionWorker } from "../timeseries/retention-worker.js";
import { TelemetryOrderedRollupWorker } from "../timeseries/ordered-rollup-worker.js";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
  parseAnalyticsCoverageRequest,
  parseAnalyticsQueryRequest,
} from "../analytics.js";
import { AnalyticsWorkLimiter } from "../analytics/work-limiter.js";
import { DerivedAnalyticsCoordinator } from "../analytics/derived-artifacts/coordinator.js";
import { configuredHeatPumpConnectionIds } from "../analytics/heat-pump-evidence.js";
import { hostAllowsBackgroundWork } from "../analytics/background-admission.js";
import { Nexus433Service } from "../nexus433/index.js";
import { loadOrCreateStugubyNodeKeys } from "../stuguby/identity.js";
import { registerStugubyLocalRoutes, registerStugubyProtocolRoutes } from "../stuguby/routes.js";
import { StugubyError, StugubyService } from "../stuguby/service.js";
import { StugubyStore } from "../stuguby/store.js";
import { TrackingSecretBox, loadOrCreateTrackingKey } from "../tracking/crypto.js";
import { registerTrackingRoutes } from "../tracking/routes.js";
import { TrackingService } from "../tracking/service.js";
import {
  TrackingError,
  TrackingStore,
  type AuthenticatedTrackingObserver,
} from "../tracking/store.js";
import { AREA_EQUIPMENT_STATUSES, AuthAbuseLimiter, HttpError, LOCAL_CSRF_COOKIE, LOCAL_SESSION_COOKIE, LOCAL_SESSION_MAX_AGE_MS, LocalVisibility, MAINTENANCE_BASES, MAINTENANCE_CREATE_FIELDS, MAINTENANCE_PATCH_FIELDS, MAINTENANCE_PRIORITIES, MAINTENANCE_STATUSES, MAX_EQUIPMENT_ATTACHMENT_BYTES, MAX_EVENT_STREAMS_GLOBAL, MAX_EVENT_STREAMS_PER_USER, MAX_SSE_QUEUE_BYTES, MAX_SSE_QUEUE_MESSAGES, MEASUREMENT_ID_PATTERN, OBSERVATION_CONFIDENCES, OBSERVATION_CREATE_FIELDS, OBSERVATION_KINDS, OBSERVATION_PATCH_FIELDS, OBSERVATION_SEVERITIES, OBSERVATION_SOURCES, OBSERVATION_STATUSES, OBSERVATION_TIME_PRECISIONS, PROPERTY_AREA_KINDS, PROPERTY_NOTE_KINDS, RESERVED_MEASUREMENT_IDS, SAFE_ASSET_MIME_TYPES, SAFE_EQUIPMENT_DOCUMENT_MIME_TYPES, SAFE_EQUIPMENT_PHOTO_MIME_TYPES, SAFE_HTTP_METHODS, UUID_PATTERN, alertDurationSeconds, appleNotesCaptureInput, appleNotesCaptureMatches, appleNotesGrant, appleNotesGrantSummary, appleNotesSnapshot, assertEquipmentAttachmentMediaType, auditAccountSubject, authAttemptKeys, bodyObject, boundedQueryInteger, boundedSseWriter, browserOriginAllowed, clearLocalSessionCookies, cloudflareUiRedirectUri, collectionPage, completeVisibleCollection, cookieValue, credentialString, dateValue, enumValue, equipmentAttachmentData, equipmentAttachmentDisposition, homeAssistantUrl, houseLocationValue, houseMapPlacementValue, initializeIntegrationMetadata, isIOSNotificationRegistrationPath, isLoopbackSocket, isPrivateProxySocket, isTrackingObserverHeartbeatPath, keyMatches, localAuthorizationFingerprint, localCloudflareUiRequestAllowed, localSetupRequestAllowed, maintenanceDateValue, maintenanceObservationIds, maintenanceText, maintenanceTitle, measurementId, measurementNumberMap, measurementStringMap, measurementUnits, mirrorEnvironmentWebhook, networkHost, normalizedHostname, normalizedOrigin, notePlainLine, noteTaskBlock, nullableFinite, nullablePropertyTarget, optionalBoolean, optionalNullableNumber, optionalNullableString, optionalObservationDate, optionalQueryNumber, optionalResourceQuery, optionalString, parseActionPlaybookInput, parseActionRunStart, parseAlertDeliveryPolicy, parseAlertRule, parseAreaEquipmentInput, parseAreaEquipmentPatch, parseEquipmentAttachmentUpload, parseEquipmentLinkInput, parseEquipmentLinkPatch, parseMaintenanceTaskInput, parseMaintenanceTaskPatch, parseMeasurementDefinition, parseMeasurementSample, parseObservationInput, parseObservationPatch, parsePropertyAreaInput, parsePropertyAreaPatch, parsePropertyInput, parsePropertyNoteInput, parsePropertyNotePatch, parsePropertyPatch, parseReading, parseSensorPatch, persistWeatherObservation, propertyCoordinate, propertyPolygon, propertyText, publicTapoHistoryExportJob, queryList, refreshAppleNotesStatus, rejectUnknownFields, requestOrigin, requestPrincipal, requireJsonContentType, requireNonGuest, requireWorkspaceAdmin, requiredNumber, requiredString, safeInteger, sameHomeAssistantCredential, sameTelegramCredential, sameTpLinkCredential, secureRequest, sessionDocument, setLocalSessionCookies, stringMap, trackingObserverAttemptKeys, trustedProxyClientAddress, trustedProxyRequest, trustedSelfHostname, validateMeasurementDefinition, visibleCollectionPage, workerTapoHistoryExportJob } from "./support/index.js";
import type { ApiRuntime, AuthAttemptBucket, AuthAttemptLimit, BoundedSseWriter, CreateApiOptions, IntegrationDraftTestResult, LocalRequestPrincipal } from "./support/index.js";
import { configureApiPart02 } from "./part-02.js";

type DeferredContext = {
  telegramDeliveryGeneration: number;
  sensorGapRecovery: SensorGapRecoveryCoordinator | null;
  tpLink: TpLinkBridge | undefined;
  notifyOpeningStateRecorded: (observation: OpeningStateObservation) => void;
};

type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

type PendingTpLinkConnectionUpdate = Omit<TpLinkConnectionUpdate, "previousHost">;

function applyTpLinkConnectionUpdate(
  current: TpLinkConnectionSecret,
  update: PendingTpLinkConnectionUpdate,
): TpLinkConnectionSecret {
  const next: TpLinkConnectionSecret = {
    ...current,
    host: update.host,
    ...(update.deviceId ? { deviceId: update.deviceId } : {}),
    ...(update.sourceType ? { sourceType: update.sourceType } : {}),
    ...(update.sourceModel ? { sourceModel: update.sourceModel } : {}),
    ...(update.sourceAlias ? { sourceAlias: update.sourceAlias } : {}),
  };
  if (update.sourceAlias === null) delete next.sourceAlias;
  return next;
}

function tpLinkConnectionsConflict(connections: TpLinkConnectionSecret[]): boolean {
  const ids = new Set<string>();
  const houseHosts = new Set<string>();
  const deviceIds = new Set<string>();
  for (const connection of connections) {
    const houseHost = `${connection.houseId.trim()}\u0000${connection.host.trim().toLowerCase()}`;
    const deviceId = connection.deviceId?.trim().toUpperCase();
    if (ids.has(connection.id) || houseHosts.has(houseHost) || (deviceId && deviceIds.has(deviceId))) return true;
    ids.add(connection.id);
    houseHosts.add(houseHost);
    if (deviceId) deviceIds.add(deviceId);
  }
  return false;
}

export function configureApiPart03(context: ReturnType<typeof configureApiPart02>) {
  const deferred = context as typeof context & DeferredContext;
  const config = context.config as NormalizedApiConfig;
  const timeseries = config.timeseriesEnabled ? context.options.timeseriesStore ?? new TimeseriesStore({
      poolConfig: {
        host: config.timeseriesHost,
        port: config.timeseriesPort,
        database: config.timeseriesDatabase,
        user: config.timeseriesUser,
        password: config.timeseriesPassword,
        // Heavy analytics are already admitted in-process. Disabling backend
        // query parallelism prevents two admitted reads from consuming every
        // Raspberry Pi core through PostgreSQL worker fan-out.
        options: "-c max_parallel_workers_per_gather=0",
        ...(context.timeseriesSsl ? { ssl: context.timeseriesSsl } : {}),
      },
      maxConnections: config.timeseriesPoolMax,
      connectionTimeoutMs: config.timeseriesConnectTimeoutMs,
      statementTimeoutMs: config.timeseriesStatementTimeoutMs,
      batchSize: config.timeseriesBatchSize,
      orderedMetricIds: context.database.listMeasurementDefinitions(false)
        .filter((definition) => definition.kind === "rate" || definition.kind === "cumulative_counter")
        .map((definition) => definition.id),
      coldStorageAfterDays: config.timeseriesColumnstoreAfterDays,
    }) : null;
  context.hostDatabaseMetrics.setTimeseries(timeseries);
  const heatPumpStates = new HeatPumpStateStore(context.database);
  const connectedDevices = new ConnectedDeviceStore(context.database);
  const telemetryArchive = timeseries
      ? new TelemetryArchiveWorker(context.database, context.bus, timeseries, {
        batchSize: config.timeseriesBatchSize,
        requireTimescale: config.timeseriesRequired,
        localHistoryRetentionDays: config.retentionDays,
        heatPumpStatePage: (cursor, limit) => heatPumpStates.archivePage(cursor, limit),
      })
      : null;
  const telemetryRetention = telemetryArchive && config.retentionDays > 0
      ? new TelemetryRetentionWorker(context.database, telemetryArchive, config.retentionDays)
      : null;
  const telemetryOrderedRollups = timeseries ? new TelemetryOrderedRollupWorker(timeseries, { ready: () => ["syncing", "ready"].includes(telemetryArchive!.status().phase) }) : null;
  const telemetryReader = context.options.telemetryReader ?? new HybridTelemetryReader({
      local: context.database,
      archive: timeseries,
      archivePhase: () => {
        const archive = telemetryArchive?.status();
        return archive?.caughtUp ? "ready" : archive?.phase;
      },
      archiveLastSuccessAt: () => telemetryArchive?.status().lastSuccessAt,
      reconcile: () => telemetryArchive?.reconcileNow(),
      localHistoryComplete: telemetryArchive === null || config.retentionDays === 0
        ? true
        : (query) => isLocalTelemetryHistoryComplete({
            timeseriesEnabled: true,
            retentionDays: config.retentionDays,
            from: query.from,
          }),
    });
  const analyticsWorkLimiter = new AnalyticsWorkLimiter({
      maxConcurrent: Math.max(1, Math.min(2, config.timeseriesPoolMax)),
      maxQueued: 32,
    });
  const admitLowPriority = context.options.backgroundWorkAdmission
    ?? (context.options.startBackground === false
      ? () => true
      : async (): Promise<boolean> => hostAllowsBackgroundWork(
          await context.hostSystem.snapshot(),
        ));
  const derivedAnalytics = new DerivedAnalyticsCoordinator(
      context.database,
      telemetryReader,
      analyticsWorkLimiter,
      {
        admitLowPriority,
        heatPumpConnectionIds: (houseId) => configuredHeatPumpConnectionIds(
          context.config.greeConnections,
          houseId,
        ),
      },
    );
  context.energyOptimizer.setTelemetryReader(telemetryReader);
  const dailyAnalyticsFindings = new DailyAnalyticsFindingsWorker({
      database: context.database,
      telemetryReader,
      ...(context.options.dailyAnalyticsNow ? { now: context.options.dailyAnalyticsNow } : {}),
    });
  const scheduledDataExports = new ScheduledDataExportService({
      database: context.database,
      telemetryReader,
      systemStorage: context.systemStorage,
      dataOperations: context.dataOperations,
      operationsDirectory: config.backupOperationsDirectory,
    });
  const measurementSnapshotCache = new LruTtlCache<MeasurementSample[]>({
      maxEntries: 64,
      maxBytes: 8 * 1024 * 1024,
      defaultTtlMs: 2_000,
    });
  const readingSnapshotCache = new LruTtlCache<Reading[]>({
      maxEntries: 4,
      maxBytes: 4 * 1024 * 1024,
      defaultTtlMs: 2_000,
    });
  const status = new RuntimeStatus(config, context.bus, context.database);
  const setupDoctor = new SetupDoctor(context.database, config, status, context.dataOperations, telemetryArchive);
  const energyCost = new EnergyCostService(
      telemetryReader,
      undefined,
      (sensorId) => context.database.getSensor(sensorId)?.energyMeterRole ?? "standalone",
    );
  const storedTelegramIdentity = context.integrationMetadata.get("telegram", "singleton");
  if (status.value.telegram?.configured && storedTelegramIdentity?.active) {
      status.value.telegram.botUsername = storedTelegramIdentity.label;
      status.value.telegram.chatLabel = storedTelegramIdentity.secondaryLabel;
    }
  const telegram = context.options.telegram ?? new TelegramService();
  const initialTelegramDeliveryGeneration: number = 0;
  Object.assign(context, { telegramDeliveryGeneration: initialTelegramDeliveryGeneration });
  const alertEngine = new AlertEngine(context.database, context.bus, config, status, telegram, telemetryReader);
  const telemetry = new TelemetryService(context.database, context.bus, alertEngine, context.dataMode);
  const nexus433 = new Nexus433Service(config, context.database, telemetry);
  const measurements = new MeasurementService(context.database, context.bus, alertEngine, context.dataMode);
  heatPumpStates.setMeasurementSink((samples) => {
    measurements.ingestBatch(samples, { allowDisabledSensors: true });
  });
  const notificationOutbox = new NotificationOutboxWorker(
      context.database,
      config,
      status,
      telegram,
      fetch,
      () => deferred.telegramDeliveryGeneration,
      undefined,
      (failure) => context.systemErrorLog.record({
        level: failure.terminal ? "error" : "warning",
        source: `notifications.${failure.channel}`,
        code: failure.terminal ? "DELIVERY_DEAD_LETTERED" : "DELIVERY_FAILED",
        message: failure.message,
      }),
    );
  context.hostSystem.setAlertSnapshotHandler((snapshot) => {
      if (enqueueHostSystemAlertNotifications(context.database, config, snapshot) > 0) {
        notificationOutbox.wake();
      }
    });
  const mock = new MockEngine(context.database, telemetry, config, context.dataMode);
  const replay = new ReplayEngine(context.database, context.bus);
  const initialSensorGapRecovery: SensorGapRecoveryCoordinator | null = null;
  Object.assign(context, { sensorGapRecovery: initialSensorGapRecovery });
  const initialTpLink: TpLinkBridge | undefined = undefined;
  Object.assign(context, { tpLink: initialTpLink });
  const initialNotifyOpeningStateRecorded = (_observation: OpeningStateObservation): void => undefined;
  Object.assign(context, { notifyOpeningStateRecorded: initialNotifyOpeningStateRecorded });
  const wakeSensorGapRecovery = (): void => deferred.sensorGapRecovery?.wake();
  const tapoHistory = new TapoHistoryExportService(config, context.database, {
      telemetryReader,
      onHistoryReady: wakeSensorGapRecovery,
      ...(context.options.tapoHistoryNow ? { now: context.options.tapoHistoryNow } : {}),
      deviceNameFor: context.options.tapoHistoryDeviceNameFor
        ?? ((sensorId, deviceId) => deferred.tpLink?.tapoAppDeviceName(sensorId, deviceId) ?? null),
    });
  const tapoHistoryFallbackKeys = new Set<string>();
  const historyFallbackKey = (sensorId: string, metric: string, from: string, to: string): string => (
      JSON.stringify([sensorId, metric, from, to])
    );
  const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, context.database, status, {
      onAvailabilityChange: wakeSensorGapRecovery,
      onOpeningStateRecorded: (observation) => deferred.notifyOpeningStateRecorded(observation),
      // Direct polling defaults to 2 s versus HA's current 5 s integration poll.
      // Prefer it only while this exact metric is healthy; HA then fails over
      // without requiring a configuration change or a second Sensor row.
      shouldIngestLiveMeasurement: (sensorId, metric) => (
        !deferred.tpLink?.isMetricAvailable(sensorId, metric)
        && !nexus433.isMetricAvailable(sensorId, metric)
      ),
    });
  const pendingTpLinkConnectionUpdates = new Map<string, PendingTpLinkConnectionUpdate>();
  deferred.tpLink = new TpLinkBridge(config, telemetry, measurements, context.database, status, {
      onAvailabilityChange: wakeSensorGapRecovery,
      onOpeningStateRecorded: (observation) => deferred.notifyOpeningStateRecorded(observation),
      historyFallback: {
        recoverHistory: async (sensorId, metric, from, to) => {
          const key = historyFallbackKey(sensorId, metric, from, to);
          tapoHistoryFallbackKeys.delete(key);
          let homeAssistantResult;
          try {
            homeAssistantResult = await homeAssistant.recoverHistory(sensorId, metric, from, to);
          } catch {
            homeAssistantResult = {
              state: "not-supported" as const,
              samples: [],
              error: "Home Assistant recorder history is temporarily unavailable",
            };
          }
          if (homeAssistantResult.state === "complete" && homeAssistantResult.samples.length > 0) {
            return homeAssistantResult;
          }
          tapoHistoryFallbackKeys.add(key);
          const tapoResult = await tapoHistory.recoverHistory(sensorId, metric, from, to);
          return mergeTpLinkHistoryRecovery(homeAssistantResult, tapoResult);
        },
        consumeRecovered: (sensorId, metric, from, to) => {
          const key = historyFallbackKey(sensorId, metric, from, to);
          if (!tapoHistoryFallbackKeys.delete(key)) return;
          tapoHistory.consumeRecovered(sensorId, metric, from, to);
        },
      },
      onConnectionUpdate: (update) => {
        const existing = config.tpLinkConnections ?? [];
        const current = existing.find((connection) => connection.id === update.id);
        if (!current || current.houseId !== update.houseId) return;
        const pending = pendingTpLinkConnectionUpdates.get(update.id);
        const effectiveCurrent = pending ? applyTpLinkConnectionUpdate(current, pending) : current;
        if (update.host !== effectiveCurrent.host && effectiveCurrent.host !== update.previousHost) return;
        if (update.deviceId && update.deviceId.length > 1_024) return;
        if (update.sourceModel && update.sourceModel.length > 128) return;
        if (update.sourceAlias && update.sourceAlias.length > 512) return;
        if (effectiveCurrent.deviceId && update.deviceId
          && effectiveCurrent.deviceId.trim().toUpperCase() !== update.deviceId.trim().toUpperCase()) return;
        const staged: PendingTpLinkConnectionUpdate = {
          id: current.id,
          houseId: current.houseId,
          host: update.host,
          ...(update.deviceId ? { deviceId: update.deviceId } : pending?.deviceId ? { deviceId: pending.deviceId } : {}),
          ...(update.sourceType ? { sourceType: update.sourceType } : pending?.sourceType ? { sourceType: pending.sourceType } : {}),
          ...(update.sourceModel ? { sourceModel: update.sourceModel } : pending?.sourceModel ? { sourceModel: pending.sourceModel } : {}),
          ...(update.sourceAlias !== undefined
            ? { sourceAlias: update.sourceAlias }
            : pending && "sourceAlias" in pending ? { sourceAlias: pending.sourceAlias } : {}),
        };
        const nextConnection = applyTpLinkConnectionUpdate(current, staged);
        if (JSON.stringify(nextConnection) === JSON.stringify(current)) pendingTpLinkConnectionUpdates.delete(current.id);
        else pendingTpLinkConnectionUpdates.set(current.id, staged);
        const connections = existing.map((connection) => {
          const connectionUpdate = pendingTpLinkConnectionUpdates.get(connection.id);
          return connectionUpdate ? applyTpLinkConnectionUpdate(connection, connectionUpdate) : connection;
        });
        if (tpLinkConnectionsConflict(connections) || pendingTpLinkConnectionUpdates.size === 0) return;
        const committedUpdates = [...pendingTpLinkConnectionUpdates.values()];
        updateIntegrationSecrets(config.integrationSecretsFile, { tpLinkConnections: connections });
        config.tpLinkConnections = connections;
        pendingTpLinkConnectionUpdates.clear();
        for (const committed of committedUpdates) {
          context.integrationMetadata.saveTpLink({
            id: committed.id,
            houseId: committed.houseId,
            host: committed.host,
            reason: "identity-refreshed",
          });
        }
      },
    });
  const gree = new GreeBridge(config, status, heatPumpStates, context.bus, {
      onStateRecorded: () => {
        void telemetryArchive?.reconcileNow().catch(() => undefined);
      },
      onConnectionUpdate: (update) => {
        const existing = config.greeConnections ?? [];
        const current = existing.find((connection) => connection.id === update.id);
        if (!current || current.houseId !== update.houseId || current.mac !== update.mac
          || current.key !== update.key || current.cipherVersion !== update.cipherVersion) return;
        const nextConnection: GreeConnectionSecret = {
          ...current,
          host: update.host,
          port: update.port,
          ...(update.name ? { name: update.name } : {}),
          ...(update.brand ? { brand: update.brand } : {}),
          ...(update.model ? { model: update.model } : {}),
          ...(update.version ? { version: update.version } : {}),
        };
        if (JSON.stringify(current) === JSON.stringify(nextConnection)) return;
        const connections = existing.map((connection) => (
          connection.id === current.id ? nextConnection : connection
        ));
        updateIntegrationSecrets(config.integrationSecretsFile, { greeConnections: connections });
        config.greeConnections = connections;
      },
    });
  const tuya = new TuyaBridge(
      config,
      status,
      connectedDevices,
      context.database,
      measurements,
      context.bus,
      {
        onConnectionUpdate: (update) => {
          const existing = config.tuyaConnections ?? [];
          const current = existing.find((connection) => connection.id === update.id);
          if (!current || current.houseId !== update.houseId
            || current.deviceId !== update.deviceId || current.localKey !== update.localKey
            || current.protocolVersion !== update.protocolVersion
            || current.profileId !== update.profileId) return;
          const nextConnection: TuyaConnectionSecret = { ...current, host: update.host };
          if (nextConnection.host === current.host) return;
          const connections = existing.map((connection) => (
            connection.id === current.id ? nextConnection : connection
          ));
          updateIntegrationSecrets(config.integrationSecretsFile, { tuyaConnections: connections });
          config.tuyaConnections = connections;
        },
      },
    );
  deferred.sensorGapRecovery = new SensorGapRecoveryCoordinator(context.database, measurements, [homeAssistant, deferred.tpLink], {
      telemetryReader,
      onRecovered: () => {
        measurementSnapshotCache.clear();
        return telemetryArchive?.reconcileNow();
      },
    });
  const extended = Object.assign(context, { timeseries, telemetryArchive, telemetryRetention, telemetryOrderedRollups, telemetryReader, analyticsWorkLimiter, admitLowPriority, derivedAnalytics, dailyAnalyticsFindings, scheduledDataExports, measurementSnapshotCache, readingSnapshotCache, status, setupDoctor, energyCost, storedTelegramIdentity, telegram, alertEngine, telemetry, nexus433, measurements, notificationOutbox, mock, replay, wakeSensorGapRecovery, tapoHistory, tapoHistoryFallbackKeys, historyFallbackKey, homeAssistant, heatPumpStates, gree, connectedDevices, tuya });
  return extended as typeof extended & DeferredContext & {
    sensorGapRecovery: SensorGapRecoveryCoordinator;
    tpLink: TpLinkBridge;
  };
}
