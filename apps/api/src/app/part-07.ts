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
import { configureApiPart06 } from "./part-06.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart07(context: ReturnType<typeof configureApiPart06>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.use((request, response, next) => {
      // Authentication endpoints were parsed above because their credentials are
      // themselves needed for authentication and abuse limiting. Everything else
      // is authorized before the server allocates a potentially large JSON body.
      if (request.path.startsWith(`${context.prefix}/auth/`)) { next(); return; }
      if (request.path === `${context.prefix}/cloudflare/setup/start`) {
        response.locals.accountBodyLimit = "16 KiB";
        context.cloudflareSetupJsonParser(request, response, next);
        return;
      }
      if (request.path.startsWith(`${context.prefix}/tenant/members`)
        || request.path.startsWith(`${context.prefix}/internal/tapo-history/`)) {
        response.locals.accountBodyLimit = "32 KiB";
        context.memberJsonParser(request, response, next);
        return;
      }
      if (request.method === "POST" && (
        request.path === `${context.prefix}/tracking/evidence:batch`
        || isTrackingObserverHeartbeatPath(request.path, context.prefix)
      )) {
        response.locals.accountBodyLimit = "256 KiB";
        context.trackingObserverJsonParser(request, response, next);
        return;
      }
      response.locals.accountBodyLimit = "15 MiB";
      context.apiJsonParser(request, response, next);
    });
  // Readings and source health already travel through the authenticated live
    // stream. Announce every other successful mutation there as well, allowing
    // all open browsers to refresh properties, tasks, notes, access grants, and
    // configuration without a manual reload.
    context.app.use((request, response, next) => {
      const sideEffectFreePost = request.method === "POST" && [
        `${context.v2Prefix}/analytics/query`, `${context.v2Prefix}/analytics/coverage`,
      ].includes(request.path);
      const unsafe = !SAFE_HTTP_METHODS.has(request.method) && request.method !== "OPTIONS" && !sideEffectFreePost;
      const excluded = request.path.startsWith(`${context.prefix}/auth/`)
        || request.path === `${context.prefix}/readings`
        || request.path === `${context.v2Prefix}/measurements`
        || request.path === `${context.v2Prefix}/measurements/import`
        || request.path === `${context.prefix}/tracking/evidence:batch`
        || isTrackingObserverHeartbeatPath(request.path, context.prefix)
        || request.path.startsWith(`${context.prefix}/mock/`)
        || request.path === `${context.prefix}/replay`;
      if (!unsafe || excluded) { next(); return; }
      response.once("finish", () => {
        if (response.statusCode < 200 || response.statusCode >= 400) return;
        const resource = request.path.startsWith(context.v2Prefix)
          ? request.path.slice(context.v2Prefix.length) || "/"
          : request.path.startsWith(context.prefix)
            ? request.path.slice(context.prefix.length) || "/"
            : request.path;
        context.bus.publish({ type: "mutation", data: { method: request.method, resource, occurredAt: new Date().toISOString() } });
      });
      next();
    });
  registerStugubyLocalRoutes(context.app, context.stuguby, { requireAdmin: requireWorkspaceAdmin });
  const requireIngestKey = (request: Request, _response: Response, next: NextFunction): void => {
      if (!config.ingestApiKey) { next(); return; }
      const authorization = request.header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
      const provided = request.header("x-api-key") ?? bearer;
      if (!provided || !keyMatches(provided, config.ingestApiKey)) {
        next(new HttpError(401, "UNAUTHORIZED", "A valid ingestion API key is required"));
        return;
      }
      next();
    };
  const visibility = (response: Response): LocalVisibility => new LocalVisibility(context.database, requestPrincipal(response));
  const currentStreamIdentity = (request: Request, response: Response): LocalRequestPrincipal | null => {
      const accepted = requestPrincipal(response);
      if (accepted.bootstrap) return accepted;
      const current = context.localAuth.sessionForToken(cookieValue(request, LOCAL_SESSION_COOKIE));
      return current ? { ...current, bootstrap: false } : null;
    };
  const currentStreamVisibility = (request: Request, response: Response): LocalVisibility | null => {
      const current = currentStreamIdentity(request, response);
      return current ? new LocalVisibility(context.database, current) : null;
    };
  const streamAuthorizationFingerprint = (request: Request, response: Response): string | null => {
      const current = currentStreamIdentity(request, response);
      return current ? localAuthorizationFingerprint(current) : null;
    };
  const authorizedStreamVisibility = (
      request: Request,
      response: Response,
      acceptedFingerprint: string,
    ): LocalVisibility | null => {
      const current = currentStreamIdentity(request, response);
      const currentFingerprint = current ? localAuthorizationFingerprint(current) : null;
      if (current && currentFingerprint === acceptedFingerprint) return new LocalVisibility(context.database, current);
      if (!response.destroyed && !response.writableEnded) {
        const status = current ? "changed" : "expired";
        response.end(`event: authorization\ndata: ${JSON.stringify({ status })}\n\n`);
      }
      return null;
    };
  context.app.get(`${context.prefix}/health`, async (_request, response) => {
      const eventLoopProbeStartedAt = performance.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const eventLoopLagMs = Number((performance.now() - eventLoopProbeStartedAt).toFixed(3));
      const archive = context.telemetryArchive?.status();
      const requiredArchiveUnavailable = config.timeseriesRequired === true && (
        !archive || archive.phase === "degraded" || archive.phase === "stopped" || !archive.timescaleAvailable
      );
      const measurementCache = context.measurementSnapshotCache.stats();
      const readingCache = context.readingSnapshotCache.stats();
      response.status(requiredArchiveUnavailable ? 503 : 200).json({
        status: requiredArchiveUnavailable ? "degraded" : "ok",
        systemVersion: SYSTEM_VERSION,
        apiVersion: "v1",
        database: "ready",
        telemetryArchive: archive ? {
          enabled: true,
          required: config.timeseriesRequired,
          phase: archive.phase,
          caughtUp: archive.caughtUp,
          timescaleAvailable: archive.timescaleAvailable,
          timescaleVersion: archive.timescaleVersion,
          hypertables: archive.hypertables,
          aggregateMode: archive.aggregateMode,
          coldStorageMode: archive.coldStorageMode,
          schemaWarningCount: archive.schemaWarningCount,
          lastSuccessAt: archive.lastSuccessAt,
          lastFailureAt: archive.lastFailureAt,
        } : { enabled: false, required: false, phase: "disabled", caughtUp: false },
        cache: {
          entries: measurementCache.entries + readingCache.entries,
          estimatedBytes: measurementCache.estimatedBytes + readingCache.estimatedBytes,
          hits: measurementCache.hits + readingCache.hits,
          misses: measurementCache.misses + readingCache.misses,
        },
        analytics: context.analyticsWorkLimiter.snapshot(),
        timeseriesPool: context.timeseries ? {
          total: context.timeseries.pool.totalCount,
          idle: context.timeseries.pool.idleCount,
          waiting: context.timeseries.pool.waitingCount,
        } : null,
        timeseriesQueries: context.timeseries?.diagnostics() ?? null,
        eventLoopLagMs,
        uptimeSeconds: Math.round(process.uptime()),
      });
    });
  context.app.get(`${context.prefix}/openapi.json`, (_request, response) => response.json(openApiV1Document));
  context.app.get(`${context.v2Prefix}/openapi.json`, (_request, response) => response.json(openApiV2Document));
  context.app.get(`${context.prefix}/session`, (request, response) => {
      if (!context.localAuth.isInitialized()) {
        const session: AppSession = {
          authenticated: false,
          principal: { type: "setup-required", email: null },
          tenant: { id: "local", name: "Local Stugu", role: "owner" },
          availableTenants: [{ id: "local", name: "Local Stugu", role: "owner" }],
          readOnly: true,
          grants: [],
          setupRequired: true,
        };
        response.json(session);
        return;
      }
      const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
      if (!principal || principal.bootstrap || !principal.csrfToken) {
        throw new HttpError(401, "UNAUTHORIZED", "Sign in to access this workspace");
      }
      response.cookie(LOCAL_CSRF_COOKIE, principal.csrfToken, {
        httpOnly: false,
        sameSite: "strict",
        secure: secureRequest(request, config),
        path: "/api",
        maxAge: LOCAL_SESSION_MAX_AGE_MS,
      });
      response.json(sessionDocument(principal, principal.csrfToken));
    });
  const extended = Object.assign(context, { requireIngestKey, visibility, currentStreamIdentity, currentStreamVisibility, streamAuthorizationFingerprint, authorizedStreamVisibility });
  return extended;
}
