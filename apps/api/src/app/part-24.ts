import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, hasLocalHouseAuthority, resolvePlanElementOpeningState } from "@climate-twin/contracts";
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
import { configureApiPart23 } from "./part-23.js";


type NormalizedApiConfig = { [Key in keyof AppConfig]-?: Exclude<AppConfig[Key], undefined> };

export function configureApiPart24(context: ReturnType<typeof configureApiPart23>) {
  const config = context.config as NormalizedApiConfig;
  const sensorGapRecovery = context.sensorGapRecovery!;
  context.app.put(`${context.prefix}/integrations/tp-link/config`, async (request, response) => {
      const body = bodyObject(request.body);
      const host = networkHost(credentialString(body, "host", 253, true));
      const username = credentialString(body, "username", 320, true);
      const password = credentialString(body, "password", 4_096);
      const houseId = body.houseId === undefined
        ? context.database.listHouses().find(hasLocalHouseAuthority)?.id
        : requiredString(body, "houseId");
      if (!houseId || !context.database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
      context.stuguby.assertHouseLocalAuthority(houseId);
      const requestedConnectionId = body.connectionId === undefined ? null : requiredString(body, "connectionId");
      const generationKey = requestedConnectionId ?? houseId;
      const generation = (context.tpLinkConfigurationGenerations.get(generationKey) ?? 0) + 1;
      context.tpLinkConfigurationGenerations.set(generationKey, generation);
      const validation = await context.tpLinkCredentialTester(host, username, password);
      if (!validation.ok || !validation.connected) {
        throw new HttpError(422, "INTEGRATION_VALIDATION_FAILED", validation.message);
      }
      if (generation !== context.tpLinkConfigurationGenerations.get(generationKey)) {
        throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer TP-Link configuration superseded this request");
      }
      const explicitConnections = config.tpLinkConnections ?? [];
      const legacyHouseId = context.status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
        ?? context.database.listHouses().find(hasLocalHouseAuthority)?.id;
      const legacyConnection: TpLinkConnectionSecret | null = explicitConnections.length === 0
        && !config.tpLinkLegacyDisabled && legacyHouseId
        && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
        ? {
            id: "legacy",
            houseId: legacyHouseId,
            host: config.tpLinkHost,
            username: config.tpLinkUsername,
            password: config.tpLinkPassword,
          }
        : null;
      // Materialize an environment-backed source before adding anything else.
      // Otherwise the first different device saved through the UI would silently
      // retire the working legacy hub.
      const existing = legacyConnection ? [legacyConnection] : explicitConnections;
      const rawTestedDeviceId = typeof validation.details?.sourceDeviceId === "string"
        ? validation.details.sourceDeviceId.trim()
        : "";
      if (rawTestedDeviceId.length > 1_024) {
        throw new HttpError(422, "INVALID_TP_LINK_DEVICE_ID", "The TP-Link helper returned an invalid source identity");
      }
      const testedDeviceId = rawTestedDeviceId || null;
      const identityKey = (value: string | null | undefined): string | null => value?.trim().toUpperCase() || null;
      const testedIdentity = identityKey(testedDeviceId);
      const requestedConnection = requestedConnectionId
        ? existing.find((connection) => connection.id === requestedConnectionId)
        : undefined;
      if (requestedConnectionId && !requestedConnection) {
        throw new HttpError(404, "NOT_FOUND", "TP-Link connection not found");
      }
      if (requestedConnection && requestedConnection.houseId !== houseId) {
        throw new HttpError(409, "TP_LINK_HOUSE_SCOPE", "TP-Link connection belongs to another house");
      }
      const identityMatch = testedIdentity
        ? existing.find((connection) => identityKey(connection.deviceId) === testedIdentity)
        : undefined;
      if (identityMatch && identityMatch.houseId !== houseId) {
        throw new HttpError(409, "TP_LINK_ALREADY_ASSIGNED", "This TP-Link device is already assigned to another house");
      }
      if (requestedConnection && identityMatch && identityMatch.id !== requestedConnection.id) {
        throw new HttpError(409, "TP_LINK_ALREADY_CONFIGURED", "This TP-Link device already has a different saved connection");
      }
      const requestedIdentity = identityKey(requestedConnection?.deviceId);
      if (requestedConnection && requestedConnection.host !== host && requestedIdentity && !testedIdentity) {
        throw new HttpError(
          409,
          "TP_LINK_IDENTITY_REQUIRED",
          "The TP-Link helper did not return a stable identity, so the saved connection address was not changed",
        );
      }
      if (requestedIdentity && testedIdentity && requestedIdentity !== testedIdentity) {
        throw new HttpError(
          409,
          "TP_LINK_CONNECTION_IDENTITY_MISMATCH",
          "The selected TP-Link connection belongs to a different physical device; add this device as a new connection instead",
        );
      }
      const hostMatch = existing.find((connection) => connection.houseId === houseId && connection.host === host);
      if (requestedConnection && hostMatch && hostMatch.id !== requestedConnection.id) {
        throw new HttpError(409, "TP_LINK_HOST_ALREADY_CONFIGURED", "This TP-Link address already has a different saved connection");
      }
      const hostIdentity = identityKey(hostMatch?.deviceId);
      if (!requestedConnection && hostIdentity && testedIdentity && hostIdentity !== testedIdentity) {
        throw new HttpError(
          409,
          "TP_LINK_HOST_IDENTITY_MISMATCH",
          "The device at this address does not match the TP-Link connection previously saved for it",
        );
      }
      // Stable identity wins over a DHCP address. Omitting connectionId therefore
      // updates a known device after an address change, but creates a second
      // connection when discovery finds genuinely different hardware.
      const matching = requestedConnection ?? identityMatch ?? hostMatch;
      const resolvedDeviceId = testedDeviceId ?? matching?.deviceId;
      const connection: TpLinkConnectionSecret = {
        id: matching?.id ?? randomUUID(), houseId, host, username, password,
        ...(resolvedDeviceId ? { deviceId: resolvedDeviceId } : {}),
      };
      const connections = [...existing.filter((candidate) => candidate.id !== connection.id), connection];
      const sameHouseConnections = existing.filter((candidate) => candidate.houseId === houseId);
      const unscopedSensors = context.database.listSensors(houseId)
        .filter((sensor) => sensor.tpLinkDeviceId && !sensor.tpLinkConnectionId);
      const sensorAssignments: Array<{
        sensorId: string;
        fromConnectionId: string | null;
        toConnectionId: string | null;
      }> = [];
      if (!matching && sameHouseConnections.length > 0 && unscopedSensors.length > 0) {
        if (sameHouseConnections.length !== 1) {
          throw new HttpError(
            409,
            "TP_LINK_BINDING_MIGRATION_REQUIRED",
            "Unscoped TP-Link sensors must be assigned before another connection can be added",
          );
        }
        const normalizeDeviceId = (value: string): string => value.trim().toUpperCase();
        const newDeviceIds = new Set((Array.isArray(validation.details?.deviceIds)
          ? validation.details.deviceIds
          : []).flatMap((value): string[] => {
            if (typeof value !== "string") return [];
            const deviceId = value.trim();
            return deviceId && deviceId.length <= 1_024 ? [normalizeDeviceId(deviceId)] : [];
          }).slice(0, 2_048));
        const existingConnection = sameHouseConnections[0]!;
        const existingDeviceIds = new Set(context.tpLink.listDiscoveredDevices(houseId)
          .filter((device) => !device.connectionId || device.connectionId === existingConnection.id)
          .map((device) => normalizeDeviceId(device.deviceId)));
        const ambiguousSensorIds: string[] = [];
        for (const sensor of unscopedSensors) {
          const deviceId = normalizeDeviceId(sensor.tpLinkDeviceId!);
          const belongsToNewConnection = newDeviceIds.has(deviceId);
          const belongsToExistingConnection = existingDeviceIds.has(deviceId);
          if (belongsToNewConnection === belongsToExistingConnection) {
            ambiguousSensorIds.push(sensor.id);
            continue;
          }
          sensorAssignments.push({
            sensorId: sensor.id,
            fromConnectionId: null,
            toConnectionId: belongsToNewConnection ? connection.id : existingConnection.id,
          });
        }
        if (ambiguousSensorIds.length > 0) {
          throw new HttpError(
            409,
            "TP_LINK_BINDING_MIGRATION_REQUIRED",
            "The existing and new TP-Link sources could not safely identify every unscoped sensor; no configuration was changed",
            { sensorIds: ambiguousSensorIds },
          );
        }
      }
      if (sensorAssignments.length > 0) {
        context.database.reassignTpLinkSensors(houseId, sensorAssignments);
      }
      try {
        updateIntegrationSecrets(config.integrationSecretsFile, {
          tpLink: null,
          tpLinkConnections: connections,
          ...(legacyConnection ? { tpLinkLegacyDisabled: true } : {}),
        });
      } catch (error) {
        if (sensorAssignments.length > 0) {
          context.database.reassignTpLinkSensors(houseId, sensorAssignments.map((assignment) => ({
            sensorId: assignment.sensorId,
            fromConnectionId: assignment.toConnectionId,
            toConnectionId: assignment.fromConnectionId,
          })));
        }
        throw error;
      }
      if (legacyConnection && connection.id !== legacyConnection.id) {
        context.integrationMetadata.saveTpLink({
          id: legacyConnection.id,
          houseId: legacyConnection.houseId,
          host: legacyConnection.host,
          reason: "reconciled",
        });
      }
      context.integrationMetadata.saveTpLink({ id: connection.id, houseId, host });
      config.tpLinkConnections = connections;
      if (legacyConnection) config.tpLinkLegacyDisabled = true;
      context.status.value.tpLink.configured = true;
      context.status.value.tpLink.error = null;
      const previousConnectionStatuses = new Map((context.status.value.tpLink.connections ?? [])
        .map((candidate) => [candidate.id, candidate] as const));
      context.status.value.tpLink.connections = connections.map((candidate) => {
        const previous = previousConnectionStatuses.get(candidate.id);
        if (candidate.id !== connection.id && previous) return previous;
        return {
          id: candidate.id, houseId: candidate.houseId, configured: true, connected: false, lastPollAt: null,
          mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null,
        };
      });
      const wasRealMode = context.dataMode.isRealMode;
      context.dataMode.activate();
      if (wasRealMode) context.status.changed();
      if (context.options.startBackground) context.tpLink.restart();
      context.recordSecurityAudit(requestPrincipal(response), {
        eventType: matching ? "integration.credentials.rotated" : "integration.credentials.configured",
        subjectType: "integration",
        subjectId: `tp-link:${connection.id}`,
        details: { integration: "tp-link", connectionId: connection.id, houseId },
      });
      response.json({ ok: true, configured: true, connectionId: connection.id, houseId, integration: structuredClone(context.status.value) });
    });
  const extended = Object.assign(context, {  });
  return extended;
}
