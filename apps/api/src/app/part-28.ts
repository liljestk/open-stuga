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
import { configureApiPart27 } from "./part-27.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart28(context: ReturnType<typeof configureApiPart27>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  if (context.options.startBackground) {
      context.tracking.start();
      context.systemUpdates.start();
      context.hostSystem.start();
      context.stuguby?.start();
      context.cloudflareAccess?.start();
      context.alertEngine.start();
      context.mock.start();
      context.homeAssistant.start();
      context.tpLink.start();
      context.gree.start();
      context.tuya.start();
      context.nexus433.start();
      context.tapoHistory.start();
      if (config.sensorGapRecoveryEnabled) sensorGapRecovery.start();
      context.electricityPrices.start();
      context.weatherMonitor.start();
      if (config.dailyAnalyticsFindingsEnabled) context.dailyAnalyticsFindings.start();
      context.derivedAnalytics.start();
      context.scheduledDataExports.start();
      context.notifySpatial((runtime) => runtime.start());
    }
  const beginShutdown = (): Promise<void> => {
      if (context.shutdownPromise) return context.shutdownPromise;
      context.shutdownStarted = true;
      context.tracking.stop();
      context.alertEngine.stop();
      context.systemUpdates.stop();
      context.hostSystem.stop();
      context.mock.stop();
      context.replay.stop();
      const stoppingStuguby = context.stuguby?.stop() ?? Promise.resolve();
      const stoppingSensorGapRecovery = sensorGapRecovery.stop();
      const stoppingTapoHistory = context.tapoHistory.stop();
      context.homeAssistant.stop();
      context.tpLink.stop();
      context.gree.stop();
      context.tuya.stop();
      const stoppingNexus433 = context.nexus433.stop();
      context.integrationDiscoveryJobs.stop();
      context.electricityPrices.stop();
      context.weatherMonitor.stop();
      const stoppingDailyAnalyticsFindings = context.dailyAnalyticsFindings.stop();
      const stoppingDerivedAnalytics = context.derivedAnalytics.stop();
      context.scheduledDataExports.stop();
      for (const closeStream of [...context.activeEventStreams]) closeStream(true);
      context.shutdownPromise = Promise.all([
        context.notificationOutbox.stop(),
        stoppingStuguby,
        context.cloudflareAccess?.stop() ?? Promise.resolve(),
        context.cloudflareSetup.stop(),
        stoppingSensorGapRecovery,
        stoppingTapoHistory,
        stoppingNexus433,
        context.weatherRecovery.stop(),
        stoppingDailyAnalyticsFindings,
        stoppingDerivedAnalytics,
        context.spatialLayers?.stop() ?? Promise.resolve(),
        Promise.all([
          context.telemetryRetention?.stop() ?? Promise.resolve(),
          context.telemetryOrderedRollups?.stop() ?? Promise.resolve(),
        ]).then(() => context.telemetryArchive?.stop()),
      ]).then(() => undefined);
      return context.shutdownPromise;
    };
  const close = (): Promise<void> => {
      if (context.closePromise) return context.closePromise;
      if (context.closed) return Promise.resolve();
      context.closed = true;
      context.removeSnapshotMutationWake();
      context.removeSnapshotMeasurementWake();
      context.removeNotificationWake();
      context.removeSpatialLayerWake();
      context.removeAnalyticsCacheWake?.();
      context.removeWeatherTelemetryBridge();
      context.removeWeatherProjector();
      context.closePromise = beginShutdown().then(() => { context.database.close(); });
      return context.closePromise;
    };
  const extended = Object.assign(context, { beginShutdown, close });
  return extended;
}
