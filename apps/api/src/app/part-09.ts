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
import { configureApiPart08 } from "./part-08.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart09(context: ReturnType<typeof configureApiPart08>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/system/updates/events`, requireWorkspaceAdmin, (request, response) => {
      if (context.rejectEventStreamDuringShutdown(response)) return;
      const releaseStream = context.acquireEventStream(response);
      if (!releaseStream) {
        response.setHeader("retry-after", "5");
        throw new HttpError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
      }
      const acceptedAuthorization = localAuthorizationFingerprint(requestPrincipal(response));
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders();
      const writer = boundedSseWriter(response);
      let previousStatus = "";
      const publishStatus = (): void => {
        if (response.destroyed || response.writableEnded) return;
        if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
        const status = context.systemUpdates.status();
        const serialized = JSON.stringify({
          currentVersion: status.currentVersion,
          latestVersion: status.latestVersion,
          updateAvailable: status.updateAvailable,
          capability: status.capability,
          operation: status.operation,
        });
        if (serialized === previousStatus) return;
        previousStatus = serialized;
        writer.send(`event: system-update\ndata: ${serialized}\n\n`);
      };
      writer.send("retry: 1000\n\n");
      publishStatus();
      const poll = setInterval(publishStatus, 1_000);
      poll.unref();
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) {
          if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
          writer.send(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
        }
      }, 10_000);
      heartbeat.unref();
      context.registerEventStream(
        request,
        response,
        () => { clearInterval(poll); clearInterval(heartbeat); writer.dispose(); },
        releaseStream,
      );
    });
  context.app.post(`${context.prefix}/system/updates/check`, requireWorkspaceAdmin, async (_request, response, next) => {
      try {
        response.setHeader("cache-control", "no-store");
        response.json(await context.systemUpdates.check());
      } catch (error) {
        next(error);
      }
    });
  context.app.patch(`${context.prefix}/system/updates/settings`, requireWorkspaceAdmin, (request, response, next) => {
      try {
        const status = context.systemUpdates.updateSettings(bodyObject(request.body));
        const principal = requestPrincipal(response);
        context.recordSecurityAudit(principal, {
          eventType: "system.update.settings.changed",
          subjectType: "system-update-settings",
          subjectId: "local",
          details: { mode: status.settings.mode, timezone: status.settings.timezone },
        });
        response.setHeader("cache-control", "no-store");
        response.json(status);
      } catch (error) {
        next(error instanceof TypeError ? new HttpError(400, "INVALID_UPDATE_SETTINGS", error.message) : error);
      }
    });
  context.app.post(`${context.prefix}/system/updates/install`, requireWorkspaceAdmin, async (_request, response, next) => {
      try {
        const status = await context.systemUpdates.queueLatest();
        const principal = requestPrincipal(response);
        context.recordSecurityAudit(principal, {
          eventType: "system.update.requested",
          subjectType: "system-update",
          subjectId: status.operation?.id ?? "unknown",
          details: { version: status.operation?.version ?? status.latestVersion ?? "unknown" },
        });
        response.setHeader("cache-control", "no-store");
        response.status(202).json(status);
      } catch (error) {
        next(error instanceof SystemUpdateError
          ? new HttpError(error.status, error.code, error.message)
          : error);
      }
    });
  context.app.get(`${context.prefix}/cloudflare/setup`, requireWorkspaceAdmin, (request, response) => {
      const status = context.cloudflareSetup.status();
      const principal = requestPrincipal(response);
      response.setHeader("cache-control", "no-store");
      response.json({
        ...status,
        canConfigure: localCloudflareUiRequestAllowed(request, config),
        localConfigureUrl: `http://127.0.0.1:${config.cloudflareSetupLocalUiPort}/stugbys`,
        configuration: {
          ...status.configuration,
          ownerEmail: status.configuration.ownerEmail ?? principal.email,
        },
      });
    });
  context.app.post(`${context.prefix}/cloudflare/setup/start`, requireWorkspaceAdmin, async (request, response, next) => {
      try {
        requireJsonContentType(request);
        const redirectUri = cloudflareUiRedirectUri(request, config);
        const body = bodyObject(request.body);
        const optionalText = (key: string): string | null => {
          const value = body[key];
          if (value === undefined || value === null || value === "") return null;
          if (typeof value !== "string") throw new HttpError(400, "INVALID_FIELD", `${key} must be a string`);
          return value;
        };
        const input: CloudflareSetupStartInput = {
          mode: requiredString(body, "mode") as CloudflareSetupStartInput["mode"],
          hostname: requiredString(body, "hostname"),
          zone: requiredString(body, "zone"),
          ownerEmail: requiredString(body, "ownerEmail"),
          accountId: optionalText("accountId"),
          zoneId: optionalText("zoneId"),
          oauthClientToken: optionalText("oauthClientToken"),
          runtimeToken: optionalText("runtimeToken"),
        };
        const result = await context.cloudflareSetup.start(input, redirectUri);
        const principal = requestPrincipal(response);
        try {
          context.recordSecurityAudit(principal, {
            eventType: "cloudflare.setup.started",
            subjectType: "cloudflare-connection",
            subjectId: result.operation.hostname,
            details: { mode: result.operation.mode, operationId: result.operation.id },
          });
        } catch {
          // Cloudflare has already accepted the external operation. Do not turn
          // that success into a retryable 500 and create a duplicate setup.
          console.error("[security-audit] Cloudflare setup started, but its local audit event could not be recorded");
        }
        response.setHeader("cache-control", "no-store");
        response.status(202).json(result);
      } catch (error) {
        next(error instanceof CloudflareSetupError
          ? new HttpError(error.status, error.code, error.message)
          : error);
      }
    });
  context.app.get(`${context.prefix}/locations/search`, requireNonGuest, async (request, response) => {
      const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
      if (query.length < 2 || query.length > 120) {
        throw new HttpError(400, "INVALID_LOCATION_QUERY", "q must contain between 2 and 120 characters");
      }
      const language = typeof request.query.language === "string" ? request.query.language : "en";
      try {
        response.json({ results: await context.locationDiscovery.search(query, language) });
      } catch {
        throw new HttpError(503, "LOCATION_DISCOVERY_UNAVAILABLE", "Location search is temporarily unavailable");
      }
    });
  context.app.get(`${context.prefix}/locations/defaults`, requireNonGuest, async (request, response) => {
      const latitude = optionalQueryNumber(request.query.latitude, "latitude");
      const longitude = optionalQueryNumber(request.query.longitude, "longitude");
      if (latitude === null || longitude === null) {
        throw new HttpError(400, "INVALID_FIELD", "latitude and longitude are required");
      }
      try {
        response.json(await context.locationDiscovery.defaultsForCoordinates(latitude, longitude));
      } catch (error) {
        if (error instanceof Error && error.message.includes("valid WGS84")) {
          throw new HttpError(422, "INVALID_COORDINATES", error.message);
        }
        throw new HttpError(503, "LOCATION_DISCOVERY_UNAVAILABLE", "Timezone discovery is temporarily unavailable");
      }
    });
  context.app.get(`${context.v2Prefix}/measurement-definitions`, (request, response) => {
      const includeDisabled = request.query.includeDisabled !== "false";
      response.json({ definitions: context.database.listMeasurementDefinitions(includeDisabled) });
    });
  context.app.post(`${context.v2Prefix}/measurement-definitions`, (request, response) => {
      const definition = context.database.createMeasurementDefinition(parseMeasurementDefinition(request.body));
      response.status(201).json({ definition });
    });
  context.app.patch(`${context.v2Prefix}/measurement-definitions/:id`, (request, response) => {
      const id = measurementId(request.params.id, "id");
      const current = context.database.getMeasurementDefinition(id);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
      const definition = context.database.updateMeasurementDefinition(id, parseMeasurementDefinition(request.body, current));
      response.json({ definition });
    });
  context.app.delete(`${context.v2Prefix}/measurement-definitions/:id`, (request, response) => {
      const definition = context.database.disableMeasurementDefinition(measurementId(request.params.id, "id"));
      if (!definition) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
      response.json({ definition });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
