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
import { configureApiPart04 } from "./part-04.js";

type DeferredContext = {
  activeEventStreamCount: number;
  shutdownStarted: boolean;
};

type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart05(context: ReturnType<typeof configureApiPart04>) {
  const deferred = context as typeof context & DeferredContext;
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  const removeSnapshotMutationWake = context.bus.subscribe((event) => {
      if (event.type === "mutation") context.invalidateSnapshotCaches();
    });
  const removeSpatialLayerWake = context.bus.subscribeMeasurements((sample) => {
      context.notifySpatial((runtime) => runtime.wakeMeasurement(sample));
    });
  const removeNotificationWake = context.bus.subscribe((event) => {
      if (event.type === "alert" && event.data.resolvedAt === null) context.notificationOutbox.wake();
    });
  context.notificationOutbox.start();
  // Keep the production build independent of the contracts package's TypeScript source export.
    const prefix = "/api/v1" as const;
  const v2Prefix = "/api/v2" as const;
  const activeEventStreams = new Set<(notifyClient?: boolean) => void>();
  const activeEventStreamsByUser = new Map<string, number>();
  const initialActiveEventStreamCount: number = 0;
  Object.assign(context, { activeEventStreamCount: initialActiveEventStreamCount });
  const initialShutdownStarted: boolean = false;
  Object.assign(context, { shutdownStarted: initialShutdownStarted });
  const initialClosed: boolean = false;
  Object.assign(context, { closed: initialClosed });
  const initialShutdownPromise: Promise<void> | null = null;
  Object.assign(context, { shutdownPromise: initialShutdownPromise });
  const initialClosePromise: Promise<void> | null = null;
  Object.assign(context, { closePromise: initialClosePromise });
  const initialTelegramConfigurationGeneration: number = 0;
  Object.assign(context, { telegramConfigurationGeneration: initialTelegramConfigurationGeneration });
  const homeAssistantConfigurationGenerations = new Map<string, number>();
  const tpLinkConfigurationGenerations = new Map<string, number>();
  const synchronizeCloudflareAccess = async (): Promise<{
      status: "disabled" | "pending" | "synced";
      lastSyncedAt: string | null;
    }> => {
      if (!context.cloudflareAccess) return { status: "disabled", lastSyncedAt: null };
      try {
        const result = await context.cloudflareAccess.synchronize();
        return { status: result.status, lastSyncedAt: result.lastSyncedAt };
      } catch {
        console.error("[cloudflare-access] Member allowlist synchronization is pending");
        return { status: "pending", lastSyncedAt: context.cloudflareAccess.status().lastSyncedAt };
      }
    };
  const integrationStatusForHouse = (houseId?: string): IntegrationStatus => {
      const value = structuredClone(context.status.value);
      if (!houseId) return value;
      const homeAssistantConnections = (value.homeAssistant.connections ?? [])
        .filter((connection) => connection.houseId === houseId);
      value.homeAssistant.connections = homeAssistantConnections;
      value.homeAssistant.configured = homeAssistantConnections.some((connection) => connection.configured);
      value.homeAssistant.connected = homeAssistantConnections.some((connection) => connection.connected);
      value.homeAssistant.lastEventAt = homeAssistantConnections.map((connection) => connection.lastEventAt)
        .filter((timestamp): timestamp is string => Boolean(timestamp)).sort().at(-1) ?? null;
      value.homeAssistant.mappedEntities = homeAssistantConnections
        .reduce((total, connection) => total + connection.mappedEntities, 0);
      value.homeAssistant.error = homeAssistantConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      const tpLinkConnections = (value.tpLink.connections ?? []).filter((connection) => connection.houseId === houseId);
      value.tpLink.connections = tpLinkConnections;
      value.tpLink.configured = tpLinkConnections.some((connection) => connection.configured);
      value.tpLink.connected = tpLinkConnections.some((connection) => connection.connected);
      value.tpLink.lastPollAt = tpLinkConnections.map((connection) => connection.lastPollAt)
        .filter((timestamp): timestamp is string => Boolean(timestamp)).sort().at(-1) ?? null;
      value.tpLink.mappedDevices = tpLinkConnections.reduce((total, connection) => total + connection.mappedDevices, 0);
      value.tpLink.discoveredDevices = tpLinkConnections.reduce((total, connection) => total + connection.discoveredDevices, 0);
      value.tpLink.hubModel = tpLinkConnections.length === 1 ? tpLinkConnections[0]!.hubModel : null;
      value.tpLink.error = tpLinkConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      const weatherConnections = (value.weather.connections ?? []).filter((connection) => connection.houseId === houseId);
      value.weather.connections = weatherConnections;
      value.weather.configuredHouses = weatherConnections.filter((connection) => connection.configured).length;
      value.weather.provider = weatherConnections[0]?.provider ?? value.weather.provider;
      value.weather.lastSuccessAt = weatherConnections[0]?.lastSuccessAt ?? null;
      value.weather.error = weatherConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
      return value;
    };
  const assertTpLinkConnectionScope = (sensor: {
      houseId: string;
      tpLinkDeviceId?: string | null;
      tpLinkConnectionId?: string | null;
    }): void => {
      if (!sensor.tpLinkConnectionId) return;
      if (!sensor.tpLinkDeviceId) throw new HttpError(400, "INVALID_TP_LINK_BINDING", "tpLinkConnectionId requires tpLinkDeviceId");
      const connection = (config.tpLinkConnections ?? []).find((candidate) => candidate.id === sensor.tpLinkConnectionId);
      if (!connection) throw new HttpError(422, "TP_LINK_CONNECTION_NOT_FOUND", "The selected TP-Link connection no longer exists");
      if (connection.houseId !== sensor.houseId) {
        throw new HttpError(409, "TP_LINK_HOUSE_SCOPE", "The selected TP-Link connection belongs to another house");
      }
    };
  const acquireEventStream = (response: Response): (() => void) | null => {
      if (deferred.shutdownStarted || deferred.activeEventStreamCount >= MAX_EVENT_STREAMS_GLOBAL) return null;
      const userId = requestPrincipal(response).userId;
      const userCount = activeEventStreamsByUser.get(userId) ?? 0;
      if (userCount >= MAX_EVENT_STREAMS_PER_USER) return null;
      deferred.activeEventStreamCount += 1;
      activeEventStreamsByUser.set(userId, userCount + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        deferred.activeEventStreamCount = Math.max(0, deferred.activeEventStreamCount - 1);
        const remaining = Math.max(0, (activeEventStreamsByUser.get(userId) ?? 1) - 1);
        if (remaining === 0) activeEventStreamsByUser.delete(userId);
        else activeEventStreamsByUser.set(userId, remaining);
      };
    };
  const rejectEventStreamDuringShutdown = (response: Response): boolean => {
      if (!deferred.shutdownStarted) return false;
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "close");
      response.flushHeaders();
      response.end(": server shutting down\n\n");
      return true;
    };
  const registerEventStream = (
      request: Request,
      response: Response,
      dispose: () => void,
      releaseLease: () => void,
    ): void => {
      let active = true;
      const closeStream = (notifyClient = false): void => {
        if (!active) return;
        active = false;
        dispose();
        releaseLease();
        activeEventStreams.delete(closeStream);
        if (notifyClient && !response.destroyed && !response.writableEnded) {
          response.write(": server shutting down\n\n");
          response.end();
        }
      };
      activeEventStreams.add(closeStream);
      request.once("aborted", () => closeStream());
      response.once("close", () => closeStream());
      // A request accepted just before server.close() can reach this handler
      // after shutdown has begun; do not let that late SSE stream block drain.
      if (deferred.shutdownStarted) closeStream(true);
    };
  context.app.disable("x-powered-by");
  context.app.use((request, response, next) => {
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("x-api-version", request.path.startsWith(v2Prefix) ? "v2" : "v1");
      if (request.path.startsWith(prefix) || request.path.startsWith(v2Prefix)) {
        // Account and Guest scope are carried by an HttpOnly cookie. Never let a
        // browser or shared intermediary reuse one account's API representation
        // after logout, account switching, or an access-grant change.
        response.setHeader("cache-control", "private, no-store");
        response.setHeader("pragma", "no-cache");
      }
      const origin = request.header("origin");
      const originAllowed = origin ? browserOriginAllowed(request, origin, config) : false;
      const unsafe = !SAFE_HTTP_METHODS.has(request.method) && request.method !== "OPTIONS";
      const crossSite = request.header("sec-fetch-site")?.toLowerCase() === "cross-site";
      if (((unsafe || request.method === "OPTIONS") && origin !== undefined && !originAllowed)
        || (unsafe && crossSite && !originAllowed)) {
        next(new HttpError(403, "CROSS_SITE_REQUEST_REJECTED", "Cross-site browser requests are not allowed"));
        return;
      }
      if (config.corsOrigin && originAllowed && normalizedOrigin(origin) === normalizedOrigin(config.corsOrigin)) {
        response.setHeader("access-control-allow-origin", normalizedOrigin(config.corsOrigin)!);
        response.setHeader("access-control-allow-credentials", "true");
        response.setHeader("vary", "Origin");
        response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        response.setHeader("access-control-allow-headers", "Content-Type,Authorization,X-API-Key,X-CSRF-Token,X-Stugu-Bootstrap-Secret,Last-Event-ID");
      }
      if (request.method === "OPTIONS") { response.status(204).end(); return; }
      next();
    });
  const extended = Object.assign(context, { removeSnapshotMutationWake, removeSpatialLayerWake, removeNotificationWake, prefix, v2Prefix, activeEventStreams, activeEventStreamsByUser, homeAssistantConfigurationGenerations, tpLinkConfigurationGenerations, synchronizeCloudflareAccess, integrationStatusForHouse, assertTpLinkConnectionScope, acquireEventStream, rejectEventStreamDuringShutdown, registerEventStream });
  return extended as typeof extended & { activeEventStreamCount: number; shutdownStarted: boolean; closed: boolean; shutdownPromise: Promise<void> | null; closePromise: Promise<void> | null; telegramConfigurationGeneration: number };
}
