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
import { configureApiPart12 } from "./part-12.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart13(context: ReturnType<typeof configureApiPart12>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.patch(`${context.prefix}/area-equipment/:id`, (request, response) => {
      const equipmentId = request.params.id as string;
      const previous = context.database.getAreaEquipment(equipmentId);
      if (!previous) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      const patch = parseAreaEquipmentPatch(request.body);
      if (patch.areaId) {
        const targetArea = context.database.getPropertyArea(patch.areaId);
        if (targetArea && targetArea.propertyId !== previous.propertyId) context.stuguby.assertPropertyWriteAllowed(targetArea.propertyId);
      }
      if (patch.houseId) {
        const targetHouse = context.database.getHouse(patch.houseId);
        if (targetHouse && targetHouse.propertyId !== previous.propertyId) {
          context.stuguby.assertPropertyWriteAllowed(targetHouse.propertyId);
        }
      }
      const equipment = context.database.updateAreaEquipment(equipmentId, patch);
      if (!equipment) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      if (previous.propertyId !== equipment.propertyId) {
        context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "equipment", equipment.id, "delete");
        context.stuguby.captureCurrentPropertyEntity(equipment.propertyId, "equipment", equipment.id, "upsert");
      } else {
        context.stuguby.captureCurrentPropertyEntity(equipment.propertyId, "equipment", equipment.id, "upsert", Object.keys(patch));
      }
      if (previous && (
        previous.propertyId !== equipment.propertyId
        || previous.areaId !== equipment.areaId
        || (previous.houseId ?? null) !== (equipment.houseId ?? null)
        || JSON.stringify(previous.location ?? null) !== JSON.stringify(equipment.location ?? null)
      )) {
        const observedAt = new Date().toISOString();
        context.notifySpatial((runtime) => {
          runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "ownership-changed", true);
          if (equipment.propertyId !== previous.propertyId) {
            runtime.scheduler.enqueueScope({ kind: "property", id: equipment.propertyId }, observedAt, "ownership-changed", true);
          }
        });
      }
      response.json({ equipment });
    });
  context.app.delete(`${context.prefix}/area-equipment/:id`, (request, response) => {
      const equipmentId = request.params.id as string;
      const previous = context.database.getAreaEquipment(equipmentId);
      if (previous) context.stuguby.assertPropertyWriteAllowed(previous.propertyId);
      if (!context.database.deleteAreaEquipment(equipmentId)) {
        throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      }
      if (previous) context.stuguby.captureCurrentPropertyEntity(previous.propertyId, "equipment", equipmentId, "delete");
      if (previous) context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: previous.propertyId },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/area-equipment/:equipmentId/attachments`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment || !context.visibility(response).equipment(equipment)) {
        throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      }
      response.json({ attachments: context.database.listEquipmentAttachments({ equipmentId }) });
    });
  context.app.post(`${context.prefix}/area-equipment/:equipmentId/attachments`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      const input = parseEquipmentAttachmentUpload(request.body);
      assertEquipmentAttachmentMediaType(input);
      const attachment = context.database.createEquipmentAttachment({
        equipmentId,
        kind: input.kind,
        name: input.name,
        mimeType: input.mimeType,
        data: equipmentAttachmentData(input),
      });
      response.status(201).json({
        attachment,
        url: `${context.prefix}/area-equipment/${encodeURIComponent(equipmentId)}/attachments/${attachment.id}`,
      });
    });
  context.app.get(`${context.prefix}/area-equipment/:equipmentId/attachments/:attachmentId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const attachment = context.database.getEquipmentAttachment(request.params.attachmentId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!attachment || attachment.equipmentId !== equipmentId
        || !equipment || !context.visibility(response).equipment(equipment)) {
        throw new HttpError(404, "NOT_FOUND", "Equipment attachment not found");
      }
      response.setHeader("content-type", attachment.mimeType);
      response.setHeader("content-length", String(attachment.size));
      response.setHeader("cache-control", "private, no-cache");
      response.setHeader("content-security-policy", "sandbox; default-src 'none'");
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("content-disposition", equipmentAttachmentDisposition(attachment.kind, attachment.name));
      response.send(Buffer.from(attachment.data));
    });
  context.app.delete(`${context.prefix}/area-equipment/:equipmentId/attachments/:attachmentId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const attachment = context.database.getEquipmentAttachment(request.params.attachmentId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!attachment || attachment.equipmentId !== equipmentId || !equipment) {
        throw new HttpError(404, "NOT_FOUND", "Equipment attachment not found");
      }
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      if (!context.database.deleteEquipmentAttachment(attachment.id)) {
        throw new HttpError(404, "NOT_FOUND", "Equipment attachment not found");
      }
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/area-equipment/:equipmentId/links`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment || !context.visibility(response).equipment(equipment)) {
        throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      }
      response.json({ links: context.database.listEquipmentLinks({ equipmentId }) });
    });
  context.app.post(`${context.prefix}/area-equipment/:equipmentId/links`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!equipment) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      const link = context.database.createEquipmentLink({
        equipmentId,
        ...parseEquipmentLinkInput(request.body),
      });
      response.status(201).json({ link });
    });
  context.app.patch(`${context.prefix}/area-equipment/:equipmentId/links/:linkId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const previous = context.database.getEquipmentLink(request.params.linkId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!previous || previous.equipmentId !== equipmentId || !equipment) {
        throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      }
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      const link = context.database.updateEquipmentLink(previous.id, parseEquipmentLinkPatch(request.body));
      if (!link) throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      response.json({ link });
    });
  context.app.delete(`${context.prefix}/area-equipment/:equipmentId/links/:linkId`, (request, response) => {
      const equipmentId = request.params.equipmentId as string;
      const link = context.database.getEquipmentLink(request.params.linkId as string);
      const equipment = context.database.getAreaEquipment(equipmentId);
      if (!link || link.equipmentId !== equipmentId || !equipment) {
        throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      }
      context.stuguby.assertPropertyWriteAllowed(equipment.propertyId);
      if (!context.database.deleteEquipmentLink(link.id)) {
        throw new HttpError(404, "NOT_FOUND", "Equipment link not found");
      }
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/property-notes`, (request, response) => {
      const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      const areaId = optionalResourceQuery(request.query.areaId, "areaId");
      const equipmentId = optionalResourceQuery(request.query.equipmentId, "equipmentId");
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      response.json({
        notes: visibleCollectionPage(
          (limit, offset) => context.database.listPropertyNotes({
            ...(propertyId ? { propertyId } : {}),
            ...(houseId ? { houseId } : {}),
            ...(areaId ? { areaId } : {}),
            ...(equipmentId ? { equipmentId } : {}),
            limit,
            offset,
          }),
          (note) => access.note(note),
          page,
        ),
      });
    });
  context.app.post(`${context.prefix}/property-notes`, (request, response) => {
      const input = parsePropertyNoteInput(request.body);
      if (input.houseId) context.stuguby.assertHouseWriteAllowed(input.houseId);
      else context.stuguby.assertPropertyWriteAllowed(input.propertyId);
      const note = context.database.createPropertyNote(input);
      const sharedHouse = note.houseId ? context.database.getHouse(note.houseId)?.stuguby : null;
      if (note.houseId && sharedHouse && sharedHouse.syncState !== "detached") context.stuguby.captureHomeMutation(note.houseId);
      else context.stuguby.captureCurrentPropertyEntity(note.propertyId, "note", note.id, "upsert");
      response.status(201).json({ note });
    });
  context.app.get(`${context.prefix}/property-notes/:id`, (request, response) => {
      const note = context.database.getPropertyNote(request.params.id as string);
      if (!note || !context.visibility(response).note(note)) throw new HttpError(404, "NOT_FOUND", "Property note not found");
      response.json({ note });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
