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
import { configuredAlertWebhookDestinations, loadConfig, type AppConfig } from "../../config.js";
import {
  ClimateDatabase,
  ClimateDataValidationError,
  outdoorLocationKey,
  type SecurityAuditEventInput,
  type SensorUpdate,
  type TapoHistoryExportJob,
  type TelemetryCascadeScope,
} from "../../db.js";
import { TelemetryBus } from "../../events.js";
import { HomeAssistantBridge, testHomeAssistantCredentials } from "../../home-assistant.js";
import { mergeTpLinkHistoryRecovery, TpLinkBridge } from "../../tp-link.js";
import { discoverHomeAssistant } from "../../discovery.js";
import {
  readIntegrationSecrets,
  updateIntegrationSecrets,
  type AppleNotesGrantSecret,
  type IntegrationSecrets,
  type TpLinkConnectionSecret,
} from "../../integration-secrets.js";
import { IntegrationMetadataStore } from "../../integration-metadata.js";
import { openApiV1Document, openApiV2Document } from "../../openapi.js";
import {
  FmiWeatherProvider,
  WeatherRequestSupersededError,
  WeatherService,
  WeatherUnavailableError,
  type WeatherProvider,
} from "../../weather.js";
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
} from "../../services.js";
import { runThermalSimulation } from "../../thermal-simulation.js";
import { runThermalIsolation } from "../../thermal-isolation.js";
import { SYSTEM_VERSION } from "../../version.js";
import { SystemUpdateError, SystemUpdateService } from "../../system-updates.js";
import { LocationDiscoveryService } from "../../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider, prefersFmi } from "../../open-meteo.js";
import { WeatherMonitor } from "../../weather-monitor.js";
import { DailyAnalyticsFindingsWorker } from "../../daily-analytics-findings.js";
import { WeatherRecoveryCoordinator } from "../../weather-recovery.js";
import { SensorGapRecoveryCoordinator } from "../../sensor-gap-recovery.js";
import {
  TAPO_CANARY_APPROVAL_MAX_AGE_MS,
  TapoHistoryCanaryError,
  TapoHistoryExportService,
} from "../../tapo-history-export.js";
import {
  InMemoryWeatherEventBroker,
  WeatherEventSupersededError,
  type WeatherEventBroker,
} from "../../weather-events.js";
import { TelegramService, TelegramServiceError } from "../../telegram.js";
import { NotificationOutboxWorker } from "../../outbox.js";
import { apnsConfigured } from "../../apns.js";
import { normalizeAlertDeliveryPolicy } from "../../notification-policy.js";
import {
  ElectricityEndpointPolicyError,
  ElectricityPriceService,
  publicElectricityConfiguration,
  validateElectricityEndpointUrl,
  type ElectricityEndpointResolver,
} from "../../electricity-prices.js";
import {
  LocalAuthError,
  LocalAuthStore,
  type LocalAuthIdentity,
  type LocalAuthSession,
} from "../../local-auth.js";
import { CloudflareAccessGroupSynchronizer } from "../../cloudflare-access.js";
import {
  CloudflareSetupError,
  CloudflareSetupService,
  cloudflareSetupCallbackPath,
  type CloudflareSetupStartInput,
} from "../../cloudflare-setup.js";
import {
  createLocalSpatialLayerRuntime,
  registerSpatialLayerRoutes,
  type LocalSpatialLayerRuntime,
} from "../../spatial-layers/index.js";
import { LruTtlCache } from "../../cache.js";
import { DataOperationsService } from "../../data-operations.js";
import { EnergyOptimizer } from "../../energy-optimizer.js";
import { EnergyCostService } from "../../energy-cost.js";
import { SetupDoctor } from "../../setup-doctor.js";
import { TimeseriesStore } from "../../timeseries/store.js";
import {
  TelemetryArchiveWorker,
} from "../../timeseries/archive-worker.js";
import {
  HybridTelemetryReader,
  bucketLegacyReadings,
  bucketMeasurementSamples,
  IncompleteTelemetryHistoryError,
} from "../../timeseries/read-facade.js";
import { TelemetryRetentionWorker } from "../../timeseries/retention-worker.js";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
  parseAnalyticsCoverageRequest,
  parseAnalyticsQueryRequest,
} from "../../analytics.js";
import { loadOrCreateStugubyNodeKeys } from "../../stuguby/identity.js";
import { registerStugubyLocalRoutes, registerStugubyProtocolRoutes } from "../../stuguby/routes.js";
import { StugubyError, StugubyService } from "../../stuguby/service.js";
import { StugubyStore } from "../../stuguby/store.js";
import { TrackingSecretBox, loadOrCreateTrackingKey } from "../../tracking/crypto.js";
import { registerTrackingRoutes } from "../../tracking/routes.js";
import { TrackingService } from "../../tracking/service.js";
import {
  TrackingError,
  TrackingStore,
  type AuthenticatedTrackingObserver,
} from "../../tracking/store.js";
import { HttpError, bodyObject, enumValue, requiredString } from "./part-01.js";
import { OBSERVATION_CONFIDENCES, OBSERVATION_CREATE_FIELDS, OBSERVATION_KINDS, OBSERVATION_PATCH_FIELDS, OBSERVATION_SEVERITIES, OBSERVATION_SOURCES, OBSERVATION_STATUSES, OBSERVATION_TIME_PRECISIONS, propertyText, rejectUnknownFields } from "./part-02.js";

