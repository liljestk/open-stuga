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
import {
  isThermalIsolationTemperatureSensor,
  runThermalIsolationAsync,
} from "../thermal-isolation.js";
import {
  isMoistureResponseSensor,
  runMoistureResponseAsync,
} from "../moisture-response.js";
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
import { mapWithConcurrency } from "../timeseries/read-support.js";
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
import { configureApiPart14 } from "./part-14.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart15(context: ReturnType<typeof configureApiPart14>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/houses/:id/weather`, async (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(house.id);
      if (!house.location) {
        throw new HttpError(409, "HOUSE_LOCATION_REQUIRED", "Set the house location before requesting weather");
      }
      const hours = safeInteger(request.query.hours, 48, 1, 240);
      try {
        const result = await context.weather.get(house, hours);
        const current = context.database.getHouse(house.id);
        if (!current) throw new HttpError(404, "NOT_FOUND", "House not found");
        if (current.updatedAt !== house.updatedAt
          || outdoorLocationKey(current.location) !== outdoorLocationKey(result.location)) {
          throw new WeatherRequestSupersededError();
        }
        await context.weatherEvents.publish(result, "on-demand");
        response.json({ weather: result });
      } catch (error) {
        if (error instanceof WeatherRequestSupersededError || error instanceof WeatherEventSupersededError) {
          throw new HttpError(409, "WEATHER_REQUEST_SUPERSEDED", error.message);
        }
        if (error instanceof WeatherUnavailableError) {
          throw new HttpError(503, "WEATHER_UNAVAILABLE", error.message, {
            provider: house.location && !prefersFmi(house.location) ? "open-meteo" : "fmi",
            recovery: context.weather.recoveryStatus(house),
          });
        }
        throw error;
      }
    });
  context.app.get(`${context.v2Prefix}/houses/:id/outdoor-temperature/history`, async (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(house.id);
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
      if (!house.location) {
        response.json({ samples: [], from, to, truncated: false });
        return;
      }
      const archived = (await context.telemetryReader.outdoorTemperatureHistory({
        houseId: house.id,
        locationKey: outdoorLocationKey(house.location),
        from,
        to,
        limit: limit + 1,
      })).records;
      const truncated = archived.length > limit;
      response.json({ samples: truncated ? archived.slice(-limit) : archived, from, to, truncated });
    });
  context.app.get(`${context.prefix}/houses/:id/thermal-simulation`, async (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      if (typeof request.query.sensorId !== "string" || !request.query.sensorId) {
        throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
      }
      const sensor = context.database.getSensor(request.query.sensorId);
      if (!sensor) throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
      if (sensor.houseId !== house.id) {
        throw new HttpError(409, "SENSOR_HOUSE_MISMATCH", "Sensor does not belong to the selected house");
      }
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 7 * 24 * 3_600_000), "from");
      if (Date.parse(from) >= Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      if (Date.parse(to) - Date.parse(from) > 14 * 24 * 3_600_000) {
        throw new HttpError(400, "RANGE_TOO_LARGE", "thermal calibration range cannot exceed 14 days");
      }
      const horizonHours = safeInteger(request.query.horizonHours, 12, 0, 72);
      const scenarioOutdoorTemperatureC = optionalQueryNumber(request.query.scenarioOutdoorTemperatureC, "scenarioOutdoorTemperatureC");
      const boundaryPaddingMs = 2 * 3_600_000;
      const abortController = new AbortController();
      const abortOnClose = () => abortController.abort();
      response.once("close", abortOnClose);
      const startedAt = performance.now();
      try {
        const simulation = await context.analyticsWorkLimiter.run("thermal-simulation", async () => {
          const [indoorRead, outdoorRead] = await Promise.all([
            context.telemetryReader.thermalMeasurementHistory({
              sensorId: sensor.id,
              metrics: ["temperature"],
              from,
              to,
              bucketMinutes: 5,
              limitPerMetric: 5_000,
              signal: abortController.signal,
            }),
            context.telemetryReader.outdoorTemperatureHistory({
              houseId: house.id,
              locationKey: outdoorLocationKey(house.location),
              from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
              to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
              limit: 50_000,
              signal: abortController.signal,
            }),
          ]);
          return runThermalSimulation({
            houseId: house.id,
            sensorId: sensor.id,
            roomLabel: sensor.room,
            from,
            to,
            indoorSamples: indoorRead.records,
            outdoorSamples: outdoorRead.records,
            horizonHours,
            scenarioOutdoorTemperatureC,
          });
        }, abortController.signal);
        if (abortController.signal.aborted) return;
        response.setHeader(
          "server-timing",
          `thermal-simulation;dur=${(performance.now() - startedAt).toFixed(1)}`,
        );
        response.json({ simulation });
      } finally {
        response.off("close", abortOnClose);
      }
    });
  context.app.get(`${context.prefix}/houses/:id/thermal-isolation`, async (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 7 * 24 * 3_600_000), "from");
      if (Date.parse(from) >= Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      if (Date.parse(to) - Date.parse(from) > 14 * 24 * 3_600_000) {
        throw new HttpError(400, "RANGE_TOO_LARGE", "thermal isolation range cannot exceed 14 days");
      }
      const sensorCandidates = context.database.listSensors(house.id)
        .filter((sensor) => sensor.enabled && context.visibility(response).sensor(sensor.id));
      const sensorsWithTemperatureHistory = new Set(
        (await context.telemetryReader.measurementCoverage({
          sensorIds: sensorCandidates.map((sensor) => sensor.id),
          metrics: ["temperature"],
        })).records
          .map((coverage) => coverage.sensorId),
      );
      const sensors = sensorCandidates.filter((sensor) =>
        isThermalIsolationTemperatureSensor(sensor, sensorsWithTemperatureHistory.has(sensor.id)));
      if (sensors.length > 64) {
        throw new HttpError(422, "THERMAL_SCOPE_TOO_LARGE", "thermal isolation comparison supports at most 64 temperature sensors per request");
      }
      const boundaryPaddingMs = 2 * 3_600_000;
      const abortController = new AbortController();
      const abortOnClose = () => abortController.abort();
      response.once("close", abortOnClose);
      const startedAt = performance.now();
      try {
        const isolation = await context.analyticsWorkLimiter.run("thermal-isolation", async () => {
          const [outdoorRead, indoorReads] = await Promise.all([
            context.telemetryReader.outdoorTemperatureHistory({
              houseId: house.id,
              locationKey: outdoorLocationKey(house.location),
              from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
              to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
              limit: 50_000,
              signal: abortController.signal,
            }),
            mapWithConcurrency(sensors, 2, (sensor) => (
              context.telemetryReader.thermalMeasurementHistory({
                sensorId: sensor.id,
                metrics: ["temperature"],
                from,
                to,
                bucketMinutes: 5,
                limitPerMetric: 5_000,
                signal: abortController.signal,
              })
            )),
          ]);
          const indoorSamplesBySensor = new Map(sensors.map((sensor, index) => [
            sensor.id,
            indoorReads[index]!.records,
          ]));
          return runThermalIsolationAsync({
            house,
            sensors,
            indoorSamplesBySensor,
            outdoorSamples: outdoorRead.records,
            from,
            to,
          }, { signal: abortController.signal });
        }, abortController.signal);
        if (abortController.signal.aborted) return;
        response.setHeader("cache-control", "no-store");
        response.setHeader(
          "server-timing",
          `thermal-isolation;dur=${(performance.now() - startedAt).toFixed(1)}`,
        );
        response.json({ isolation });
      } catch (error) {
        if (abortController.signal.aborted) return;
        throw error;
      } finally {
        response.off("close", abortOnClose);
      }
    });
  context.app.get(`${context.prefix}/houses/:id/moisture-response`, async (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 7 * 24 * 3_600_000), "from");
      if (Date.parse(from) >= Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      if (Date.parse(to) - Date.parse(from) > 14 * 24 * 3_600_000) {
        throw new HttpError(400, "RANGE_TOO_LARGE", "moisture response range cannot exceed 14 days");
      }
      const sensorCandidates = context.database.listSensors(house.id)
        .filter((sensor) => sensor.enabled && context.visibility(response).sensor(sensor.id));
      const coverage = (await context.telemetryReader.measurementCoverage({
        sensorIds: sensorCandidates.map((sensor) => sensor.id),
        metrics: ["temperature", "humidity"],
      })).records;
      const sensorsWithTemperature = new Set(
        coverage.filter((item) => item.metric === "temperature").map((item) => item.sensorId),
      );
      const sensorsWithHumidity = new Set(
        coverage.filter((item) => item.metric === "humidity").map((item) => item.sensorId),
      );
      const sensors = sensorCandidates.filter((sensor) => isMoistureResponseSensor(
        sensor,
        sensorsWithTemperature.has(sensor.id),
        sensorsWithHumidity.has(sensor.id),
      ));
      if (sensors.length > 64) {
        throw new HttpError(422, "MOISTURE_SCOPE_TOO_LARGE", "moisture response comparison supports at most 64 paired climate sensors per request");
      }
      const boundaryPaddingMs = 2 * 3_600_000;
      const abortController = new AbortController();
      const abortOnClose = () => abortController.abort();
      response.once("close", abortOnClose);
      const startedAt = performance.now();
      try {
        const moistureResponse = await context.analyticsWorkLimiter.run("moisture-response", async () => {
          const [outdoorRead, indoorReads] = await Promise.all([
            context.telemetryReader.outdoorTemperatureHistory({
              houseId: house.id,
              locationKey: outdoorLocationKey(house.location),
              from: new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
              to: new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
              limit: 50_000,
              signal: abortController.signal,
            }),
            mapWithConcurrency(sensors, 2, (sensor) => (
              context.telemetryReader.thermalMeasurementHistory({
                sensorId: sensor.id,
                metrics: ["temperature", "humidity"],
                from,
                to,
                bucketMinutes: 5,
                limitPerMetric: 5_000,
                signal: abortController.signal,
              })
            )),
          ]);
          const indoorSamplesBySensor = new Map(sensors.map((sensor, index) => [
            sensor.id,
            indoorReads[index]!.records,
          ]));
          return runMoistureResponseAsync({
            house,
            sensors,
            indoorSamplesBySensor,
            outdoorSamples: outdoorRead.records,
            from,
            to,
          }, { signal: abortController.signal });
        }, abortController.signal);
        if (abortController.signal.aborted) return;
        response.setHeader("cache-control", "no-store");
        response.setHeader(
          "server-timing",
          `moisture-response;dur=${(performance.now() - startedAt).toFixed(1)}`,
        );
        response.json({ moistureResponse });
      } catch (error) {
        if (abortController.signal.aborted) return;
        throw error;
      } finally {
        response.off("close", abortOnClose);
      }
    });
  context.app.patch(`${context.prefix}/houses/:id`, async (request, response) => {
      const houseId = request.params.id as string;
      const previous = context.database.getHouse(houseId);
      context.stuguby.assertHouseWriteAllowed(houseId);
      const body = bodyObject(request.body);
      const patch: {
        name?: string;
        timezone?: string;
        propertyId?: string;
        orientationDegrees?: number | null;
        floors?: Floor[];
        location?: HouseLocation | null;
        mapPlacement?: HouseMapPlacement | null;
      } = {};
      if (body.name !== undefined) patch.name = requiredString(body, "name");
      if (body.timezone !== undefined) patch.timezone = requiredString(body, "timezone");
      if (body.propertyId !== undefined) patch.propertyId = requiredString(body, "propertyId");
      if (body.location !== undefined) patch.location = houseLocationValue(body.location, true);
      if (body.mapPlacement !== undefined) patch.mapPlacement = houseMapPlacementValue(body.mapPlacement, true);
      if (body.orientationDegrees !== undefined) {
        patch.orientationDegrees = body.orientationDegrees === null ? null : requiredNumber(body, "orientationDegrees");
      }
      if (body.floors !== undefined) {
        if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
        patch.floors = body.floors as Floor[];
      }
      if (patch.propertyId !== undefined && patch.propertyId !== previous?.propertyId
        && previous?.stuguby?.ownership === "shared" && previous.stuguby.syncState !== "detached") {
        throw new HttpError(
          409,
          "STUGBY_HOME_PROPERTY_MANAGED",
          "A shared Home remains in its adopted Stuguby Property until permanent disconnect",
        );
      }
      if (patch.propertyId !== undefined && patch.propertyId !== previous?.propertyId && previous) {
        const sourceLink = context.database.getProperty(previous.propertyId)?.stuguby;
        const targetLink = context.database.getProperty(patch.propertyId)?.stuguby;
        if ((sourceLink && sourceLink.syncState !== "detached") || (targetLink && targetLink.syncState !== "detached")) {
          throw new HttpError(
            409,
            "STUGBY_PROPERTY_MIGRATION_REQUIRED",
            "Use the reviewed Stuguby Property migration to move a local Home into or out of an adopted Property",
          );
        }
      }
      if (patch.floors) context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, patch.floors);
      if (patch.location !== undefined) await context.requireArchivedBeforeCascade("house-location", houseId);
      const house = context.database.transaction(() => {
        const updated = context.database.updateHouse(houseId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(updated.id);
        return updated;
      });
      if (patch.floors !== undefined) context.homeAssistant.refreshMappings();
      if (previous) {
        const observedAt = new Date().toISOString();
        if (previous.propertyId !== house.propertyId) {
          context.notifySpatial((runtime) => {
            runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "ownership-changed", true);
            runtime.scheduler.wakeHouse(house.id, house.propertyId, observedAt, "ownership-changed");
          });
        } else if (patch.name !== undefined || patch.floors !== undefined || patch.location !== undefined
          || patch.mapPlacement !== undefined || patch.orientationDegrees !== undefined) {
          context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
            house.id,
            house.propertyId,
            observedAt,
            "property-context-changed",
          ));
        }
      }
      context.weather.invalidate(house.id);
      context.weatherEvents.invalidate(house.id);
      context.status.refreshWeatherConfiguration();
      response.json({ house });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
