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
import { configureApiPart19 } from "./part-19.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart20(context: ReturnType<typeof configureApiPart19>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/data-export`, async (request, response) => {
      const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel") as DataExportPrivacyLevel;
      const includeTelemetry = request.query.includeTelemetry === "true";
      if (includeTelemetry && context.telemetryArchive) {
        throw new HttpError(409, "ARCHIVE_EXPORT_REQUIRES_BACKUP", "A raw telemetry JSON export is unavailable after SQLite hot retention; use a verified backup, which includes both SQLite and TimescaleDB");
      }
      const generatedAt = new Date().toISOString();
      const preview = context.dataOperations.preview(privacyLevel, includeTelemetry);
      const controlPlane = context.dataOperations.bundle(privacyLevel);
      context.dataOperations.audit("export.started", { privacyLevel, includeTelemetry });
      response.status(200);
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("content-disposition", `attachment; filename="stugu-export-${generatedAt.replace(/[:.]/g, "-")}.json"`);
      response.setHeader("cache-control", "no-store");
      response.flushHeaders();
      const write = async (chunk: string): Promise<boolean> => {
        if (response.destroyed || request.destroyed) return false;
        if (response.write(chunk)) return true;
        await new Promise<void>((resolve) => response.once("drain", resolve));
        return !response.destroyed && !request.destroyed;
      };
      const head = JSON.stringify({
        schemaVersion: "stugu.export/v1",
        generatedAt,
        privacyLevel,
        includesTelemetry: includeTelemetry,
        privacyPreview: preview,
        data: controlPlane,
      });
      if (!includeTelemetry) {
        response.end(head);
        context.dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
        return;
      }
      if (!await write(`${head.slice(0, -1)},"telemetry":{`)) return;
      const telemetryTables = ["measurement_samples", "readings", "outdoor_temperature_samples", "electricity_price_points"] as const;
      for (let tableIndex = 0; tableIndex < telemetryTables.length; tableIndex += 1) {
        const table = telemetryTables[tableIndex]!;
        if (!await write(`${tableIndex === 0 ? "" : ","}${JSON.stringify(table)}:[`)) return;
        let first = true;
        for (const row of context.database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
          if (!await write(`${first ? "" : ","}${JSON.stringify(row)}`)) return;
          first = false;
        }
        if (!await write("]")) return;
      }
      response.end("}}");
      context.dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
    });
  context.app.get(`${context.prefix}/backups/status`, (_request, response) => {
      response.json({ backup: context.dataOperations.backupStatus() });
    });
  context.app.post(`${context.prefix}/backups`, (_request, response) => {
      response.status(202).json({ backup: context.dataOperations.requestBackup() });
    });
  context.app.get(`${context.prefix}/setup/doctor`, (_request, response) => {
      response.json({ report: context.setupDoctor.report() });
    });
  context.app.get(`${context.prefix}/sensors/:id/label`, (request, response) => {
      const label = context.setupDoctor.sensorLabel(request.params.id as string);
      if (!label) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      response.json({ label });
    });
  context.app.post(`${context.prefix}/setup/bulk-sensor-mappings`, (request, response) => {
      const body = bodyObject(request.body);
      const houseId = requiredString(body, "houseId");
      context.stuguby.assertHouseLocalAuthority(houseId);
      if (!Array.isArray(body.mappings)) throw new HttpError(400, "INVALID_FIELD", "mappings must be an array");
      const mappings = body.mappings.map((candidate) => {
        const mapping = bodyObject(candidate);
        if (!mapping.measurementEntityIds || typeof mapping.measurementEntityIds !== "object" || Array.isArray(mapping.measurementEntityIds)) {
          throw new HttpError(400, "INVALID_FIELD", "measurementEntityIds must be an object");
        }
        return { sensorId: requiredString(mapping, "sensorId"), measurementEntityIds: Object.fromEntries(
          Object.entries(mapping.measurementEntityIds as Record<string, unknown>).map(([metric, entityId]) => {
            if (typeof entityId !== "string") throw new HttpError(400, "INVALID_FIELD", "Entity ids must be strings");
            return [metric, entityId];
          }),
        ) };
      });
      const sensors = context.database.bulkUpdateSensorBindings(houseId, mappings);
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/houses/${houseId}/sensor-mappings`, occurredAt: new Date().toISOString() } });
      response.json({ sensors });
    });
  context.app.get(`${context.prefix}/observations`, (request, response) => {
      const access = context.visibility(response);
      response.json({ observations: context.database.listObservations(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((observation) => access.house(observation.houseId)) });
    });
  context.app.post(`${context.prefix}/observations`, (request, response) => {
      const input = parseObservationInput(request.body);
      context.stuguby.assertHouseWriteAllowed(input.houseId);
      const { observation, created } = context.database.transaction(() => {
        const result = context.database.getOrCreateObservation(input, "local-rest");
        if (result.created) context.stuguby.captureHomeMutation(result.observation.houseId);
        return result;
      });
      response.status(created ? 201 : 200).json(observation);
    });
  context.app.patch(`${context.prefix}/observations/:id`, (request, response) => {
      const current = context.database.getObservation(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      const observation = context.database.transaction(() => {
        const updated = context.database.updateObservation(
          request.params.id as string,
          parseObservationPatch(request.body),
          "local-rest",
        );
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Observation not found");
        context.stuguby.captureHomeMutation(updated.houseId);
        return updated;
      });
      response.json(observation);
    });
  context.app.get(`${context.prefix}/observations/:id/revisions`, (request, response) => {
      const id = request.params.id as string;
      const observation = context.database.getObservation(id);
      const access = context.visibility(response);
      if (!observation || !access.house(observation.houseId)) throw new HttpError(404, "NOT_FOUND", "Observation not found");
      if (access.restricted) throw new HttpError(403, "GUEST_AUDIT_RESTRICTED", "Guest accounts cannot access revision histories");
      response.json({ revisions: context.database.listObservationRevisions(id) });
    });
  context.app.delete(`${context.prefix}/observations/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getObservation(id);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      context.database.transaction(() => {
        if (!context.database.deleteObservation(id)) throw new HttpError(404, "NOT_FOUND", "Observation not found");
        if (current) context.stuguby.captureHomeMutation(current.houseId);
      });
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/maintenance-tasks`, (request, response) => {
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      const areaId = optionalResourceQuery(request.query.areaId, "areaId");
      const equipmentId = optionalResourceQuery(request.query.equipmentId, "equipmentId");
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      response.json({
        maintenanceTasks: visibleCollectionPage(
          (limit, offset) => context.database.listMaintenanceTasks({
            ...(propertyId ? { propertyId } : {}),
            ...(houseId ? { houseId } : {}),
            ...(areaId ? { areaId } : {}),
            ...(equipmentId ? { equipmentId } : {}),
            limit,
            offset,
          }),
          (task) => access.maintenance(task),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/maintenance-tasks`, (request, response) => {
      const input = parseMaintenanceTaskInput(request.body);
      const propertyId = input.propertyId ?? (input.houseId ? context.database.getHouse(input.houseId)?.propertyId : undefined);
      if (propertyId) context.stuguby.assertPropertyWriteAllowed(propertyId);
      const { task, created } = context.database.transaction(() => {
        const result = context.database.getOrCreateMaintenanceTask(input, "local-rest");
        if (result.created) context.stuguby.captureCurrentPropertyEntity(
          result.task.propertyId,
          "maintenance",
          result.task.id,
          "upsert",
        );
        return result;
      });
      response.status(created ? 201 : 200).json(task);
    });
  context.app.get(`${context.prefix}/maintenance-tasks/:id`, (request, response) => {
      const task = context.database.getMaintenanceTask(request.params.id as string);
      if (!task || !context.visibility(response).maintenance(task)) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
      response.json(task);
    });
  context.app.patch(`${context.prefix}/maintenance-tasks/:id`, (request, response) => {
      const taskId = request.params.id as string;
      const previous = context.database.getMaintenanceTask(taskId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      const task = context.database.transaction(() => {
        const updated = context.database.updateMaintenanceTask(
          taskId,
          parseMaintenanceTaskPatch(request.body),
          "local-rest",
        );
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
        context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "maintenance", updated.id, "upsert");
        return updated;
      });
      response.json(task);
    });
  context.app.get(`${context.prefix}/maintenance-tasks/:id/revisions`, (request, response) => {
      const id = request.params.id as string;
      const task = context.database.getMaintenanceTask(id);
      const access = context.visibility(response);
      if (!task || !access.maintenance(task)) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
      if (access.restricted) throw new HttpError(403, "GUEST_AUDIT_RESTRICTED", "Guest accounts cannot access revision histories");
      response.json({ revisions: context.database.listMaintenanceTaskRevisions(id) });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