export function optionalNullableString(
  body: Record<string, unknown>,
  key: string,
  maximumLength?: number,
): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "string"
    || !value.trim()
    || (maximumLength !== undefined && Array.from(value).length > maximumLength)
  ) {
    const bound = maximumLength === undefined ? "" : ` of at most ${maximumLength} characters`;
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string${bound} or null`);
  }
  return value.trim();
}

export function optionalNullableNumber(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${key} must be a finite number or null`);
  return value;
}

export function optionalObservationDate(body: Record<string, unknown>, key: "occurredAt" | "validFrom" | "validTo"): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty date string or null`);
  return value.trim();
}

export function parseObservationInput(value: unknown): ManualObservationInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, OBSERVATION_CREATE_FIELDS, "Observation input");
  const occurredAt = optionalObservationDate(body, "occurredAt");
  if (occurredAt === null) throw new HttpError(400, "INVALID_FIELD", "occurredAt must be a date string when provided");
  return {
    ...(typeof body.id === "string" ? { id: requiredString(body, "id") } : {}),
    houseId: requiredString(body, "houseId"),
    floorId: requiredString(body, "floorId"),
    ...(body.sensorId !== undefined ? { sensorId: optionalNullableString(body, "sensorId") ?? null } : {}),
    kind: enumValue(body.kind, OBSERVATION_KINDS, "kind"),
    severity: enumValue(body.severity, OBSERVATION_SEVERITIES, "severity"),
    note: requiredString(body, "note"),
    ...(body.x !== undefined ? { x: optionalNullableNumber(body, "x") ?? null } : {}),
    ...(body.y !== undefined ? { y: optionalNullableNumber(body, "y") ?? null } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(body.timePrecision !== undefined
      ? { timePrecision: enumValue(body.timePrecision, OBSERVATION_TIME_PRECISIONS, "timePrecision") }
      : {}),
    ...(body.validFrom !== undefined ? { validFrom: optionalObservationDate(body, "validFrom") ?? null } : {}),
    ...(body.validTo !== undefined ? { validTo: optionalObservationDate(body, "validTo") ?? null } : {}),
    ...(body.source !== undefined ? { source: enumValue(body.source, OBSERVATION_SOURCES, "source") } : {}),
    ...(body.sourceDetail !== undefined ? { sourceDetail: optionalNullableString(body, "sourceDetail") ?? null } : {}),
    ...(body.confidence !== undefined
      ? { confidence: enumValue(body.confidence, OBSERVATION_CONFIDENCES, "confidence") }
      : {}),
  };
}

export function parseObservationPatch(value: unknown): ManualObservationPatch {
  const body = bodyObject(value);
  rejectUnknownFields(body, OBSERVATION_PATCH_FIELDS, "Observation patch");
  const baseRevision = body.baseRevision;
  if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 1) {
    throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a positive integer");
  }
  if (![...OBSERVATION_PATCH_FIELDS].some((field) => field !== "baseRevision" && body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Observation patch must contain at least one mutable field");
  }
  const occurredAt = optionalObservationDate(body, "occurredAt");
  if (occurredAt === null) throw new HttpError(400, "INVALID_FIELD", "occurredAt must be a date string when provided");
  return {
    baseRevision,
    ...(body.floorId !== undefined ? { floorId: requiredString(body, "floorId") } : {}),
    ...(body.sensorId !== undefined ? { sensorId: optionalNullableString(body, "sensorId") ?? null } : {}),
    ...(body.kind !== undefined ? { kind: enumValue(body.kind, OBSERVATION_KINDS, "kind") } : {}),
    ...(body.severity !== undefined ? { severity: enumValue(body.severity, OBSERVATION_SEVERITIES, "severity") } : {}),
    ...(body.note !== undefined ? { note: requiredString(body, "note") } : {}),
    ...(body.x !== undefined ? { x: optionalNullableNumber(body, "x") ?? null } : {}),
    ...(body.y !== undefined ? { y: optionalNullableNumber(body, "y") ?? null } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(body.timePrecision !== undefined
      ? { timePrecision: enumValue(body.timePrecision, OBSERVATION_TIME_PRECISIONS, "timePrecision") }
      : {}),
    ...(body.validFrom !== undefined ? { validFrom: optionalObservationDate(body, "validFrom") ?? null } : {}),
    ...(body.validTo !== undefined ? { validTo: optionalObservationDate(body, "validTo") ?? null } : {}),
    ...(body.source !== undefined ? { source: enumValue(body.source, OBSERVATION_SOURCES, "source") } : {}),
    ...(body.sourceDetail !== undefined ? { sourceDetail: optionalNullableString(body, "sourceDetail") ?? null } : {}),
    ...(body.confidence !== undefined
      ? { confidence: enumValue(body.confidence, OBSERVATION_CONFIDENCES, "confidence") }
      : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, OBSERVATION_STATUSES, "status") } : {}),
    ...(body.resolutionNote !== undefined
      ? {
          resolutionNote: optionalNullableString(
            body,
            "resolutionNote",
            MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
          ) ?? null,
        }
      : {}),
  };
}

export const MAINTENANCE_BASES = ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] as const;

export const MAINTENANCE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const MAINTENANCE_STATUSES = ["planned", "in-progress", "completed", "verified", "cancelled"] as const;

export const MAINTENANCE_CREATE_FIELDS = new Set([
  "id", "propertyId", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor",
  "dueBy", "observationIds",
]);

export const MAINTENANCE_PATCH_FIELDS = new Set([
  "baseRevision", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor",
  "dueBy", "observationIds", "status", "completionNote", "verificationNote",
]);

export function maintenanceText(
  body: Record<string, unknown>,
  key: string,
  maximumLength = 5_000,
): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || Array.from(value).length > maximumLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a string of at most ${maximumLength} characters or null`);
  }
  return value.trim() || null;
}

