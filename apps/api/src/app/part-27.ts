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
import { AREA_EQUIPMENT_STATUSES, AuthAbuseLimiter, HttpError, LOCAL_CSRF_COOKIE, LOCAL_SESSION_COOKIE, LOCAL_SESSION_MAX_AGE_MS, LocalVisibility, MAINTENANCE_BASES, MAINTENANCE_CREATE_FIELDS, MAINTENANCE_PATCH_FIELDS, MAINTENANCE_PRIORITIES, MAINTENANCE_STATUSES, MAX_EQUIPMENT_ATTACHMENT_BYTES, MAX_EVENT_STREAMS_GLOBAL, MAX_EVENT_STREAMS_PER_USER, MAX_SSE_QUEUE_BYTES, MAX_SSE_QUEUE_MESSAGES, MEASUREMENT_ID_PATTERN, OBSERVATION_CONFIDENCES, OBSERVATION_CREATE_FIELDS, OBSERVATION_KINDS, OBSERVATION_PATCH_FIELDS, OBSERVATION_SEVERITIES, OBSERVATION_SOURCES, OBSERVATION_STATUSES, OBSERVATION_TIME_PRECISIONS, PROPERTY_AREA_KINDS, PROPERTY_NOTE_KINDS, RESERVED_MEASUREMENT_IDS, SAFE_ASSET_MIME_TYPES, SAFE_EQUIPMENT_DOCUMENT_MIME_TYPES, SAFE_EQUIPMENT_PHOTO_MIME_TYPES, SAFE_HTTP_METHODS, UUID_PATTERN, alertDurationSeconds, appleNotesCaptureInput, appleNotesCaptureMatches, appleNotesGrant, appleNotesGrantSummary, appleNotesSnapshot, assertEquipmentAttachmentMediaType, auditAccountSubject, authAttemptKeys, bodyObject, boundedQueryInteger, boundedSseWriter, browserOriginAllowed, clearLocalSessionCookies, cloudflareUiRedirectUri, collectionPage, completeVisibleCollection, cookieValue, credentialString, dateValue, enumValue, equipmentAttachmentData, equipmentAttachmentDisposition, homeAssistantUrl, houseLocationValue, houseMapPlacementValue, initializeIntegrationMetadata, isIOSNotificationRegistrationPath, isLoopbackSocket, isPrivateProxySocket, isRequestCancellation, isTrackingObserverHeartbeatPath, keyMatches, localAuthorizationFingerprint, localCloudflareUiRequestAllowed, localSetupRequestAllowed, maintenanceDateValue, maintenanceObservationIds, maintenanceText, maintenanceTitle, measurementId, measurementNumberMap, measurementStringMap, measurementUnits, mirrorEnvironmentWebhook, networkHost, normalizedHostname, normalizedOrigin, notePlainLine, noteTaskBlock, nullableFinite, nullablePropertyTarget, optionalBoolean, optionalNullableNumber, optionalNullableString, optionalObservationDate, optionalQueryNumber, optionalResourceQuery, optionalString, parseActionPlaybookInput, parseActionRunStart, parseAlertDeliveryPolicy, parseAlertRule, parseAreaEquipmentInput, parseAreaEquipmentPatch, parseEquipmentAttachmentUpload, parseEquipmentLinkInput, parseEquipmentLinkPatch, parseMaintenanceTaskInput, parseMaintenanceTaskPatch, parseMeasurementDefinition, parseMeasurementSample, parseObservationInput, parseObservationPatch, parsePropertyAreaInput, parsePropertyAreaPatch, parsePropertyInput, parsePropertyNoteInput, parsePropertyNotePatch, parsePropertyPatch, parseReading, parseSensorPatch, persistWeatherObservation, propertyCoordinate, propertyPolygon, propertyText, publicTapoHistoryExportJob, queryList, refreshAppleNotesStatus, rejectUnknownFields, requestOrigin, requestPrincipal, requireJsonContentType, requireNonGuest, requireWorkspaceAdmin, requiredNumber, requiredString, safeInteger, sameHomeAssistantCredential, sameTelegramCredential, sameTpLinkCredential, secureRequest, sessionDocument, setLocalSessionCookies, stringMap, trackingObserverAttemptKeys, trustedProxyClientAddress, trustedProxyRequest, trustedSelfHostname, validateMeasurementDefinition, visibleCollectionPage, workerTapoHistoryExportJob } from "./support/index.js";
import type { ApiRuntime, AuthAttemptBucket, AuthAttemptLimit, BoundedSseWriter, CreateApiOptions, IntegrationDraftTestResult, LocalRequestPrincipal } from "./support/index.js";
import { configureApiPart26 } from "./part-26.js";
import { AnalyticsCapacityError } from "../analytics/work-limiter.js";

