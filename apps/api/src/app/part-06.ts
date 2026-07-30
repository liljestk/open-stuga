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
import { configureApiPart05 } from "./part-05.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart06(context: ReturnType<typeof configureApiPart05>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(cloudflareSetupCallbackPath, async (request, response, next) => {
      try {
        if (!localCloudflareUiRequestAllowed(request, config)) {
          throw new HttpError(403, "CLOUDFLARE_SETUP_LOCAL_ONLY", "Cloudflare approval must return to this Stugu's local address");
        }
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(request.query)) {
          if (typeof value === "string") query.set(key, value);
        }
        const operation = await context.cloudflareSetup.completeOAuth(query);
        const successful = operation.phase !== "failed";
        response.status(successful ? 200 : 400);
        response.type("html");
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        response.setHeader("x-frame-options", "DENY");
        response.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        );
        response.send(`<!doctype html>
  <html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>${successful ? "Cloudflare approved" : "Cloudflare approval not completed"}</title>
  <body style="font:16px system-ui,sans-serif;max-width:38rem;margin:10vh auto;padding:1.5rem;color:#1b1d1a;background:#f1efe9">
  <h1>${successful ? "Cloudflare approved" : "Approval not completed"}</h1>
  <p>${successful
      ? "Stugu is finishing the secure connection. You can close this window and return to Stugu."
      : "Return to Stugu to review the problem and try again."}</p>
  </body></html>`);
      } catch (error) {
        next(error instanceof CloudflareSetupError
          ? new HttpError(error.status, error.code, error.message)
          : error);
      }
    });
  context.app.get(`${context.prefix}/internal/cloudflare-setup/claims/:id`, (request, response) => {
      const authorization = request.header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
      const claim = context.cloudflareSetup.claim(request.params.id, bearer);
      response.setHeader("cache-control", "no-store");
      if (!claim) {
        response.status(404).json({ error: { code: "CLOUDFLARE_SETUP_CLAIM_NOT_FOUND", message: "Setup claim was not found" } });
        return;
      }
      response.json(claim);
    });
  registerStugubyProtocolRoutes(context.app, context.stuguby);
  const authJsonParser = express.json({ limit: "8kb" });
  context.app.use((request, response, next) => {
      if (request.path.startsWith(`${context.prefix}/auth/`)) {
        response.locals.accountBodyLimit = "8 KiB";
        authJsonParser(request, response, next);
        return;
      }
      next();
    });
  context.app.use((request, response, next) => {
      const initialized = context.localAuth.isInitialized();
      const rawToken = cookieValue(request, LOCAL_SESSION_COOKIE);
      const session = initialized ? context.localAuth.sessionForToken(rawToken) : null;
      if (session) {
        response.locals.localPrincipal = { ...session, bootstrap: false } satisfies LocalRequestPrincipal;
      } else if (!initialized && config.localAuthTestBypass === true) {
        response.locals.localPrincipal = {
          userId: "bootstrap",
          email: "",
          role: "owner",
          joinedAt: "",
          grants: [],
          bootstrap: true,
        } satisfies LocalRequestPrincipal;
      }

      const tapoWorkerPath = request.path.startsWith(`${context.prefix}/internal/tapo-history/`);
      if (tapoWorkerPath) {
        response.setHeader("cache-control", "no-store");
        if (!config.tapoHistoryEnabled || !config.tapoHistoryWorkerToken) {
          next(new HttpError(404, "TAPO_HISTORY_WORKER_DISABLED", "Tapo history worker endpoint is disabled"));
          return;
        }
        const authorization = request.header("authorization");
        const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
        if (!bearer || !keyMatches(bearer, config.tapoHistoryWorkerToken)) {
          next(new HttpError(401, "UNAUTHORIZED", "A valid Tapo history worker token is required"));
          return;
        }
        next();
        return;
      }

      const trackingObserverPath = (
        request.method === "POST"
        && (
          request.path === `${context.prefix}/tracking/evidence:batch`
          || isTrackingObserverHeartbeatPath(request.path, context.prefix)
        )
      ) || (
        request.method === "GET"
        && new RegExp(
          `^${context.prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`
          + "/tracking/observers/[^/]+/resolution-manifest$",
          "u",
        ).test(request.path)
      );
      const trackingAuthorization = request.header("authorization");
      const trackingBearer = trackingAuthorization?.startsWith("Bearer ")
        ? trackingAuthorization.slice(7)
        : null;
      if (trackingObserverPath && trackingBearer?.startsWith("stugu_observer.")) {
        if (!context.tracking.enabled) {
          next(new TrackingError(404, "TRACKING_DISABLED", "Equipment tracking is not enabled"));
          return;
        }
        const release = context.trackingObserverAbuseLimiter.enter(
          trackingObserverAttemptKeys(request, config, trackingBearer),
          response,
        );
        let authenticated = false;
        try {
          const observer = context.tracking.authenticateObserverCredential(trackingBearer);
          if (!observer) {
            next(new TrackingError(401, "UNAUTHORIZED", "A valid observer credential is required"));
            return;
          }
          authenticated = true;
          response.locals.trackingObserver = observer;
          next();
        } finally {
          release(authenticated);
        }
        return;
      }

      const preSetupPath = request.path === `${context.prefix}/health`
        || request.path === `${context.prefix}/openapi.json`
        || request.path === `${context.v2Prefix}/openapi.json`
        || request.path === `${context.prefix}/session`
        || request.path === `${context.prefix}/auth/setup`;
      if (!initialized && config.localAuthTestBypass !== true) {
        if (preSetupPath) { next(); return; }
        next(new HttpError(401, "SETUP_REQUIRED", "Create the first local Owner before using the API"));
        return;
      }

      const publicPath = preSetupPath
        || request.path === `${context.prefix}/auth/login`
        || request.path === `${context.prefix}/auth/register`;
      if (publicPath) { next(); return; }

      const authorization = request.header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
      const providedIngestKey = request.header("x-api-key") ?? bearer;
      const ingestServicePath = request.method === "POST" && (
        request.path === `${context.prefix}/readings`
        || request.path === `${context.v2Prefix}/measurements`
        || request.path === `${context.v2Prefix}/measurements/import`
      );
      const validIngestService = ingestServicePath && Boolean(
        config.ingestApiKey && providedIngestKey && keyMatches(providedIngestKey, config.ingestApiKey),
      );
      const hostMetricsServicePath = request.method === "GET"
        && request.path === `${context.prefix}/system/metrics`;
      const validHostMetricsService = hostMetricsServicePath && Boolean(
        config.ingestApiKey && providedIngestKey && keyMatches(providedIngestKey, config.ingestApiKey),
      );
      const appleNotesService = (request.method === "POST"
        && request.path === `${context.prefix}/integrations/apple-notes/capture`)
        || (request.method === "GET" && request.path === `${context.prefix}/integrations/apple-notes/snapshot`);
      if (validIngestService) { next(); return; }
      if (validHostMetricsService) {
        response.locals.hostMetricsAuthorized = true;
        next();
        return;
      }
      if (appleNotesService) {
        // Validate the route-scoped machine credential before the large parser.
        response.setHeader("cache-control", "no-store");
        appleNotesGrant(request, config);
        next();
        return;
      }

      const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
      if (!principal) {
        next(new HttpError(401, "UNAUTHORIZED", "Sign in to access this endpoint"));
        return;
      }
      const sideEffectFreePost = request.method === "POST" && [
        `${context.v2Prefix}/analytics/query`, `${context.v2Prefix}/analytics/coverage`,
      ].includes(request.path);
      const unsafe = !SAFE_HTTP_METHODS.has(request.method) && !sideEffectFreePost;
      const iosNotificationSelfService = ["PUT", "DELETE"].includes(request.method)
        && isIOSNotificationRegistrationPath(request.path, context.prefix);
      if (unsafe && principal.role === "guest"
        && request.path !== `${context.prefix}/auth/logout`
        && !iosNotificationSelfService) {
        next(new HttpError(403, "GUEST_READ_ONLY", "Guest accounts are read-only"));
        return;
      }
      if (principal.role === "guest" && (
        request.path.startsWith(`${context.prefix}/integrations/`)
        || request.path.startsWith(`${context.prefix}/mock/`)
        || request.path === `${context.prefix}/replay`
      )) {
        next(new HttpError(403, "FORBIDDEN", "Guest accounts cannot access administrative configuration"));
        return;
      }
      if (unsafe && !principal.bootstrap) {
        const authenticatedSession = session as LocalAuthSession;
        if (!context.localAuth.csrfMatches(authenticatedSession, request.header("x-csrf-token"))) {
          next(new HttpError(403, "CSRF_TOKEN_INVALID", "A valid X-CSRF-Token header is required"));
          return;
        }
      }
      next();
    });
  const cloudflareSetupJsonParser = express.json({ limit: "16kb" });
  const memberJsonParser = express.json({ limit: "32kb" });
  const trackingObserverJsonParser = express.json({ limit: "256kb" });
  const apiJsonParser = express.json({ limit: "15mb" });
  const extended = Object.assign(context, { authJsonParser, cloudflareSetupJsonParser, memberJsonParser, trackingObserverJsonParser, apiJsonParser });
  return extended;
}