export function maintenanceDateValue(body: Record<string, unknown>, key: "plannedFor" | "dueBy"): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a YYYY-MM-DD string or null`);
  }
  return value.trim();
}

export function maintenanceObservationIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => (
    typeof id !== "string" || !id.trim() || Array.from(id.trim()).length > 200
  ))) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      "observationIds must contain at most 100 non-empty identifiers of at most 200 characters",
    );
  }
  return [...new Set(value.map((id) => (id as string).trim()))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function maintenanceTitle(body: Record<string, unknown>): string {
  const title = requiredString(body, "title");
  if (Array.from(title).length > 200) {
    throw new HttpError(400, "INVALID_FIELD", "title must be at most 200 characters");
  }
  return title;
}

export function parseMaintenanceTaskInput(value: unknown): MaintenanceTaskInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, MAINTENANCE_CREATE_FIELDS, "Maintenance task input");
  const propertyId = body.propertyId === undefined ? undefined : propertyText(body, "propertyId", 200) as string;
  const houseId = body.houseId === undefined ? undefined : optionalNullableString(body, "houseId", 200) ?? null;
  if (!propertyId && !houseId) {
    throw new HttpError(400, "INVALID_FIELD", "propertyId or houseId is required");
  }
  const common = {
    ...(body.id !== undefined ? { id: requiredString(body, "id") } : {}),
    ...(body.floorId !== undefined ? { floorId: optionalNullableString(body, "floorId", 200) ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: optionalNullableString(body, "areaId", 200) ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: optionalNullableString(body, "equipmentId", 200) ?? null } : {}),
    title: maintenanceTitle(body),
    ...(body.description !== undefined ? { description: maintenanceText(body, "description") ?? null } : {}),
    basis: enumValue(body.basis, MAINTENANCE_BASES, "basis"),
    ...(body.basisDetail !== undefined ? { basisDetail: maintenanceText(body, "basisDetail") ?? null } : {}),
    ...(body.priority !== undefined ? { priority: enumValue(body.priority, MAINTENANCE_PRIORITIES, "priority") } : {}),
    ...(body.plannedFor !== undefined ? { plannedFor: maintenanceDateValue(body, "plannedFor") ?? null } : {}),
    ...(body.dueBy !== undefined ? { dueBy: maintenanceDateValue(body, "dueBy") ?? null } : {}),
    ...(body.observationIds !== undefined ? { observationIds: maintenanceObservationIds(body.observationIds) } : {}),
  };
  return propertyId
    ? { ...common, propertyId, ...(houseId !== undefined ? { houseId } : {}) }
    : { ...common, houseId: houseId! };
}

export function parseMaintenanceTaskPatch(value: unknown): MaintenanceTaskPatch {
  const body = bodyObject(value);
  rejectUnknownFields(body, MAINTENANCE_PATCH_FIELDS, "Maintenance task patch");
  const baseRevision = body.baseRevision;
  if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 1) {
    throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a positive integer");
  }
  if (![...MAINTENANCE_PATCH_FIELDS].some((field) => field !== "baseRevision" && body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Maintenance task patch must contain at least one mutable field");
  }
  return {
    baseRevision,
    ...(body.houseId !== undefined ? { houseId: optionalNullableString(body, "houseId", 200) ?? null } : {}),
    ...(body.floorId !== undefined ? { floorId: optionalNullableString(body, "floorId", 200) ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: optionalNullableString(body, "areaId", 200) ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: optionalNullableString(body, "equipmentId", 200) ?? null } : {}),
    ...(body.title !== undefined ? { title: maintenanceTitle(body) } : {}),
    ...(body.description !== undefined ? { description: maintenanceText(body, "description") ?? null } : {}),
    ...(body.basis !== undefined ? { basis: enumValue(body.basis, MAINTENANCE_BASES, "basis") } : {}),
    ...(body.basisDetail !== undefined ? { basisDetail: maintenanceText(body, "basisDetail") ?? null } : {}),
    ...(body.priority !== undefined ? { priority: enumValue(body.priority, MAINTENANCE_PRIORITIES, "priority") } : {}),
    ...(body.plannedFor !== undefined ? { plannedFor: maintenanceDateValue(body, "plannedFor") ?? null } : {}),
    ...(body.dueBy !== undefined ? { dueBy: maintenanceDateValue(body, "dueBy") ?? null } : {}),
    ...(body.observationIds !== undefined ? { observationIds: maintenanceObservationIds(body.observationIds) } : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, MAINTENANCE_STATUSES, "status") } : {}),
    ...(body.completionNote !== undefined ? { completionNote: maintenanceText(body, "completionNote") ?? null } : {}),
    ...(body.verificationNote !== undefined ? { verificationNote: maintenanceText(body, "verificationNote") ?? null } : {}),
  };
}

export function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return [];
}

export function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function boundedQueryInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function collectionPage(query: Record<string, unknown>): { limit: number; offset: number } {
  return {
    limit: boundedQueryInteger(query.limit, "limit", 1, 500) ?? 500,
    offset: boundedQueryInteger(query.offset, "offset", 0, 1_000_000) ?? 0,
  };
}
