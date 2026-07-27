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
import { configureApiPart01 } from "./part-01.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart02(context: ReturnType<typeof configureApiPart01>) {
  const config = context.config as NormalizedApiConfig;
  config.timeseriesPassword ??= "";
  config.timeseriesSslMode ??= "disable";
  config.timeseriesSslCa ??= null;
  config.timeseriesPoolMax ??= 6;
  config.timeseriesConnectTimeoutMs ??= 5_000;
  config.timeseriesStatementTimeoutMs ??= 15_000;
  config.timeseriesBatchSize ??= 1_000;
  if (config.timeseriesRequired && !config.timeseriesEnabled) {
      throw new Error("timeseriesRequired=true requires timeseriesEnabled=true");
    }
  const database = context.options.database ?? new ClimateDatabase(config.databasePath);
  const trackingFlags: TrackingFeatureFlags = {
      "tracking.enabled": config.trackingEnabled,
      "tracking.mobileObserver.enabled": config.trackingMobileObserverEnabled,
      "tracking.mobileObserver.iosBackground.enabled": config.trackingIosBackgroundEnabled,
      "tracking.mobileObserver.androidBackground.enabled": config.trackingAndroidBackgroundEnabled,
      "tracking.androidGatewayMode.enabled": config.trackingAndroidGatewayModeEnabled,
      "tracking.liveMap.enabled": config.trackingLiveMapEnabled,
      "tracking.movementTrails.enabled": config.trackingMovementTrailsEnabled,
      "tracking.exitAlerts.enabled": config.trackingExitAlertsEnabled,
      "tracking.userLocationSharing.enabled": config.trackingUserLocationSharingEnabled,
    };
  if (config.trackingUserLocationSharingEnabled
      && (!config.trackingEnabled || !config.trackingLiveMapEnabled)) {
      throw new Error("TRACKING_USER_LOCATION_SHARING_REQUIRES_LIVE_MAP");
    }
  const trackingStore = new TrackingStore(
      database,
      new TrackingSecretBox(loadOrCreateTrackingKey(
        config.trackingEnabled ? config.trackingSecretKeyFile : null,
      )),
    );
  const tracking = new TrackingService(
      trackingStore,
      {
        flags: trackingFlags,
      },
    );
  const systemUpdates = new SystemUpdateService({
      currentVersion: SYSTEM_VERSION,
      repository: config.systemUpdateRepository,
      imagePrefix: config.systemUpdateImagePrefix,
      operationsDirectory: config.systemUpdateOperationsDirectory,
    });
  const cloudflareSetup = context.options.cloudflareSetup ?? new CloudflareSetupService({
      operationsDirectory: config.systemUpdateOperationsDirectory,
      deploymentFile: config.cloudflareSetupDeploymentFile,
      runtimeToken: config.cloudflareAccessApiToken,
      ownerEmail: config.cloudflareAccessStaticEmails[0] ?? null,
      oauthClientId: config.cloudflareSetupOAuthClientId,
      ...(context.options.cloudflareSetupFetcher ? { fetchImpl: context.options.cloudflareSetupFetcher } : {}),
    });
  const dataOperations = new DataOperationsService(database, config);
  const energyOptimizer = new EnergyOptimizer(database);
  const integrationMetadata = initializeIntegrationMetadata(config, database);
  const localAuth = new LocalAuthStore(database);
  const recordSecurityAudit = (
      actor: Pick<LocalAuthIdentity, "userId" | "role"> | null,
      event: Omit<SecurityAuditEventInput, "actorUserId" | "actorRole">,
    ): void => {
      database.recordSecurityAuditEvent({
        ...event,
        actorUserId: actor?.userId ?? null,
        actorRole: actor?.role ?? null,
      });
    };
  const cloudflareAccess = config.cloudflareAccessAccountId
      && config.cloudflareAccessGroupId
      && config.cloudflareAccessGroupName
      && config.cloudflareAccessApiToken
      && config.cloudflareAccessStaticEmails.length > 0
      ? new CloudflareAccessGroupSynchronizer({
        accountId: config.cloudflareAccessAccountId,
        groupId: config.cloudflareAccessGroupId,
        groupName: config.cloudflareAccessGroupName,
        apiToken: config.cloudflareAccessApiToken,
        syncIntervalMs: config.cloudflareAccessSyncIntervalMs,
      }, () => {
        if (!localAuth.isInitialized()) return null;
        const directory = localAuth.listWorkspaceMembers();
        // The Cloudflare identity used by the installation owner may differ from
        // their local Stugu login. Keep configured operators permanently allowed,
        // and reconcile every invited/non-owner local account around them.
        return [
          ...(config.cloudflareAccessStaticEmails ?? []),
          ...directory.members.filter((entry) => entry.role !== "owner").map((entry) => entry.email),
          ...directory.invitations.map((entry) => entry.email),
        ];
      }, context.options.cloudflareAccessFetcher, () => {
        // This intentionally omits account, group, email, and provider details.
        console.error("[cloudflare-access] Member allowlist synchronization is pending");
      })
      : null;
  const authAbuseLimiter = new AuthAbuseLimiter();
  const trackingObserverAbuseLimiter = new AuthAbuseLimiter();
  const dataMode = new DataModeCoordinator(database);
  if ((config.homeAssistantConnections?.length ?? 0) > 0
      || (!config.homeAssistantLegacyDisabled && config.haUrl && config.haToken)
      || (config.tpLinkConnections?.length ?? 0) > 0
      || (!config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword)) {
      dataMode.activate();
    }
  const bus = new TelemetryBus();
  const stuguby = (() => {
      const keys = loadOrCreateStugubyNodeKeys(config.stugubyIdentityFile ?? null, config.stugubyNodeName);
      const store = new StugubyStore(database.db, keys.identity.nodeId);
      return new StugubyService({
        database,
        store,
        keys,
        bus,
        assetDirectory: config.assetDirectory,
        syncIntervalMs: config.stugubySyncIntervalMs,
        publicOrigin: config.stugubyPublicOrigin,
        suggestedPublicOrigin: config.stugubySuggestedPublicOrigin ?? null,
        allowUiPublicOrigin: !config.stugubyCoordinatorProvisioningRequired,
        ...(context.options.stugubyFetcher ? { fetcher: context.options.stugubyFetcher } : {}),
      });
    })();
  const assertSensorHouseMoveAllowed = (sourceHouseId: string, targetHouseId: string): void => {
      const managed = [sourceHouseId, targetHouseId].some((houseId) => {
        const link = database.getHouse(houseId)?.stuguby;
        return link?.ownership === "shared" && link.syncState !== "detached";
      });
      if (managed) {
        throw new HttpError(
          409,
          "STUGBY_SENSOR_HOME_MANAGED",
          "A sensor in a shared Home remains with that Home until permanent disconnect",
        );
      }
    };
  const timeseriesSsl = config.timeseriesSslMode === "disable"
      ? undefined
      : config.timeseriesSslMode === "require"
        ? { rejectUnauthorized: false }
        : config.timeseriesSslMode === "verify-ca"
          ? {
            rejectUnauthorized: true,
            ...(config.timeseriesSslCa ? { ca: config.timeseriesSslCa } : {}),
            checkServerIdentity: () => undefined,
          }
          : {
            rejectUnauthorized: true,
            ...(config.timeseriesSslCa ? { ca: config.timeseriesSslCa } : {}),
            ...(isIP(config.timeseriesHost) === 0 ? { servername: config.timeseriesHost } : {}),
          };
  const extended = Object.assign(context, { database, trackingFlags, trackingStore, tracking, systemUpdates, cloudflareSetup, dataOperations, energyOptimizer, integrationMetadata, localAuth, recordSecurityAudit, cloudflareAccess, authAbuseLimiter, trackingObserverAbuseLimiter, dataMode, bus, stuguby, assertSensorHouseMoveAllowed, timeseriesSsl });
  return extended;
}
