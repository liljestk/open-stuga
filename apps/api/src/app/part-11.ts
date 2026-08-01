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
import { configureApiPart10 } from "./part-10.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart11(context: ReturnType<typeof configureApiPart10>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.get(`${context.v2Prefix}/measurements/history`, async (request, response) => {
      if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
      if (!context.database.getSensor(request.query.sensorId) || !context.visibility(response).sensor(request.query.sensorId)) {
        throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
      }
      const metric = measurementId(request.query.metric);
      if (!context.database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
      const to = dateValue(request.query.to, new Date(), "to");
      const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
      if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
      const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
      const bucketSeconds = boundedQueryInteger(request.query.bucketSeconds, "bucketSeconds", 1, 86_400);
      const rawLimit = bucketSeconds === null ? limit + 1 : 100_000;
      const archived = (await context.telemetryReader.measurementHistory({
        sensorId: request.query.sensorId,
        metric,
        from,
        to,
        limit: rawLimit,
      })).records;
      const requestedSamples = bucketSeconds === null ? archived : bucketMeasurementSamples(archived, bucketSeconds);
      const truncated = requestedSamples.length > limit || (bucketSeconds !== null && archived.length === rawLimit);
      const samples = truncated ? requestedSamples.slice(-limit) : requestedSamples;
      response.json({ samples, from, to, bucketSeconds, truncated });
    });
  context.app.get(`${context.v2Prefix}/sensors/:id/measurements`, (request, response) => {
      if (!context.database.getSensor(request.params.id) || !context.visibility(response).sensor(request.params.id)) {
        throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
      }
      const limit = safeInteger(request.query.limit, 100, 1, 500);
      let before: { timestamp: string; id: number } | null = null;
      if (typeof request.query.cursor === "string" && request.query.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(request.query.cursor, "base64url").toString("utf8")) as unknown;
          if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string"
            || !Number.isSafeInteger(decoded[1]) || !Number.isFinite(Date.parse(decoded[0]))) throw new Error();
          before = { timestamp: new Date(decoded[0]).toISOString(), id: decoded[1] as number };
        } catch {
          throw new HttpError(400, "INVALID_CURSOR", "cursor is invalid");
        }
      }
      response.json(context.database.sensorMeasurementPage(request.params.id, before, limit));
    });
  context.app.get(`${context.v2Prefix}/measurements/forecast`, async (request, response) => {
      if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
      if (!context.database.getSensor(request.query.sensorId) || !context.visibility(response).sensor(request.query.sensorId)) {
        throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
      }
      const metric = measurementId(request.query.metric);
      const hours = safeInteger(request.query.hours, 12, 1, 168);
      response.json({
        forecast: await forecastMeasurement(
          context.database,
          request.query.sensorId,
          metric,
          hours,
          context.telemetryReader,
        ),
      });
    });
  context.app.get(`${context.v2Prefix}/measurements/events`, (request, response) => {
      if (context.rejectEventStreamDuringShutdown(response)) return;
      const sensorFilter = new Set(queryList(request.query.sensorId));
      const metricFilter = new Set(queryList(request.query.metric));
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
      writer.send(": connected\n\n");
      const write = (sample: MeasurementSample): void => {
        if (response.destroyed || response.writableEnded) return;
        const access = context.authorizedStreamVisibility(request, response, acceptedAuthorization);
        if (!access) return;
        if (!access.sensor(sample.sensorId)) return;
        if (sensorFilter.size > 0 && !sensorFilter.has(sample.sensorId)) return;
        if (metricFilter.size > 0 && !metricFilter.has(sample.metric)) return;
        writer.send(`event: measurement\ndata: ${JSON.stringify(sample)}\n\n`);
      };
      const unsubscribe = context.bus.subscribeMeasurements(write);
      const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) {
          if (!context.authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
          writer.send(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
        }
      }, 15_000);
      heartbeat.unref();
      context.registerEventStream(
        request,
        response,
        () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
        releaseStream,
      );
    });
  context.app.get(`${context.prefix}/properties`, (request, response) => {
      const page = collectionPage(request.query);
      const access = context.visibility(response);
      const properties = visibleCollectionPage(
        (limit, offset) => context.database.listProperties(limit, offset),
        (property) => access.property(property) !== null,
        page,
      ).map((property) => access.property(property) as Property);
      response.json({ properties });
    });
  context.app.post(`${context.prefix}/properties`, (request, response) => {
      const property = context.database.createProperty(parsePropertyInput(request.body));
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: property.id },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.status(201).json({ property });
    });
  context.app.get(`${context.prefix}/properties/:id`, (request, response) => {
      const candidate = context.database.getProperty(request.params.id as string);
      const property = candidate ? context.visibility(response).property(candidate) : null;
      if (!property) throw new HttpError(404, "NOT_FOUND", "Property not found");
      response.json({ property });
    });
  context.app.patch(`${context.prefix}/properties/:id`, (request, response) => {
      const propertyId = request.params.id as string;
      context.stuguby.assertPropertyWriteAllowed(propertyId);
      const patch = parsePropertyPatch(request.body);
      const property = context.database.transaction(() => {
        const updated = context.database.updateProperty(propertyId, patch);
        if (!updated) throw new HttpError(404, "NOT_FOUND", "Property not found");
        context.stuguby.captureCurrentPropertyEntity(updated.id, "property", updated.id, "upsert", Object.keys(patch));
        return updated;
      });
      context.notifySpatial((runtime) => runtime.scheduler.enqueueScope(
        { kind: "property", id: property.id },
        new Date().toISOString(),
        "property-context-changed",
        true,
      ));
      response.json({ property });
    });
  context.app.delete(`${context.prefix}/properties/:id`, async (request, response) => {
      const propertyId = request.params.id as string;
      const property = context.database.getProperty(propertyId);
      if (property?.stuguby && property.stuguby.syncState !== "detached") {
        throw new HttpError(409, "STUGBY_DISCONNECT_REQUIRED", "Disconnect the Stuguby Property explicitly before deleting it");
      }
      context.requireImmutableTelemetryLineage("property", propertyId);
      if (!context.database.deleteProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
      response.status(204).end();
    });
  context.app.get(`${context.prefix}/properties/:id/electricity`, async (request, response) => {
      const propertyId = request.params.id as string;
      const property = context.database.getProperty(propertyId);
      if (!property || !context.visibility(response).hasProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
      const config = context.database.getPropertyElectricityConfig(propertyId);
      if (!config) throw new HttpError(404, "NOT_FOUND", "Property electricity configuration not found");
      const from = dateValue(request.query.from, new Date(Date.now() - 24 * 60 * 60_000), "from");
      const to = dateValue(request.query.to, new Date(Date.now() + 48 * 60 * 60_000), "to");
      const history = await context.telemetryReader.electricityPriceHistory({
        propertyId,
        from,
        to,
        limit: 100_000,
      });
      response.json({
        config: publicElectricityConfiguration(config, requestPrincipal(response).role === "guest"),
        current: context.database.getCurrentPropertyElectricityPrice(propertyId),
        prices: history.records,
      });
    });
  context.app.put(`${context.prefix}/properties/:id/electricity/config`, (request, response) => {
      const propertyId = request.params.id as string;
      const property = context.database.getProperty(propertyId);
      if (!property || !context.visibility(response).hasProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
      const body = bodyObject(request.body);
      rejectUnknownFields(body, new Set(["provider", "endpointUrl", "enabled", "marginCentsPerKwh", "contractType", "contractName", "retailer", "monthlyFeeEur"]), "Electricity configuration");
      const nullableText = (key: "contractName" | "retailer"): string | null => body[key] === null || body[key] === undefined
        ? null : propertyText(body, key, 200) as string;
      const input: PropertyElectricityConfigInput = {
        provider: enumValue(body.provider, ["porssisahko", "custom"] as const, "provider"),
        endpointUrl: requiredString(body, "endpointUrl"),
        enabled: typeof body.enabled === "boolean" ? body.enabled : true,
        marginCentsPerKwh: requiredNumber(body, "marginCentsPerKwh"),
        contractType: enumValue(body.contractType, ["spot", "fixed", "other"] as const, "contractType"),
        contractName: nullableText("contractName"),
        retailer: nullableText("retailer"),
        monthlyFeeEur: body.monthlyFeeEur === null || body.monthlyFeeEur === undefined ? null : requiredNumber(body, "monthlyFeeEur"),
      };
      try {
        const endpoint = validateElectricityEndpointUrl(input.endpointUrl, config.electricityAllowPrivateEndpoints === true);
        if (input.provider === "porssisahko" && endpoint.toString() !== DEFAULT_ELECTRICITY_PRICE_ENDPOINT) {
          throw new ElectricityEndpointPolicyError("The Porssisahko provider must use its canonical endpoint");
        }
        input.endpointUrl = endpoint.toString();
      } catch (error) {
        if (error instanceof ElectricityEndpointPolicyError) {
          throw new HttpError(400, "INVALID_ELECTRICITY_ENDPOINT", error.message);
        }
        throw error;
      }
      const savedConfig = context.database.updatePropertyElectricityConfig(propertyId, input);
      response.json({ config: savedConfig });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
