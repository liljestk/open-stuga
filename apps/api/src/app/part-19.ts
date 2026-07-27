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
import { configureApiPart18 } from "./part-18.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart19(context: ReturnType<typeof configureApiPart18>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/ios-notification-registrations/:id`, (request, response) => {
      const id = request.params.id as string;
      if (!UUID_PATTERN.test(id)) {
        throw new HttpError(400, "INVALID_IOS_REGISTRATION_ID", "Notification registration id must be a UUID");
      }
      const principal = requestPrincipal(response);
      response.setHeader("cache-control", "no-store");
      response.json({
        configured: apnsConfigured(config),
        registration: context.database.getIOSNotificationRegistration(principal.userId, id),
      });
    });
  context.app.put(`${context.prefix}/ios-notification-registrations/:id`, (request, response) => {
      const id = request.params.id as string;
      if (!UUID_PATTERN.test(id)) {
        throw new HttpError(400, "INVALID_IOS_REGISTRATION_ID", "Notification registration id must be a UUID");
      }
      const body = bodyObject(request.body);
      const deviceToken = requiredString(body, "deviceToken").toLowerCase();
      if (!/^[a-f0-9]{64,200}$/u.test(deviceToken) || deviceToken.length % 2 !== 0) {
        throw new HttpError(400, "INVALID_IOS_DEVICE_TOKEN", "deviceToken must be an APNs hexadecimal device token");
      }
      if (!Array.isArray(body.homeIds) || body.homeIds.length > 100) {
        throw new HttpError(400, "INVALID_FIELD", "homeIds must be an array of at most 100 Home ids");
      }
      const homeIds = [...new Set(body.homeIds.map((value) => {
        if (typeof value !== "string" || !value.trim() || value.length > 200) {
          throw new HttpError(400, "INVALID_FIELD", "Every homeIds value must be a non-empty string of at most 200 characters");
        }
        return value.trim();
      }))];
      const access = context.visibility(response);
      for (const homeId of homeIds) {
        if (!context.database.getHouse(homeId) || !access.house(homeId)) {
          throw new HttpError(404, "NOT_FOUND", "Home not found");
        }
      }
      const principal = requestPrincipal(response);
      if (principal.bootstrap) {
        throw new HttpError(409, "ACCOUNT_REQUIRED", "Create and sign in to a local account before enabling notifications");
      }
      const registration = context.database.saveIOSNotificationRegistration(principal.userId, id, {
        deviceToken,
        environment: enumValue(body.environment, ["sandbox", "production"] as const, "environment"),
        homeIds,
        minimumSeverity: enumValue(
          body.minimumSeverity ?? "warning",
          ["info", "warning", "critical"] as const,
          "minimumSeverity",
        ),
        includeDetails: optionalBoolean(body, "includeDetails") ?? false,
      });
      response.setHeader("cache-control", "no-store");
      response.json({ configured: apnsConfigured(config), registration });
    });
  context.app.delete(`${context.prefix}/ios-notification-registrations/:id`, (request, response) => {
      const id = request.params.id as string;
      if (!UUID_PATTERN.test(id)) {
        throw new HttpError(400, "INVALID_IOS_REGISTRATION_ID", "Notification registration id must be a UUID");
      }
      context.database.deleteIOSNotificationRegistration(requestPrincipal(response).userId, id);
      response.setHeader("cache-control", "no-store");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/notification-deliveries`, (request, response) => {
      const access = context.visibility(response);
      const principal = requestPrincipal(response);
      const limit = safeInteger(request.query.limit, 200, 1, 500);
      const deliveries = context.database.listNotificationDeliveries(limit * 2).filter((delivery) => {
        if (!access.restricted) return true;
        if (delivery.subjectKind !== "alert") return false;
        const event = context.database.getAlertEvent(delivery.subjectId);
        if (!event || !access.sensor(event.sensorId)) return false;
        return delivery.channel !== "apns"
          || context.database.getIOSNotificationRegistration(
            principal.userId,
            delivery.destinationId,
          ) !== null;
      }).slice(0, limit);
      response.json({ deliveries });
    });
  context.app.post(`${context.prefix}/notification-deliveries/:id/retry`, requireWorkspaceAdmin, (request, response) => {
      if (!context.database.retryNotificationDelivery(request.params.id as string)) {
        throw new HttpError(409, "NOT_RETRYABLE", "Notification delivery is not dead-lettered or abandoned");
      }
      context.notificationOutbox.wake();
      const delivery = context.database.listNotificationDeliveries(500)
        .find((candidate) => candidate.id === request.params.id);
      response.json({ delivery });
    });
  context.app.get(`${context.prefix}/action-playbooks`, (request, response) => {
      const metric = typeof request.query.metric === "string" ? measurementId(request.query.metric) : undefined;
      response.json({ playbooks: context.database.listActionPlaybooks(metric, request.query.enabled === "true") });
    });
  context.app.post(`${context.prefix}/action-playbooks`, (request, response) => {
      response.status(201).json({ playbook: context.database.saveActionPlaybook(parseActionPlaybookInput(request.body) as ActionPlaybookInput) });
    });
  context.app.patch(`${context.prefix}/action-playbooks/:id`, (request, response) => {
      const playbook = context.database.updateActionPlaybook(
        request.params.id as string,
        parseActionPlaybookInput(request.body, true) as Partial<ActionPlaybookInput>,
      );
      if (!playbook) throw new HttpError(404, "NOT_FOUND", "Action playbook not found");
      response.json({ playbook });
    });
  context.app.get(`${context.prefix}/alerts/:id/action-playbooks`, (request, response) => {
      const event = context.database.getAlertEvent(request.params.id as string);
      if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      response.json({ playbooks: context.database.listActionPlaybooks(event.metric, true) });
    });
  context.app.get(`${context.prefix}/action-runs`, (request, response) => {
      const access = context.visibility(response);
      const houseId = optionalResourceQuery(request.query.houseId, "houseId");
      if (houseId) {
        const house = context.database.getHouse(houseId);
        if (!house || !access.house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      }
      response.json({ runs: context.database.listActionRuns({
        ...(houseId ? { houseId } : {}),
        ...(typeof request.query.sensorId === "string" ? { sensorId: request.query.sensorId } : {}),
        ...(typeof request.query.alertEventId === "string" ? { alertEventId: request.query.alertEventId } : {}),
        activeOnly: request.query.active === "true",
        limit: boundedQueryInteger(request.query.limit, "limit", 1, 500) ?? 500,
      }).filter((run) => access.sensor(run.sensorId)) });
    });
  context.app.post(`${context.prefix}/action-runs`, (request, response) => {
      const run = context.database.startActionRun(parseActionRunStart(request.body));
      context.bus.publish({ type: "mutation", data: { method: "POST", resource: `/action-runs/${run.id}`, occurredAt: run.createdAt } });
      response.status(201).json({ run });
    });
  context.app.post(`${context.prefix}/action-runs/:id/complete`, (request, response) => {
      const run = context.database.completeActionRun(request.params.id as string);
      if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
      response.json({ run });
    });
  context.app.post(`${context.prefix}/action-runs/:id/cancel`, (request, response) => {
      const body = request.body === undefined ? {} : bodyObject(request.body);
      const note = body.note === undefined || body.note === null ? null : requiredString(body, "note");
      const run = context.database.cancelActionRun(request.params.id as string, note);
      if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
      context.bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
      response.json({ run });
    });
  context.app.get(`${context.prefix}/data-export/preview`, (request, response) => {
      const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel");
      const includeTelemetry = request.query.includeTelemetry === "true";
      response.json({ preview: context.dataOperations.preview(privacyLevel, includeTelemetry) });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
