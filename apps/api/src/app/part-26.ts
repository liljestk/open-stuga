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
import { configureApiPart25 } from "./part-25.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart26(context: ReturnType<typeof configureApiPart25>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/integrations/home-assistant/setup`, (request, response) => response.json({
      configured: context.integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).homeAssistant.configured,
      steps: [
        "Create a Home Assistant long-lived access token for a dedicated local user.",
        "Use the setup page to discover Home Assistant or enter its local URL, then save the token.",
        "Map each Stugu sensor to legacy climate keys and/or a measurements object keyed by registry id.",
        "Verify /api/v1/integrations/status reports connected=true.",
      ],
      entityMapSchema: {
        entities: [{
          sensorId: "sensor-01", temperature: "sensor.living_room_temperature", humidity: "sensor.living_room_humidity",
          battery: "sensor.living_room_battery", measurements: { co2: "sensor.living_room_co2" },
        }],
      },
      notes: [
        "All entity keys are optional, but each mapping needs at least one entity.",
        "Generic string bindings require the exact canonical unit; use {entityId, unit, scale, offset} for explicit conversions such as ppb to ppm.",
        "Saved credentials are write-only through the API and stored in the protected integration secrets file, outside SQLite.",
        "HA_URL and HA_TOKEN environment variables remain advanced overrides.",
        "Saving a real integration permanently disables mock telemetry for this database and purges existing demo samples and mock-derived alert events.",
      ],
    }));
  context.app.get(`${context.prefix}/integrations/tp-link/devices`, (request, response) => response.json({
      devices: context.tpLink.listDiscoveredDevices(typeof request.query.houseId === "string" ? request.query.houseId : undefined),
    }));
  context.app.post(`${context.prefix}/integrations/tp-link/history-export/canary`, requireWorkspaceAdmin, (request, response) => {
      const body = bodyObject(request.body);
      rejectUnknownFields(body, new Set(["sensorId", "metric", "from", "to"]), "Tapo history canary");
      const sensorId = requiredString(body, "sensorId");
      const sensor = context.database.getSensor(sensorId);
      if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      const metric = enumValue(body.metric, ["temperature", "humidity"] as const, "metric");
      const fromMs = Date.parse(requiredString(body, "from"));
      const toMs = Date.parse(requiredString(body, "to"));
      const minimumRangeMs = 8 * (config.tapoHistoryExportIntervalMinutes ?? 15) * 60_000;
      const maximumRangeMs = Math.max(7 * 24 * 60 * 60_000, minimumRangeMs);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
        || toMs - fromMs < minimumRangeMs || toMs - fromMs > maximumRangeMs
        || toMs > Date.now() + 5 * 60_000) {
        throw new HttpError(
          422,
          "INVALID_TAPO_CANARY_RANGE",
          "Canary range must be explicit, end no more than five minutes in the future, span at least eight export intervals, and stay within the configured bounded acceptance window",
        );
      }
      try {
        const job = context.tapoHistory.createCanary(
          sensorId,
          metric,
          new Date(fromMs).toISOString(),
          new Date(toMs).toISOString(),
        );
        response.status(202).json({ job: publicTapoHistoryExportJob(job) });
      } catch (error) {
        if (error instanceof TapoHistoryCanaryError) throw new HttpError(409, error.code, error.message);
        throw error;
      }
    });
  context.app.post(`${context.prefix}/integrations/tp-link/history-export/backfill`, requireWorkspaceAdmin, (request, response) => {
      const body = bodyObject(request.body);
      rejectUnknownFields(body, new Set(["sensorId", "metric", "from", "to"]), "Tapo history backfill");
      const sensorId = requiredString(body, "sensorId");
      const metric = enumValue(body.metric, ["temperature", "humidity"] as const, "metric");
      const sensor = context.database.getSensor(sensorId);
      if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      const definition = context.database.getMeasurementDefinition(metric);
      if (!sensor.enabled || !definition?.enabled) {
        throw new HttpError(409, "TAPO_BACKFILL_TARGET_DISABLED", "Backfill sensor and metric must both be enabled");
      }
      const fromMs = Date.parse(requiredString(body, "from"));
      const toMs = Date.parse(requiredString(body, "to"));
      const validationNowMs = Date.now();
      const minimumRangeMs = 2 * (config.tapoHistoryExportIntervalMinutes ?? 15) * 60_000;
      const maximumRangeMs = 730 * 24 * 60 * 60_000;
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
        || toMs - fromMs < minimumRangeMs || toMs - fromMs > maximumRangeMs
        || fromMs < validationNowMs - maximumRangeMs
        || toMs > validationNowMs + 5 * 60_000) {
        throw new HttpError(
          422,
          "INVALID_TAPO_BACKFILL_RANGE",
          "Backfill range must be explicit, fall within the most recent two years, span at least two export intervals, and end no more than five minutes in the future",
        );
      }
      try {
        const gap = context.tapoHistory.requestBackfill(
          sensorId,
          metric,
          new Date(fromMs).toISOString(),
          new Date(toMs).toISOString(),
        );
        sensorGapRecovery.wake();
        response.status(202).json({ gap });
      } catch (error) {
        if (error instanceof TapoHistoryCanaryError) {
          throw new HttpError(error.code === "INVALID_TAPO_BACKFILL_RANGE" ? 422 : 409, error.code, error.message);
        }
        throw error;
      }
    });
  context.app.get(`${context.prefix}/integrations/tp-link/history-export/jobs`, (_request, response) => {
      const jobs = context.tapoHistory.listJobs(250);
      const lastWorkerJob = jobs.filter((job) => job.deploymentFingerprint)
        .sort((left, right) => (right.heartbeatAt ?? right.updatedAt).localeCompare(left.heartbeatAt ?? left.updatedAt))[0];
      response.json({
        enabled: context.tapoHistory.enabled,
        automation: {
          operational: context.tapoHistory.operational,
          canaryPending: context.database.hasOpenTapoHistoryCanary(),
          waitingEmails: context.database.countWaitingTapoHistoryExportEmails(),
          maxPendingEmails: config.tapoHistoryMaxPendingEmails ?? 1,
          exportIntervalMinutes: config.tapoHistoryExportIntervalMinutes ?? 15,
          canaryApprovalMaxAgeDays: TAPO_CANARY_APPROVAL_MAX_AGE_MS / (24 * 60 * 60_000),
          mailbox: context.tapoHistory.mailboxHealth,
          lastWorkerSeenAt: lastWorkerJob?.heartbeatAt ?? lastWorkerJob?.updatedAt ?? null,
          deploymentFingerprintPrefix: lastWorkerJob?.deploymentFingerprint?.slice(0, 12) ?? null,
        },
        jobs: jobs.map(publicTapoHistoryExportJob),
      });
    });
  context.app.post(`${context.prefix}/integrations/tp-link/history-export/jobs/:id/retry`, requireWorkspaceAdmin, (request, response) => {
      const id = typeof request.params.id === "string" ? request.params.id : "";
      if (!id || id.length > 200) throw new HttpError(400, "INVALID_FIELD", "Invalid Tapo export job id");
      const job = context.tapoHistory.retry(id);
      if (!job) throw new HttpError(409, "TAPO_EXPORT_NOT_RETRYABLE", "Tapo export job is not retryable");
      response.json({ job: publicTapoHistoryExportJob(job) });
    });
  context.app.delete(`${context.prefix}/integrations/tp-link/history-export/jobs/:id`, requireWorkspaceAdmin, (request, response) => {
      const id = typeof request.params.id === "string" ? request.params.id : "";
      if (!id || id.length > 200) throw new HttpError(400, "INVALID_FIELD", "Invalid Tapo export job id");
      const existing = context.database.getTapoHistoryExportJob(id);
      if (!existing) throw new HttpError(404, "TAPO_EXPORT_NOT_FOUND", "Tapo export job was not found");
      const job = context.tapoHistory.cancel(id);
      response.json({ job: job ? publicTapoHistoryExportJob(job) : null });
    });
  context.app.get(`${context.prefix}/internal/tapo-history/jobs/claim`, (request, response) => {
      const workerId = typeof request.query.workerId === "string" ? request.query.workerId.trim() : "";
      if (!workerId || workerId.length > 200) throw new HttpError(400, "INVALID_FIELD", "workerId is required and must be at most 200 characters");
      const deploymentFingerprint = typeof request.query.deploymentFingerprint === "string"
        ? request.query.deploymentFingerprint.trim().toLowerCase()
        : "";
      const attestedHeader = request.get("x-tapo-deployment-fingerprint")?.trim().toLowerCase() ?? "";
      if (!/^[a-f0-9]{64}$/u.test(deploymentFingerprint) || attestedHeader !== deploymentFingerprint) {
        throw new HttpError(
          400,
          "INVALID_TAPO_DEPLOYMENT_FINGERPRINT",
          "A matching SHA-256 deployment fingerprint is required in the claim query and header",
        );
      }
      const claim = context.tapoHistory.claim(workerId, deploymentFingerprint);
      if (!claim) { response.status(204).end(); return; }
      response.json({ job: workerTapoHistoryExportJob(claim.job), leaseToken: claim.leaseToken, serverNow: claim.serverNow });
    });
  context.app.post(`${context.prefix}/internal/tapo-history/jobs/:id/heartbeat`, (request, response) => {
      const body = bodyObject(request.body);
      const workerId = requiredString(body, "workerId");
      const leaseToken = requiredString(body, "leaseToken");
      const existing = context.database.getTapoHistoryExportJob(request.params.id);
      const deploymentFingerprint = request.get("x-tapo-deployment-fingerprint")?.trim().toLowerCase() ?? "";
      if (!existing || existing.leaseOwner !== workerId || !existing.deploymentFingerprint
        || deploymentFingerprint !== existing.deploymentFingerprint) {
        throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
      }
      const renewed = context.tapoHistory.heartbeat(request.params.id, leaseToken);
      if (!renewed) throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
      response.json({ job: workerTapoHistoryExportJob(renewed.job), serverNow: renewed.serverNow });
    });
  context.app.post(`${context.prefix}/internal/tapo-history/jobs/:id/status`, (request, response) => {
      const body = bodyObject(request.body);
      const workerId = requiredString(body, "workerId");
      const leaseToken = requiredString(body, "leaseToken");
      const status = enumValue(body.status, ["running", "waiting-email", "needs-attention", "failed"] as const, "status");
      const detail = body.detail === undefined || body.detail === null ? null : requiredString(body, "detail").slice(0, 1_000);
      const existing = context.database.getTapoHistoryExportJob(request.params.id);
      const deploymentFingerprint = request.get("x-tapo-deployment-fingerprint")?.trim().toLowerCase() ?? "";
      if (!existing || existing.leaseOwner !== workerId || !existing.deploymentFingerprint
        || deploymentFingerprint !== existing.deploymentFingerprint) {
        throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
      }
      const job = context.tapoHistory.updateFromWorker(request.params.id, leaseToken, { status, detail });
      if (!job) throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
      response.json({ job: workerTapoHistoryExportJob(job) });
    });
  context.app.post(`${context.prefix}/integrations/tp-link/test`, (request, response) => {
      const houseStatus = context.integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).tpLink;
      response.json({
      ok: houseStatus.connected,
      message: houseStatus.connected
        ? `TP-Link ${houseStatus.hubModel ?? "energy device"} is connected; ${houseStatus.discoveredDevices} devices discovered and ${houseStatus.mappedDevices} mapped.`
        : houseStatus.configured
          ? houseStatus.error ?? "TP-Link credentials are configured, but discovery has not connected yet."
          : "Use the setup page to discover or enter the hub or energy device, then save the TP-Link account credentials.",
      });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
