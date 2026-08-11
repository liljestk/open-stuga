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
import { mergeTpLinkHistoryRecovery, TpLinkBridge } from "../tp-link.js";
import { discoverHomeAssistant } from "../discovery.js";
import {
  readIntegrationSecrets,
  updateIntegrationSecrets,
  type AppleNotesGrantSecret,
  type IntegrationSecrets,
  type TpLinkConnectionSecret,
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
import { TimeseriesStore } from "../timeseries/store.js";
import {
  TelemetryArchiveWorker,
} from "../timeseries/archive-worker.js";
import {
  HybridTelemetryReader,
  bucketLegacyReadings,
  bucketMeasurementSamples,
  IncompleteTelemetryHistoryError,
} from "../timeseries/read-facade.js";
import { TelemetryRetentionWorker } from "../timeseries/retention-worker.js";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
  parseAnalyticsCoverageRequest,
  parseAnalyticsQueryRequest,
} from "../analytics.js";
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
import { configureApiPart03 } from "./part-03.js";

type DeferredContext = {
  spatialLayers: LocalSpatialLayerRuntime | null;
};

type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart04(context: ReturnType<typeof configureApiPart03>) {
  const deferred = context as typeof context & DeferredContext;
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  const electricityPrices = new ElectricityPriceService(
      context.database,
      context.options.electricityPriceFetcher ?? fetch,
      undefined,
      {
        allowPrivateNetwork: config.electricityAllowPrivateEndpoints,
        ...(context.options.electricityEndpointResolver ? { resolver: context.options.electricityEndpointResolver } : {}),
      },
      () => context.telemetryArchive?.reconcileNow(),
    );
  const homeAssistantCredentialTester = context.options.homeAssistantCredentialTester ?? testHomeAssistantCredentials;
  const tpLinkCredentialTester = context.options.tpLinkCredentialTester
      ?? ((host: string, username: string, password: string) => context.tpLink.testCredentials(host, username, password));
  const locationDiscovery = context.options.locationDiscovery ?? new LocationDiscoveryService();
  const weatherProvider = context.options.weatherProvider ?? new AutomaticWeatherProvider(
        new FmiWeatherProvider(),
        new OpenMeteoWeatherProvider(),
      );
  const weatherRecovery = new WeatherRecoveryCoordinator(context.database, weatherProvider, {
      telemetryReader: context.telemetryReader,
      onRecovered: () => context.telemetryArchive?.reconcileNow(),
    });
  const weather = new WeatherService(
      weatherProvider,
      context.status.value.weather,
      () => context.status.changed(),
      undefined,
      undefined,
      undefined,
      weatherRecovery,
      context.database,
    );
  const weatherEvents = context.options.weatherEventBroker ?? new InMemoryWeatherEventBroker();
  const removeWeatherProjector = weatherEvents.addProjector((event) => {
      persistWeatherObservation(context.database, event.weather, context.dataMode);
      void context.telemetryArchive?.reconcileNow().catch(() => undefined);
    });
  const removeWeatherTelemetryBridge = weatherEvents.subscribe((event) => {
      context.bus.publish({ type: "weather", data: event });
    });
  const weatherMonitor = new WeatherMonitor({
      houses: context.database,
      weather,
      // Polling is an input adapter: providers do not need native push support.
      persist: async (result) => {
        context.database.saveWeatherSnapshot(result, outdoorLocationKey(result.location));
        try {
          await weatherEvents.publish(result, "scheduled-refresh");
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown projection failure";
          console.error(`[weather] Snapshot stored, but live projection failed: ${message}`);
        }
      },
      persistFailure: (house, error, attemptedAt) => {
        if (!house.location) return;
        const message = (error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Weather refresh failed").slice(0, 1000);
        const connection = context.status.value.weather.connections
          ?.find((candidate) => candidate.houseId === house.id);
        const statusChanged = context.status.value.weather.error !== message
          || (connection !== undefined && connection.error !== message);
        context.status.value.weather.error = message;
        if (connection) connection.error = message;
        if (statusChanged) context.status.changed();
        context.database.noteWeatherSnapshotFailure(
          house.id,
          outdoorLocationKey(house.location),
          error,
          attemptedAt,
        );
      },
    });
  const app = express();
  // Security middleware classifies route prefixes before Express dispatches.
    // Keep dispatch case-sensitive so mixed-case paths cannot cross auth zones.
    app.set("case sensitive routing", true);
  const initialSpatialLayers: LocalSpatialLayerRuntime | null = null;
  Object.assign(context, { spatialLayers: initialSpatialLayers });
  if (config.spatialLayersEnabled ?? false) {
      try {
        deferred.spatialLayers = createLocalSpatialLayerRuntime({
          coreDatabase: context.database,
          telemetryReader: context.telemetryReader,
          coreDatabasePath: config.databasePath,
          dataMode: context.database.isRealDataMode() ? "real" : "demo",
          startBackground: false,
          admission: {
            acquire: () => context.analyticsWorkLimiter.acquireLowPriority(
              "spatial-inference",
              context.admitLowPriority,
            ),
          },
          ...(config.spatialLayersDatabasePath === undefined ? {} : { statePath: config.spatialLayersDatabasePath }),
          ...(config.spatialLayersIntervalMs === undefined ? {} : { intervalMs: config.spatialLayersIntervalMs }),
          ...(config.spatialLayersRetentionDays === undefined ? {} : { retentionDays: config.spatialLayersRetentionDays }),
        });
      } catch (error) {
        // This optional research subsystem must never prevent the core API from
        // starting. Its routes remain available and report 503 while disabled.
        const message = error instanceof Error ? error.message : "unknown startup failure";
        console.error(`[spatial-layers] Optional engine unavailable: ${message}`);
      }
    }
  const notifySpatial = (operation: (runtime: LocalSpatialLayerRuntime) => void): void => {
      if (!deferred.spatialLayers) return;
      try {
        operation(deferred.spatialLayers);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown notification failure";
        // Core writes are authoritative and may already be committed. An
        // optional derived subsystem must never turn that successful mutation
        // into an HTTP failure; its periodic scheduler can reconcile later.
        console.error(`[spatial-layers] Optional change notification failed: ${message}`);
      }
    };
  context.notifyOpeningStateRecorded = (observation: OpeningStateObservation): void => {
      context.bus.publish({ type: "opening", data: observation });
      void context.telemetryArchive?.reconcileNow().catch(() => undefined);
      notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        observation.houseId,
        null,
        observation.observedAt,
        "property-context-changed",
      ));
    };
  const notifySpatialSensorChange = (before: Sensor | null, after: Sensor | null): void => {
      const houseIds = [...new Set([before?.houseId, after?.houseId].filter((id): id is string => Boolean(id)))];
      if (houseIds.length === 0) return;
      const observedAt = new Date().toISOString();
      notifySpatial((runtime) => {
        for (const houseId of houseIds) {
          runtime.scheduler.wakeHouse(houseId, null, observedAt, "sensor-context-changed");
        }
      });
    };
  // Authentication decisions use the real socket address. Proxy headers must
    // never turn a remote first-owner setup request into a loopback request.
    app.disable("trust proxy");
  context.dataMode.onActivated(() => {
      context.mock.stop();
      context.replay.reset();
      context.derivedAnalytics.handleDataModeActivated();
      notifySpatial((runtime) => runtime.handleDataModeActivated("real"));
      context.telemetryArchive?.enforceRealDataBoundary();
      context.status.refreshDataMode();
    });
  const invalidateSnapshotCaches = (): void => {
      context.measurementSnapshotCache.clear();
      context.readingSnapshotCache.clear();
    };
  const cachedLatestMeasurements = (houseId?: string): MeasurementSample[] => {
      const key = houseId ? `house:${houseId}` : "all";
      const cached = context.measurementSnapshotCache.get(key);
      if (cached) return cached;
      const loaded = context.database.latestMeasurementSamples(houseId);
      context.measurementSnapshotCache.set(key, loaded);
      return loaded;
    };
  const cachedLatestReadings = (): Reading[] => {
      const cached = context.readingSnapshotCache.get("all");
      if (cached) return cached;
      const loaded = context.database.latestReadings();
      context.readingSnapshotCache.set("all", loaded);
      return loaded;
    };
  const requireArchivedBeforeCascade = async (scope: TelemetryCascadeScope, resourceId: string): Promise<void> => {
      if (!context.telemetryArchive) {
        if (context.database.hasRealTelemetryForCascade(scope, resourceId)) {
          throw new HttpError(
            409,
            "TELEMETRY_ARCHIVE_REQUIRED",
            "This change would erase the only copy of retained telemetry; enable and reconcile the archive first",
          );
        }
        return;
      }
      try {
        await context.telemetryArchive.reconcileNow();
      } catch {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_NOT_READY",
          "Telemetry must be durably archived before deleting a telemetry-owning resource",
        );
      }
      if (!context.telemetryArchive.status().caughtUp) {
        throw new HttpError(
          503,
          "TELEMETRY_ARCHIVE_NOT_READY",
          "Telemetry must be durably archived before deleting a telemetry-owning resource",
        );
      }
    };
  const requireImmutableTelemetryLineage = (
      scope: Exclude<TelemetryCascadeScope, "house-location">,
      resourceId: string,
    ): void => {
      if (!context.database.hasRealTelemetryForCascade(scope, resourceId)) return;
      throw new HttpError(
        409,
        "TELEMETRY_LINEAGE_REQUIRED",
        "Resources with real telemetry cannot be moved or deleted until immutable historical ownership context is available; disable the resource instead",
      );
    };
  const removeSnapshotMeasurementWake = context.bus.subscribeMeasurements(invalidateSnapshotCaches);
  const extended = Object.assign(context, { electricityPrices, homeAssistantCredentialTester, tpLinkCredentialTester, locationDiscovery, weatherProvider, weatherRecovery, weather, weatherEvents, removeWeatherProjector, removeWeatherTelemetryBridge, weatherMonitor, app, notifySpatial, notifySpatialSensorChange, invalidateSnapshotCaches, cachedLatestMeasurements, cachedLatestReadings, requireArchivedBeforeCascade, requireImmutableTelemetryLineage, removeSnapshotMeasurementWake });
  return extended as typeof extended & { spatialLayers: LocalSpatialLayerRuntime | null };
}
