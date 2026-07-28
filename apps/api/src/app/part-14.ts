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
import { configureApiPart13 } from "./part-13.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart14(context: ReturnType<typeof configureApiPart13>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.patch(`${context.prefix}/property-notes/:id`, (request, response) => {
      const noteId = request.params.id as string;
      const previous = context.database.getPropertyNote(noteId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "Property note not found");
      const patch = parsePropertyNotePatch(request.body);
      const targetHouseId = patch.houseId === undefined ? previous.houseId : patch.houseId;
      if (previous.houseId) context.stuguby.assertHouseWriteAllowed(previous.houseId);
      else context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      if (targetHouseId !== previous.houseId) {
        if (targetHouseId) context.stuguby.assertHouseWriteAllowed(targetHouseId);
        else context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      }
      const note = context.database.transaction(() => {
        const updated = context.database.updatePropertyNote(noteId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Property note not found");
        if (previous.houseId !== updated.houseId) {
          const previousSharedHouse = previous.houseId ? context.database.getHouse(previous.houseId)?.stuguby : null;
          if (previous.houseId && previousSharedHouse && previousSharedHouse.syncState !== "detached") {
            context.stuguby.captureHomeMutation(previous.houseId);
          } else {
            context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "note", updated.id, "delete");
          }
        }
        const sharedHouse = updated.houseId ? context.database.getHouse(updated.houseId)?.stuguby : null;
        if (updated.houseId && sharedHouse && sharedHouse.syncState !== "detached") context.stuguby.captureHomeMutation(updated.houseId);
        else context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "note", updated.id, "upsert", Object.keys(patch));
        return updated;
      });
      response.json({ note });
    });
  context.app.delete(`${context.prefix}/property-notes/:id`, (request, response) => {
      const noteId = request.params.id as string;
      const previous = context.database.getPropertyNote(noteId);
      if (previous?.houseId) context.stuguby.assertHouseWriteAllowed(previous.houseId);
      else if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      context.database.transaction(() => {
        if (!context.database.deletePropertyNote(noteId)) {
          throw new HttpError(404, "NOT_FOUND", "Property note not found");
        }
        const sharedHouse = previous?.houseId ? context.database.getHouse(previous.houseId)?.stuguby : null;
        if (previous?.houseId && sharedHouse && sharedHouse.syncState !== "detached") context.stuguby.captureHomeMutation(previous.houseId);
        else if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "note", noteId, "delete");
      });
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/houses`, (request, response) => {
      const access = context.visibility(response);
      response.json({
        houses: context.database.listHouses(optionalResourceQuery(request.query.propertyId, "propertyId"))
          .filter((house) => access.house(house.id)),
      });
    });
  context.app.post(`${context.prefix}/houses`, (request, response) => {
      const body = bodyObject(request.body);
      if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
      const targetPropertyId = body.propertyId !== undefined ? requiredString(body, "propertyId") : undefined;
      const propertyCandidates = targetPropertyId ? [] : context.database.listProperties(2, 0);
      const inferredPropertyId = targetPropertyId ?? (propertyCandidates.length === 1 ? propertyCandidates[0]!.id : undefined);
      if (inferredPropertyId) context.stuguby.assertPropertyWriteAllowed(inferredPropertyId);
      let house = context.database.createHouse({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(targetPropertyId ? { propertyId: targetPropertyId } : {}),
        name: requiredString(body, "name"),
        timezone: requiredString(body, "timezone"),
        ...(body.location !== undefined ? { location: houseLocationValue(body.location) } : {}),
        ...(body.mapPlacement !== undefined ? { mapPlacement: houseMapPlacementValue(body.mapPlacement) } : {}),
        ...(body.orientationDegrees !== undefined ? { orientationDegrees: requiredNumber(body, "orientationDegrees") } : {}),
        floors: body.floors as Floor[],
      });
      house = context.stuguby.markLocalHouseInAdoptedProperty(house.id);
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        house.id,
        house.propertyId,
        new Date().toISOString(),
        "ownership-changed",
      ));
      context.status.refreshWeatherConfiguration();
      response.status(201).json({ house });
    });
  context.app.get(`${context.prefix}/houses/:id`, (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house || !context.visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
      response.json({ house });
    });
  context.app.get(`${context.prefix}/houses/:id/opening-states`, async (request, response) => {
      const houseId = request.params.id as string;
      const house = context.database.getHouse(houseId);
      if (!house || !context.visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      const at = request.query.at === undefined && request.query.to !== undefined
        ? dateValue(request.query.to, new Date(), "to")
        : dateValue(request.query.at, new Date(), "at");
      const observations = (await context.telemetryReader.openingStateSnapshot({
        houseId,
        at,
        limit: 10_000,
      })).records;
      const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
        if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
        return [{ floorId: floor.id, elementId: element.id, kind: element.kind, ...(element.label ? { label: element.label } : {}),
          ...resolvePlanElementOpeningState(element, observations.filter((observation) => observation.floorId === floor.id), at) }];
      }));
      if (request.query.from === undefined) {
        response.json({ snapshot: { houseId, at, states }, observations });
        return;
      }
      const from = dateValue(request.query.from, new Date(Date.parse(at) - 7 * 86_400_000), "from");
      const to = dateValue(request.query.to, new Date(at), "to");
      const durationMs = Date.parse(to) - Date.parse(from);
      if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
        throw new HttpError(400, "INVALID_OPENING_HISTORY_RANGE", "Opening-state history must cover more than zero and at most 366 days");
      }
      const limit = boundedQueryInteger(request.query.limit, "limit", 1, 10_000) ?? 10_000;
      // Seed the requested interval with the effective candidates at its leading
      // edge so clients can distinguish a real closed-to-open transition from a
      // startup heartbeat whose previous state lies just outside the range.
      const initial = (await context.telemetryReader.openingStateSnapshot({
        houseId,
        at: from,
        limit,
      })).records;
      const history = (await context.telemetryReader.openingStateHistory({
        houseId,
        from,
        to,
        limit: Math.max(1, limit - Math.min(initial.length, limit - 1)),
      })).records;
      const mergedHistory = [...new Map([...initial, ...history].map((observation) => [observation.id, observation])).values()]
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.id.localeCompare(right.id))
        .slice(-limit);
      response.json({ snapshot: { houseId, at, states }, observations, history: mergedHistory, from, to });
    });
  context.app.post(`${context.prefix}/houses/:id/opening-states`, (request, response) => {
      const houseId = request.params.id as string;
      const house = context.database.getHouse(houseId);
      if (!house || !context.visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const body = bodyObject(request.body);
      const source = body.source === undefined ? "api" : requiredString(body, "source");
      if (source !== "api" && source !== "manual") {
        throw new HttpError(400, "INVALID_FIELD", "REST callers may record only api or manual opening-state provenance; Home Assistant and Tapo provenance is adapter-managed");
      }
      const input: OpeningStateObservationInput = {
        ...(body.id !== undefined ? { id: requiredString(body, "id") } : {}),
        floorId: requiredString(body, "floorId"),
        elementId: requiredString(body, "elementId"),
        state: requiredString(body, "state") as OpeningStateObservationInput["state"],
        ...(body.openFraction !== undefined ? { openFraction: requiredNumber(body, "openFraction") } : {}),
        source,
        observedAt: body.observedAt === undefined ? new Date().toISOString() : requiredString(body, "observedAt"),
        ...(body.validUntil !== undefined ? { validUntil: requiredString(body, "validUntil") } : {}),
        ...(body.externalId !== undefined ? { externalId: requiredString(body, "externalId") } : {}),
      };
      const observation = context.database.recordOpeningStateObservation(houseId, input);
      context.notifyOpeningStateRecorded(observation);
      response.status(201).json({ observation });
    });
  context.app.get(`${context.prefix}/houses/:id/electricity-price`, async (request, response) => {
      const houseId = request.params.id as string;
      const house = context.database.getHouse(houseId);
      if (!house || !context.visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      const propertyPrice = context.database.getCurrentPropertyElectricityPrice(house.propertyId);
      const homePrice = (price: NonNullable<typeof propertyPrice>): HomeElectricityPricePoint => ({
        startAt: price.startAt,
        endAt: price.endAt,
        effectivePriceCentsPerKwh: price.effectivePriceCentsPerKwh,
        effectivePriceEurPerKwh: price.effectivePriceEurPerKwh,
        fetchedAt: price.fetchedAt,
      });
      const current = propertyPrice ? homePrice(propertyPrice) : null;
      const historyRequested = request.query.from !== undefined || request.query.to !== undefined;
      if (!historyRequested) {
        response.json({ current });
        return;
      }
      const from = dateValue(request.query.from, new Date(Date.now() - 24 * 60 * 60_000), "from");
      const to = dateValue(request.query.to, new Date(Date.now() + 48 * 60 * 60_000), "to");
      const history = await context.telemetryReader.electricityPriceHistory({
        propertyId: house.propertyId,
        from,
        to,
        limit: 100_000,
      });
      const prices = history.records.map(homePrice);
      response.json({ current, prices });
    });
  context.app.get(`${context.prefix}/houses/:id/energy-cost`, async (request, response) => {
      const houseId = request.params.id as string;
      const house = context.database.getHouse(houseId);
      if (!house || !context.visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      const sensorId = optionalResourceQuery(request.query.sensorId, "sensorId");
      if (!sensorId) throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
      const sensor = context.database.getSensor(sensorId);
      if (!sensor || sensor.houseId !== houseId || !context.visibility(response).sensor(sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Energy sensor not found");
      }
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 30 * 86_400_000), "from");
      const durationMs = Date.parse(to) - Date.parse(from);
      if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
        throw new HttpError(400, "INVALID_ENERGY_COST_RANGE", "Energy cost range must be greater than zero and at most 366 days");
      }
      response.setHeader("cache-control", "no-store");
      response.json({ cost: await context.energyCost.calculate({
        houseId,
        propertyId: house.propertyId,
        sensorId,
        from,
        to,
      }) });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
