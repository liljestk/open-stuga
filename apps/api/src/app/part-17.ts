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
  type AppleNotesGrantSecret,
  type IntegrationSecrets,
  type TpLinkConnectionSecret,
} from "../integration-secrets.js";
import { commitCoordinatedIntegrationSecrets } from "../integration-secrets-coordinator.js";
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
import { configureApiPart16 } from "./part-16.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart17(context: ReturnType<typeof configureApiPart16>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.delete(`${context.prefix}/houses/:id`, async (request, response) => {
      const houseId = request.params.id as string;
      const previous = context.database.getHouse(houseId);
      context.stuguby.assertHouseWriteAllowed(houseId);
      context.stuguby.assertHouseLocalAuthority(houseId);
      context.requireImmutableTelemetryLineage("house", houseId);
      const previousHomeAssistantConnections = [...(config.homeAssistantConnections ?? [])];
      const previousTpLinkConnections = [...(config.tpLinkConnections ?? [])];
      const previousGreeConnections = [...(config.greeConnections ?? [])];
      const previousTuyaConnections = [...(config.tuyaConnections ?? [])];
      const previousAppleNotesGrants = [...config.appleNotesGrants];
      const remainingHomeAssistantConnections = previousHomeAssistantConnections
        .filter((connection) => connection.houseId !== houseId);
      const remainingTpLinkConnections = previousTpLinkConnections
        .filter((connection) => connection.houseId !== houseId);
      const remainingGreeConnections = previousGreeConnections
        .filter((connection) => connection.houseId !== houseId);
      const greeChanged = remainingGreeConnections.length !== previousGreeConnections.length;
      const remainingTuyaConnections = previousTuyaConnections
        .filter((connection) => connection.houseId !== houseId);
      const tuyaChanged = remainingTuyaConnections.length !== previousTuyaConnections.length;
      const remainingGrants = previousAppleNotesGrants.filter((grant) => grant.houseId !== houseId);
      const connectionsChanged = remainingHomeAssistantConnections.length !== previousHomeAssistantConnections.length
        || remainingTpLinkConnections.length !== previousTpLinkConnections.length
        || greeChanged
        || tuyaChanged;
      const grantsChanged = remainingGrants.length !== previousAppleNotesGrants.length;
      if (connectionsChanged || grantsChanged) {
        commitCoordinatedIntegrationSecrets(config.integrationSecretsFile, context.database, () => {
          context.integrationMetadata.retireHouse(houseId);
          if (!context.database.deleteHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
          return {
            patch: {
              homeAssistantConnections: remainingHomeAssistantConnections,
              tpLinkConnections: remainingTpLinkConnections,
              greeConnections: remainingGreeConnections,
              tuyaConnections: remainingTuyaConnections,
              appleNotesGrants: remainingGrants,
            },
            result: undefined,
          };
        });
      } else {
        context.database.transaction(() => {
          context.integrationMetadata.retireHouse(houseId);
          if (!context.database.deleteHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
        });
      }
      config.homeAssistantConnections = remainingHomeAssistantConnections;
      config.tpLinkConnections = remainingTpLinkConnections;
      config.greeConnections = remainingGreeConnections;
      config.tuyaConnections = remainingTuyaConnections;
      config.appleNotesGrants = remainingGrants;
      if (previous) context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: previous.propertyId },
        new Date().toISOString(),
        "ownership-changed",
        true,
      ));
      context.homeAssistant.refreshMappings();
      if (connectionsChanged) {
        if (context.options.startBackground) {
          context.homeAssistant.restart();
          context.tpLink.restart();
        }
        if (greeChanged) context.gree.refreshConfiguration();
        if (tuyaChanged) context.tuya.refreshConfiguration();
      }
      context.weather.invalidate(houseId);
      context.weatherEvents.invalidate(houseId);
      if (grantsChanged) refreshAppleNotesStatus(config, context.status);
      context.status.refreshWeatherConfiguration();
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/sensors/snapshots`, (request, response) => {
      const access = context.visibility(response);
      const sensors = context.database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((sensor) => access.sensor(sensor.id));
      const selected = new Set(sensors.map((sensor) => sensor.id));
      const latest = new Map(context.cachedLatestReadings().filter((reading) => selected.has(reading.sensorId))
        .map((reading) => [reading.sensorId, reading]));
      response.json({ sensors: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
    });
  context.app.get(`${context.prefix}/snapshot`, (request, response) => {
      const access = context.visibility(response);
      const sensors = context.database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
        .filter((sensor) => access.sensor(sensor.id));
      const selected = new Set(sensors.map((sensor) => sensor.id));
      const latest = new Map(context.cachedLatestReadings().filter((reading) => selected.has(reading.sensorId))
        .map((reading) => [reading.sensorId, reading]));
      response.json({ snapshot: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
    });
  context.app.get(`${context.prefix}/sensors`, (request, response) => {
      const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
      const access = context.visibility(response);
      response.json({ sensors: context.database.listSensors(houseId).filter((sensor) => access.sensor(sensor.id)) });
    });
  context.app.post(`${context.prefix}/sensors`, (request, response) => {
      const body = bodyObject(request.body);
      const tags = body.tags === undefined ? [] : body.tags;
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
      const input: Omit<Sensor, "id"> & { id?: string } = {
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        houseId: requiredString(body, "houseId"), floorId: requiredString(body, "floorId"), name: requiredString(body, "name"),
        ...(body.roomId !== undefined ? { roomId: body.roomId === null ? null : requiredString(body, "roomId") } : {}),
        room: requiredString(body, "room"), model: requiredString(body, "model"), x: requiredNumber(body, "x"),
        y: requiredNumber(body, "y"), z: requiredNumber(body, "z"), tags: tags as string[],
        energyMeterRole: body.energyMeterRole === undefined
          ? "standalone"
          : enumValue(body.energyMeterRole, ["whole_home", "submeter", "standalone"] as const, "energyMeterRole"),
        enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
        ...(optionalString(body, "temperatureEntityId") !== undefined ? { temperatureEntityId: optionalString(body, "temperatureEntityId") as string } : {}),
        ...(optionalString(body, "humidityEntityId") !== undefined ? { humidityEntityId: optionalString(body, "humidityEntityId") as string } : {}),
        ...(optionalString(body, "batteryEntityId") !== undefined ? { batteryEntityId: optionalString(body, "batteryEntityId") as string } : {}),
        ...(body.tpLinkDeviceId !== undefined && body.tpLinkDeviceId !== null
          ? { tpLinkDeviceId: requiredString(body, "tpLinkDeviceId") }
          : {}),
        ...(body.tpLinkConnectionId !== undefined && body.tpLinkConnectionId !== null
          ? { tpLinkConnectionId: requiredString(body, "tpLinkConnectionId") }
          : {}),
        ...(body.measurementEntityIds !== undefined ? { measurementEntityIds: measurementStringMap(body.measurementEntityIds, "measurementEntityIds") } : {}),
      };
      context.stuguby.assertHouseWriteAllowed(input.houseId);
      if (input.temperatureEntityId || input.humidityEntityId || input.batteryEntityId
        || input.tpLinkDeviceId || input.tpLinkConnectionId || Object.keys(input.measurementEntityIds ?? {}).length > 0) {
        context.stuguby.assertHouseLocalAuthority(input.houseId);
      }
      context.assertTpLinkConnectionScope(input);
      const sensor = context.database.transaction(() => {
        const created = context.database.createSensor(input);
        context.stuguby.captureHomeMutation(created.houseId);
        return created;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(null, sensor);
      response.status(201).json({ sensor });
    });
  context.app.get(`${context.prefix}/sensors/:id`, (request, response) => {
      const sensor = context.database.getSensor(request.params.id as string);
      if (!sensor || !context.visibility(response).sensor(sensor.id)) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
      response.json({ sensor, reading: context.database.getLatestReading(sensor.id) });
    });
  context.app.patch(`${context.prefix}/sensors/:id`, (request, response) => {
      const current = context.database.getSensor(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      const patch = parseSensorPatch(request.body);
      if (current && patch.houseId && patch.houseId !== current.houseId) {
        context.stuguby.assertHouseWriteAllowed(patch.houseId);
        context.assertSensorHouseMoveAllowed(current.houseId, patch.houseId);
      }
      if (current && ["temperatureEntityId", "humidityEntityId", "batteryEntityId", "tpLinkDeviceId", "tpLinkConnectionId", "measurementEntityIds"]
        .some((field) => Object.hasOwn(patch, field))) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (current && (Object.hasOwn(patch, "houseId") || Object.hasOwn(patch, "tpLinkDeviceId") || Object.hasOwn(patch, "tpLinkConnectionId"))) {
        const candidate = { ...current, ...patch };
        if (patch.tpLinkDeviceId === null) {
          delete candidate.tpLinkDeviceId;
          delete candidate.tpLinkConnectionId;
        }
        if (patch.tpLinkConnectionId === null) delete candidate.tpLinkConnectionId;
        context.assertTpLinkConnectionScope(candidate);
      }
      const sensor = context.database.transaction(() => {
        const updated = context.database.updateSensor(request.params.id as string, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
        if (current && current.houseId !== updated.houseId) context.stuguby.captureHomeMutation(current.houseId);
        context.stuguby.captureHomeMutation(updated.houseId);
        return updated;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(current, sensor);
      response.json({ sensor });
    });
  context.app.put(`${context.prefix}/sensors/:id`, (request, response) => {
      const current = context.database.getSensor(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      const patch = parseSensorPatch(request.body);
      if (current && patch.houseId && patch.houseId !== current.houseId) {
        context.stuguby.assertHouseWriteAllowed(patch.houseId);
        context.assertSensorHouseMoveAllowed(current.houseId, patch.houseId);
      }
      if (current && ["temperatureEntityId", "humidityEntityId", "batteryEntityId", "tpLinkDeviceId", "tpLinkConnectionId", "measurementEntityIds"]
        .some((field) => Object.hasOwn(patch, field))) context.stuguby.assertHouseLocalAuthority(current.houseId);
      if (current && (Object.hasOwn(patch, "houseId") || Object.hasOwn(patch, "tpLinkDeviceId") || Object.hasOwn(patch, "tpLinkConnectionId"))) {
        const candidate = { ...current, ...patch };
        if (patch.tpLinkDeviceId === null) {
          delete candidate.tpLinkDeviceId;
          delete candidate.tpLinkConnectionId;
        }
        if (patch.tpLinkConnectionId === null) delete candidate.tpLinkConnectionId;
        context.assertTpLinkConnectionScope(candidate);
      }
      const sensor = context.database.transaction(() => {
        const updated = context.database.updateSensor(request.params.id as string, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
        if (current && current.houseId !== updated.houseId) context.stuguby.captureHomeMutation(current.houseId);
        context.stuguby.captureHomeMutation(updated.houseId);
        return updated;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(current, sensor);
      response.json(sensor);
    });
  context.app.delete(`${context.prefix}/sensors/:id`, async (request, response) => {
      const current = context.database.getSensor(request.params.id as string);
      if (current) context.stuguby.assertHouseWriteAllowed(current.houseId);
      context.requireImmutableTelemetryLineage("sensor", request.params.id as string);
      context.database.transaction(() => {
        if (!context.database.deleteSensor(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
        if (current) context.stuguby.captureHomeMutation(current.houseId);
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatialSensorChange(current, null);
      response.status(204).end();
    });
  context.app.post(`${context.prefix}/readings`, context.requireIngestKey, (request, response) => {
      const candidate = request.body as unknown;
      const readingsInput = Array.isArray(candidate) ? candidate : (
        candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).readings)
          ? (candidate as { readings: unknown[] }).readings : [candidate]
      );
      if (readingsInput.length === 0 || readingsInput.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 readings");
      const submitted = readingsInput.map(parseReading);
      for (const reading of submitted) {
        const sensor = context.database.getSensor(reading.sensorId);
        if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      }
      const readings = context.telemetry.ingestBatch(submitted);
      response.status(201).json({ readings, ignoredDuplicates: submitted.length - readings.length });
    });
  context.app.get(`${context.prefix}/readings/latest`, (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const selectedIds = new Set(selected);
      response.json({ readings: selected.length > 0
        ? context.cachedLatestReadings().filter((reading) => selectedIds.has(reading.sensorId))
        : [] });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
