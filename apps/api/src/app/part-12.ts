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
import { configureApiPart11 } from "./part-11.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart12(context: ReturnType<typeof configureApiPart11>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/property-areas`, (request, response) => {
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      response.json({
        areas: visibleCollectionPage(
          (limit, offset) => context.database.listPropertyAreas(propertyId, limit, offset),
          (area) => access.area(area.id),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/property-areas`, (request, response) => {
      const input = parsePropertyAreaInput(request.body);
      context.stuguby.assertPropertyWriteAllowed(input.propertyId);
      const area = context.database.transaction(() => {
        const created = context.database.createPropertyArea(input);
        context.stuguby.captureCurrentPropertyEntity(created.propertyId, "area", created.id, "upsert");
        return created;
      });
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: area.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(201).json({ area });
    });
  context.app.get(`${context.prefix}/property-areas/:id`, (request, response) => {
      const area = context.database.getPropertyArea(request.params.id as string);
      if (!area || !context.visibility(response).area(area.id)) throw new HttpError(404, "NOT_FOUND", "Property area not found");
      response.json({ area });
    });
  context.app.patch(`${context.prefix}/property-areas/:id`, (request, response) => {
      const areaId = request.params.id as string;
      const previous = context.database.getPropertyArea(areaId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "Property area not found");
      context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      const patch = parsePropertyAreaPatch(request.body);
      if (patch.propertyId && patch.propertyId !== previous.propertyId) context.stuguby.assertPropertyWriteAllowed(patch.propertyId);
      const area = context.database.transaction(() => {
        const updated = context.database.updatePropertyArea(areaId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Property area not found");
        if (previous.propertyId !== updated.propertyId) {
          context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "area", updated.id, "delete");
          context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "area", updated.id, "upsert");
        } else {
          context.stuguby.captureCurrentPropertyEntity(updated.propertyId, "area", updated.id, "upsert",
            Object.keys(patch).filter((field) => field !== "propertyId"));
        }
        return updated;
      });
      if (previous) {
        const observedAt = new Date().toISOString();
        context.notifySpatial((runtime) => {
          runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "property-context-changed", true);
          if (previous.propertyId !== area.propertyId) {
            runtime.scheduler.enqueueScope({ kind: "property", id: area.propertyId }, observedAt, "ownership-changed", true);
          }
        });
      }
      response.json({ area });
    });
  context.app.delete(`${context.prefix}/property-areas/:id`, (request, response) => {
      const areaId = request.params.id as string;
      const previous = context.database.getPropertyArea(areaId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      context.database.transaction(() => {
        if (!context.database.deletePropertyArea(areaId)) {
          throw new HttpError(404, "NOT_FOUND", "Property area not found");
        }
        if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "area", areaId, "delete");
      });
      if (previous) context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: previous.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/properties/:propertyId/inventory`, (request, response) => {
      const propertyId = request.params.propertyId as string;
      const property = context.database.getProperty(propertyId);
      const access = context.visibility(response);
      if (!property || !access.property(property)) {
        throw new HttpError(404, "NOT_FOUND", "Property not found");
      }
      const areas = completeVisibleCollection(
        (limit, offset) => context.database.listPropertyAreas(propertyId, limit, offset),
        (area) => access.area(area.id),
      );
      const equipment = completeVisibleCollection(
        (limit, offset) => context.database.listAreaEquipment({ propertyId, limit, offset }),
        (item) => access.equipment(item),
      );
      const visibleEquipmentIds = new Set(equipment.map((item) => item.id));
      const attachments = context.database.listEquipmentAttachments({ propertyId })
        .filter((attachment) => visibleEquipmentIds.has(attachment.equipmentId));
      const links = context.database.listEquipmentLinks({ propertyId })
        .filter((link) => visibleEquipmentIds.has(link.equipmentId));
      const syncToken = createHash("sha256")
        .update(JSON.stringify({ propertyId, areas, equipment, attachments, links }))
        .digest("hex");
      const etag = `"${syncToken}"`;
      response.setHeader("cache-control", "private, no-cache");
      response.setHeader("etag", etag);
      if (request.header("if-none-match")?.split(",").some((value) => {
        const candidate = value.trim();
        return candidate === "*" || candidate.replace(/^W\//u, "") === etag;
      })) {
        response.status(304).end();
        return;
      }
      const inventory: PropertyInventorySnapshot = {
        propertyId,
        generatedAt: new Date().toISOString(),
        syncToken,
        areas,
        equipment,
        attachments,
        links,
      };
      response.json({ inventory });
    });
  context.app.get(`${context.prefix}/area-equipment`, (request, response) => {
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      const areaId = optionalResourceQuery(request.query.areaId, "areaId");
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      response.json({
        equipment: visibleCollectionPage(
          (limit, offset) => context.database.listAreaEquipment({
            ...(propertyId ? { propertyId } : {}),
            ...(areaId ? { areaId } : {}),
            ...(houseId ? { houseId } : {}),
            limit,
            offset,
          }),
          (equipment) => access.equipment(equipment),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/area-equipment`, (request, response) => {
      const input = parseAreaEquipmentInput(request.body);
      const area = input.areaId ? context.database.getPropertyArea(input.areaId) : null;
      const house = input.houseId ? context.database.getHouse(input.houseId) : null;
      const propertyId = area?.propertyId ?? house?.propertyId ?? input.propertyId;
      if (propertyId) context.stuguby.assertPropertyWriteAllowed(propertyId);
      const equipment = context.database.transaction(() => {
        const created = context.database.createAreaEquipment(input);
        context.stuguby.captureCurrentPropertyEntity(created.propertyId, "equipment", created.id, "upsert");
        return created;
      });
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: equipment.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(201).json({ equipment });
    });
  context.app.get(`${context.prefix}/area-equipment/:id`, (request, response) => {
      const equipment = context.database.getAreaEquipment(request.params.id as string);
      if (!equipment || !context.visibility(response).equipment(equipment)) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      response.json({ equipment });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
