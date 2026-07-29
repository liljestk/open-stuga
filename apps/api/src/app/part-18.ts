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
import { configureApiPart17 } from "./part-17.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart18(context: ReturnType<typeof configureApiPart17>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.prefix}/readings`, async (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      const limit = safeInteger(request.query.limit, 2_000, 1, 50_000);
      const readings = (await context.telemetryReader.legacyReadingHistory({ sensorIds: selected, from, to, limit })).records;
      response.json({ readings });
    });
  context.app.get(`${context.prefix}/history`, async (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
      const bucketSeconds = boundedQueryInteger(request.query.bucketSeconds, "bucketSeconds", 1, 86_400);
      const rawLimit = bucketSeconds === null ? limit + 1 : 100_000;
      const archived = (await context.telemetryReader.legacyReadingHistory({ sensorIds: selected, from, to, limit: rawLimit })).records;
      const requestedReadings = bucketSeconds === null ? archived : bucketLegacyReadings(archived, bucketSeconds);
      const truncated = requestedReadings.length > limit || (bucketSeconds !== null && archived.length === rawLimit);
      const readings = truncated ? requestedReadings.slice(-limit) : requestedReadings;
      const forecastHours = safeInteger(request.query.forecastHours, 0, 0, 168);
      const series = await Promise.all(selected.map(async (sensorId) => ({
        sensorId,
        readings: readings.filter((reading) => reading.sensorId === sensorId),
        forecast: forecastHours
          ? await forecast(context.database, sensorId, forecastHours, context.telemetryReader)
          : [],
      })));
      response.json({ from, to, bucketSeconds, series, truncated });
    });
  context.app.get(`${context.prefix}/forecast`, async (request, response) => {
      const sensorIds = queryList(request.query.sensorId);
      const access = context.visibility(response);
      const selected = (sensorIds.length ? sensorIds : context.database.listSensors().map((sensor) => sensor.id))
        .filter((sensorId) => access.sensor(sensorId));
      const horizonMinutes = safeInteger(request.query.horizonMinutes, 0, 0, 10_080);
      const hours = horizonMinutes > 0 ? Math.max(1, Math.ceil(horizonMinutes / 60)) : safeInteger(request.query.hours, 12, 1, 168);
      const series = await Promise.all(selected.map(async (sensorId) => ({
        sensorId,
        forecast: await forecast(context.database, sensorId, hours, context.telemetryReader),
      })));
      response.json({ generatedAt: new Date().toISOString(), model: "linear-v1", series, ...(series.length === 1 ? { forecast: series[0]?.forecast ?? [] } : {}) });
    });
  const streamTelemetry = (request: Request, response: Response): void => {
      if (context.rejectEventStreamDuringShutdown(response)) return;
      const filter = new Set(queryList(request.query.sensorId));
      const releaseStream = context.acquireEventStream(response);
      if (!releaseStream) {
        response.setHeader("retry-after", "5");
        throw new HttpError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
      }
      const acceptedAuthorization = localAuthorizationFingerprint(requestPrincipal(response));
      response.status(200);
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.flushHeaders();
      const writer = boundedSseWriter(response);
      const write = (event: TelemetryEvent): void => {
        if (response.destroyed || response.writableEnded) return;
        const access = context.authorizedStreamVisibility(request, response, acceptedAuthorization);
        if (!access) return;
        if (access.restricted && event.type === "integration") return;
        if ((event.type === "reading" || event.type === "measurement" || event.type === "alert")
          && !access.sensor(event.data.sensorId)) return;
        if (event.type === "weather" && !access.house(event.data.houseId)) return;
        if (event.type === "opening" && !access.house(event.data.houseId)) return;
        if (event.type === "heat-pump" && !access.house(event.data.houseId)) return;
        if (filter.size > 0 && (event.type === "reading" || event.type === "alert")) {
          const data = event.data as Reading | { sensorId: string };
          if (!filter.has(data.sensorId)) return;
        }
        const id = event.type === "weather" ? `id: ${event.data.id}\n` : "";
        writer.send(`${id}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      };
      if (!context.visibility(response).restricted) write({ type: "integration", data: structuredClone(context.status.value) });
      const unsubscribe = context.bus.subscribe(write);
      const heartbeat = setInterval(() => write({ type: "heartbeat", data: { timestamp: new Date().toISOString() } }), 15_000);
      heartbeat.unref();
      context.registerEventStream(
        request,
        response,
        () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
        releaseStream,
      );
    };
  context.app.get(`${context.prefix}/stream`, streamTelemetry);
  context.app.get(`${context.prefix}/events`, streamTelemetry);
  context.app.get(`${context.prefix}/alert-rules`, (_request, response) => {
      const access = context.visibility(response);
      response.json({ rules: context.database.listAlertRules().filter((rule) => (
        !access.restricted || (rule.sensorId !== null && access.sensor(rule.sensorId))
      )) });
    });
  context.app.post(`${context.prefix}/alert-rules`, (request, response) => {
      const input = parseAlertRule(request.body, context.database);
      const sensor = input.sensorId ? context.database.getSensor(input.sensorId) : null;
      if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      response.status(201).json(context.database.saveAlertRule(input));
    });
  context.app.patch(`${context.prefix}/alert-rules/:id`, (request, response) => {
      const current = context.database.getAlertRule(request.params.id as string);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
      const currentSensor = current.sensorId ? context.database.getSensor(current.sensorId) : null;
      if (currentSensor) context.stuguby.assertHouseLocalAuthority(currentSensor.houseId);
      const body = bodyObject(request.body);
      if (body.sensorId !== undefined && body.sensorId !== null) {
        const nextSensor = context.database.getSensor(requiredString(body, "sensorId"));
        if (nextSensor) context.stuguby.assertHouseLocalAuthority(nextSensor.houseId);
      }
      const rule = context.database.updateAlertRule(current.id, {
        ...(body.name !== undefined ? { name: requiredString(body, "name") } : {}),
        ...(body.sensorId !== undefined ? { sensorId: body.sensorId === null ? null : requiredString(body, "sensorId") } : {}),
        ...(body.metric !== undefined ? { metric: (() => {
          const metric = measurementId(body.metric);
          if (!context.database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
          return metric;
        })() } : {}),
        ...(body.operator !== undefined ? { operator: enumValue(body.operator, ["gt", "gte", "lt", "lte"] as const, "operator") } : {}),
        ...(body.threshold !== undefined ? { threshold: requiredNumber(body, "threshold") } : {}),
        ...(body.durationSeconds !== undefined ? { durationSeconds: alertDurationSeconds(body.durationSeconds) } : {}),
        ...(body.severity !== undefined ? { severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity") } : {}),
        ...(body.enabled !== undefined ? { enabled: optionalBoolean(body, "enabled") as boolean } : {}),
        ...(body.webhookEnabled !== undefined ? { webhookEnabled: optionalBoolean(body, "webhookEnabled") as boolean } : {}),
        ...(body.telegramEnabled !== undefined ? { telegramEnabled: optionalBoolean(body, "telegramEnabled") as boolean } : {}),
        ...(body.deliveryPolicy !== undefined ? { deliveryPolicy: parseAlertDeliveryPolicy(
          body.deliveryPolicy,
          current.sensorId ? context.database.getHouse(context.database.getSensor(current.sensorId)?.houseId ?? "")?.timezone ?? "UTC" : "UTC",
        ) } : {}),
      });
      response.json({ rule });
    });
  context.app.delete(`${context.prefix}/alert-rules/:id`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAlertRule(id);
      const sensor = current?.sensorId ? context.database.getSensor(current.sensorId) : null;
      if (sensor) context.stuguby.assertHouseLocalAuthority(sensor.houseId);
      if (!context.database.deleteAlertRule(id)) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/alert-events`, (request, response) => {
      const activeOnly = request.query.active === "true";
      const access = context.visibility(response);
      const limit = safeInteger(request.query.limit, 200, 1, 1_000);
      response.json({ events: visibleCollectionPage(
        (batchLimit, offset) => context.database.listAlertEvents(batchLimit, activeOnly, offset),
        (event) => access.sensor(event.sensorId),
        { limit, offset: 0 },
      ) });
    });
  context.app.get(`${context.prefix}/alerts`, (request, response) => {
      const activeOnly = request.query.active === "true";
      const access = context.visibility(response);
      const limit = safeInteger(request.query.limit, 200, 1, 1_000);
      response.json({ alerts: visibleCollectionPage(
        (batchLimit, offset) => context.database.listAlertEvents(batchLimit, activeOnly, offset),
        (event) => access.sensor(event.sensorId),
        { limit, offset: 0 },
      ) });
    });
  context.app.post(`${context.prefix}/alert-events/:id/acknowledge`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAlertEvent(id);
      if (!current || !context.visibility(response).sensor(current.sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      }
      const event = context.database.acknowledgeAlert(id, new Date().toISOString());
      if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      context.bus.publish({ type: "alert", data: event });
      response.json({ event });
    });
  context.app.post(`${context.prefix}/alerts/:id/acknowledge`, (request, response) => {
      const id = request.params.id as string;
      const current = context.database.getAlertEvent(id);
      if (!current || !context.visibility(response).sensor(current.sensorId)) {
        throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      }
      const event = context.database.acknowledgeAlert(id, new Date().toISOString());
      if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
      context.bus.publish({ type: "alert", data: event });
      response.json(event);
    });
  const extended = Object.assign(context, { streamTelemetry });
  return extended;
}
