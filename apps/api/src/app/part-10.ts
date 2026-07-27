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
import { configureApiPart09 } from "./part-09.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart10(context: ReturnType<typeof configureApiPart09>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.v2Prefix}/analytics/findings`, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : "";
      if (!houseId || houseId.length > 200) throw new HttpError(400, "INVALID_FIELD", "houseId is required");
      const house = context.database.getHouse(houseId);
      if (!house || !context.visibility(response).house(house.id)) {
        throw new HttpError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
      }
      const dataMode = context.database.isRealDataMode() ? "live" : "demo";
      const stored = context.database.dailyAnalyticsFindings(house.id, dataMode);
      response.setHeader("cache-control", "no-store");
      response.json({
        snapshot: stored?.snapshot ?? null,
        status: {
          state: stored?.lastError ? "failed" : stored?.snapshot ? "ready" : "pending",
          lastAttemptAt: stored?.lastAttemptAt ?? null,
          lastError: stored?.lastError ?? null,
        },
      });
    });
  context.app.post(`${context.v2Prefix}/analytics/coverage`, async (request, response) => {
      try {
        const coverageRequest = parseAnalyticsCoverageRequest(request.body);
        const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
        if (coverageRequest.dataMode !== activeDataMode) {
          throw new AnalyticsQueryError(
            409,
            "ANALYTICS_DATA_MODE_MISMATCH",
            `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
          );
        }
        const house = context.database.getHouse(coverageRequest.scope.id);
        if (!house || !context.visibility(response).house(house.id)) {
          throw new AnalyticsQueryError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
        }
        const accessibleSensors = context.database.listSensors(house.id)
          .filter((sensor) => sensor.enabled && context.visibility(response).sensor(sensor.id));
        const byId = new Map(accessibleSensors.map((sensor) => [sensor.id, sensor]));
        const requestedSensorIds = coverageRequest.scope.entityIds ?? accessibleSensors.map((sensor) => sensor.id);
        const sensors = requestedSensorIds.map((sensorId) => {
          const sensor = byId.get(sensorId);
          if (!sensor) {
            throw new AnalyticsQueryError(404, "ANALYTICS_ENTITY_NOT_FOUND", `Sensor ${sensorId} is not available in the requested house`);
          }
          return sensor;
        });
        for (const metric of coverageRequest.measurementIds) {
          const definition = context.database.getMeasurementDefinition(metric);
          if (!definition) throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${metric}`);
          if (definition.genericHistoryEnabled === false || definition.genericStatsEnabled === false) {
            throw new AnalyticsQueryError(422, "ANALYTICS_MEASUREMENT_DISABLED", `Analytics is disabled for measurement: ${metric}`);
          }
        }
        const coverage = await context.telemetryReader.measurementCoverage({
          sensorIds: sensors.map((sensor) => sensor.id),
          metrics: coverageRequest.measurementIds,
        });
        const labels = new Map(sensors.map((sensor) => [sensor.id, sensor.name]));
        const series = coverage.records.map((record) => ({
          entityId: record.sensorId,
          entityLabel: labels.get(record.sensorId) ?? record.sensorId,
          measurementId: record.metric,
          start: record.start,
          end: record.end,
        }));
        const starts = series.map((item) => item.start).sort();
        const ends = series.map((item) => item.end).sort();
        response.setHeader("cache-control", "no-store");
        response.json({
          apiVersion: "1.0",
          requestId: coverageRequest.requestId,
          dataMode: coverageRequest.dataMode,
          range: { start: starts[0] ?? null, end: ends.at(-1) ?? null },
          series,
          complete: coverage.complete,
          archiveState: coverage.archiveState,
          generatedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof AnalyticsQueryError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
    });
  context.app.post(`${context.v2Prefix}/analytics/query`, async (request, response) => {
      try {
        const analyticsRequest = parseAnalyticsQueryRequest(request.body);
        const activeDataMode = context.database.isRealDataMode() ? "live" : "demo";
        if (analyticsRequest.dataMode !== activeDataMode) {
          throw new AnalyticsQueryError(
            409,
            "ANALYTICS_DATA_MODE_MISMATCH",
            `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
          );
        }
        const house = context.database.getHouse(analyticsRequest.scope.id);
        if (!house || !context.visibility(response).house(house.id)) {
          throw new AnalyticsQueryError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
        }
        const accessibleSensors = context.database.listSensors(house.id)
          .filter((sensor) => sensor.enabled && context.visibility(response).sensor(sensor.id));
        const byId = new Map(accessibleSensors.map((sensor) => [sensor.id, sensor]));
        const requestedSensorIds = analyticsRequest.scope.entityIds ?? accessibleSensors.map((sensor) => sensor.id);
        const sensors = requestedSensorIds.map((sensorId) => {
          const sensor = byId.get(sensorId);
          if (!sensor) {
            throw new AnalyticsQueryError(404, "ANALYTICS_ENTITY_NOT_FOUND", `Sensor ${sensorId} is not available in the requested house`);
          }
          return sensor;
        });
        const definitions = analyticsRequest.measurementIds.map((metric) => {
          const definition = context.database.getMeasurementDefinition(metric);
          if (!definition) throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${metric}`);
          return definition;
        });
        const read = await context.telemetryReader.measurementWindow({
          sensorIds: sensors.map((sensor) => sensor.id),
          metrics: definitions.map((definition) => definition.id),
          from: analyticsRequest.range.start,
          // The shared telemetry readers use inclusive upper bounds, while an
          // analytics range is [start, end) so adjacent requests never overlap.
          to: new Date(Date.parse(analyticsRequest.range.end) - 1).toISOString(),
          limit: 250_000,
        });
        if (read.records.length >= 250_000) {
          throw new AnalyticsQueryError(
            422,
            "ANALYTICS_SOURCE_POINT_LIMIT_EXCEEDED",
            "The source window reached the 250000-point interactive limit; choose a shorter range or fewer series",
          );
        }
        response.setHeader("cache-control", "no-store");
        response.json(buildAnalyticsResponse({
          request: analyticsRequest,
          samples: read.records,
          definitions,
          entities: sensors.map((sensor) => ({ id: sensor.id, label: sensor.name })),
          archiveState: read.provenance.archiveState,
        }));
      } catch (error) {
        if (error instanceof AnalyticsQueryError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
    });
  context.app.post(`${context.v2Prefix}/measurements`, context.requireIngestKey, (request, response) => {
      const candidate = request.body as unknown;
      let input: unknown[];
      if (Array.isArray(candidate)) input = candidate;
      else if (candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).samples)) {
        input = (candidate as { samples: unknown[] }).samples;
      } else if (candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).sample !== undefined) {
        input = [(candidate as Record<string, unknown>).sample];
      } else input = [candidate];
      if (input.length === 0 || input.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 measurement samples");
      const submitted = input.map((item) => parseMeasurementSample(item, context.database));
      for (const sample of submitted) {
        const sensor = context.database.getSensor(sample.sensorId);
        if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const samples = context.measurements.ingestBatch(submitted);
      response.status(201).json({ accepted: samples.length, samples });
    });
  context.app.post(`${context.v2Prefix}/measurements/import`, context.requireIngestKey, (request, response) => {
      const candidate = request.body as unknown;
      const input = candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).samples)
        ? (candidate as { samples: unknown[] }).samples
        : [];
      if (input.length === 0 || input.length > 10_000) {
        throw new HttpError(400, "INVALID_BATCH", "Import between 1 and 10000 measurement samples at a time");
      }
      const submitted = input.map((item) => ({ ...parseMeasurementSample(item, context.database), source: "import" as const }));
      for (const sample of submitted) {
        const sensor = context.database.getSensor(sample.sensorId);
        if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const samples = context.measurements.ingestBatch(submitted, {
        allowDisabledSensors: true,
        publish: false,
        evaluateAlerts: false,
        deduplicateAcrossSources: true,
      });
      if (samples.length > 0) void context.telemetryArchive?.reconcileNow().catch(() => undefined);
      response.status(201).json({ accepted: samples.length, ignoredDuplicates: submitted.length - samples.length });
    });
  context.app.get(`${context.v2Prefix}/measurements/snapshot`, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
      const access = context.visibility(response);
      if (houseId && (!context.database.getHouse(houseId) || !access.house(houseId))) {
        response.json({ snapshot: [] });
        return;
      }
      const latest = context.cachedLatestMeasurements(houseId);
      const bySensor = new Map<string, Record<string, MeasurementSample>>();
      for (const sample of latest) {
        const map = bySensor.get(sample.sensorId) ?? Object.create(null) as Record<string, MeasurementSample>;
        map[sample.metric] = sample;
        bySensor.set(sample.sensorId, map);
      }
      const snapshot = context.database.listSensors(houseId).filter((sensor) => access.sensor(sensor.id)).map((sensor) => ({
        sensorId: sensor.id,
        measurements: bySensor.get(sensor.id) ?? {},
      }));
      response.json({ snapshot });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
