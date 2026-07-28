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
import { configureApiPart15 } from "./part-15.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart16(context: ReturnType<typeof configureApiPart15>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.put(`${context.prefix}/houses/:id/layout`, (request, response) => {
      const houseId = request.params.id as string;
      context.stuguby.assertHouseWriteAllowed(houseId);
      const body = bodyObject(request.body);
      if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
      context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(houseId, body.floors as Floor[]);
      const house = context.database.transaction(() => {
        const updated = context.database.updateHouse(houseId, { floors: body.floors as Floor[] });
        if (!updated) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(updated.id);
        return updated;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        house.id,
        house.propertyId,
        new Date().toISOString(),
        "property-context-changed",
      ));
      response.json({ house });
    });
  context.app.put(`${context.prefix}/houses/:id/floors/:floorId`, (request, response) => {
      const house = context.database.getHouse(request.params.id as string);
      if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseWriteAllowed(house.id);
      const floor = bodyObject(request.body) as unknown as Floor;
      if (typeof floor.id !== "string" || floor.id !== request.params.floorId) throw new HttpError(400, "INVALID_FIELD", "Floor id must match the route");
      const index = house.floors.findIndex((candidate) => candidate.id === floor.id);
      if (index < 0) throw new HttpError(404, "NOT_FOUND", "Floor not found");
      const floors = house.floors.slice();
      floors[index] = floor;
      context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(house.id, floors);
      const updated = context.database.transaction(() => {
        const saved = context.database.updateHouse(house.id, { floors });
        if (!saved) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(saved.id);
        return saved;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        updated.id,
        updated.propertyId,
        new Date().toISOString(),
        "property-context-changed",
      ));
      response.json(floor);
    });
  context.app.post(`${context.prefix}/houses/:id/floors/:floorId/roomplan-import`, (request, response) => {
      const houseId = request.params.id as string;
      const floorId = request.params.floorId as string;
      const house = context.database.getHouse(houseId);
      if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseWriteAllowed(house.id);
      const body = bodyObject(request.body);
      const assertOnlyFields = (
        value: Record<string, unknown>,
        allowed: readonly string[],
        context: string,
      ): void => {
        const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
        if (unexpected) {
          throw new HttpError(
            400,
            "ROOMPLAN_PAYLOAD_NOT_ACCEPTED",
            `${context} contains unsupported field ${unexpected}`,
          );
        }
      };
      assertOnlyFields(
        body,
        ["source", "capturedAt", "expectedHouseUpdatedAt", "floor"],
        "RoomPlan import",
      );
      const expectedHouseUpdatedAt = requiredString(body, "expectedHouseUpdatedAt");
      if (house.updatedAt !== expectedHouseUpdatedAt) {
        throw new HttpError(
          409,
          "ROOMPLAN_STALE_HOME",
          "The Home changed after this scan started. Refresh and review the floor again",
        );
      }
      if (body.source !== "apple-roomplan") {
        throw new HttpError(400, "INVALID_FIELD", "source must be apple-roomplan");
      }
      const capturedAt = requiredString(body, "capturedAt");
      if (!Number.isFinite(Date.parse(capturedAt))) {
        throw new HttpError(400, "INVALID_FIELD", "capturedAt must be an ISO timestamp");
      }
      const floorObject = bodyObject(body.floor);
      const floor = floorObject as unknown as Floor;
      if (typeof floor.id !== "string" || floor.id !== floorId) {
        throw new HttpError(400, "INVALID_FIELD", "Floor id must match the route");
      }
      if (floor.backgroundImage !== undefined) {
        throw new HttpError(
          400,
          "ROOMPLAN_IMAGE_NOT_ACCEPTED",
          "RoomPlan imports accept derived geometry only, not images",
        );
      }
      assertOnlyFields(
        floorObject,
        [
          "id", "name", "type", "width", "height", "metersPerPlanUnit",
          "elevation", "ceilingHeight", "wallHeight", "roof", "walls",
          "rooms", "planElements",
        ],
        "RoomPlan floor",
      );
      if (floor.metersPerPlanUnit !== 1) {
        throw new HttpError(
          400,
          "ROOMPLAN_SCALE_INVALID",
          "RoomPlan geometry must use metres as floor-plan units",
        );
      }
      if (!Array.isArray(floor.rooms) || floor.rooms.length !== 1
        || !Array.isArray(floor.walls) || floor.walls.length < 2 || floor.walls.length > 1_000
        || (floor.planElements?.length ?? 0) > 1_000) {
        throw new HttpError(
          400,
          "ROOMPLAN_GEOMETRY_INVALID",
          "RoomPlan imports require one room, 2-1000 walls, and at most 1000 openings",
        );
      }
      for (const [wallIndex, wallValue] of floor.walls.entries()) {
        const wall = bodyObject(wallValue);
        assertOnlyFields(wall, ["id", "from", "to"], `RoomPlan wall ${wallIndex}`);
        assertOnlyFields(bodyObject(wall.from), ["x", "y"], `RoomPlan wall ${wallIndex} start`);
        assertOnlyFields(bodyObject(wall.to), ["x", "y"], `RoomPlan wall ${wallIndex} end`);
      }
      for (const [roomIndex, roomValue] of floor.rooms.entries()) {
        const room = bodyObject(roomValue);
        assertOnlyFields(room, ["id", "name", "kind", "points"], `RoomPlan room ${roomIndex}`);
        if (Array.isArray(room.points)) {
          for (const [pointIndex, pointValue] of room.points.entries()) {
            assertOnlyFields(
              bodyObject(pointValue),
              ["x", "y"],
              `RoomPlan room ${roomIndex} point ${pointIndex}`,
            );
          }
        }
      }
      if (Array.isArray(floor.planElements)) {
        for (const [elementIndex, elementValue] of floor.planElements.entries()) {
          const element = bodyObject(elementValue);
          assertOnlyFields(
            element,
            [
              "id", "kind", "position", "rotationDegrees", "width", "height",
              "label", "wallId", "variant", "state", "openFraction",
              "bottomOffsetM",
            ],
            `RoomPlan opening ${elementIndex}`,
          );
          assertOnlyFields(
            bodyObject(element.position),
            ["x", "y"],
            `RoomPlan opening ${elementIndex} position`,
          );
        }
      }
      if (floor.roof !== undefined) {
        assertOnlyFields(
          bodyObject(floor.roof),
          ["style", "pitchDegrees", "ridgeAxis", "overhang", "eavesHeight"],
          "RoomPlan floor roof",
        );
      }
      const index = house.floors.findIndex((candidate) => candidate.id === floor.id);
      if (index < 0) throw new HttpError(404, "NOT_FOUND", "Floor not found");
      const floors = house.floors.slice();
      floors[index] = floor;
      context.stuguby.assertSharedHouseFloorPlanAssetsUnchanged(house.id, floors);
      const updated = context.database.transaction(() => {
        const saved = context.database.updateHouse(house.id, { floors });
        if (!saved) throw new HttpError(404, "NOT_FOUND", "House not found");
        context.stuguby.captureHomeMutation(saved.id);
        return saved;
      });
      context.homeAssistant.refreshMappings();
      context.notifySpatial((runtime) => runtime.scheduler.wakeHouse(
        updated.id,
        updated.propertyId,
        new Date().toISOString(),
        "property-context-changed",
      ));
      response.json({ house: updated, floor: updated.floors[index] });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