type DeferredContext = {
  runtimeReady: Promise<void>;
};

type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart27(context: ReturnType<typeof configureApiPart26>) {
  const deferred = context as typeof context & DeferredContext;
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/integrations/tp-link/setup`, (request, response) => {
      const houseStatus = context.integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).tpLink;
      response.json({
      configured: houseStatus.configured,
      connections: houseStatus.connections ?? [],
      supportedHubs: ["H100", "H200", "H500"],
      supportedClimateSensors: ["T310", "T315"],
      supportedContactSensors: ["T110"],
      supportedEnergyDevices: "Configured TP-Link/Kasa hosts that python-kasa exposes through Module.Energy",
      steps: [
        "Install python-kasa from apps/api/python/requirements.txt (already included in the Docker image).",
        "Select the owning house, discover an H100/H200/H500 hub or supported energy device, or enter a reserved LAN address, then save the house-scoped TP-Link connection.",
        "Inspect /api/v1/integrations/tp-link/devices for normalized climate, contact, and energy devices.",
        "Assign a discovered device by PATCHing its stable deviceId into a sensor's tpLinkDeviceId field.",
        "Attach a T110 contact to an operable door or window by saving a Tapo stateBinding on that floor-plan element.",
      ],
      sensorPatchSchema: { tpLinkDeviceId: "hub-child-device-id" },
      deviceMapSchema: { devices: [{ deviceId: "hub-child-device-id", sensorId: "sensor-01" }] },
      notes: [
        "The helper polls the hub over the local LAN; credentials are passed through its process environment and are never returned or stored in SQLite.",
        "Web-saved credentials live in the protected integration secrets file; TP_LINK_* environment variables remain advanced overrides.",
        "TP_LINK_DEVICE_MAP_FILE remains supported as an optional legacy fallback; database sensor bindings take precedence.",
        "Set tpLinkDeviceId to null to unassign a child device without deleting the sensor or its history.",
        "Home Assistant and direct TP-Link bridges can run at the same time, but the same physical child should be mapped through only one path.",
        "Direct smart energy devices provide power when current_consumption is available and cumulative kWh only when consumption_total is available; daily/monthly reset counters are not mapped to energy.",
        "TP-Link provides consumption only. Property electricity prices are fetched separately from the configured price API (Pörssisähkö by default).",
        "LAN Find devices discovers H100/H200/H500 hubs and uses saved or request-scoped draft TP-Link credentials to include devices that python-kasa verifies through Module.Energy; draft credentials are never persisted.",
        "H500 support is capability-based: Stugu uses only child devices exposed by the hub's local API and reports when the hub advertises additional paired devices that remain hidden.",
        "Saving a real integration permanently disables mock telemetry for this database and purges existing demo samples and mock-derived alert events.",
      ],
      });
    });
  context.app.get(`${context.prefix}/mock/scenarios`, (_request, response) => {
      context.dataMode.synchronize();
      response.json({ scenarios: MOCK_SCENARIOS, active: context.mock.scenario, enabled: context.status.value.mock.enabled });
    });
  context.app.put(`${context.prefix}/mock/scenario`, (request, response) => {
      const scenario = enumValue(bodyObject(request.body).scenario, MOCK_SCENARIOS.map((item) => item.id), "scenario");
      context.mock.setScenario(scenario);
      response.json({ active: context.mock.scenario });
    });
  context.app.post(`${context.prefix}/mock/scenario`, (request, response) => {
      const body = bodyObject(request.body);
      const scenario = enumValue(body.scenarioId ?? body.scenario, MOCK_SCENARIOS.map((item) => item.id), "scenarioId");
      context.mock.setScenario(scenario);
      response.json({ ok: true, active: context.mock.scenario });
    });
  context.app.post(`${context.prefix}/mock/tick`, (_request, response) => response.status(201).json({ readings: context.mock.generate(), scenario: context.mock.scenario }));
  context.app.get(`${context.prefix}/replay`, (_request, response) => response.json({ replay: context.replay.state }));
  context.app.post(`${context.prefix}/replay`, async (request, response) => {
      const body = bodyObject(request.body);
      const sensorIds = Array.isArray(body.sensorIds)
        ? body.sensorIds.filter((id): id is string => typeof id === "string")
        : context.database.listSensors()
            .filter((sensor) => {
              const house = context.database.getHouse(sensor.houseId);
              return Boolean(house && hasLocalHouseAuthority(house));
            })
            .map((sensor) => sensor.id);
      for (const sensorId of sensorIds) {
        const sensor = context.database.getSensor(sensorId);
        if (!sensor) throw new HttpError(404, "NOT_FOUND", `Sensor ${sensorId} not found`);
        context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const to = dateValue(body.to, new Date(), "to");
      const from = dateValue(body.from, new Date(Date.parse(to) - 3_600_000), "from");
      const speed = typeof body.speed === "number" ? body.speed : 60;
      const readings = (await context.telemetryReader.legacyReadingHistory({ sensorIds, from, to, limit: 50_000 })).records;
      response.status(202).json({ replay: context.replay.startReadings(readings, from, to, speed) });
    });
  context.app.delete(`${context.prefix}/replay`, (_request, response) => response.json({ replay: context.replay.stop() }));
  registerTrackingRoutes(context.app, {
      service: context.tracking,
      prefix: context.prefix,
      principal: (response) => {
        const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
        return principal
          ? {
              userId: principal.userId,
              label: principal.email || "Property member",
              role: principal.role,
            }
          : null;
      },
      machineObserver: (response) => (
        response.locals.trackingObserver as AuthenticatedTrackingObserver | undefined
      ) ?? null,
      authorizeProperty: (response, propertyId) => {
        const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
        return principal ? new LocalVisibility(context.database, principal).hasProperty(propertyId) : false;
      },
      authorizeEquipment: (response, equipmentId) => {
        const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
        const equipment = context.database.getAreaEquipment(equipmentId);
        return Boolean(
          principal
          && equipment
          && new LocalVisibility(context.database, principal).equipment(equipment),
        );
      },
      assertPropertyWriteAllowed: (propertyId) => context.stuguby.assertPropertyWriteAllowed(propertyId),
      streamAuthorizationFingerprint: context.streamAuthorizationFingerprint,
      validateStream: (_request, response) => !context.rejectEventStreamDuringShutdown(response),
      acquireStream: (_request, response) => context.acquireEventStream(response),
      registerStream: context.registerEventStream,
    });
  registerSpatialLayerRoutes(context.app, {
      runtime: context.spatialLayers,
      prefix: context.prefix,
      authorizeScope: (request, response, scope) => {
        const access = request.path === `${context.prefix}/layers/events`
          ? context.currentStreamVisibility(request, response)
          : context.visibility(response);
        if (!access) return false;
        // A property aggregate may contain several houses, so a guest needs the
        // property-level grant. House-specific grants remain usable through the
        // corresponding house layer endpoint.
        return scope.kind === "house" ? access.house(scope.id) : access.hasProperty(scope.id);
      },
      authorizeMutation: (_request, response, scope) => {
        if (requestPrincipal(response).role === "guest") return false;
        try {
          if (scope.kind === "house") {
            context.stuguby.assertHouseWriteAllowed(scope.id);
            context.stuguby.assertHouseLocalAuthority(scope.id);
          } else {
            context.stuguby.assertPropertyWriteAllowed(scope.id);
          }
          return true;
        } catch {
          return false;
        }
      },
      auditActor: (_request, response) => requestPrincipal(response).userId,
      streamAuthorizationFingerprint: context.streamAuthorizationFingerprint,
      validateStream: (_request, response) => !context.rejectEventStreamDuringShutdown(response),
      acquireStream: (_request, response) => context.acquireEventStream(response),
    });
  context.app.use(`${context.prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  context.app.use(`${context.v2Prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  context.app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (error instanceof AnalyticsCapacityError) {
        response.setHeader("retry-after", String(error.retryAfterSeconds));
        response.status(503).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof IncompleteTelemetryHistoryError) {
        response.status(503).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof LocalAuthError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof TrackingError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof ClimateDataValidationError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof StugubyError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof TelemetryValidationError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof MeasurementValidationError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof TelegramServiceError) {
        response.status(error.status).json({ error: { code: `TELEGRAM_${error.code}`, message: error.message } });
        return;
      }
      if (error instanceof HttpError) {
        response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
        return;
      }
      const message = error instanceof Error ? error.message : "Unexpected error";
      const httpError = error as { status?: unknown; type?: unknown };
      if (httpError.status === 413 || httpError.type === "entity.too.large") {
        const limit = typeof response.locals.accountBodyLimit === "string"
          ? response.locals.accountBodyLimit
          : "15 MiB";
        response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds the ${limit} limit` } });
        return;
      }
      if (message.includes("FOREIGN KEY constraint failed")) {
        response.status(409).json({ error: { code: "INVALID_REFERENCE", message: "A referenced resource does not exist" } });
        return;
      }
      if (message.includes("UNIQUE constraint failed")) {
        response.status(409).json({ error: { code: "CONFLICT", message: "A resource with this identifier already exists" } });
        return;
      }
      if (message.includes("DEMO_DATA_DISABLED")) {
        response.status(409).json({ error: { code: "DEMO_DATA_DISABLED", message: "Demo telemetry is permanently disabled for this real-data database" } });
        return;
      }
      if (error instanceof SyntaxError) {
        response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
        return;
      }
      if (isRequestCancellation(error)) {
        // Nothing failed: the caller left, or the work was cancelled on its behalf.
        // Reporting these as errors buried the real ones in the system error log.
        if (!response.headersSent && !response.writableEnded && !response.destroyed) {
          response.setHeader("retry-after", "1");
          response.status(503).json({
            error: { code: "REQUEST_CANCELLED", message: "The request was cancelled before it completed" },
          });
        }
        return;
      }
      context.systemErrorLog.record({
        source: "api",
        code: error instanceof Error ? error.name : "UNEXPECTED_ERROR",
        message,
      });
      response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
    });
  const initialRuntimeReady: Promise<void> = Promise.resolve();
  Object.assign(context, { runtimeReady: initialRuntimeReady });
  if (context.options.startBackground && context.telemetryArchive) {
      const starting = context.telemetryArchive.start();
      deferred.runtimeReady = config.timeseriesRequired
        ? starting
        : starting.catch(() => {
          // SQLite remains durable and the worker retries. Never log connection
          // configuration because it contains a database credential.
          console.error("[telemetry-archive] Optional TimescaleDB archive is unavailable; SQLite buffering continues");
        });
      void deferred.runtimeReady.then(() => {
        context.telemetryRetention?.start();
        context.telemetryOrderedRollups?.start();
      }).catch(() => undefined);
    }
  const extended = Object.assign(context, {  });
  return extended as typeof extended & { runtimeReady: Promise<void> };
}
