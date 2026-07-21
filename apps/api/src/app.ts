import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, resolvePlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AreaEquipment,
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
  OpeningStateObservationInput,
  MeasurementDefinition,
  MeasurementSample,
  PropertyAreaInput,
  PropertyAreaPatch,
  Property,
  PropertyArea,
  PropertyCreateInput,
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
} from "@climate-twin/contracts";
import { loadConfig, type AppConfig } from "./config.js";
import {
  ClimateDatabase,
  ClimateDataValidationError,
  outdoorLocationKey,
  type SensorUpdate,
  type TapoHistoryExportJob,
  type TelemetryCascadeScope,
} from "./db.js";
import { TelemetryBus } from "./events.js";
import { HomeAssistantBridge, testHomeAssistantCredentials } from "./home-assistant.js";
import { TpLinkBridge } from "./tp-link.js";
import { discoverHomeAssistant } from "./discovery.js";
import {
  readIntegrationSecrets,
  updateIntegrationSecrets,
  type AppleNotesGrantSecret,
  type IntegrationSecrets,
  type TpLinkConnectionSecret,
} from "./integration-secrets.js";
import { IntegrationMetadataStore } from "./integration-metadata.js";
import { openApiV1Document, openApiV2Document } from "./openapi.js";
import {
  FmiWeatherProvider,
  WeatherRequestSupersededError,
  WeatherService,
  WeatherUnavailableError,
  type WeatherProvider,
} from "./weather.js";
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
} from "./services.js";
import { runThermalSimulation } from "./thermal-simulation.js";
import { SYSTEM_VERSION } from "./version.js";
import { LocationDiscoveryService } from "./location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider, prefersFmi } from "./open-meteo.js";
import { WeatherMonitor } from "./weather-monitor.js";
import { WeatherRecoveryCoordinator } from "./weather-recovery.js";
import { SensorGapRecoveryCoordinator } from "./sensor-gap-recovery.js";
import {
  TAPO_CANARY_APPROVAL_MAX_AGE_MS,
  TapoHistoryCanaryError,
  TapoHistoryExportService,
} from "./tapo-history-export.js";
import {
  InMemoryWeatherEventBroker,
  WeatherEventSupersededError,
  type WeatherEventBroker,
} from "./weather-events.js";
import { TelegramService, TelegramServiceError } from "./telegram.js";
import { NotificationOutboxWorker } from "./outbox.js";
import { normalizeAlertDeliveryPolicy } from "./notification-policy.js";
import {
  ElectricityEndpointPolicyError,
  ElectricityPriceService,
  publicElectricityConfiguration,
  validateElectricityEndpointUrl,
  type ElectricityEndpointResolver,
} from "./electricity-prices.js";
import {
  LocalAuthError,
  LocalAuthStore,
  type LocalAuthIdentity,
  type LocalAuthSession,
} from "./local-auth.js";
import { CloudflareAccessGroupSynchronizer } from "./cloudflare-access.js";
import {
  createLocalSpatialLayerRuntime,
  registerSpatialLayerRoutes,
  type LocalSpatialLayerRuntime,
} from "./spatial-layers/index.js";
import { LruTtlCache } from "./cache.js";
import { DataOperationsService } from "./data-operations.js";
import { EnergyOptimizer } from "./energy-optimizer.js";
import { EnergyCostService } from "./energy-cost.js";
import { SetupDoctor } from "./setup-doctor.js";
import { TimeseriesStore } from "./timeseries/store.js";
import {
  TelemetryArchiveWorker,
} from "./timeseries/archive-worker.js";
import {
  HybridTelemetryReader,
  bucketLegacyReadings,
  bucketMeasurementSamples,
  IncompleteTelemetryHistoryError,
} from "./timeseries/read-facade.js";
import { TelemetryRetentionWorker } from "./timeseries/retention-worker.js";
import {
  AnalyticsQueryError,
  buildAnalyticsResponse,
  parseAnalyticsQueryRequest,
} from "./analytics.js";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_BODY", "A JSON object is required");
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string`);
  return value.trim();
}

function credentialString(body: Record<string, unknown>, key: string, maximumLength: number, trim = false): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return trim ? value.trim() : value;
}

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD"]);
const MAX_SSE_QUEUE_MESSAGES = 128;
const MAX_SSE_QUEUE_BYTES = 256 * 1024;
const MAX_EVENT_STREAMS_GLOBAL = 64;
const MAX_EVENT_STREAMS_PER_USER = 8;

interface BoundedSseWriter {
  send: (payload: string) => boolean;
  dispose: () => void;
}

function boundedSseWriter(response: Response): BoundedSseWriter {
  const queue: string[] = [];
  let queuedBytes = 0;
  let blocked = false;
  let disposed = false;
  const flush = (): void => {
    if (disposed || response.destroyed || response.writableEnded) return;
    blocked = false;
    while (queue.length > 0 && !blocked) {
      const payload = queue.shift()!;
      queuedBytes -= Buffer.byteLength(payload);
      blocked = !response.write(payload);
    }
  };
  response.on("drain", flush);
  return {
    send(payload): boolean {
      if (disposed || response.destroyed || response.writableEnded) return false;
      if (!blocked && queue.length === 0) {
        blocked = !response.write(payload);
        return true;
      }
      const bytes = Buffer.byteLength(payload);
      if (queue.length >= MAX_SSE_QUEUE_MESSAGES || queuedBytes + bytes > MAX_SSE_QUEUE_BYTES) {
        disposed = true;
        response.off("drain", flush);
        response.end();
        return false;
      }
      queue.push(payload);
      queuedBytes += bytes;
      return true;
    },
    dispose(): void {
      disposed = true;
      queue.length = 0;
      queuedBytes = 0;
      response.off("drain", flush);
    },
  };
}

function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestOrigin(request: Request, config: AppConfig): string | null {
  const host = request.header("host");
  if (!host) return null;
  const forwardedProtocol = trustedProxyRequest(request, config)
    ? request.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
    : null;
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : request.protocol;
  return normalizedOrigin(`${protocol}://${host}`);
}

function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function trustedSelfHostname(hostname: string, apiHost: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1") return true;
  const configured = normalizedHostname(apiHost);
  return !["0.0.0.0", "::", ""].includes(configured) && normalized === configured;
}

function browserOriginAllowed(request: Request, origin: string, config: AppConfig): boolean {
  const normalized = normalizedOrigin(origin);
  if (!normalized) return false;
  if (normalized === normalizedOrigin(config.corsOrigin)) return true;
  if (normalized !== requestOrigin(request, config)) return false;
  return trustedSelfHostname(new URL(normalized).hostname, config.apiHost);
}

function homeAssistantUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new HttpError(400, "INVALID_FIELD", "url must be a valid HTTP or HTTPS Home Assistant address");
  }
}

function networkHost(value: string): string {
  const host = value.trim();
  const hostnameOrIpv4 = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
  const ipv6 = host.includes(":") && /^[0-9A-Fa-f:]+$/.test(host);
  if (host.length > 253 || (!hostnameOrIpv4 && !ipv6)) {
    throw new HttpError(400, "INVALID_FIELD", "host must be an IP address or local network name without a URL scheme");
  }
  return host;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "INVALID_FIELD", `${key} must be a string`);
  return value;
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${key} must be a finite number`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, "INVALID_FIELD", `${key} must be a boolean`);
  return value;
}

function houseLocationValue(value: unknown): HouseLocation;
function houseLocationValue(value: unknown, allowNull: true): HouseLocation | null;
function houseLocationValue(value: unknown, allowNull = false): HouseLocation | null {
  if (value === null && allowNull) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_FIELD", "location must be an object with latitude and longitude");
  }
  const body = value as Record<string, unknown>;
  const latitude = requiredNumber(body, "latitude");
  const longitude = requiredNumber(body, "longitude");
  const label = optionalString(body, "label")?.trim();
  const countryCode = optionalString(body, "countryCode")?.trim().toUpperCase();
  const source = optionalString(body, "source")?.trim() as HouseLocation["source"];
  const confidence = optionalString(body, "confidence")?.trim() as HouseLocation["confidence"];
  const discoveredAt = optionalString(body, "discoveredAt")?.trim();
  const userOverridden = optionalBoolean(body, "userOverridden");
  return {
    latitude,
    longitude,
    ...(label ? { label } : {}),
    ...(countryCode ? { countryCode } : {}),
    ...(source ? { source } : {}),
    ...(confidence ? { confidence } : {}),
    ...(discoveredAt ? { discoveredAt } : {}),
    ...(userOverridden !== undefined ? { userOverridden } : {}),
  };
}

function houseMapPlacementValue(value: unknown): HouseMapPlacement;
function houseMapPlacementValue(value: unknown, allowNull: true): HouseMapPlacement | null;
function houseMapPlacementValue(value: unknown, allowNull = false): HouseMapPlacement | null {
  if (value === null && allowNull) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      "mapPlacement must be an object with latitude, longitude, and metersPerPlanUnit",
    );
  }
  const body = value as Record<string, unknown>;
  const latitude = requiredNumber(body, "latitude");
  const longitude = requiredNumber(body, "longitude");
  const metersPerPlanUnit = requiredNumber(body, "metersPerPlanUnit");
  const footprintFloorId = body.footprintFloorId === undefined
    ? undefined
    : requiredString(body, "footprintFloorId");
  return { latitude, longitude, metersPerPlanUnit, ...(footprintFloorId ? { footprintFloorId } : {}) };
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

const PROPERTY_AREA_KINDS = [
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road",
  "yard", "building", "other",
] as const;
const AREA_EQUIPMENT_STATUSES = ["active", "out-of-service", "retired"] as const;
const PROPERTY_NOTE_KINDS = ["note", "inspection", "maintenance"] as const;

function propertyText(
  body: Record<string, unknown>,
  key: string,
  maximumLength: number,
  nullable = false,
): string | null {
  const value = body[key];
  if (nullable && value === null) return null;
  if (typeof value !== "string" || (!nullable && !value.trim()) || Array.from(value.trim()).length > maximumLength) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      `${key} must be ${nullable ? "a string" : "a non-empty string"} of at most ${maximumLength} characters${nullable ? " or null" : ""}`,
    );
  }
  return value.trim() || null;
}

function propertyPolygon(value: unknown): GeoCoordinate[] {
  if (!Array.isArray(value) || (value.length !== 0 && value.length < 3) || value.length > 500) {
    throw new HttpError(400, "INVALID_FIELD", "polygon must be empty for a fixed asset or contain between 3 and 500 coordinate objects");
  }
  return value.map((candidate) => {
    const point = bodyObject(candidate);
    rejectUnknownFields(point, new Set(["latitude", "longitude"]), "Area polygon coordinate");
    return { latitude: requiredNumber(point, "latitude"), longitude: requiredNumber(point, "longitude") };
  });
}

function propertyCoordinate(value: unknown, nullable = false): GeoCoordinate | null {
  if (nullable && value === null) return null;
  const point = bodyObject(value);
  rejectUnknownFields(point, new Set(["latitude", "longitude"]), "Fixed asset coordinate");
  return { latitude: requiredNumber(point, "latitude"), longitude: requiredNumber(point, "longitude") };
}

function parsePropertyInput(value: unknown): PropertyCreateInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set(["id", "name", "description", "location"]), "Property input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    name: propertyText(body, "name", 200) as string,
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.location !== undefined ? { location: houseLocationValue(body.location, true) } : {}),
  };
}

function parsePropertyPatch(value: unknown): PropertyPatch {
  const body = bodyObject(value);
  const fields = new Set(["name", "description", "location"]);
  rejectUnknownFields(body, fields, "Property patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Property patch must contain at least one mutable field");
  }
  return {
    ...(body.name !== undefined ? { name: propertyText(body, "name", 200) as string } : {}),
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.location !== undefined ? { location: houseLocationValue(body.location, true) } : {}),
  };
}

function parsePropertyAreaInput(value: unknown): PropertyAreaInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set(["id", "propertyId", "name", "kind", "description", "location", "polygon"]), "Property area input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    propertyId: propertyText(body, "propertyId", 200) as string,
    name: propertyText(body, "name", 200) as string,
    kind: enumValue(body.kind, PROPERTY_AREA_KINDS, "kind"),
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.location !== undefined ? { location: propertyCoordinate(body.location) as GeoCoordinate } : {}),
    polygon: propertyPolygon(body.polygon),
  };
}

function parsePropertyAreaPatch(value: unknown): PropertyAreaPatch {
  const body = bodyObject(value);
  const fields = new Set(["propertyId", "name", "kind", "description", "location", "polygon"]);
  rejectUnknownFields(body, fields, "Property area patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Property area patch must contain at least one mutable field");
  }
  return {
    ...(body.propertyId !== undefined ? { propertyId: propertyText(body, "propertyId", 200) as string } : {}),
    ...(body.name !== undefined ? { name: propertyText(body, "name", 200) as string } : {}),
    ...(body.kind !== undefined ? { kind: enumValue(body.kind, PROPERTY_AREA_KINDS, "kind") } : {}),
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.location !== undefined ? { location: propertyCoordinate(body.location, true) } : {}),
    ...(body.polygon !== undefined ? { polygon: propertyPolygon(body.polygon) } : {}),
  };
}

function parseAreaEquipmentInput(value: unknown): AreaEquipmentInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set([
    "id", "propertyId", "areaId", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes",
  ]), "Area equipment input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    ...(body.propertyId !== undefined ? { propertyId: propertyText(body, "propertyId", 200) as string } : {}),
    areaId: propertyText(body, "areaId", 200) as string,
    name: propertyText(body, "name", 200) as string,
    kind: propertyText(body, "kind", 200) as string,
    ...(body.manufacturer !== undefined ? { manufacturer: propertyText(body, "manufacturer", 200, true) } : {}),
    ...(body.model !== undefined ? { model: propertyText(body, "model", 200, true) } : {}),
    ...(body.serialNumber !== undefined ? { serialNumber: propertyText(body, "serialNumber", 200, true) } : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, AREA_EQUIPMENT_STATUSES, "status") } : {}),
    ...(body.notes !== undefined ? { notes: propertyText(body, "notes", 5_000, true) } : {}),
  };
}

function parseAreaEquipmentPatch(value: unknown): AreaEquipmentPatch {
  const body = bodyObject(value);
  const fields = new Set([
    "areaId", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes",
  ]);
  rejectUnknownFields(body, fields, "Area equipment patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Area equipment patch must contain at least one mutable field");
  }
  return {
    ...(body.areaId !== undefined ? { areaId: propertyText(body, "areaId", 200) as string } : {}),
    ...(body.name !== undefined ? { name: propertyText(body, "name", 200) as string } : {}),
    ...(body.kind !== undefined ? { kind: propertyText(body, "kind", 200) as string } : {}),
    ...(body.manufacturer !== undefined ? { manufacturer: propertyText(body, "manufacturer", 200, true) } : {}),
    ...(body.model !== undefined ? { model: propertyText(body, "model", 200, true) } : {}),
    ...(body.serialNumber !== undefined ? { serialNumber: propertyText(body, "serialNumber", 200, true) } : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, AREA_EQUIPMENT_STATUSES, "status") } : {}),
    ...(body.notes !== undefined ? { notes: propertyText(body, "notes", 5_000, true) } : {}),
  };
}

function nullablePropertyTarget(body: Record<string, unknown>, key: string): string | null | undefined {
  if (body[key] === undefined) return undefined;
  return propertyText(body, key, 200, true);
}

function parsePropertyNoteInput(value: unknown): PropertyNoteInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set([
    "id", "propertyId", "houseId", "areaId", "equipmentId", "kind", "text",
  ]), "Property note input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    propertyId: propertyText(body, "propertyId", 200) as string,
    ...(body.houseId !== undefined ? { houseId: nullablePropertyTarget(body, "houseId") ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: nullablePropertyTarget(body, "areaId") ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: nullablePropertyTarget(body, "equipmentId") ?? null } : {}),
    kind: enumValue(body.kind, PROPERTY_NOTE_KINDS, "kind"),
    text: propertyText(body, "text", 5_000) as string,
  };
}

function parsePropertyNotePatch(value: unknown): PropertyNotePatch {
  const body = bodyObject(value);
  const fields = new Set(["houseId", "areaId", "equipmentId", "kind", "text"]);
  rejectUnknownFields(body, fields, "Property note patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Property note patch must contain at least one mutable field");
  }
  return {
    ...(body.houseId !== undefined ? { houseId: nullablePropertyTarget(body, "houseId") ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: nullablePropertyTarget(body, "areaId") ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: nullablePropertyTarget(body, "equipmentId") ?? null } : {}),
    ...(body.kind !== undefined ? { kind: enumValue(body.kind, PROPERTY_NOTE_KINDS, "kind") } : {}),
    ...(body.text !== undefined ? { text: propertyText(body, "text", 5_000) as string } : {}),
  };
}

function optionalResourceQuery(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

function dateValue(value: unknown, fallback: Date, field: string): string {
  if (value === undefined) return fallback.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, "INVALID_FIELD", `${field} must be an ISO date-time`);
  return new Date(value).toISOString();
}

const OBSERVATION_KINDS = ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] as const;
const OBSERVATION_SEVERITIES = ["info", "warning", "critical"] as const;
const OBSERVATION_TIME_PRECISIONS = ["exact", "approximate", "date-only", "date-range", "unknown"] as const;
const OBSERVATION_SOURCES = [
  "owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown",
] as const;
const OBSERVATION_CONFIDENCES = ["confirmed", "probable", "uncertain", "awaiting-inspection"] as const;
const OBSERVATION_STATUSES = ["open", "resolved"] as const;
const OBSERVATION_CREATE_FIELDS = new Set([
  "id", "houseId", "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt",
  "timePrecision", "validFrom", "validTo", "source", "sourceDetail", "confidence",
]);
const OBSERVATION_PATCH_FIELDS = new Set([
  "baseRevision", "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt",
  "timePrecision", "validFrom", "validTo", "source", "sourceDetail", "confidence", "status", "resolutionNote",
]);

function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new HttpError(400, "INVALID_FIELD", `${name} does not accept: ${unknown.join(", ")}`);
}

function optionalNullableString(
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

function optionalNullableNumber(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${key} must be a finite number or null`);
  return value;
}

function optionalObservationDate(body: Record<string, unknown>, key: "occurredAt" | "validFrom" | "validTo"): string | null | undefined {
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

const MAINTENANCE_BASES = ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] as const;
const MAINTENANCE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const MAINTENANCE_STATUSES = ["planned", "in-progress", "completed", "verified", "cancelled"] as const;
const MAINTENANCE_CREATE_FIELDS = new Set([
  "id", "propertyId", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor",
  "dueBy", "observationIds",
]);
const MAINTENANCE_PATCH_FIELDS = new Set([
  "baseRevision", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor",
  "dueBy", "observationIds", "status", "completionNote", "verificationNote",
]);

function maintenanceText(
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

function maintenanceDateValue(body: Record<string, unknown>, key: "plannedFor" | "dueBy"): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a YYYY-MM-DD string or null`);
  }
  return value.trim();
}

function maintenanceObservationIds(value: unknown): string[] {
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

function maintenanceTitle(body: Record<string, unknown>): string {
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

function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return [];
}

function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function boundedQueryInteger(value: unknown, field: string, min: number, max: number): number | null {
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

function collectionPage(query: Record<string, unknown>): { limit: number; offset: number } {
  return {
    limit: boundedQueryInteger(query.limit, "limit", 1, 500) ?? 500,
    offset: boundedQueryInteger(query.offset, "offset", 0, 1_000_000) ?? 0,
  };
}

function visibleCollectionPage<T>(
  load: (limit: number, offset: number) => T[],
  visible: (item: T) => boolean,
  page: { limit: number; offset: number },
): T[] {
  const result: T[] = [];
  let rawOffset = 0;
  let visibleOffset = 0;
  for (;;) {
    const batch = load(500, rawOffset);
    for (const item of batch) {
      if (!visible(item)) continue;
      if (visibleOffset < page.offset) {
        visibleOffset += 1;
        continue;
      }
      result.push(item);
      if (result.length >= page.limit) return result;
    }
    if (batch.length < 500) return result;
    rawOffset += batch.length;
  }
}

function alertDurationSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 31_536_000) {
    throw new HttpError(400, "INVALID_FIELD", "durationSeconds must be an integer from 1 to 31536000");
  }
  return value;
}

function optionalQueryNumber(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Number(value))) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be a finite number`);
  }
  return Number(value);
}

export function persistWeatherObservation(database: ClimateDatabase, weather: HouseWeather, dataMode?: DataModeCoordinator): void {
  if (weather.stale || !weather.current || !Number.isFinite(weather.current.temperatureC)) return;
  database.upsertCurrentOutdoorTemperatureSample({
    houseId: weather.houseId,
    locationKey: outdoorLocationKey(weather.location),
    timestamp: weather.current.timestamp,
    temperatureC: weather.current.temperatureC as number,
    source: weather.provider === "fmi" ? "fmi-observation" : "open-meteo-current",
    fetchedAt: weather.fetchedAt,
    stationId: weather.observationStation?.id ?? null,
    stationName: weather.observationStation?.name ?? null,
    conditions: weather.current,
  });
  // The repository performs the irreversible latch only after verifying the
  // location key. Synchronize runtime listeners after that guarded write.
  dataMode?.synchronize();
}

function keyMatches(provided: string, expected: string): boolean {
  const first = Buffer.from(provided);
  const second = Buffer.from(expected);
  return first.length === second.length && timingSafeEqual(first, second);
}

const LOCAL_SESSION_COOKIE = "stuga_session";
const LOCAL_CSRF_COOKIE = "stuga_csrf";
const LOCAL_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

interface LocalRequestPrincipal extends LocalAuthIdentity {
  bootstrap: boolean;
  csrfToken?: string;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.header("cookie");
  if (!header || header.length > 16_384) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function secureRequest(request: Request, config: AppConfig): boolean {
  return request.secure || (trustedProxyRequest(request, config)
    && request.header("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase() === "https");
}

function setLocalSessionCookies(response: Response, request: Request, config: AppConfig, token: string, csrfToken: string): void {
  const common = {
    sameSite: "strict" as const,
    secure: secureRequest(request, config),
    path: "/api",
    maxAge: LOCAL_SESSION_MAX_AGE_MS,
  };
  response.cookie(LOCAL_SESSION_COOKIE, token, { ...common, httpOnly: true });
  response.cookie(LOCAL_CSRF_COOKIE, csrfToken, { ...common, httpOnly: false });
}

function clearLocalSessionCookies(response: Response, request: Request, config: AppConfig): void {
  const common = { sameSite: "strict" as const, secure: secureRequest(request, config), path: "/api" };
  response.clearCookie(LOCAL_SESSION_COOKIE, { ...common, httpOnly: true });
  response.clearCookie(LOCAL_CSRF_COOKIE, { ...common, httpOnly: false });
}

function isLoopbackSocket(request: Request): boolean {
  const address = request.socket.remoteAddress?.toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isPrivateProxySocket(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  if (/^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return normalized.startsWith("fc") || normalized.startsWith("fd");
}

function trustedProxyRequest(request: Request, config: AppConfig): boolean {
  const expected = config.localAuthProxySecret;
  const provided = request.header("x-stuga-local-proxy");
  return Boolean(expected
    && provided
    && isPrivateProxySocket(request.socket.remoteAddress)
    && keyMatches(provided, expected));
}

function localSetupRequestAllowed(request: Request, config: AppConfig): boolean {
  if (isLoopbackSocket(request)) return true;
  const configuredBind = config.localAuthProxyBindAddress?.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const loopbackBind = configuredBind === "127.0.0.1" || configuredBind === "::1" || configuredBind === "localhost";
  return loopbackBind
    && trustedProxyRequest(request, config);
}

function requireJsonContentType(request: Request): void {
  if (!request.is("application/json")) {
    throw new HttpError(415, "JSON_REQUIRED", "This endpoint requires an application/json request body");
  }
}

function sessionDocument(identity: LocalAuthIdentity, csrfToken?: string): AppSession {
  return {
    authenticated: true,
    principal: { type: "local", email: identity.email },
    tenant: { id: "local", name: "Local Stuga", role: identity.role },
    availableTenants: [{ id: "local", name: "Local Stuga", role: identity.role }],
    readOnly: identity.role === "guest",
    grants: identity.role === "guest" ? identity.grants : [],
    ...(csrfToken ? { csrfToken } : {}),
  };
}

function localAuthorizationFingerprint(identity: LocalAuthIdentity): string {
  const grants = identity.grants
    .map((grant) => `${grant.scopeType}:${grant.scopeId}`)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([identity.userId, identity.role, grants]))
    .digest("base64url");
}

function requestPrincipal(response: Response): LocalRequestPrincipal {
  const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
  if (!principal) throw new HttpError(401, "UNAUTHORIZED", "Sign in to access this endpoint");
  return principal;
}

function requireWorkspaceAdmin(_request: Request, response: Response, next: NextFunction): void {
  const principal = requestPrincipal(response);
  if (principal.role !== "owner" && principal.role !== "admin") {
    next(new HttpError(403, "FORBIDDEN", "Workspace administration requires an Owner or Admin account"));
    return;
  }
  next();
}

function requireNonGuest(_request: Request, response: Response, next: NextFunction): void {
  if (requestPrincipal(response).role === "guest") {
    next(new HttpError(403, "GUEST_READ_ONLY", "Guest accounts cannot access administrative configuration"));
    return;
  }
  next();
}

class LocalVisibility {
  readonly #propertyIds = new Set<string>();
  readonly #houseIds = new Set<string>();
  readonly #areaIds = new Set<string>();
  readonly #derivedPropertyIds = new Set<string>();
  readonly #houseAccess = new Map<string, boolean>();
  readonly #areaAccess = new Map<string, boolean>();
  readonly #equipmentAccess = new Map<string, boolean>();
  readonly #sensorAccess = new Map<string, boolean>();

  constructor(
    private readonly database: ClimateDatabase,
    private readonly principal: LocalRequestPrincipal,
  ) {
    for (const grant of principal.grants) {
      if (grant.scopeType === "property") this.#propertyIds.add(grant.scopeId);
      else if (grant.scopeType === "house") {
        this.#houseIds.add(grant.scopeId);
        const house = database.getHouse(grant.scopeId);
        if (house) this.#derivedPropertyIds.add(house.propertyId);
      } else {
        this.#areaIds.add(grant.scopeId);
        const area = database.getPropertyArea(grant.scopeId);
        if (area) this.#derivedPropertyIds.add(area.propertyId);
      }
    }
  }

  get restricted(): boolean { return this.principal.role === "guest"; }

  hasProperty(propertyId: string): boolean {
    return !this.restricted || this.#propertyIds.has(propertyId);
  }

  property(property: Property): Property | null {
    if (!this.restricted || this.#propertyIds.has(property.id)) return property;
    return this.#derivedPropertyIds.has(property.id)
      ? { ...property, description: null, location: null }
      : null;
  }

  house(houseId: string): boolean {
    if (!this.restricted) return true;
    const cached = this.#houseAccess.get(houseId);
    if (cached !== undefined) return cached;
    const house = this.database.getHouse(houseId);
    const allowed = Boolean(house && (this.#propertyIds.has(house.propertyId) || this.#houseIds.has(houseId)));
    this.#houseAccess.set(houseId, allowed);
    return allowed;
  }

  area(areaId: string): boolean {
    if (!this.restricted) return true;
    const cached = this.#areaAccess.get(areaId);
    if (cached !== undefined) return cached;
    const area = this.database.getPropertyArea(areaId);
    const allowed = Boolean(area && (this.#propertyIds.has(area.propertyId) || this.#areaIds.has(areaId)));
    this.#areaAccess.set(areaId, allowed);
    return allowed;
  }

  equipment(equipment: AreaEquipment): boolean {
    if (!this.restricted) return true;
    const cached = this.#equipmentAccess.get(equipment.id);
    if (cached !== undefined) return cached;
    const allowed = this.#propertyIds.has(equipment.propertyId) || this.area(equipment.areaId);
    this.#equipmentAccess.set(equipment.id, allowed);
    return allowed;
  }

  sensor(sensorId: string): boolean {
    if (!this.restricted) return true;
    const cached = this.#sensorAccess.get(sensorId);
    if (cached !== undefined) return cached;
    const sensor = this.database.getSensor(sensorId);
    const allowed = Boolean(sensor && this.house(sensor.houseId));
    this.#sensorAccess.set(sensorId, allowed);
    return allowed;
  }

  note(note: PropertyNote): boolean {
    if (!this.restricted || this.#propertyIds.has(note.propertyId)) return true;
    if (note.houseId) return this.house(note.houseId);
    if (note.areaId) return this.area(note.areaId);
    if (note.equipmentId) {
      const equipment = this.database.getAreaEquipment(note.equipmentId);
      return Boolean(equipment && this.equipment(equipment));
    }
    return false;
  }

  maintenance(task: MaintenanceTask): boolean {
    if (!this.restricted || this.#propertyIds.has(task.propertyId)) return true;
    const hasHouseContext = Boolean(task.houseId);
    const hasAreaContext = Boolean(task.areaId || task.equipmentId);
    if (!hasHouseContext && !hasAreaContext) return false;
    if (task.houseId && !this.house(task.houseId)) return false;
    if (task.areaId && !this.area(task.areaId)) return false;
    if (task.equipmentId) {
      const equipment = this.database.getAreaEquipment(task.equipmentId);
      if (!equipment || !this.equipment(equipment)) return false;
    }
    return true;
  }
}

interface AuthAttemptBucket {
  attempts: number;
  active: number;
  resetAt: number;
}

interface AuthAttemptLimit {
  key: string;
  maxAttempts: number;
  maxActive: number;
}

class AuthAbuseLimiter {
  readonly #buckets = new Map<string, AuthAttemptBucket>();
  #active = 0;

  enter(limits: readonly AuthAttemptLimit[], response: Response): () => void {
    const now = Date.now();
    this.prune(now);
    const uniqueLimits = [...new Map(limits.map((limit) => [limit.key, limit])).values()];
    const entries = uniqueLimits.map((limit) => {
      let bucket = this.#buckets.get(limit.key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { attempts: 0, active: 0, resetAt: now + 60_000 };
        this.#buckets.set(limit.key, bucket);
      }
      return { bucket, limit };
    });
    const limited = entries.find(({ bucket, limit }) => (
      bucket.attempts >= limit.maxAttempts || bucket.active >= limit.maxActive
    ));
    if (limited || this.#active >= 4) {
      const retrySeconds = limited && limited.bucket.attempts >= limited.limit.maxAttempts
        ? Math.max(1, Math.ceil((limited.bucket.resetAt - now) / 1_000))
        : 1;
      response.setHeader("retry-after", String(retrySeconds));
      throw new HttpError(429, "AUTH_RATE_LIMITED", "Too many authentication attempts; try again later");
    }
    for (const { bucket } of entries) {
      bucket.attempts += 1;
      bucket.active += 1;
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const { bucket } of entries) bucket.active = Math.max(0, bucket.active - 1);
      this.#active = Math.max(0, this.#active - 1);
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.resetAt <= now && bucket.active === 0) this.#buckets.delete(key);
    }
    if (this.#buckets.size <= 10_000) return;
    for (const key of this.#buckets.keys()) {
      this.#buckets.delete(key);
      if (this.#buckets.size <= 10_000) break;
    }
  }
}

function trustedProxyClientAddress(request: Request, config: AppConfig): string | null {
  if (!config.localAuthProxyBindAddress
    || !trustedProxyRequest(request, config)) return null;
  const candidate = request.header("x-real-ip")?.trim().toLowerCase();
  if (!candidate || candidate.includes(",") || isIP(candidate.replace(/^::ffff:/, "")) === 0) return null;
  return candidate.replace(/^::ffff:/, "");
}

function authAttemptKeys(request: Request, config: AppConfig, kind: string, subject: unknown): AuthAttemptLimit[] {
  const address = trustedProxyClientAddress(request, config)
    ?? request.socket.remoteAddress?.toLowerCase().replace(/^::ffff:/, "")
    ?? "unknown";
  const normalized = typeof subject === "string" ? subject.trim().toLowerCase() : "invalid";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return [
    { key: `auth:${address}:*`, maxAttempts: 60, maxActive: 4 },
    { key: `${kind}:subject:${digest}`, maxAttempts: 8, maxActive: 2 },
  ];
}

function appleNotesGrant(request: Request, config: AppConfig): AppleNotesGrantSecret {
  const authorization = request.header("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match) throw new HttpError(401, "APPLE_NOTES_UNAUTHORIZED", "A valid Apple Notes Shortcut bearer token is required");
  const tokenHash = `sha256:${createHash("sha256").update(match[1]!).digest("hex")}`;
  let grant: AppleNotesGrantSecret | undefined;
  for (const candidate of config.appleNotesGrants) {
    if (keyMatches(tokenHash, candidate.tokenHash)) grant = candidate;
  }
  if (!grant) throw new HttpError(401, "APPLE_NOTES_UNAUTHORIZED", "A valid Apple Notes Shortcut bearer token is required");
  return grant;
}

function appleNotesGrantSummary(grant: AppleNotesGrantSecret): Omit<AppleNotesGrantSecret, "tokenHash"> {
  const { tokenHash: _tokenHash, ...summary } = grant;
  return summary;
}

function refreshAppleNotesStatus(config: AppConfig, status: RuntimeStatus): void {
  const appleNotes = status.value.appleNotes!;
  appleNotes.configured = config.appleNotesGrants.length > 0;
  appleNotes.grantCount = config.appleNotesGrants.length;
  appleNotes.error = null;
  status.changed();
}

function notePlainLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function noteTaskBlock(task: MaintenanceTask): string {
  const schedule = task.dueBy
    ? `due ${task.dueBy}`
    : task.plannedFor ? `planned ${task.plannedFor}` : "no date";
  const lines = [
    `• ${notePlainLine(task.title)}`,
    `  Status: ${task.status}; priority: ${task.priority}; ${schedule}`,
    `  Basis: ${task.basis}${task.basisDetail ? ` — ${notePlainLine(task.basisDetail)}` : ""}`,
    ...(task.description ? [`  Details: ${notePlainLine(task.description)}`] : []),
  ];
  return lines.join("\n");
}

function appleNotesSnapshot(database: ClimateDatabase, houseId: string): AppleNotesSnapshot {
  const house = database.getHouse(houseId);
  if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
  const generatedAt = new Date().toISOString();
  const maintenanceTasks = database.listMaintenanceTasks(houseId);
  const title = `${notePlainLine(house.name)} maintenance — ${generatedAt.slice(0, 10)} — Stuga`;
  const lines = [
    title,
    `Generated by Stuga: ${generatedAt}`,
    "Stuga is the source of truth. Use this export to create a new dated generated note; checkboxes and edits in Notes are not imported.",
    "",
    ...(maintenanceTasks.length ? maintenanceTasks.map(noteTaskBlock) : ["No maintenance tasks."]),
  ];
  return { schema: "stuga.apple-notes-snapshot/v1", generatedAt, houseId, title, text: lines.join("\n"), maintenanceTasks };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function appleNotesCaptureInput(
  value: unknown,
): { operationId: string; input: MaintenanceTaskInput & { houseId: string } } {
  const body = bodyObject(value);
  if (body.schema !== "stuga.apple-notes-command/v1") {
    throw new HttpError(400, "INVALID_FIELD", "schema must be stuga.apple-notes-command/v1");
  }
  const operationId = requiredString(body, "operationId");
  if (!UUID_PATTERN.test(operationId)) throw new HttpError(400, "INVALID_FIELD", "operationId must be a UUID");
  const id = `apple-notes-${operationId.toLowerCase()}`;
  if (body.id !== undefined && body.id !== id) {
    throw new HttpError(400, "INVALID_FIELD", `id must be ${id} when provided`);
  }
  const candidate: Record<string, unknown> = { ...body, id };
  delete candidate.schema;
  delete candidate.operationId;
  const input = parseMaintenanceTaskInput(candidate);
  if (!input.houseId) throw new HttpError(400, "INVALID_FIELD", "houseId is required");
  return { operationId: operationId.toLowerCase(), input: { ...input, houseId: input.houseId } };
}

function appleNotesCaptureMatches(task: MaintenanceTask, input: MaintenanceTaskInput): boolean {
  return JSON.stringify({
    id: task.id,
    houseId: task.houseId,
    floorId: task.floorId,
    areaId: task.areaId,
    equipmentId: task.equipmentId,
    title: task.title,
    description: task.description,
    basis: task.basis,
    basisDetail: task.basisDetail,
    priority: task.priority,
    plannedFor: task.plannedFor,
    dueBy: task.dueBy,
    observationIds: task.observationIds,
  }) === JSON.stringify({
    id: input.id,
    houseId: input.houseId,
    floorId: input.floorId ?? null,
    areaId: input.areaId ?? null,
    equipmentId: input.equipmentId ?? null,
    title: input.title,
    description: input.description ?? null,
    basis: input.basis,
    basisDetail: input.basisDetail ?? null,
    priority: input.priority ?? "normal",
    plannedFor: input.plannedFor ?? null,
    dueBy: input.dueBy ?? null,
    observationIds: input.observationIds ?? [],
  });
}

const SAFE_ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "model/gltf+json",
  "model/gltf-binary",
]);

const RESERVED_MEASUREMENT_IDS = new Set(["__proto__", "constructor", "prototype"]);
const MEASUREMENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function measurementId(value: unknown, field = "metric"): string {
  if (typeof value !== "string" || value.length > 64 || !MEASUREMENT_ID_PATTERN.test(value) || RESERVED_MEASUREMENT_IDS.has(value)) {
    throw new HttpError(400, "INVALID_MEASUREMENT_ID", `${field} must be a safe lowercase registry identifier`);
  }
  return value;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(key) || typeof item !== "string" || !item.trim()) {
      throw new HttpError(400, "INVALID_FIELD", `${field} must contain non-empty labels keyed by language tag`);
    }
    result[key] = item.trim();
  }
  if (Object.keys(result).length === 0) throw new HttpError(400, "INVALID_FIELD", `${field} must contain at least one label`);
  return result;
}

function measurementNumberMap(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "number" || !Number.isFinite(item)) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be finite`);
    result[id] = item;
  }
  return result;
}

function measurementStringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "string" || !item.trim()) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be a non-empty entity id`);
    result[id] = item.trim();
  }
  return result;
}

function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be finite or null`);
  return value;
}

function validateMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
  if (!Number.isInteger(definition.precision) || definition.precision < 0 || definition.precision > 6) {
    throw new HttpError(400, "INVALID_FIELD", "precision must be an integer from 0 to 6");
  }
  if (!Number.isFinite(definition.interpolationDelta) || definition.interpolationDelta <= 0) {
    throw new HttpError(400, "INVALID_FIELD", "interpolationDelta must be positive and finite");
  }
  if (definition.validMin !== null && definition.validMax !== null && definition.validMin >= definition.validMax) {
    throw new HttpError(400, "INVALID_RANGE", "validMin must be less than validMax");
  }
  if (definition.displayMin !== null && definition.displayMax !== null && definition.displayMin >= definition.displayMax) {
    throw new HttpError(400, "INVALID_RANGE", "displayMin must be less than displayMax");
  }
  const displayBounds = [definition.displayMin, definition.displayMax].filter((value): value is number => value !== null);
  if (displayBounds.some((value) => (definition.validMin !== null && value < definition.validMin)
    || (definition.validMax !== null && value > definition.validMax))) {
    throw new HttpError(400, "INVALID_RANGE", "Display range must be within the valid range");
  }
  if (!definition.dimension?.trim()) throw new HttpError(400, "INVALID_FIELD", "dimension must be a non-empty string");
  if (!definition.allowedUnits?.length || definition.allowedUnits.some((unit) => !unit.trim())) {
    throw new HttpError(400, "INVALID_FIELD", "allowedUnits must contain at least one non-empty unit");
  }
  if (!definition.allowedUnits.includes(definition.unit)) {
    throw new HttpError(400, "INVALID_FIELD", "allowedUnits must include the canonical unit");
  }
  return definition;
}

function measurementUnits(value: unknown, canonicalUnit: string, current?: string[]): string[] {
  if (value === undefined) return current ?? [canonicalUnit];
  if (!Array.isArray(value) || value.length === 0 || value.length > 50
    || value.some((unit) => typeof unit !== "string" || !unit.trim() || unit.length > 50)) {
    throw new HttpError(400, "INVALID_FIELD", "allowedUnits must contain between 1 and 50 non-empty unit strings");
  }
  return [...new Set(value.map((unit) => (unit as string).trim()))];
}

export function parseMeasurementDefinition(value: unknown, current?: MeasurementDefinition): MeasurementDefinition {
  const body = bodyObject(value);
  if ((current && body.id !== undefined) || body.builtin !== undefined) {
    throw new HttpError(409, "IMMUTABLE_FIELD", "Measurement definition id and builtin status cannot be changed");
  }
  const canonicalUnit = body.unit === undefined ? current?.unit ?? requiredString(body, "unit") : requiredString(body, "unit");
  const inheritedAllowedUnits = body.unit !== undefined && body.allowedUnits === undefined
    ? [canonicalUnit, ...(current?.allowedUnits ?? []).filter((unit) => unit !== canonicalUnit)]
    : current?.allowedUnits;
  const definition: MeasurementDefinition = {
    id: current?.id ?? measurementId(body.id, "id"),
    labels: body.labels === undefined ? current?.labels ?? (() => { throw new HttpError(400, "INVALID_FIELD", "labels is required"); })() : stringMap(body.labels, "labels"),
    unit: canonicalUnit,
    dimension: body.dimension === undefined ? current?.dimension ?? "finite_scalar" : requiredString(body, "dimension"),
    allowedUnits: measurementUnits(body.allowedUnits, canonicalUnit, inheritedAllowedUnits),
    kind: body.kind === undefined ? current?.kind ?? "gauge" : enumValue(body.kind, ["gauge", "rate", "increment", "cumulative_counter", "binary_state", "categorical_state"] as const, "kind"),
    defaultAggregation: body.defaultAggregation === undefined ? current?.defaultAggregation ?? "mean" : enumValue(body.defaultAggregation, ["mean", "sum", "delta", "last", "time_weighted_mean", "duration", "custom"] as const, "defaultAggregation"),
    genericHistoryEnabled: body.genericHistoryEnabled === undefined ? current?.genericHistoryEnabled ?? true : optionalBoolean(body, "genericHistoryEnabled") as boolean,
    genericStatsEnabled: body.genericStatsEnabled === undefined ? current?.genericStatsEnabled ?? true : optionalBoolean(body, "genericStatsEnabled") as boolean,
    precision: body.precision === undefined ? current?.precision ?? 1 : (() => {
      if (typeof body.precision !== "number" || !Number.isInteger(body.precision)) {
        throw new HttpError(400, "INVALID_FIELD", "precision must be an integer from 0 to 6");
      }
      return body.precision;
    })(),
    validMin: body.validMin === undefined ? current?.validMin ?? null : nullableFinite(body.validMin, "validMin"),
    validMax: body.validMax === undefined ? current?.validMax ?? null : nullableFinite(body.validMax, "validMax"),
    displayMin: body.displayMin === undefined ? current?.displayMin ?? null : nullableFinite(body.displayMin, "displayMin"),
    displayMax: body.displayMax === undefined ? current?.displayMax ?? null : nullableFinite(body.displayMax, "displayMax"),
    interpolationDelta: body.interpolationDelta === undefined ? current?.interpolationDelta ?? 1 : requiredNumber(body, "interpolationDelta"),
    colorScale: body.colorScale === undefined ? current?.colorScale ?? "sequential" : enumValue(body.colorScale, ["thermal", "humidity", "air-quality", "sequential"] as const, "colorScale"),
    builtin: current?.builtin ?? false,
    enabled: body.enabled === undefined ? current?.enabled ?? true : optionalBoolean(body, "enabled") as boolean,
    spatialInterpolation: body.spatialInterpolation === undefined ? current?.spatialInterpolation ?? false : optionalBoolean(body, "spatialInterpolation") as boolean,
    forecastSupported: body.forecastSupported === undefined ? current?.forecastSupported ?? false : optionalBoolean(body, "forecastSupported") as boolean,
  };
  return validateMeasurementDefinition(definition);
}

export function parseMeasurementSample(value: unknown, database: ClimateDatabase): MeasurementSample {
  const body = bodyObject(value);
  const metric = measurementId(body.metric);
  const definition = database.getMeasurementDefinition(metric);
  const canonicalUnit = body.canonicalUnit === undefined ? definition?.unit ?? "" : requiredString(body, "canonicalUnit");
  return {
    sensorId: requiredString(body, "sensorId"),
    metric,
    value: requiredNumber(body, "value"),
    canonicalUnit,
    timestamp: dateValue(body.timestamp, new Date(), "timestamp"),
    // External REST/MCP callers cannot assert trusted integration provenance.
    // Historical traffic is assigned `import` only by the dedicated import path.
    source: "api",
    quality: body.quality === undefined ? "good" : enumValue(body.quality, ["good", "estimated", "stale"] as const, "quality"),
  };
}

export function parseReading(value: unknown): Reading {
  const body = bodyObject(value);
  const temperature = requiredNumber(body, "temperature");
  const humidity = requiredNumber(body, "humidity");
  const batteryValue = body.battery;
  if (temperature < -80 || temperature > 100) throw new HttpError(400, "OUT_OF_RANGE", "temperature must be between -80 and 100 °C");
  if (humidity < 0 || humidity > 100) throw new HttpError(400, "OUT_OF_RANGE", "humidity must be between 0 and 100 percent");
  if (batteryValue !== undefined && batteryValue !== null && (typeof batteryValue !== "number" || batteryValue < 0 || batteryValue > 100)) {
    throw new HttpError(400, "OUT_OF_RANGE", "battery must be null or between 0 and 100 percent");
  }
  return {
    sensorId: requiredString(body, "sensorId"),
    timestamp: dateValue(body.timestamp, new Date(), "timestamp"),
    temperature,
    humidity,
    battery: typeof batteryValue === "number" ? batteryValue : null,
    source: "api",
    quality: body.quality === undefined ? "good" : enumValue(body.quality, ["good", "estimated", "stale"] as const, "quality"),
    ...(body.measurements !== undefined ? { measurements: measurementNumberMap(body.measurements, "measurements") } : {}),
  };
}

export function parseAlertRule(value: unknown, database: ClimateDatabase): Omit<AlertRule, "id"> & { id?: string } {
  const body = bodyObject(value);
  const sensorId = body.sensorId;
  if (sensorId !== null && sensorId !== undefined && typeof sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId must be a string or null");
  const sensor = typeof sensorId === "string" ? database.getSensor(sensorId) : null;
  const fallbackTimeZone = sensor ? database.getHouse(sensor.houseId)?.timezone ?? "UTC" : "UTC";
  return {
    ...(typeof body.id === "string" ? { id: body.id } : {}),
    name: requiredString(body, "name"),
    sensorId: typeof sensorId === "string" ? sensorId : null,
    metric: (() => {
      const metric = measurementId(body.metric);
      if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
      return metric;
    })(),
    operator: enumValue(body.operator, ["gt", "gte", "lt", "lte"] as const, "operator"),
    threshold: requiredNumber(body, "threshold"),
    durationSeconds: alertDurationSeconds(body.durationSeconds),
    severity: enumValue(body.severity, ["info", "warning", "critical"] as const, "severity"),
    enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
    webhookEnabled: body.webhookEnabled === undefined ? false : optionalBoolean(body, "webhookEnabled") as boolean,
    telegramEnabled: body.telegramEnabled === undefined ? false : optionalBoolean(body, "telegramEnabled") as boolean,
    deliveryPolicy: parseAlertDeliveryPolicy(body.deliveryPolicy, fallbackTimeZone),
  };
}

function parseAlertDeliveryPolicy(value: unknown, fallbackTimeZone = "UTC"): AlertDeliveryPolicy {
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new HttpError(400, "INVALID_FIELD", "deliveryPolicy must be an object");
  }
  try {
    return normalizeAlertDeliveryPolicy(value as Partial<AlertDeliveryPolicy> | undefined, fallbackTimeZone);
  } catch (error) {
    throw new HttpError(400, "INVALID_FIELD", error instanceof Error ? error.message : "deliveryPolicy is invalid");
  }
}

function parseActionPlaybookInput(value: unknown, partial = false): ActionPlaybookInput | Partial<ActionPlaybookInput> {
  const body = bodyObject(value);
  const text = (key: "name" | "description"): string | undefined => {
    if (body[key] === undefined && partial) return undefined;
    const result = requiredString(body, key);
    if (Array.from(result).length > (key === "name" ? 160 : 2_000)) {
      throw new HttpError(400, "INVALID_FIELD", `${key} is too long`);
    }
    return result;
  };
  const instructions = body.instructions === undefined && partial ? undefined : (() => {
    if (!Array.isArray(body.instructions) || body.instructions.length < 1 || body.instructions.length > 20
      || body.instructions.some((item) => typeof item !== "string" || !item.trim() || item.length > 500)) {
      throw new HttpError(400, "INVALID_FIELD", "instructions must contain 1–20 concise steps");
    }
    return body.instructions.map((item) => (item as string).trim());
  })();
  const numeric = (key: "minimumImprovement" | "targetValue" | "waitSeconds" | "verificationWindowSeconds"): number | null | undefined => {
    if (body[key] === undefined) return partial ? undefined : key === "targetValue" ? null : requiredNumber(body, key);
    if (body[key] === null && key === "targetValue") return null;
    return requiredNumber(body, key);
  };
  return {
    ...(body.id !== undefined ? { id: requiredString(body, "id") } : {}),
    ...(text("name") !== undefined ? { name: text("name")! } : {}),
    ...(text("description") !== undefined ? { description: text("description")! } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(body.metric !== undefined || !partial ? { metric: measurementId(body.metric) } : {}),
    ...(body.goal !== undefined || !partial ? { goal: enumValue(body.goal, ["decrease", "increase", "below", "above"] as const, "goal") } : {}),
    ...(numeric("minimumImprovement") !== undefined ? { minimumImprovement: numeric("minimumImprovement")! } : {}),
    ...(numeric("targetValue") !== undefined ? { targetValue: numeric("targetValue") ?? null } : {}),
    ...(numeric("waitSeconds") !== undefined ? { waitSeconds: numeric("waitSeconds")! } : {}),
    ...(numeric("verificationWindowSeconds") !== undefined ? { verificationWindowSeconds: numeric("verificationWindowSeconds")! } : {}),
    ...(body.enabled !== undefined ? { enabled: optionalBoolean(body, "enabled") as boolean } : {}),
  } as ActionPlaybookInput | Partial<ActionPlaybookInput>;
}

function parseActionRunStart(value: unknown): ActionRunStartInput {
  const body = bodyObject(value);
  return {
    playbookId: requiredString(body, "playbookId"),
    sensorId: requiredString(body, "sensorId"),
    ...(body.alertEventId !== undefined ? { alertEventId: body.alertEventId === null ? null : requiredString(body, "alertEventId") } : {}),
    ...(body.maintenanceTaskId !== undefined ? { maintenanceTaskId: body.maintenanceTaskId === null ? null : requiredString(body, "maintenanceTaskId") } : {}),
    ...(body.operatorNote !== undefined ? { operatorNote: body.operatorNote === null ? null : requiredString(body, "operatorNote") } : {}),
  };
}

export function parseSensorPatch(value: unknown): SensorUpdate {
  const body = bodyObject(value);
  const patch: SensorUpdate = {};
  for (const key of ["houseId", "floorId", "name", "room", "model"] as const) {
    if (body[key] !== undefined) Object.assign(patch, { [key]: requiredString(body, key) });
  }
  for (const key of ["x", "y", "z"] as const) {
    if (body[key] !== undefined) Object.assign(patch, { [key]: requiredNumber(body, key) });
  }
  if (body.roomId !== undefined) {
    patch.roomId = body.roomId === null ? null : requiredString(body, "roomId");
  }
  for (const key of ["temperatureEntityId", "humidityEntityId", "batteryEntityId"] as const) {
    if (body[key] !== undefined) Object.assign(patch, { [key]: requiredString(body, key) });
  }
  if (body.tpLinkDeviceId !== undefined) {
    patch.tpLinkDeviceId = body.tpLinkDeviceId === null ? null : requiredString(body, "tpLinkDeviceId");
  }
  if (body.tpLinkConnectionId !== undefined) {
    patch.tpLinkConnectionId = body.tpLinkConnectionId === null ? null : requiredString(body, "tpLinkConnectionId");
  }
  if (body.measurementEntityIds !== undefined) patch.measurementEntityIds = measurementStringMap(body.measurementEntityIds, "measurementEntityIds");
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
    patch.tags = body.tags as string[];
  }
  if (body.enabled !== undefined) patch.enabled = optionalBoolean(body, "enabled") as boolean;
  return patch;
}

export interface ApiRuntime {
  app: express.Express;
  database: ClimateDatabase;
  integrationMetadata: IntegrationMetadataStore;
  bus: TelemetryBus;
  telemetry: TelemetryService;
  measurements: MeasurementService;
  mock: MockEngine;
  replay: ReplayEngine;
  status: RuntimeStatus;
  homeAssistant: HomeAssistantBridge;
  tpLink: TpLinkBridge;
  tapoHistory: TapoHistoryExportService;
  electricityPrices: ElectricityPriceService;
  telegram: TelegramService;
  weather: WeatherService;
  weatherMonitor: WeatherMonitor;
  weatherRecovery: WeatherRecoveryCoordinator;
  sensorGapRecovery: SensorGapRecoveryCoordinator;
  weatherEvents: WeatherEventBroker;
  dataMode: DataModeCoordinator;
  notificationOutbox: NotificationOutboxWorker;
  dataOperations: DataOperationsService;
  energyOptimizer: EnergyOptimizer;
  energyCost: EnergyCostService;
  setupDoctor: SetupDoctor;
  cloudflareAccess: CloudflareAccessGroupSynchronizer | null;
  spatialLayers: LocalSpatialLayerRuntime | null;
  timeseries: TimeseriesStore | null;
  telemetryArchive: TelemetryArchiveWorker | null;
  telemetryReader: HybridTelemetryReader;
  ready: () => Promise<void>;
  beginShutdown: () => Promise<void>;
  close: () => Promise<void>;
}

export interface IntegrationDraftTestResult {
  ok: boolean;
  connected: boolean;
  message: string;
  details?: Record<string, unknown>;
}

function publicTapoHistoryExportJob(job: TapoHistoryExportJob): Omit<TapoHistoryExportJob,
  "dedupeKey" | "expectedDeviceId" | "rangeStart" | "rangeEnd" | "attempt"
  | "deploymentFingerprint" | "acceptanceRevision" | "expectedSchemaSignature"> {
  const redactRecipient = (value: string | null): string | null => value && job.expectedRecipient
    ? value.replaceAll(job.expectedRecipient, "[redacted export recipient]")
    : value;
  return {
    id: job.id,
    canary: job.canary,
    provider: job.provider,
    sensorId: job.sensorId,
    deviceId: job.deviceId,
    deviceName: job.deviceName,
    timeZone: job.timeZone,
    metric: job.metric,
    // Correlation aliases and mailbox ids are capabilities, not operator UI data.
    expectedRecipient: null,
    from: job.from,
    to: job.to,
    intervalMinutes: job.intervalMinutes,
    status: job.status,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    submittedAt: job.submittedAt,
    mailboxMessageId: null,
    sourceArtifactSha256: job.sourceArtifactSha256,
    sourceArtifactBytes: job.sourceArtifactBytes,
    parserVersion: job.parserVersion,
    sourceSchemaSignature: job.sourceSchemaSignature,
    stagedSampleCount: job.stagedSampleCount,
    consumedSampleCount: job.consumedSampleCount,
    lastError: redactRecipient(job.lastError),
    attentionReason: redactRecipient(job.attentionReason),
    detail: redactRecipient(job.detail),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

function workerTapoHistoryExportJob(job: TapoHistoryExportJob): Pick<TapoHistoryExportJob,
  "id" | "sensorId" | "deviceId" | "deviceName" | "metric" | "from" | "to" | "timeZone"
  | "intervalMinutes" | "expectedRecipient" | "status" | "attemptCount" | "leaseExpiresAt"> {
  return {
    id: job.id,
    sensorId: job.sensorId,
    deviceId: job.deviceId,
    deviceName: job.deviceName,
    metric: job.metric,
    from: job.from,
    to: job.to,
    timeZone: job.timeZone,
    intervalMinutes: job.intervalMinutes,
    expectedRecipient: job.expectedRecipient,
    status: job.status,
    attemptCount: job.attemptCount,
    leaseExpiresAt: job.leaseExpiresAt,
  };
}

export interface CreateApiOptions {
  config?: AppConfig;
  database?: ClimateDatabase;
  weatherProvider?: WeatherProvider;
  weatherEventBroker?: WeatherEventBroker;
  locationDiscovery?: LocationDiscoveryService;
  telegram?: TelegramService;
  homeAssistantCredentialTester?: (url: string, token: string) => Promise<IntegrationDraftTestResult>;
  tpLinkCredentialTester?: (host: string, username: string, password: string) => Promise<IntegrationDraftTestResult>;
  electricityPriceFetcher?: typeof fetch;
  cloudflareAccessFetcher?: typeof fetch;
  electricityEndpointResolver?: ElectricityEndpointResolver;
  /** Test/embedding hook; normal deployments resolve aliases from live TP-Link discovery. */
  tapoHistoryDeviceNameFor?: (sensorId: string, deviceId: string) => string | null;
  /** Test/embedding clock for durable Tapo history transitions. */
  tapoHistoryNow?: () => Date;
  timeseriesStore?: TimeseriesStore;
  telemetryReader?: HybridTelemetryReader;
  startBackground?: boolean;
}

function sameHomeAssistantCredential(
  left: IntegrationSecrets["homeAssistant"],
  right: { url: string | null; token: string | null },
): boolean {
  return Boolean(left && left.url === right.url && left.token === right.token);
}

function sameTpLinkCredential(
  left: IntegrationSecrets["tpLink"],
  right: { host: string | null; username: string | null; password: string | null },
): boolean {
  return Boolean(left && left.host === right.host && left.username === right.username && left.password === right.password);
}

function sameTelegramCredential(
  left: IntegrationSecrets["telegram"],
  right: { botToken: string | null; chatId: string | null },
): boolean {
  return Boolean(left && left.botToken === right.botToken && left.chatId === right.chatId);
}

function mirrorEnvironmentWebhook(config: AppConfig): void {
  if (config.alertWebhookSource !== "environment" || !config.alertWebhookUrl) return;
  const webhook: NonNullable<IntegrationSecrets["webhook"]> = {
    url: config.alertWebhookUrl,
    ...(config.alertWebhookBearerToken ? { bearerToken: config.alertWebhookBearerToken } : {}),
    ...(config.alertWebhookSigningSecret ? { signingSecret: config.alertWebhookSigningSecret } : {}),
  };
  try {
    const fileExists = existsSync(config.integrationSecretsFile);
    const existing = fileExists
      ? readIntegrationSecrets(config.integrationSecretsFile).webhook
      : undefined;
    if (existing?.url === webhook.url && existing.bearerToken === webhook.bearerToken
      && existing.signingSecret === webhook.signingSecret) return;
    updateIntegrationSecrets(config.integrationSecretsFile, {
      webhook,
      ...(!fileExists ? { metadataSnapshotIncomplete: true } : {}),
    });
  } catch {
    // Environment configuration remains usable. A missing/unreadable protected
    // store must never trigger metadata pruning or reveal credential details.
  }
}

function initializeIntegrationMetadata(config: AppConfig, database: ClimateDatabase): IntegrationMetadataStore {
  const store = new IntegrationMetadataStore(database);
  const protectedFileExistedAtStart = existsSync(config.integrationSecretsFile);
  mirrorEnvironmentWebhook(config);
  let protectedSecrets: IntegrationSecrets | null = null;
  let authoritative = false;
  if (existsSync(config.integrationSecretsFile)) {
    try {
      protectedSecrets = readIntegrationSecrets(config.integrationSecretsFile);
      authoritative = protectedFileExistedAtStart && protectedSecrets.metadataSnapshotIncomplete !== true;
    } catch {
      // Fail closed: keep last-known metadata active until a validated snapshot
      // can prove that its credential reference was intentionally removed.
    }
  }
  const metadataSecrets: IntegrationSecrets = protectedSecrets
    ? {
        ...protectedSecrets,
        ...(protectedSecrets.homeAssistantConnections
          ? { homeAssistantConnections: protectedSecrets.homeAssistantConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(protectedSecrets.tpLinkConnections
          ? { tpLinkConnections: protectedSecrets.tpLinkConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(protectedSecrets.appleNotesGrants
          ? { appleNotesGrants: protectedSecrets.appleNotesGrants.map((grant) => ({ ...grant })) }
          : {}),
      }
    : {
        version: 1,
        ...(config.homeAssistantConnections
          ? { homeAssistantConnections: config.homeAssistantConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(config.tpLinkConnections
          ? { tpLinkConnections: config.tpLinkConnections.map((connection) => ({ ...connection })) }
          : {}),
        ...(config.appleNotesGrants.length
          ? { appleNotesGrants: config.appleNotesGrants.map((grant) => ({ ...grant })) }
          : {}),
      };
  const firstHouseId = database.listHouses()[0]?.id ?? null;
  const homeAssistantFromEnvironment = Boolean(
    firstHouseId && !config.homeAssistantLegacyDisabled && config.haUrl && config.haToken
      && !sameHomeAssistantCredential(protectedSecrets?.homeAssistant, { url: config.haUrl, token: config.haToken }),
  );
  const tpLinkFromEnvironment = Boolean(
    firstHouseId && !config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
      && !sameTpLinkCredential(protectedSecrets?.tpLink, {
        host: config.tpLinkHost, username: config.tpLinkUsername, password: config.tpLinkPassword,
      }),
  );
  const telegramFromEnvironment = Boolean(
    config.telegramBotToken && config.telegramChatId
      && !sameTelegramCredential(protectedSecrets?.telegram, {
        botToken: config.telegramBotToken, chatId: config.telegramChatId,
      }),
  );
  const webhookFromEnvironment = config.alertWebhookSource === "environment" && Boolean(config.alertWebhookUrl);
  if (homeAssistantFromEnvironment) delete metadataSecrets.homeAssistant;
  if (tpLinkFromEnvironment) delete metadataSecrets.tpLink;
  if (telegramFromEnvironment) delete metadataSecrets.telegram;
  if (webhookFromEnvironment) delete metadataSecrets.webhook;
  store.reconcileEnvironment({
    homeAssistant: homeAssistantFromEnvironment && firstHouseId && config.haUrl
      ? { houseId: firstHouseId, url: config.haUrl }
      : null,
    tpLink: tpLinkFromEnvironment && firstHouseId && config.tpLinkHost
      ? { houseId: firstHouseId, host: config.tpLinkHost }
      : null,
    telegramConfigured: telegramFromEnvironment,
    webhookConfigured: webhookFromEnvironment,
  });
  store.reconcileProtectedFile({ authoritative, secrets: metadataSecrets, legacyHouseId: firstHouseId });
  return store;
}

export function createApi(options: CreateApiOptions = {}): ApiRuntime {
  const config = options.config ?? loadConfig();
  // Keep programmatic callers built against older AppConfig shapes compatible.
  config.telegramBotToken ??= null;
  config.telegramChatId ??= null;
  config.alertWebhookSource ??= config.alertWebhookUrl ? "environment" : null;
  config.alertWebhookSigningSecret ??= null;
  config.alertWebhookAllowedHosts ??= config.alertWebhookUrl ? [new URL(config.alertWebhookUrl).hostname.toLowerCase()] : [];
  config.appleNotesGrants ??= [];
  config.homeAssistantLegacyDisabled ??= false;
  config.tpLinkLegacyDisabled ??= false;
  config.tapoHistoryEnabled ??= false;
  config.tapoHistoryWorkerToken ??= null;
  config.tapoHistoryExportEmail ??= null;
  config.tapoHistoryEmailTagPrefix ??= "stuga";
  config.tapoHistoryExportIntervalMinutes ??= 15;
  config.tapoHistoryMaxExportDays ??= 30;
  config.tapoHistoryMaxPendingEmails ??= 1;
  config.tapoHistoryMailboxPollIntervalMs ??= 60_000;
  config.tapoHistoryEmailTimeoutMs ??= 6 * 60 * 60_000;
  config.tapoHistoryWorkerLeaseMs ??= 5 * 60_000;
  config.tapoHistoryGmailClientId ??= null;
  config.tapoHistoryGmailClientSecret ??= null;
  config.tapoHistoryGmailRefreshToken ??= null;
  config.tapoHistoryPrivateEndpoint ??= null;
  config.tapoHistoryPrivateToken ??= null;
  // Older in-memory test fixtures predate local authentication. Preserve their
  // trusted harness behavior without ever enabling the bypass outside tests.
  config.localAuthTestBypass ??= process.env.NODE_ENV === "test";
  config.cloudflareAccessAccountId ??= null;
  config.cloudflareAccessGroupId ??= null;
  config.cloudflareAccessGroupName ??= null;
  config.cloudflareAccessApiToken ??= null;
  config.cloudflareAccessSyncIntervalMs ??= 5 * 60_000;
  config.electricityAllowPrivateEndpoints ??= false;
  config.timeseriesEnabled ??= false;
  config.timeseriesRequired ??= false;
  config.timeseriesHost ??= "127.0.0.1";
  config.timeseriesPort ??= 5432;
  config.timeseriesDatabase ??= "stuga";
  config.timeseriesUser ??= "stuga_app";
  config.timeseriesPassword ??= "";
  config.timeseriesSslMode ??= "disable";
  config.timeseriesSslCa ??= null;
  config.timeseriesPoolMax ??= 6;
  config.timeseriesConnectTimeoutMs ??= 5_000;
  config.timeseriesStatementTimeoutMs ??= 15_000;
  config.timeseriesBatchSize ??= 1_000;
  if (config.timeseriesRequired && !config.timeseriesEnabled) {
    throw new Error("timeseriesRequired=true requires timeseriesEnabled=true");
  }
  const database = options.database ?? new ClimateDatabase(config.databasePath);
  const dataOperations = new DataOperationsService(database, config);
  const energyOptimizer = new EnergyOptimizer(database);
  const integrationMetadata = initializeIntegrationMetadata(config, database);
  const localAuth = new LocalAuthStore(database);
  const cloudflareAccess = config.cloudflareAccessAccountId
    && config.cloudflareAccessGroupId
    && config.cloudflareAccessGroupName
    && config.cloudflareAccessApiToken
    ? new CloudflareAccessGroupSynchronizer({
      accountId: config.cloudflareAccessAccountId,
      groupId: config.cloudflareAccessGroupId,
      groupName: config.cloudflareAccessGroupName,
      apiToken: config.cloudflareAccessApiToken,
      syncIntervalMs: config.cloudflareAccessSyncIntervalMs,
    }, () => {
      if (!localAuth.isInitialized()) return null;
      const directory = localAuth.listWorkspaceMembers();
      return [...directory.members, ...directory.invitations].map((entry) => entry.email);
    }, options.cloudflareAccessFetcher, () => {
      // This intentionally omits account, group, email, and provider details.
      console.error("[cloudflare-access] Member allowlist synchronization is pending");
    })
    : null;
  const authAbuseLimiter = new AuthAbuseLimiter();
  const dataMode = new DataModeCoordinator(database);
  if ((config.homeAssistantConnections?.length ?? 0) > 0
    || (!config.homeAssistantLegacyDisabled && config.haUrl && config.haToken)
    || (config.tpLinkConnections?.length ?? 0) > 0
    || (!config.tpLinkLegacyDisabled && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword)) {
    dataMode.activate();
  }
  const bus = new TelemetryBus();
  const timeseriesSsl = config.timeseriesSslMode === "disable"
    ? undefined
    : config.timeseriesSslMode === "require"
      ? { rejectUnauthorized: false }
      : config.timeseriesSslMode === "verify-ca"
        ? {
          rejectUnauthorized: true,
          ...(config.timeseriesSslCa ? { ca: config.timeseriesSslCa } : {}),
          checkServerIdentity: () => undefined,
        }
        : {
          rejectUnauthorized: true,
          ...(config.timeseriesSslCa ? { ca: config.timeseriesSslCa } : {}),
          ...(isIP(config.timeseriesHost) === 0 ? { servername: config.timeseriesHost } : {}),
        };
  const timeseries = config.timeseriesEnabled ? options.timeseriesStore ?? new TimeseriesStore({
    poolConfig: {
      host: config.timeseriesHost,
      port: config.timeseriesPort,
      database: config.timeseriesDatabase,
      user: config.timeseriesUser,
      password: config.timeseriesPassword,
      ...(timeseriesSsl ? { ssl: timeseriesSsl } : {}),
    },
    maxConnections: config.timeseriesPoolMax,
    connectionTimeoutMs: config.timeseriesConnectTimeoutMs,
    statementTimeoutMs: config.timeseriesStatementTimeoutMs,
    batchSize: config.timeseriesBatchSize,
  }) : null;
  const telemetryArchive = timeseries
    ? new TelemetryArchiveWorker(database, bus, timeseries, {
      batchSize: config.timeseriesBatchSize,
      requireTimescale: config.timeseriesRequired,
    })
    : null;
  const telemetryRetention = telemetryArchive && config.retentionDays > 0
    ? new TelemetryRetentionWorker(database, telemetryArchive, config.retentionDays)
    : null;
  const telemetryReader = options.telemetryReader ?? new HybridTelemetryReader({
    local: database,
    archive: timeseries,
    archivePhase: () => telemetryArchive?.status().phase,
    reconcile: () => telemetryArchive?.reconcileNow(),
    localHistoryComplete: !telemetryRetention
      ? true
      : (query) => Date.parse(query.from) >= Date.now() - config.retentionDays * 86_400_000,
  });
  const measurementSnapshotCache = new LruTtlCache<MeasurementSample[]>({
    maxEntries: 64,
    maxBytes: 8 * 1024 * 1024,
    defaultTtlMs: 2_000,
  });
  const readingSnapshotCache = new LruTtlCache<Reading[]>({
    maxEntries: 4,
    maxBytes: 4 * 1024 * 1024,
    defaultTtlMs: 2_000,
  });
  const status = new RuntimeStatus(config, bus, database);
  const setupDoctor = new SetupDoctor(database, config, status, dataOperations, telemetryArchive);
  const energyCost = new EnergyCostService(telemetryReader);
  const storedTelegramIdentity = integrationMetadata.get("telegram", "singleton");
  if (status.value.telegram?.configured && storedTelegramIdentity?.active) {
    status.value.telegram.botUsername = storedTelegramIdentity.label;
    status.value.telegram.chatLabel = storedTelegramIdentity.secondaryLabel;
  }
  const telegram = options.telegram ?? new TelegramService();
  let telegramDeliveryGeneration = 0;
  const alertEngine = new AlertEngine(database, bus, config, status, telegram);
  const telemetry = new TelemetryService(database, bus, alertEngine, dataMode);
  const measurements = new MeasurementService(database, bus, alertEngine, dataMode);
  const notificationOutbox = new NotificationOutboxWorker(
    database,
    config,
    status,
    telegram,
    fetch,
    () => telegramDeliveryGeneration,
  );
  const mock = new MockEngine(database, telemetry, config, dataMode);
  const replay = new ReplayEngine(database, bus);
  let sensorGapRecovery: SensorGapRecoveryCoordinator | null = null;
  let tpLink: TpLinkBridge;
  const wakeSensorGapRecovery = (): void => sensorGapRecovery?.wake();
  const tapoHistory = new TapoHistoryExportService(config, database, {
    onHistoryReady: wakeSensorGapRecovery,
    ...(options.tapoHistoryNow ? { now: options.tapoHistoryNow } : {}),
    deviceNameFor: options.tapoHistoryDeviceNameFor
      ?? ((sensorId, deviceId) => tpLink?.tapoAppDeviceName(sensorId, deviceId) ?? null),
  });
  const homeAssistant = new HomeAssistantBridge(config, telemetry, measurements, database, status, {
    onAvailabilityChange: wakeSensorGapRecovery,
  });
  tpLink = new TpLinkBridge(config, telemetry, measurements, database, status, {
    onAvailabilityChange: wakeSensorGapRecovery,
    historyFallback: tapoHistory,
    onConnectionUpdate: (update) => {
      const existing = config.tpLinkConnections ?? [];
      const current = existing.find((connection) => connection.id === update.id);
      if (!current || current.houseId !== update.houseId) return;
      if (update.host !== current.host && current.host !== update.previousHost) return;
      if (update.deviceId && update.deviceId.length > 1_024) return;
      if (current.deviceId && update.deviceId
        && current.deviceId.trim().toUpperCase() !== update.deviceId.trim().toUpperCase()) return;
      const nextConnection: TpLinkConnectionSecret = {
        ...current,
        host: update.host,
        ...(update.deviceId ? { deviceId: update.deviceId } : {}),
      };
      if (nextConnection.host === current.host && nextConnection.deviceId === current.deviceId) return;
      const connections = existing.map((connection) => connection.id === current.id ? nextConnection : connection);
      updateIntegrationSecrets(config.integrationSecretsFile, { tpLinkConnections: connections });
      config.tpLinkConnections = connections;
      integrationMetadata.saveTpLink({
        id: nextConnection.id,
        houseId: nextConnection.houseId,
        host: nextConnection.host,
        reason: "identity-refreshed",
      });
    },
  });
  sensorGapRecovery = new SensorGapRecoveryCoordinator(database, measurements, [homeAssistant, tpLink], {
    onRecovered: () => {
      measurementSnapshotCache.clear();
      return telemetryArchive?.reconcileNow();
    },
  });
  const electricityPrices = new ElectricityPriceService(
    database,
    options.electricityPriceFetcher ?? fetch,
    undefined,
    {
      allowPrivateNetwork: config.electricityAllowPrivateEndpoints,
      ...(options.electricityEndpointResolver ? { resolver: options.electricityEndpointResolver } : {}),
    },
  );
  const homeAssistantCredentialTester = options.homeAssistantCredentialTester ?? testHomeAssistantCredentials;
  const tpLinkCredentialTester = options.tpLinkCredentialTester
    ?? ((host: string, username: string, password: string) => tpLink.testCredentials(host, username, password));
  const locationDiscovery = options.locationDiscovery ?? new LocationDiscoveryService();
  const weatherProvider = options.weatherProvider ?? new AutomaticWeatherProvider(
      new FmiWeatherProvider(),
      new OpenMeteoWeatherProvider(),
    );
  const weatherRecovery = new WeatherRecoveryCoordinator(database, weatherProvider, {
    onRecovered: () => telemetryArchive?.reconcileNow(),
  });
  const weather = new WeatherService(
    weatherProvider,
    status.value.weather,
    () => status.changed(),
    undefined,
    undefined,
    undefined,
    weatherRecovery,
  );
  const weatherEvents = options.weatherEventBroker ?? new InMemoryWeatherEventBroker();
  const removeWeatherProjector = weatherEvents.addProjector((event) => {
    persistWeatherObservation(database, event.weather, dataMode);
  });
  const removeWeatherTelemetryBridge = weatherEvents.subscribe((event) => {
    bus.publish({ type: "weather", data: event });
  });
  const weatherMonitor = new WeatherMonitor({
    houses: database,
    weather,
    // Polling is an input adapter: providers do not need native push support.
    persist: async (result) => { await weatherEvents.publish(result, "scheduled-refresh"); },
  });
  const app = express();
  // Security middleware classifies route prefixes before Express dispatches.
  // Keep dispatch case-sensitive so mixed-case paths cannot cross auth zones.
  app.set("case sensitive routing", true);
  let spatialLayers: LocalSpatialLayerRuntime | null = null;
  if (config.spatialLayersEnabled ?? false) {
    try {
      spatialLayers = createLocalSpatialLayerRuntime({
        coreDatabase: database,
        telemetryReader,
        coreDatabasePath: config.databasePath,
        dataMode: database.isRealDataMode() ? "real" : "demo",
        startBackground: false,
        ...(config.spatialLayersDatabasePath === undefined ? {} : { statePath: config.spatialLayersDatabasePath }),
        ...(config.spatialLayersIntervalMs === undefined ? {} : { intervalMs: config.spatialLayersIntervalMs }),
        ...(config.spatialLayersRetentionDays === undefined ? {} : { retentionDays: config.spatialLayersRetentionDays }),
      });
    } catch (error) {
      // This optional research subsystem must never prevent the core API from
      // starting. Its routes remain available and report 503 while disabled.
      const message = error instanceof Error ? error.message : "unknown startup failure";
      console.error(`[spatial-layers] Optional engine unavailable: ${message}`);
    }
  }
  const notifySpatial = (operation: (runtime: LocalSpatialLayerRuntime) => void): void => {
    if (!spatialLayers) return;
    try {
      operation(spatialLayers);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown notification failure";
      // Core writes are authoritative and may already be committed. An
      // optional derived subsystem must never turn that successful mutation
      // into an HTTP failure; its periodic scheduler can reconcile later.
      console.error(`[spatial-layers] Optional change notification failed: ${message}`);
    }
  };
  const notifySpatialSensorChange = (before: Sensor | null, after: Sensor | null): void => {
    const houseIds = [...new Set([before?.houseId, after?.houseId].filter((id): id is string => Boolean(id)))];
    if (houseIds.length === 0) return;
    const observedAt = new Date().toISOString();
    notifySpatial((runtime) => {
      for (const houseId of houseIds) {
        const house = database.getHouse(houseId);
        runtime.scheduler.wakeHouse(houseId, house?.propertyId ?? null, observedAt, "sensor-context-changed");
      }
    });
  };
  // Authentication decisions use the real socket address. Proxy headers must
  // never turn a remote first-owner setup request into a loopback request.
  app.disable("trust proxy");
  dataMode.onActivated(() => {
    mock.stop();
    replay.reset();
    notifySpatial((runtime) => runtime.handleDataModeActivated("real"));
    telemetryArchive?.enforceRealDataBoundary();
    status.refreshDataMode();
  });
  const invalidateSnapshotCaches = (): void => {
    measurementSnapshotCache.clear();
    readingSnapshotCache.clear();
  };
  const cachedLatestMeasurements = (houseId?: string): MeasurementSample[] => {
    const key = houseId ? `house:${houseId}` : "all";
    const cached = measurementSnapshotCache.get(key);
    if (cached) return cached;
    const loaded = database.latestMeasurementSamples(houseId);
    measurementSnapshotCache.set(key, loaded);
    return loaded;
  };
  const cachedLatestReadings = (): Reading[] => {
    const cached = readingSnapshotCache.get("all");
    if (cached) return cached;
    const loaded = database.latestReadings();
    readingSnapshotCache.set("all", loaded);
    return loaded;
  };
  const requireArchivedBeforeCascade = async (scope: TelemetryCascadeScope, resourceId: string): Promise<void> => {
    if (!telemetryArchive) {
      if (database.hasRealTelemetryForCascade(scope, resourceId)) {
        throw new HttpError(
          409,
          "TELEMETRY_ARCHIVE_REQUIRED",
          "This change would erase the only copy of retained telemetry; enable and reconcile the archive first",
        );
      }
      return;
    }
    try {
      await telemetryArchive.reconcileNow();
    } catch {
      throw new HttpError(
        503,
        "TELEMETRY_ARCHIVE_NOT_READY",
        "Telemetry must be durably archived before deleting a telemetry-owning resource",
      );
    }
    if (!telemetryArchive.status().caughtUp) {
      throw new HttpError(
        503,
        "TELEMETRY_ARCHIVE_NOT_READY",
        "Telemetry must be durably archived before deleting a telemetry-owning resource",
      );
    }
  };
  const requireImmutableTelemetryLineage = (
    scope: Exclude<TelemetryCascadeScope, "house-location">,
    resourceId: string,
  ): void => {
    if (!database.hasRealTelemetryForCascade(scope, resourceId)) return;
    throw new HttpError(
      409,
      "TELEMETRY_LINEAGE_REQUIRED",
      "Resources with real telemetry cannot be moved or deleted until immutable historical ownership context is available; disable the resource instead",
    );
  };
  const removeSnapshotMeasurementWake = bus.subscribeMeasurements(invalidateSnapshotCaches);
  const removeSnapshotMutationWake = bus.subscribe((event) => {
    if (event.type === "mutation") invalidateSnapshotCaches();
  });
  const removeSpatialLayerWake = bus.subscribeMeasurements((sample) => {
    notifySpatial((runtime) => runtime.wakeMeasurement(sample));
  });
  const removeNotificationWake = bus.subscribe((event) => {
    if (event.type === "alert" && event.data.resolvedAt === null) notificationOutbox.wake();
  });
  notificationOutbox.start();
  // Keep the production build independent of the contracts package's TypeScript source export.
  const prefix = "/api/v1" as const;
  const v2Prefix = "/api/v2" as const;
  const activeEventStreams = new Set<(notifyClient?: boolean) => void>();
  const activeEventStreamsByUser = new Map<string, number>();
  let activeEventStreamCount = 0;
  let shutdownStarted = false;
  let closed = false;
  let shutdownPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  let telegramConfigurationGeneration = 0;
  const homeAssistantConfigurationGenerations = new Map<string, number>();
  const tpLinkConfigurationGenerations = new Map<string, number>();

  const synchronizeCloudflareAccess = async (): Promise<{
    status: "disabled" | "pending" | "synced";
    lastSyncedAt: string | null;
  }> => {
    if (!cloudflareAccess) return { status: "disabled", lastSyncedAt: null };
    try {
      const result = await cloudflareAccess.synchronize();
      return { status: result.status, lastSyncedAt: result.lastSyncedAt };
    } catch {
      console.error("[cloudflare-access] Member allowlist synchronization is pending");
      return { status: "pending", lastSyncedAt: cloudflareAccess.status().lastSyncedAt };
    }
  };

  const integrationStatusForHouse = (houseId?: string): IntegrationStatus => {
    const value = structuredClone(status.value);
    if (!houseId) return value;
    const homeAssistantConnections = (value.homeAssistant.connections ?? [])
      .filter((connection) => connection.houseId === houseId);
    value.homeAssistant.connections = homeAssistantConnections;
    value.homeAssistant.configured = homeAssistantConnections.some((connection) => connection.configured);
    value.homeAssistant.connected = homeAssistantConnections.some((connection) => connection.connected);
    value.homeAssistant.lastEventAt = homeAssistantConnections.map((connection) => connection.lastEventAt)
      .filter((timestamp): timestamp is string => Boolean(timestamp)).sort().at(-1) ?? null;
    value.homeAssistant.mappedEntities = homeAssistantConnections
      .reduce((total, connection) => total + connection.mappedEntities, 0);
    value.homeAssistant.error = homeAssistantConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
    const tpLinkConnections = (value.tpLink.connections ?? []).filter((connection) => connection.houseId === houseId);
    value.tpLink.connections = tpLinkConnections;
    value.tpLink.configured = tpLinkConnections.some((connection) => connection.configured);
    value.tpLink.connected = tpLinkConnections.some((connection) => connection.connected);
    value.tpLink.lastPollAt = tpLinkConnections.map((connection) => connection.lastPollAt)
      .filter((timestamp): timestamp is string => Boolean(timestamp)).sort().at(-1) ?? null;
    value.tpLink.mappedDevices = tpLinkConnections.reduce((total, connection) => total + connection.mappedDevices, 0);
    value.tpLink.discoveredDevices = tpLinkConnections.reduce((total, connection) => total + connection.discoveredDevices, 0);
    value.tpLink.hubModel = tpLinkConnections.length === 1 ? tpLinkConnections[0]!.hubModel : null;
    value.tpLink.error = tpLinkConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
    const weatherConnections = (value.weather.connections ?? []).filter((connection) => connection.houseId === houseId);
    value.weather.connections = weatherConnections;
    value.weather.configuredHouses = weatherConnections.filter((connection) => connection.configured).length;
    value.weather.provider = weatherConnections[0]?.provider ?? value.weather.provider;
    value.weather.lastSuccessAt = weatherConnections[0]?.lastSuccessAt ?? null;
    value.weather.error = weatherConnections.map((connection) => connection.error).filter(Boolean).join("; ") || null;
    return value;
  };

  const assertTpLinkConnectionScope = (sensor: {
    houseId: string;
    tpLinkDeviceId?: string | null;
    tpLinkConnectionId?: string | null;
  }): void => {
    if (!sensor.tpLinkConnectionId) return;
    if (!sensor.tpLinkDeviceId) throw new HttpError(400, "INVALID_TP_LINK_BINDING", "tpLinkConnectionId requires tpLinkDeviceId");
    const connection = (config.tpLinkConnections ?? []).find((candidate) => candidate.id === sensor.tpLinkConnectionId);
    if (!connection) throw new HttpError(422, "TP_LINK_CONNECTION_NOT_FOUND", "The selected TP-Link connection no longer exists");
    if (connection.houseId !== sensor.houseId) {
      throw new HttpError(409, "TP_LINK_HOUSE_SCOPE", "The selected TP-Link connection belongs to another house");
    }
  };

  const acquireEventStream = (response: Response): (() => void) | null => {
    if (shutdownStarted || activeEventStreamCount >= MAX_EVENT_STREAMS_GLOBAL) return null;
    const userId = requestPrincipal(response).userId;
    const userCount = activeEventStreamsByUser.get(userId) ?? 0;
    if (userCount >= MAX_EVENT_STREAMS_PER_USER) return null;
    activeEventStreamCount += 1;
    activeEventStreamsByUser.set(userId, userCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeEventStreamCount = Math.max(0, activeEventStreamCount - 1);
      const remaining = Math.max(0, (activeEventStreamsByUser.get(userId) ?? 1) - 1);
      if (remaining === 0) activeEventStreamsByUser.delete(userId);
      else activeEventStreamsByUser.set(userId, remaining);
    };
  };

  const rejectEventStreamDuringShutdown = (response: Response): boolean => {
    if (!shutdownStarted) return false;
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "close");
    response.flushHeaders();
    response.end(": server shutting down\n\n");
    return true;
  };

  const registerEventStream = (
    request: Request,
    response: Response,
    dispose: () => void,
    releaseLease: () => void,
  ): void => {
    let active = true;
    const closeStream = (notifyClient = false): void => {
      if (!active) return;
      active = false;
      dispose();
      releaseLease();
      activeEventStreams.delete(closeStream);
      if (notifyClient && !response.destroyed && !response.writableEnded) {
        response.write(": server shutting down\n\n");
        response.end();
      }
    };
    activeEventStreams.add(closeStream);
    request.once("aborted", () => closeStream());
    response.once("close", () => closeStream());
    // A request accepted just before server.close() can reach this handler
    // after shutdown has begun; do not let that late SSE stream block drain.
    if (shutdownStarted) closeStream(true);
  };

  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-api-version", request.path.startsWith(v2Prefix) ? "v2" : "v1");
    if (request.path.startsWith(prefix) || request.path.startsWith(v2Prefix)) {
      // Account and Guest scope are carried by an HttpOnly cookie. Never let a
      // browser or shared intermediary reuse one account's API representation
      // after logout, account switching, or an access-grant change.
      response.setHeader("cache-control", "private, no-store");
      response.setHeader("pragma", "no-cache");
    }
    const origin = request.header("origin");
    const originAllowed = origin ? browserOriginAllowed(request, origin, config) : false;
    const unsafe = !SAFE_HTTP_METHODS.has(request.method) && request.method !== "OPTIONS";
    const crossSite = request.header("sec-fetch-site")?.toLowerCase() === "cross-site";
    if (((unsafe || request.method === "OPTIONS") && origin !== undefined && !originAllowed)
      || (unsafe && crossSite && !originAllowed)) {
      next(new HttpError(403, "CROSS_SITE_REQUEST_REJECTED", "Cross-site browser requests are not allowed"));
      return;
    }
    if (config.corsOrigin && originAllowed && normalizedOrigin(origin) === normalizedOrigin(config.corsOrigin)) {
      response.setHeader("access-control-allow-origin", normalizedOrigin(config.corsOrigin)!);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "Origin");
      response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      response.setHeader("access-control-allow-headers", "Content-Type,Authorization,X-API-Key,X-CSRF-Token,X-Stuga-Bootstrap-Secret,Last-Event-ID");
    }
    if (request.method === "OPTIONS") { response.status(204).end(); return; }
    next();
  });
  const authJsonParser = express.json({ limit: "8kb" });
  app.use((request, response, next) => {
    if (request.path.startsWith(`${prefix}/auth/`)) {
      response.locals.accountBodyLimit = "8 KiB";
      authJsonParser(request, response, next);
      return;
    }
    next();
  });

  app.use((request, response, next) => {
    const initialized = localAuth.isInitialized();
    const rawToken = cookieValue(request, LOCAL_SESSION_COOKIE);
    const session = initialized ? localAuth.sessionForToken(rawToken) : null;
    if (session) {
      response.locals.localPrincipal = { ...session, bootstrap: false } satisfies LocalRequestPrincipal;
    } else if (!initialized && config.localAuthTestBypass === true) {
      response.locals.localPrincipal = {
        userId: "bootstrap",
        email: "",
        role: "owner",
        joinedAt: "",
        grants: [],
        bootstrap: true,
      } satisfies LocalRequestPrincipal;
    }

    const tapoWorkerPath = request.path.startsWith(`${prefix}/internal/tapo-history/`);
    if (tapoWorkerPath) {
      response.setHeader("cache-control", "no-store");
      if (!config.tapoHistoryEnabled || !config.tapoHistoryWorkerToken) {
        next(new HttpError(404, "TAPO_HISTORY_WORKER_DISABLED", "Tapo history worker endpoint is disabled"));
        return;
      }
      const authorization = request.header("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
      if (!bearer || !keyMatches(bearer, config.tapoHistoryWorkerToken)) {
        next(new HttpError(401, "UNAUTHORIZED", "A valid Tapo history worker token is required"));
        return;
      }
      next();
      return;
    }

    const preSetupPath = request.path === `${prefix}/health`
      || request.path === `${prefix}/openapi.json`
      || request.path === `${v2Prefix}/openapi.json`
      || request.path === `${prefix}/session`
      || request.path === `${prefix}/auth/setup`;
    if (!initialized && config.localAuthTestBypass !== true) {
      if (preSetupPath) { next(); return; }
      next(new HttpError(401, "SETUP_REQUIRED", "Create the first local Owner before using the API"));
      return;
    }

    const publicPath = preSetupPath
      || request.path === `${prefix}/auth/login`
      || request.path === `${prefix}/auth/register`;
    if (publicPath) { next(); return; }

    const authorization = request.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const providedIngestKey = request.header("x-api-key") ?? bearer;
    const ingestServicePath = request.method === "POST" && (
      request.path === `${prefix}/readings`
      || request.path === `${v2Prefix}/measurements`
      || request.path === `${v2Prefix}/measurements/import`
    );
    const validIngestService = ingestServicePath && Boolean(
      config.ingestApiKey && providedIngestKey && keyMatches(providedIngestKey, config.ingestApiKey),
    );
    const appleNotesService = (request.method === "POST"
      && request.path === `${prefix}/integrations/apple-notes/capture`)
      || (request.method === "GET" && request.path === `${prefix}/integrations/apple-notes/snapshot`);
    if (validIngestService) { next(); return; }
    if (appleNotesService) {
      // Validate the route-scoped machine credential before the large parser.
      response.setHeader("cache-control", "no-store");
      appleNotesGrant(request, config);
      next();
      return;
    }

    const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
    if (!principal) {
      next(new HttpError(401, "UNAUTHORIZED", "Sign in to access this endpoint"));
      return;
    }
    const sideEffectFreePost = request.method === "POST" && request.path === `${v2Prefix}/analytics/query`;
    const unsafe = !SAFE_HTTP_METHODS.has(request.method) && !sideEffectFreePost;
    if (unsafe && principal.role === "guest" && request.path !== `${prefix}/auth/logout`) {
      next(new HttpError(403, "GUEST_READ_ONLY", "Guest accounts are read-only"));
      return;
    }
    if (principal.role === "guest" && (
      request.path.startsWith(`${prefix}/integrations/`)
      || request.path.startsWith(`${prefix}/mock/`)
      || request.path === `${prefix}/replay`
    )) {
      next(new HttpError(403, "FORBIDDEN", "Guest accounts cannot access administrative configuration"));
      return;
    }
    if (unsafe && !principal.bootstrap) {
      const authenticatedSession = session as LocalAuthSession;
      if (!localAuth.csrfMatches(authenticatedSession, request.header("x-csrf-token"))) {
        next(new HttpError(403, "CSRF_TOKEN_INVALID", "A valid X-CSRF-Token header is required"));
        return;
      }
    }
    next();
  });

  const memberJsonParser = express.json({ limit: "32kb" });
  const apiJsonParser = express.json({ limit: "15mb" });
  app.use((request, response, next) => {
    // Authentication endpoints were parsed above because their credentials are
    // themselves needed for authentication and abuse limiting. Everything else
    // is authorized before the server allocates a potentially large JSON body.
    if (request.path.startsWith(`${prefix}/auth/`)) { next(); return; }
    if (request.path.startsWith(`${prefix}/tenant/members`)
      || request.path.startsWith(`${prefix}/internal/tapo-history/`)) {
      response.locals.accountBodyLimit = "32 KiB";
      memberJsonParser(request, response, next);
      return;
    }
    response.locals.accountBodyLimit = "15 MiB";
    apiJsonParser(request, response, next);
  });

  // Readings and source health already travel through the authenticated live
  // stream. Announce every other successful mutation there as well, allowing
  // all open browsers to refresh properties, tasks, notes, access grants, and
  // configuration without a manual reload.
  app.use((request, response, next) => {
    const sideEffectFreePost = request.method === "POST" && request.path === `${v2Prefix}/analytics/query`;
    const unsafe = !SAFE_HTTP_METHODS.has(request.method) && request.method !== "OPTIONS" && !sideEffectFreePost;
    const excluded = request.path.startsWith(`${prefix}/auth/`)
      || request.path === `${prefix}/readings`
      || request.path === `${v2Prefix}/measurements`
      || request.path === `${v2Prefix}/measurements/import`
      || request.path.startsWith(`${prefix}/mock/`)
      || request.path === `${prefix}/replay`;
    if (!unsafe || excluded) { next(); return; }
    response.once("finish", () => {
      if (response.statusCode < 200 || response.statusCode >= 400) return;
      const resource = request.path.startsWith(v2Prefix)
        ? request.path.slice(v2Prefix.length) || "/"
        : request.path.startsWith(prefix)
          ? request.path.slice(prefix.length) || "/"
          : request.path;
      bus.publish({ type: "mutation", data: { method: request.method, resource, occurredAt: new Date().toISOString() } });
    });
    next();
  });

  const requireIngestKey = (request: Request, _response: Response, next: NextFunction): void => {
    if (!config.ingestApiKey) { next(); return; }
    const authorization = request.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const provided = request.header("x-api-key") ?? bearer;
    if (!provided || !keyMatches(provided, config.ingestApiKey)) {
      next(new HttpError(401, "UNAUTHORIZED", "A valid ingestion API key is required"));
      return;
    }
    next();
  };
  const visibility = (response: Response): LocalVisibility => new LocalVisibility(database, requestPrincipal(response));
  const currentStreamIdentity = (request: Request, response: Response): LocalRequestPrincipal | null => {
    const accepted = requestPrincipal(response);
    if (accepted.bootstrap) return accepted;
    const current = localAuth.sessionForToken(cookieValue(request, LOCAL_SESSION_COOKIE));
    return current ? { ...current, bootstrap: false } : null;
  };
  const currentStreamVisibility = (request: Request, response: Response): LocalVisibility | null => {
    const current = currentStreamIdentity(request, response);
    return current ? new LocalVisibility(database, current) : null;
  };
  const streamAuthorizationFingerprint = (request: Request, response: Response): string | null => {
    const current = currentStreamIdentity(request, response);
    return current ? localAuthorizationFingerprint(current) : null;
  };
  const authorizedStreamVisibility = (
    request: Request,
    response: Response,
    acceptedFingerprint: string,
  ): LocalVisibility | null => {
    const current = currentStreamIdentity(request, response);
    const currentFingerprint = current ? localAuthorizationFingerprint(current) : null;
    if (current && currentFingerprint === acceptedFingerprint) return new LocalVisibility(database, current);
    if (!response.destroyed && !response.writableEnded) {
      const status = current ? "changed" : "expired";
      response.end(`event: authorization\ndata: ${JSON.stringify({ status })}\n\n`);
    }
    return null;
  };

  app.get(`${prefix}/health`, (_request, response) => {
    const archive = telemetryArchive?.status();
    const requiredArchiveUnavailable = config.timeseriesRequired === true && (
      !archive || archive.phase === "degraded" || archive.phase === "stopped" || !archive.timescaleAvailable
    );
    const measurementCache = measurementSnapshotCache.stats();
    const readingCache = readingSnapshotCache.stats();
    response.status(requiredArchiveUnavailable ? 503 : 200).json({
      status: requiredArchiveUnavailable ? "degraded" : "ok",
      systemVersion: SYSTEM_VERSION,
      apiVersion: "v1",
      database: "ready",
      telemetryArchive: archive ? {
        enabled: true,
        required: config.timeseriesRequired,
        phase: archive.phase,
        caughtUp: archive.caughtUp,
        timescaleAvailable: archive.timescaleAvailable,
        timescaleVersion: archive.timescaleVersion,
        hypertables: archive.hypertables,
        aggregateMode: archive.aggregateMode,
        coldStorageMode: archive.coldStorageMode,
        schemaWarningCount: archive.schemaWarningCount,
        lastSuccessAt: archive.lastSuccessAt,
        lastFailureAt: archive.lastFailureAt,
      } : { enabled: false, required: false, phase: "disabled", caughtUp: false },
      cache: {
        entries: measurementCache.entries + readingCache.entries,
        estimatedBytes: measurementCache.estimatedBytes + readingCache.estimatedBytes,
        hits: measurementCache.hits + readingCache.hits,
        misses: measurementCache.misses + readingCache.misses,
      },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });
  app.get(`${prefix}/openapi.json`, (_request, response) => response.json(openApiV1Document));
  app.get(`${v2Prefix}/openapi.json`, (_request, response) => response.json(openApiV2Document));
  app.get(`${prefix}/session`, (request, response) => {
    if (!localAuth.isInitialized()) {
      const session: AppSession = {
        authenticated: false,
        principal: { type: "setup-required", email: null },
        tenant: { id: "local", name: "Local Stuga", role: "owner" },
        availableTenants: [{ id: "local", name: "Local Stuga", role: "owner" }],
        readOnly: true,
        grants: [],
        setupRequired: true,
      };
      response.json(session);
      return;
    }
    const principal = response.locals.localPrincipal as LocalRequestPrincipal | undefined;
    if (!principal || principal.bootstrap || !principal.csrfToken) {
      throw new HttpError(401, "UNAUTHORIZED", "Sign in to access this workspace");
    }
    response.cookie(LOCAL_CSRF_COOKIE, principal.csrfToken, {
      httpOnly: false,
      sameSite: "strict",
      secure: secureRequest(request, config),
      path: "/api",
      maxAge: LOCAL_SESSION_MAX_AGE_MS,
    });
    response.json(sessionDocument(principal, principal.csrfToken));
  });

  app.post(`${prefix}/auth/setup`, async (request, response) => {
    requireJsonContentType(request);
    const configuredSecret = config.localAuthBootstrapSecret ?? null;
    const providedSecret = request.header("x-stuga-bootstrap-secret");
    const secretAuthorized = Boolean(configuredSecret && providedSecret && keyMatches(providedSecret, configuredSecret));
    if (!localSetupRequestAllowed(request, config) && !secretAuthorized) {
      throw new HttpError(403, "BOOTSTRAP_LOCAL_ONLY", "First-owner setup is restricted to the local machine");
    }
    if (localAuth.isInitialized()) {
      throw new HttpError(409, "AUTH_ALREADY_INITIALIZED", "Local authentication has already been initialized");
    }
    const body = bodyObject(request.body);
    const release = authAbuseLimiter.enter(authAttemptKeys(request, config, "setup", body.email), response);
    try {
      const identity = await localAuth.createFirstOwner(body.email, body.password);
      const issued = localAuth.issueSession(identity);
      setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
      const cloudflareAccessStatus = await synchronizeCloudflareAccess();
      response.status(201).json({
        ...sessionDocument(issued.session, issued.session.csrfToken),
        cloudflareAccess: cloudflareAccessStatus,
      });
    } finally {
      release();
    }
  });

  app.post(`${prefix}/auth/register`, async (request, response) => {
    requireJsonContentType(request);
    if (!localAuth.isInitialized()) {
      throw new HttpError(409, "SETUP_REQUIRED", "Create the first owner before accepting invitations");
    }
    const body = bodyObject(request.body);
    const release = authAbuseLimiter.enter(authAttemptKeys(request, config, "register", body.token), response);
    try {
      const identity = await localAuth.registerInvitation(body.token, body.password, body.email);
      const issued = localAuth.issueSession(identity);
      setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
      response.status(201).json(sessionDocument(issued.session, issued.session.csrfToken));
    } finally {
      release();
    }
  });

  app.post(`${prefix}/auth/login`, async (request, response) => {
    requireJsonContentType(request);
    if (!localAuth.isInitialized()) {
      throw new HttpError(409, "SETUP_REQUIRED", "Create the first owner before signing in");
    }
    const body = bodyObject(request.body);
    const release = authAbuseLimiter.enter(authAttemptKeys(request, config, "login", body.email), response);
    try {
      const identity = await localAuth.verifyCredentials(body.email, body.password);
      if (!identity) throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
      const previousToken = cookieValue(request, LOCAL_SESSION_COOKIE);
      if (previousToken) localAuth.revokeSession(previousToken);
      const issued = localAuth.issueSession(identity);
      setLocalSessionCookies(response, request, config, issued.token, issued.session.csrfToken);
      response.json(sessionDocument(issued.session, issued.session.csrfToken));
    } finally {
      release();
    }
  });

  app.post(`${prefix}/auth/logout`, (request, response) => {
    localAuth.revokeSession(cookieValue(request, LOCAL_SESSION_COOKIE));
    clearLocalSessionCookies(response, request, config);
    response.status(204).end();
  });

  app.get(`${prefix}/tenant/members`, requireWorkspaceAdmin, (_request, response) => {
    const directory = localAuth.listWorkspaceMembers();
    if (cloudflareAccess) void synchronizeCloudflareAccess();
    response.json(directory);
  });
  app.post(`${prefix}/tenant/members`, requireWorkspaceAdmin, async (request, response) => {
    requireJsonContentType(request);
    const body = bodyObject(request.body);
    const role = enumValue(body.role, ["admin", "member", "guest"] as const, "role");
    const principal = requestPrincipal(response);
    const grants = body.grants === undefined ? [] : body.grants;
    if (!Array.isArray(grants)) throw new HttpError(400, "INVALID_GRANTS", "grants must be an array");
    const created = localAuth.inviteMember(principal, body.email, role, grants as GuestAccessGrant[]);
    const cloudflareAccessStatus = await synchronizeCloudflareAccess();
    response.status(201).json({
      invitation: created.invitation,
      registrationToken: created.registrationToken,
      // URL fragments remain client-side and avoid leaking the one-time token
      // through HTTP access logs, browser referrers, or intermediary caches.
      activationPath: `/invite-bootstrap#invite=${encodeURIComponent(created.registrationToken)}`,
      expiresAt: created.expiresAt,
      cloudflareAccess: cloudflareAccessStatus,
    });
  });
  app.put(`${prefix}/tenant/members/:email/access`, requireWorkspaceAdmin, (request, response) => {
    requireJsonContentType(request);
    const body = bodyObject(request.body);
    if (!Array.isArray(body.grants)) throw new HttpError(400, "INVALID_GRANTS", "grants must be an array");
    const member = localAuth.updateMemberAccess(request.params.email, body.grants as GuestAccessGrant[]);
    response.json({ member });
  });
  app.delete(`${prefix}/tenant/members/:email`, requireWorkspaceAdmin, async (request, response) => {
    if (!localAuth.removeMember(request.params.email, requestPrincipal(response))) {
      throw new HttpError(404, "MEMBER_NOT_FOUND", "Member or invitation not found");
    }
    await synchronizeCloudflareAccess();
    response.status(204).end();
  });
  app.get(`${prefix}/locations/search`, requireNonGuest, async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    if (query.length < 2 || query.length > 120) {
      throw new HttpError(400, "INVALID_LOCATION_QUERY", "q must contain between 2 and 120 characters");
    }
    const language = typeof request.query.language === "string" ? request.query.language : "en";
    try {
      response.json({ results: await locationDiscovery.search(query, language) });
    } catch {
      throw new HttpError(503, "LOCATION_DISCOVERY_UNAVAILABLE", "Location search is temporarily unavailable");
    }
  });
  app.get(`${prefix}/locations/defaults`, requireNonGuest, async (request, response) => {
    const latitude = optionalQueryNumber(request.query.latitude, "latitude");
    const longitude = optionalQueryNumber(request.query.longitude, "longitude");
    if (latitude === null || longitude === null) {
      throw new HttpError(400, "INVALID_FIELD", "latitude and longitude are required");
    }
    try {
      response.json(await locationDiscovery.defaultsForCoordinates(latitude, longitude));
    } catch (error) {
      if (error instanceof Error && error.message.includes("valid WGS84")) {
        throw new HttpError(422, "INVALID_COORDINATES", error.message);
      }
      throw new HttpError(503, "LOCATION_DISCOVERY_UNAVAILABLE", "Timezone discovery is temporarily unavailable");
    }
  });

  app.get(`${v2Prefix}/measurement-definitions`, (request, response) => {
    const includeDisabled = request.query.includeDisabled !== "false";
    response.json({ definitions: database.listMeasurementDefinitions(includeDisabled) });
  });
  app.post(`${v2Prefix}/measurement-definitions`, (request, response) => {
    const definition = database.createMeasurementDefinition(parseMeasurementDefinition(request.body));
    response.status(201).json({ definition });
  });
  app.patch(`${v2Prefix}/measurement-definitions/:id`, (request, response) => {
    const id = measurementId(request.params.id, "id");
    const current = database.getMeasurementDefinition(id);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
    const definition = database.updateMeasurementDefinition(id, parseMeasurementDefinition(request.body, current));
    response.json({ definition });
  });
  app.delete(`${v2Prefix}/measurement-definitions/:id`, (request, response) => {
    const definition = database.disableMeasurementDefinition(measurementId(request.params.id, "id"));
    if (!definition) throw new HttpError(404, "NOT_FOUND", "Measurement definition not found");
    response.json({ definition });
  });

  app.post(`${v2Prefix}/analytics/query`, async (request, response) => {
    try {
      const analyticsRequest = parseAnalyticsQueryRequest(request.body);
      const activeDataMode = database.isRealDataMode() ? "live" : "demo";
      if (analyticsRequest.dataMode !== activeDataMode) {
        throw new AnalyticsQueryError(
          409,
          "ANALYTICS_DATA_MODE_MISMATCH",
          `This local database is in ${activeDataMode} mode; cross-mode analytics queries are not allowed`,
        );
      }
      const house = database.getHouse(analyticsRequest.scope.id);
      if (!house || !visibility(response).house(house.id)) {
        throw new AnalyticsQueryError(404, "ANALYTICS_SCOPE_NOT_FOUND", "Analytics house scope was not found");
      }
      const accessibleSensors = database.listSensors(house.id)
        .filter((sensor) => sensor.enabled && visibility(response).sensor(sensor.id));
      const byId = new Map(accessibleSensors.map((sensor) => [sensor.id, sensor]));
      const requestedSensorIds = analyticsRequest.scope.entityIds ?? accessibleSensors.map((sensor) => sensor.id);
      const sensors = requestedSensorIds.map((sensorId) => {
        const sensor = byId.get(sensorId);
        if (!sensor) {
          throw new AnalyticsQueryError(404, "ANALYTICS_ENTITY_NOT_FOUND", `Sensor ${sensorId} is not available in the requested house`);
        }
        return sensor;
      });
      const definitions = analyticsRequest.measurementIds.map((metric) => {
        const definition = database.getMeasurementDefinition(metric);
        if (!definition) throw new AnalyticsQueryError(404, "UNKNOWN_ANALYTICS_MEASUREMENT", `Unknown measurement: ${metric}`);
        return definition;
      });
      const read = await telemetryReader.measurementWindow({
        sensorIds: sensors.map((sensor) => sensor.id),
        metrics: definitions.map((definition) => definition.id),
        from: analyticsRequest.range.start,
        to: analyticsRequest.range.end,
        limit: 250_000,
      });
      if (read.records.length >= 250_000) {
        throw new AnalyticsQueryError(
          422,
          "ANALYTICS_SOURCE_POINT_LIMIT_EXCEEDED",
          "The source window reached the 250000-point interactive limit; choose a shorter range or fewer series",
        );
      }
      response.setHeader("cache-control", "no-store");
      response.json(buildAnalyticsResponse({
        request: analyticsRequest,
        samples: read.records,
        definitions,
        entities: sensors.map((sensor) => ({ id: sensor.id, label: sensor.name })),
        archiveState: read.provenance.archiveState,
      }));
    } catch (error) {
      if (error instanceof AnalyticsQueryError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  });

  app.post(`${v2Prefix}/measurements`, requireIngestKey, (request, response) => {
    const candidate = request.body as unknown;
    let input: unknown[];
    if (Array.isArray(candidate)) input = candidate;
    else if (candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).samples)) {
      input = (candidate as { samples: unknown[] }).samples;
    } else if (candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).sample !== undefined) {
      input = [(candidate as Record<string, unknown>).sample];
    } else input = [candidate];
    if (input.length === 0 || input.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 measurement samples");
    const samples = measurements.ingestBatch(input.map((item) => parseMeasurementSample(item, database)));
    response.status(201).json({ accepted: samples.length, samples });
  });
  app.post(`${v2Prefix}/measurements/import`, requireIngestKey, (request, response) => {
    const candidate = request.body as unknown;
    const input = candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).samples)
      ? (candidate as { samples: unknown[] }).samples
      : [];
    if (input.length === 0 || input.length > 10_000) {
      throw new HttpError(400, "INVALID_BATCH", "Import between 1 and 10000 measurement samples at a time");
    }
    const submitted = input.map((item) => ({ ...parseMeasurementSample(item, database), source: "import" as const }));
    const samples = measurements.ingestBatch(submitted, {
      allowDisabledSensors: true,
      publish: false,
      evaluateAlerts: false,
      deduplicateAcrossSources: true,
    });
    if (samples.length > 0) void telemetryArchive?.reconcileNow().catch(() => undefined);
    response.status(201).json({ accepted: samples.length, ignoredDuplicates: submitted.length - samples.length });
  });
  app.get(`${v2Prefix}/measurements/snapshot`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
    const access = visibility(response);
    if (houseId && (!database.getHouse(houseId) || !access.house(houseId))) {
      response.json({ snapshot: [] });
      return;
    }
    const latest = cachedLatestMeasurements(houseId);
    const bySensor = new Map<string, Record<string, MeasurementSample>>();
    for (const sample of latest) {
      const map = bySensor.get(sample.sensorId) ?? Object.create(null) as Record<string, MeasurementSample>;
      map[sample.metric] = sample;
      bySensor.set(sample.sensorId, map);
    }
    const snapshot = database.listSensors(houseId).filter((sensor) => access.sensor(sensor.id)).map((sensor) => ({
      sensorId: sensor.id,
      measurements: bySensor.get(sensor.id) ?? {},
    }));
    response.json({ snapshot });
  });
  app.get(`${v2Prefix}/measurements/history`, async (request, response) => {
    if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    if (!database.getSensor(request.query.sensorId) || !visibility(response).sensor(request.query.sensorId)) {
      throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
    }
    const metric = measurementId(request.query.metric);
    if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
    if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
    const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
    const bucketSeconds = boundedQueryInteger(request.query.bucketSeconds, "bucketSeconds", 1, 86_400);
    const rawLimit = bucketSeconds === null ? limit + 1 : 100_000;
    const archived = (await telemetryReader.measurementHistory({
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
  app.get(`${v2Prefix}/sensors/:id/measurements`, (request, response) => {
    if (!database.getSensor(request.params.id) || !visibility(response).sensor(request.params.id)) {
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
    response.json(database.sensorMeasurementPage(request.params.id, before, limit));
  });
  app.get(`${v2Prefix}/measurements/forecast`, (request, response) => {
    if (typeof request.query.sensorId !== "string") throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    if (!database.getSensor(request.query.sensorId) || !visibility(response).sensor(request.query.sensorId)) {
      throw new HttpError(404, "UNKNOWN_SENSOR", "Sensor not found");
    }
    const metric = measurementId(request.query.metric);
    const hours = safeInteger(request.query.hours, 12, 1, 168);
    response.json({ forecast: forecastMeasurement(database, request.query.sensorId, metric, hours) });
  });
  app.get(`${v2Prefix}/measurements/events`, (request, response) => {
    if (rejectEventStreamDuringShutdown(response)) return;
    const sensorFilter = new Set(queryList(request.query.sensorId));
    const metricFilter = new Set(queryList(request.query.metric));
    const releaseStream = acquireEventStream(response);
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
    const write = (sample: MeasurementSample): void => {
      if (response.destroyed || response.writableEnded) return;
      const access = authorizedStreamVisibility(request, response, acceptedAuthorization);
      if (!access) return;
      if (!access.sensor(sample.sensorId)) return;
      if (sensorFilter.size > 0 && !sensorFilter.has(sample.sensorId)) return;
      if (metricFilter.size > 0 && !metricFilter.has(sample.metric)) return;
      writer.send(`event: measurement\ndata: ${JSON.stringify(sample)}\n\n`);
    };
    const unsubscribe = bus.subscribeMeasurements(write);
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded) {
        if (!authorizedStreamVisibility(request, response, acceptedAuthorization)) return;
        writer.send(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
      }
    }, 15_000);
    heartbeat.unref();
    registerEventStream(
      request,
      response,
      () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
      releaseStream,
    );
  });

  app.get(`${prefix}/properties`, (request, response) => {
    const page = collectionPage(request.query);
    const access = visibility(response);
    const properties = visibleCollectionPage(
      (limit, offset) => database.listProperties(limit, offset),
      (property) => access.property(property) !== null,
      page,
    ).map((property) => access.property(property) as Property);
    response.json({ properties });
  });
  app.post(`${prefix}/properties`, (request, response) => {
    const property = database.createProperty(parsePropertyInput(request.body));
    notifySpatial((runtime) => runtime.scheduler.enqueueScope(
      { kind: "property", id: property.id },
      new Date().toISOString(),
      "property-context-changed",
      true,
    ));
    response.status(201).json({ property });
  });
  app.get(`${prefix}/properties/:id`, (request, response) => {
    const candidate = database.getProperty(request.params.id as string);
    const property = candidate ? visibility(response).property(candidate) : null;
    if (!property) throw new HttpError(404, "NOT_FOUND", "Property not found");
    response.json({ property });
  });
  app.patch(`${prefix}/properties/:id`, (request, response) => {
    const property = database.updateProperty(request.params.id as string, parsePropertyPatch(request.body));
    if (!property) throw new HttpError(404, "NOT_FOUND", "Property not found");
    notifySpatial((runtime) => runtime.scheduler.enqueueScope(
      { kind: "property", id: property.id },
      new Date().toISOString(),
      "property-context-changed",
      true,
    ));
    response.json({ property });
  });
  app.delete(`${prefix}/properties/:id`, async (request, response) => {
    requireImmutableTelemetryLineage("property", request.params.id as string);
    if (!database.deleteProperty(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Property not found");
    response.status(204).end();
  });

  app.get(`${prefix}/properties/:id/electricity`, (request, response) => {
    const propertyId = request.params.id as string;
    const property = database.getProperty(propertyId);
    if (!property || !visibility(response).hasProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
    const config = database.getPropertyElectricityConfig(propertyId);
    if (!config) throw new HttpError(404, "NOT_FOUND", "Property electricity configuration not found");
    const from = dateValue(request.query.from, new Date(Date.now() - 24 * 60 * 60_000), "from");
    const to = dateValue(request.query.to, new Date(Date.now() + 48 * 60 * 60_000), "to");
    response.json({
      config: publicElectricityConfiguration(config, requestPrincipal(response).role === "guest"),
      current: database.getCurrentPropertyElectricityPrice(propertyId),
      prices: database.listPropertyElectricityPrices(propertyId, from, to),
    });
  });
  app.put(`${prefix}/properties/:id/electricity/config`, (request, response) => {
    const propertyId = request.params.id as string;
    const property = database.getProperty(propertyId);
    if (!property || !visibility(response).hasProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
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
    const savedConfig = database.updatePropertyElectricityConfig(propertyId, input);
    response.json({ config: savedConfig });
  });
  app.post(`${prefix}/properties/:id/electricity/refresh`, async (request, response) => {
    const propertyId = request.params.id as string;
    const property = database.getProperty(propertyId);
    if (!property || !visibility(response).hasProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
    try {
      const prices = await electricityPrices.refresh(propertyId);
      const savedConfig = database.getPropertyElectricityConfig(propertyId);
      response.json({
        config: savedConfig ? publicElectricityConfiguration(savedConfig, requestPrincipal(response).role === "guest") : null,
        current: database.getCurrentPropertyElectricityPrice(propertyId),
        prices,
      });
    } catch (error) {
      throw new HttpError(502, "ELECTRICITY_PRICE_SOURCE_FAILED", error instanceof Error ? error.message : "Electricity price refresh failed");
    }
  });
  app.get(`${prefix}/properties/:id/energy-optimization`, (request, response) => {
    const propertyId = request.params.id as string;
    if (!database.getProperty(propertyId)) throw new HttpError(404, "NOT_FOUND", "Property not found");
    const hours = safeInteger(request.query.windowHours, 2, 1, 12);
    response.json({ report: energyOptimizer.report(propertyId, hours) });
  });

  app.get(`${prefix}/property-areas`, (request, response) => {
    const page = collectionPage(request.query);
    const access = visibility(response);
    const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
    response.json({
      areas: visibleCollectionPage(
        (limit, offset) => database.listPropertyAreas(propertyId, limit, offset),
        (area) => access.area(area.id),
        page,
      ),
    });
  });
  app.post(`${prefix}/property-areas`, (request, response) => {
    const area = database.createPropertyArea(parsePropertyAreaInput(request.body));
    notifySpatial((runtime) => runtime.scheduler.enqueueScope(
      { kind: "property", id: area.propertyId },
      new Date().toISOString(),
      "property-context-changed",
      true,
    ));
    response.status(201).json({ area });
  });
  app.get(`${prefix}/property-areas/:id`, (request, response) => {
    const area = database.getPropertyArea(request.params.id as string);
    if (!area || !visibility(response).area(area.id)) throw new HttpError(404, "NOT_FOUND", "Property area not found");
    response.json({ area });
  });
  app.patch(`${prefix}/property-areas/:id`, (request, response) => {
    const areaId = request.params.id as string;
    const previous = database.getPropertyArea(areaId);
    const area = database.updatePropertyArea(areaId, parsePropertyAreaPatch(request.body));
    if (!area) throw new HttpError(404, "NOT_FOUND", "Property area not found");
    if (previous) {
      const observedAt = new Date().toISOString();
      notifySpatial((runtime) => {
        runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "property-context-changed", true);
        if (previous.propertyId !== area.propertyId) {
          runtime.scheduler.enqueueScope({ kind: "property", id: area.propertyId }, observedAt, "ownership-changed", true);
        }
      });
    }
    response.json({ area });
  });
  app.delete(`${prefix}/property-areas/:id`, (request, response) => {
    const areaId = request.params.id as string;
    const previous = database.getPropertyArea(areaId);
    if (!database.deletePropertyArea(areaId)) {
      throw new HttpError(404, "NOT_FOUND", "Property area not found");
    }
    if (previous) notifySpatial((runtime) => runtime.scheduler.enqueueScope(
      { kind: "property", id: previous.propertyId },
      new Date().toISOString(),
      "property-context-changed",
      true,
    ));
    response.status(204).end();
  });

  app.get(`${prefix}/area-equipment`, (request, response) => {
    const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
    const areaId = optionalResourceQuery(request.query.areaId, "areaId");
    const page = collectionPage(request.query);
    const access = visibility(response);
    response.json({
      equipment: visibleCollectionPage(
        (limit, offset) => database.listAreaEquipment({
          ...(propertyId ? { propertyId } : {}),
          ...(areaId ? { areaId } : {}),
          limit,
          offset,
        }),
        (equipment) => access.equipment(equipment),
        page,
      ),
    });
  });
  app.post(`${prefix}/area-equipment`, (request, response) => {
    const equipment = database.createAreaEquipment(parseAreaEquipmentInput(request.body));
    notifySpatial((runtime) => runtime.scheduler.enqueueScope(
      { kind: "property", id: equipment.propertyId },
      new Date().toISOString(),
      "property-context-changed",
      true,
    ));
    response.status(201).json({ equipment });
  });
  app.get(`${prefix}/area-equipment/:id`, (request, response) => {
    const equipment = database.getAreaEquipment(request.params.id as string);
    if (!equipment || !visibility(response).equipment(equipment)) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
    response.json({ equipment });
  });
  app.patch(`${prefix}/area-equipment/:id`, (request, response) => {
    const equipmentId = request.params.id as string;
    const previous = database.getAreaEquipment(equipmentId);
    const equipment = database.updateAreaEquipment(equipmentId, parseAreaEquipmentPatch(request.body));
    if (!equipment) throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
    if (previous && (previous.propertyId !== equipment.propertyId || previous.areaId !== equipment.areaId)) {
      const observedAt = new Date().toISOString();
      notifySpatial((runtime) => {
        runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "ownership-changed", true);
        if (equipment.propertyId !== previous.propertyId) {
          runtime.scheduler.enqueueScope({ kind: "property", id: equipment.propertyId }, observedAt, "ownership-changed", true);
        }
      });
    }
    response.json({ equipment });
  });
  app.delete(`${prefix}/area-equipment/:id`, (request, response) => {
    const equipmentId = request.params.id as string;
    const previous = database.getAreaEquipment(equipmentId);
    if (!database.deleteAreaEquipment(equipmentId)) {
      throw new HttpError(404, "NOT_FOUND", "Area equipment not found");
    }
    if (previous) notifySpatial((runtime) => runtime.scheduler.enqueueScope(
      { kind: "property", id: previous.propertyId },
      new Date().toISOString(),
      "property-context-changed",
      true,
    ));
    response.status(204).end();
  });

  app.get(`${prefix}/property-notes`, (request, response) => {
    const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
    const houseId = optionalResourceQuery(request.query.houseId, "houseId");
    const areaId = optionalResourceQuery(request.query.areaId, "areaId");
    const equipmentId = optionalResourceQuery(request.query.equipmentId, "equipmentId");
    const page = collectionPage(request.query);
    const access = visibility(response);
    response.json({
      notes: visibleCollectionPage(
        (limit, offset) => database.listPropertyNotes({
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
  app.post(`${prefix}/property-notes`, (request, response) => {
    response.status(201).json({ note: database.createPropertyNote(parsePropertyNoteInput(request.body)) });
  });
  app.get(`${prefix}/property-notes/:id`, (request, response) => {
    const note = database.getPropertyNote(request.params.id as string);
    if (!note || !visibility(response).note(note)) throw new HttpError(404, "NOT_FOUND", "Property note not found");
    response.json({ note });
  });
  app.patch(`${prefix}/property-notes/:id`, (request, response) => {
    const note = database.updatePropertyNote(request.params.id as string, parsePropertyNotePatch(request.body));
    if (!note) throw new HttpError(404, "NOT_FOUND", "Property note not found");
    response.json({ note });
  });
  app.delete(`${prefix}/property-notes/:id`, (request, response) => {
    if (!database.deletePropertyNote(request.params.id as string)) {
      throw new HttpError(404, "NOT_FOUND", "Property note not found");
    }
    response.status(204).end();
  });

  app.get(`${prefix}/houses`, (request, response) => {
    const access = visibility(response);
    response.json({
      houses: database.listHouses(optionalResourceQuery(request.query.propertyId, "propertyId"))
        .filter((house) => access.house(house.id)),
    });
  });
  app.post(`${prefix}/houses`, (request, response) => {
    const body = bodyObject(request.body);
    if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
    const house = database.createHouse({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      ...(body.propertyId !== undefined ? { propertyId: requiredString(body, "propertyId") } : {}),
      name: requiredString(body, "name"),
      timezone: requiredString(body, "timezone"),
      ...(body.location !== undefined ? { location: houseLocationValue(body.location) } : {}),
      ...(body.mapPlacement !== undefined ? { mapPlacement: houseMapPlacementValue(body.mapPlacement) } : {}),
      ...(body.orientationDegrees !== undefined ? { orientationDegrees: requiredNumber(body, "orientationDegrees") } : {}),
      floors: body.floors as Floor[],
    });
    notifySpatial((runtime) => runtime.scheduler.wakeHouse(
      house.id,
      house.propertyId,
      new Date().toISOString(),
      "ownership-changed",
    ));
    status.refreshWeatherConfiguration();
    response.status(201).json({ house });
  });
  app.get(`${prefix}/houses/:id`, (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house || !visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
    response.json({ house });
  });
  app.get(`${prefix}/houses/:id/opening-states`, (request, response) => {
    const houseId = request.params.id as string;
    const house = database.getHouse(houseId);
    if (!house || !visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const at = dateValue(request.query.at, new Date(), "at");
    const observations = database.listOpeningStateObservations(houseId, 10_000, at);
    const states = house.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
      if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") return [];
      return [{ floorId: floor.id, elementId: element.id, kind: element.kind, ...(element.label ? { label: element.label } : {}),
        ...resolvePlanElementOpeningState(element, observations.filter((observation) => observation.floorId === floor.id), at) }];
    }));
    response.json({ snapshot: { houseId, at, states }, observations });
  });
  app.post(`${prefix}/houses/:id/opening-states`, (request, response) => {
    const houseId = request.params.id as string;
    const house = database.getHouse(houseId);
    if (!house || !visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
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
    const observation = database.recordOpeningStateObservation(houseId, input);
    notifySpatial((runtime) => runtime.scheduler.wakeHouse(house.id, house.propertyId, observation.observedAt, "property-context-changed"));
    response.status(201).json({ observation });
  });
  app.get(`${prefix}/houses/:id/electricity-price`, (request, response) => {
    const houseId = request.params.id as string;
    const house = database.getHouse(houseId);
    if (!house || !visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const propertyPrice = database.getCurrentPropertyElectricityPrice(house.propertyId);
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
    const prices = database.listPropertyElectricityPrices(house.propertyId, from, to).map(homePrice);
    response.json({ current, prices });
  });
  app.get(`${prefix}/houses/:id/energy-cost`, async (request, response) => {
    const houseId = request.params.id as string;
    const house = database.getHouse(houseId);
    if (!house || !visibility(response).house(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const sensorId = optionalResourceQuery(request.query.sensorId, "sensorId");
    if (!sensorId) throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    const sensor = database.getSensor(sensorId);
    if (!sensor || sensor.houseId !== houseId || !visibility(response).sensor(sensorId)) {
      throw new HttpError(404, "NOT_FOUND", "Energy sensor not found");
    }
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 30 * 86_400_000), "from");
    const durationMs = Date.parse(to) - Date.parse(from);
    if (durationMs <= 0 || durationMs > 366 * 86_400_000) {
      throw new HttpError(400, "INVALID_ENERGY_COST_RANGE", "Energy cost range must be greater than zero and at most 366 days");
    }
    response.setHeader("cache-control", "no-store");
    response.json({ cost: await energyCost.calculate({
      houseId,
      propertyId: house.propertyId,
      sensorId,
      from,
      to,
    }) });
  });
  app.get(`${prefix}/houses/:id/weather`, async (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house || !visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
    if (!house.location) {
      throw new HttpError(409, "HOUSE_LOCATION_REQUIRED", "Set the house location before requesting weather");
    }
    const hours = safeInteger(request.query.hours, 48, 1, 240);
    try {
      const result = await weather.get(house, hours);
      const current = database.getHouse(house.id);
      if (!current) throw new HttpError(404, "NOT_FOUND", "House not found");
      if (current.updatedAt !== house.updatedAt
        || outdoorLocationKey(current.location) !== outdoorLocationKey(result.location)) {
        throw new WeatherRequestSupersededError();
      }
      await weatherEvents.publish(result, "on-demand");
      response.json({ weather: result });
    } catch (error) {
      if (error instanceof WeatherRequestSupersededError || error instanceof WeatherEventSupersededError) {
        throw new HttpError(409, "WEATHER_REQUEST_SUPERSEDED", error.message);
      }
      if (error instanceof WeatherUnavailableError) {
        throw new HttpError(503, "WEATHER_UNAVAILABLE", error.message, {
          provider: house.location && !prefersFmi(house.location) ? "open-meteo" : "fmi",
          recovery: weather.recoveryStatus(house),
        });
      }
      throw error;
    }
  });
  app.get(`${v2Prefix}/houses/:id/outdoor-temperature/history`, async (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house || !visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
    if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
    const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
    if (!house.location) {
      response.json({ samples: [], from, to, truncated: false });
      return;
    }
    const archived = (await telemetryReader.outdoorTemperatureHistory({
      houseId: house.id,
      locationKey: outdoorLocationKey(house.location),
      from,
      to,
      limit: limit + 1,
    })).records;
    const truncated = archived.length > limit;
    response.json({ samples: truncated ? archived.slice(-limit) : archived, from, to, truncated });
  });
  app.get(`${prefix}/houses/:id/thermal-simulation`, (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house || !visibility(response).house(house.id)) throw new HttpError(404, "NOT_FOUND", "House not found");
    if (typeof request.query.sensorId !== "string" || !request.query.sensorId) {
      throw new HttpError(400, "INVALID_FIELD", "sensorId is required");
    }
    const sensor = database.getSensor(request.query.sensorId);
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
    const indoorSamples = database.thermalTemperatureHistory(sensor.id, from, to, 5, 5_000);
    const outdoorSamples = database.outdoorTemperatureHistory(
      house.id,
      outdoorLocationKey(house.location),
      new Date(Date.parse(from) - boundaryPaddingMs).toISOString(),
      new Date(Date.parse(to) + boundaryPaddingMs).toISOString(),
      50_000,
    );
    const simulation = runThermalSimulation({
      houseId: house.id,
      sensorId: sensor.id,
      roomLabel: sensor.room,
      from,
      to,
      indoorSamples,
      outdoorSamples,
      horizonHours,
      scenarioOutdoorTemperatureC,
    });
    response.json({ simulation });
  });
  app.patch(`${prefix}/houses/:id`, async (request, response) => {
    const houseId = request.params.id as string;
    const previous = database.getHouse(houseId);
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
    if (patch.location !== undefined) await requireArchivedBeforeCascade("house-location", houseId);
    const house = database.updateHouse(houseId, patch);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    if (patch.floors !== undefined) homeAssistant.refreshMappings();
    if (previous) {
      const observedAt = new Date().toISOString();
      if (previous.propertyId !== house.propertyId) {
        notifySpatial((runtime) => {
          runtime.scheduler.enqueueScope({ kind: "property", id: previous.propertyId }, observedAt, "ownership-changed", true);
          runtime.scheduler.wakeHouse(house.id, house.propertyId, observedAt, "ownership-changed");
        });
      } else if (patch.name !== undefined || patch.floors !== undefined || patch.location !== undefined
        || patch.mapPlacement !== undefined || patch.orientationDegrees !== undefined) {
        notifySpatial((runtime) => runtime.scheduler.wakeHouse(
          house.id,
          house.propertyId,
          observedAt,
          "property-context-changed",
        ));
      }
    }
    weather.invalidate(house.id);
    weatherEvents.invalidate(house.id);
    status.refreshWeatherConfiguration();
    response.json({ house });
  });
  app.put(`${prefix}/houses/:id/layout`, (request, response) => {
    const body = bodyObject(request.body);
    if (!Array.isArray(body.floors)) throw new HttpError(400, "INVALID_FIELD", "floors must be an array");
    const house = database.updateHouse(request.params.id as string, { floors: body.floors as Floor[] });
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    homeAssistant.refreshMappings();
    notifySpatial((runtime) => runtime.scheduler.wakeHouse(
      house.id,
      house.propertyId,
      new Date().toISOString(),
      "property-context-changed",
    ));
    response.json({ house });
  });
  app.put(`${prefix}/houses/:id/floors/:floorId`, (request, response) => {
    const house = database.getHouse(request.params.id as string);
    if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
    const floor = bodyObject(request.body) as unknown as Floor;
    if (typeof floor.id !== "string" || floor.id !== request.params.floorId) throw new HttpError(400, "INVALID_FIELD", "Floor id must match the route");
    const index = house.floors.findIndex((candidate) => candidate.id === floor.id);
    if (index < 0) throw new HttpError(404, "NOT_FOUND", "Floor not found");
    const floors = house.floors.slice();
    floors[index] = floor;
    const updated = database.updateHouse(house.id, { floors });
    if (!updated) throw new HttpError(404, "NOT_FOUND", "House not found");
    homeAssistant.refreshMappings();
    notifySpatial((runtime) => runtime.scheduler.wakeHouse(
      updated.id,
      updated.propertyId,
      new Date().toISOString(),
      "property-context-changed",
    ));
    response.json(floor);
  });
  app.delete(`${prefix}/houses/:id`, async (request, response) => {
    const houseId = request.params.id as string;
    const previous = database.getHouse(houseId);
    requireImmutableTelemetryLineage("house", houseId);
    if (!database.deleteHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    if (previous) notifySpatial((runtime) => runtime.scheduler.enqueueScope(
      { kind: "property", id: previous.propertyId },
      new Date().toISOString(),
      "ownership-changed",
      true,
    ));
    homeAssistant.refreshMappings();
    const remainingHomeAssistantConnections = (config.homeAssistantConnections ?? [])
      .filter((connection) => connection.houseId !== houseId);
    const remainingTpLinkConnections = (config.tpLinkConnections ?? [])
      .filter((connection) => connection.houseId !== houseId);
    if (remainingHomeAssistantConnections.length !== (config.homeAssistantConnections ?? []).length
      || remainingTpLinkConnections.length !== (config.tpLinkConnections ?? []).length) {
      updateIntegrationSecrets(config.integrationSecretsFile, {
        homeAssistantConnections: remainingHomeAssistantConnections,
        tpLinkConnections: remainingTpLinkConnections,
      });
      config.homeAssistantConnections = remainingHomeAssistantConnections;
      config.tpLinkConnections = remainingTpLinkConnections;
      if (options.startBackground) {
        homeAssistant.restart();
        tpLink.restart();
      }
    }
    weather.invalidate(houseId);
    weatherEvents.invalidate(houseId);
    const remainingGrants = config.appleNotesGrants.filter((grant) => grant.houseId !== houseId);
    if (remainingGrants.length !== config.appleNotesGrants.length) {
      updateIntegrationSecrets(config.integrationSecretsFile, { appleNotesGrants: remainingGrants });
      config.appleNotesGrants = remainingGrants;
      refreshAppleNotesStatus(config, status);
    }
    integrationMetadata.retireHouse(houseId);
    status.refreshWeatherConfiguration();
    response.status(204).end();
  });

  app.get(`${prefix}/sensors/snapshots`, (request, response) => {
    const access = visibility(response);
    const sensors = database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
      .filter((sensor) => access.sensor(sensor.id));
    const selected = new Set(sensors.map((sensor) => sensor.id));
    const latest = new Map(cachedLatestReadings().filter((reading) => selected.has(reading.sensorId))
      .map((reading) => [reading.sensorId, reading]));
    response.json({ sensors: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
  });
  app.get(`${prefix}/snapshot`, (request, response) => {
    const access = visibility(response);
    const sensors = database.listSensors(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
      .filter((sensor) => access.sensor(sensor.id));
    const selected = new Set(sensors.map((sensor) => sensor.id));
    const latest = new Map(cachedLatestReadings().filter((reading) => selected.has(reading.sensorId))
      .map((reading) => [reading.sensorId, reading]));
    response.json({ snapshot: sensors.map((sensor) => ({ ...sensor, reading: latest.get(sensor.id) ?? null })) });
  });
  app.get(`${prefix}/sensors`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
    const access = visibility(response);
    response.json({ sensors: database.listSensors(houseId).filter((sensor) => access.sensor(sensor.id)) });
  });
  app.post(`${prefix}/sensors`, (request, response) => {
    const body = bodyObject(request.body);
    const tags = body.tags === undefined ? [] : body.tags;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new HttpError(400, "INVALID_FIELD", "tags must be a string array");
    const input: Omit<Sensor, "id"> & { id?: string } = {
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      houseId: requiredString(body, "houseId"), floorId: requiredString(body, "floorId"), name: requiredString(body, "name"),
      ...(body.roomId !== undefined ? { roomId: body.roomId === null ? null : requiredString(body, "roomId") } : {}),
      room: requiredString(body, "room"), model: requiredString(body, "model"), x: requiredNumber(body, "x"),
      y: requiredNumber(body, "y"), z: requiredNumber(body, "z"), tags: tags as string[],
      enabled: body.enabled === undefined ? true : optionalBoolean(body, "enabled") as boolean,
      ...(optionalString(body, "temperatureEntityId") !== undefined ? { temperatureEntityId: optionalString(body, "temperatureEntityId") as string } : {}),
      ...(optionalString(body, "humidityEntityId") !== undefined ? { humidityEntityId: optionalString(body, "humidityEntityId") as string } : {}),
      ...(optionalString(body, "batteryEntityId") !== undefined ? { batteryEntityId: optionalString(body, "batteryEntityId") as string } : {}),
      ...(body.tpLinkDeviceId !== undefined && body.tpLinkDeviceId !== null
        ? { tpLinkDeviceId: requiredString(body, "tpLinkDeviceId") }
        : {}),
      ...(body.tpLinkConnectionId !== undefined && body.tpLinkConnectionId !== null
        ? { tpLinkConnectionId: requiredString(body, "tpLinkConnectionId") }
        : {}),
      ...(body.measurementEntityIds !== undefined ? { measurementEntityIds: measurementStringMap(body.measurementEntityIds, "measurementEntityIds") } : {}),
    };
    assertTpLinkConnectionScope(input);
    const sensor = database.createSensor(input);
    homeAssistant.refreshMappings();
    notifySpatialSensorChange(null, sensor);
    response.status(201).json({ sensor });
  });
  app.get(`${prefix}/sensors/:id`, (request, response) => {
    const sensor = database.getSensor(request.params.id as string);
    if (!sensor || !visibility(response).sensor(sensor.id)) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    response.json({ sensor, reading: database.getLatestReading(sensor.id) });
  });
  app.patch(`${prefix}/sensors/:id`, (request, response) => {
    const current = database.getSensor(request.params.id as string);
    const patch = parseSensorPatch(request.body);
    if (current && (Object.hasOwn(patch, "houseId") || Object.hasOwn(patch, "tpLinkDeviceId") || Object.hasOwn(patch, "tpLinkConnectionId"))) {
      const candidate = { ...current, ...patch };
      if (patch.tpLinkDeviceId === null) {
        delete candidate.tpLinkDeviceId;
        delete candidate.tpLinkConnectionId;
      }
      if (patch.tpLinkConnectionId === null) delete candidate.tpLinkConnectionId;
      assertTpLinkConnectionScope(candidate);
    }
    const sensor = database.updateSensor(request.params.id as string, patch);
    if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    homeAssistant.refreshMappings();
    notifySpatialSensorChange(current, sensor);
    response.json({ sensor });
  });
  app.put(`${prefix}/sensors/:id`, (request, response) => {
    const current = database.getSensor(request.params.id as string);
    const patch = parseSensorPatch(request.body);
    if (current && (Object.hasOwn(patch, "houseId") || Object.hasOwn(patch, "tpLinkDeviceId") || Object.hasOwn(patch, "tpLinkConnectionId"))) {
      const candidate = { ...current, ...patch };
      if (patch.tpLinkDeviceId === null) {
        delete candidate.tpLinkDeviceId;
        delete candidate.tpLinkConnectionId;
      }
      if (patch.tpLinkConnectionId === null) delete candidate.tpLinkConnectionId;
      assertTpLinkConnectionScope(candidate);
    }
    const sensor = database.updateSensor(request.params.id as string, patch);
    if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    homeAssistant.refreshMappings();
    notifySpatialSensorChange(current, sensor);
    response.json(sensor);
  });
  app.delete(`${prefix}/sensors/:id`, async (request, response) => {
    const current = database.getSensor(request.params.id as string);
    requireImmutableTelemetryLineage("sensor", request.params.id as string);
    if (!database.deleteSensor(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    homeAssistant.refreshMappings();
    notifySpatialSensorChange(current, null);
    response.status(204).end();
  });

  app.post(`${prefix}/readings`, requireIngestKey, (request, response) => {
    const candidate = request.body as unknown;
    const readingsInput = Array.isArray(candidate) ? candidate : (
      candidate && typeof candidate === "object" && Array.isArray((candidate as Record<string, unknown>).readings)
        ? (candidate as { readings: unknown[] }).readings : [candidate]
    );
    if (readingsInput.length === 0 || readingsInput.length > 1_000) throw new HttpError(400, "INVALID_BATCH", "Submit between 1 and 1000 readings");
    const submitted = readingsInput.map(parseReading);
    const readings = telemetry.ingestBatch(submitted);
    response.status(201).json({ readings, ignoredDuplicates: submitted.length - readings.length });
  });
  app.get(`${prefix}/readings/latest`, (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const access = visibility(response);
    const selected = (sensorIds.length ? sensorIds : database.listSensors().map((sensor) => sensor.id))
      .filter((sensorId) => access.sensor(sensorId));
    const selectedIds = new Set(selected);
    response.json({ readings: selected.length > 0
      ? cachedLatestReadings().filter((reading) => selectedIds.has(reading.sensorId))
      : [] });
  });
  app.get(`${prefix}/readings`, async (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const access = visibility(response);
    const selected = (sensorIds.length ? sensorIds : database.listSensors().map((sensor) => sensor.id))
      .filter((sensorId) => access.sensor(sensorId));
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
    const limit = safeInteger(request.query.limit, 2_000, 1, 50_000);
    const readings = (await telemetryReader.legacyReadingHistory({ sensorIds: selected, from, to, limit })).records;
    response.json({ readings });
  });
  app.get(`${prefix}/history`, async (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const access = visibility(response);
    const selected = (sensorIds.length ? sensorIds : database.listSensors().map((sensor) => sensor.id))
      .filter((sensorId) => access.sensor(sensorId));
    const to = dateValue(request.query.to, new Date(), "to");
    const from = dateValue(request.query.from, new Date(Date.parse(to) - 24 * 3_600_000), "from");
    if (Date.parse(from) > Date.parse(to)) throw new HttpError(400, "INVALID_RANGE", "from must be before to");
    const limit = safeInteger(request.query.limit, 20_000, 1, 50_000);
    const bucketSeconds = boundedQueryInteger(request.query.bucketSeconds, "bucketSeconds", 1, 86_400);
    const rawLimit = bucketSeconds === null ? limit + 1 : 100_000;
    const archived = (await telemetryReader.legacyReadingHistory({ sensorIds: selected, from, to, limit: rawLimit })).records;
    const requestedReadings = bucketSeconds === null ? archived : bucketLegacyReadings(archived, bucketSeconds);
    const truncated = requestedReadings.length > limit || (bucketSeconds !== null && archived.length === rawLimit);
    const readings = truncated ? requestedReadings.slice(-limit) : requestedReadings;
    const forecastHours = safeInteger(request.query.forecastHours, 0, 0, 168);
    const series = selected.map((sensorId) => ({
      sensorId,
      readings: readings.filter((reading) => reading.sensorId === sensorId),
      forecast: forecastHours ? forecast(database, sensorId, forecastHours) : [],
    }));
    response.json({ from, to, bucketSeconds, series, truncated });
  });
  app.get(`${prefix}/forecast`, (request, response) => {
    const sensorIds = queryList(request.query.sensorId);
    const access = visibility(response);
    const selected = (sensorIds.length ? sensorIds : database.listSensors().map((sensor) => sensor.id))
      .filter((sensorId) => access.sensor(sensorId));
    const horizonMinutes = safeInteger(request.query.horizonMinutes, 0, 0, 10_080);
    const hours = horizonMinutes > 0 ? Math.max(1, Math.ceil(horizonMinutes / 60)) : safeInteger(request.query.hours, 12, 1, 168);
    const series = selected.map((sensorId) => ({ sensorId, forecast: forecast(database, sensorId, hours) }));
    response.json({ generatedAt: new Date().toISOString(), model: "linear-v1", series, ...(series.length === 1 ? { forecast: series[0]?.forecast ?? [] } : {}) });
  });
  const streamTelemetry = (request: Request, response: Response): void => {
    if (rejectEventStreamDuringShutdown(response)) return;
    const filter = new Set(queryList(request.query.sensorId));
    const releaseStream = acquireEventStream(response);
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
      const access = authorizedStreamVisibility(request, response, acceptedAuthorization);
      if (!access) return;
      if (access.restricted && event.type === "integration") return;
      if ((event.type === "reading" || event.type === "measurement" || event.type === "alert")
        && !access.sensor(event.data.sensorId)) return;
      if (event.type === "weather" && !access.house(event.data.houseId)) return;
      if (filter.size > 0 && (event.type === "reading" || event.type === "alert")) {
        const data = event.data as Reading | { sensorId: string };
        if (!filter.has(data.sensorId)) return;
      }
      const id = event.type === "weather" ? `id: ${event.data.id}\n` : "";
      writer.send(`${id}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    };
    if (!visibility(response).restricted) write({ type: "integration", data: structuredClone(status.value) });
    const unsubscribe = bus.subscribe(write);
    const heartbeat = setInterval(() => write({ type: "heartbeat", data: { timestamp: new Date().toISOString() } }), 15_000);
    heartbeat.unref();
    registerEventStream(
      request,
      response,
      () => { clearInterval(heartbeat); unsubscribe(); writer.dispose(); },
      releaseStream,
    );
  };
  app.get(`${prefix}/stream`, streamTelemetry);
  app.get(`${prefix}/events`, streamTelemetry);

  app.get(`${prefix}/alert-rules`, (_request, response) => {
    const access = visibility(response);
    response.json({ rules: database.listAlertRules().filter((rule) => (
      !access.restricted || (rule.sensorId !== null && access.sensor(rule.sensorId))
    )) });
  });
  app.post(`${prefix}/alert-rules`, (request, response) => response.status(201).json(database.saveAlertRule(parseAlertRule(request.body, database))));
  app.patch(`${prefix}/alert-rules/:id`, (request, response) => {
    const current = database.getAlertRule(request.params.id as string);
    if (!current) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
    const body = bodyObject(request.body);
    const rule = database.updateAlertRule(current.id, {
      ...(body.name !== undefined ? { name: requiredString(body, "name") } : {}),
      ...(body.sensorId !== undefined ? { sensorId: body.sensorId === null ? null : requiredString(body, "sensorId") } : {}),
      ...(body.metric !== undefined ? { metric: (() => {
        const metric = measurementId(body.metric);
        if (!database.getMeasurementDefinition(metric)) throw new HttpError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${metric}`);
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
        current.sensorId ? database.getHouse(database.getSensor(current.sensorId)?.houseId ?? "")?.timezone ?? "UTC" : "UTC",
      ) } : {}),
    });
    response.json({ rule });
  });
  app.delete(`${prefix}/alert-rules/:id`, (request, response) => {
    if (!database.deleteAlertRule(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Alert rule not found");
    response.status(204).end();
  });
  app.get(`${prefix}/alert-events`, (request, response) => {
    const activeOnly = request.query.active === "true";
    const access = visibility(response);
    const limit = safeInteger(request.query.limit, 200, 1, 1_000);
    response.json({ events: visibleCollectionPage(
      (batchLimit, offset) => database.listAlertEvents(batchLimit, activeOnly, offset),
      (event) => access.sensor(event.sensorId),
      { limit, offset: 0 },
    ) });
  });
  app.get(`${prefix}/alerts`, (request, response) => {
    const activeOnly = request.query.active === "true";
    const access = visibility(response);
    const limit = safeInteger(request.query.limit, 200, 1, 1_000);
    response.json({ alerts: visibleCollectionPage(
      (batchLimit, offset) => database.listAlertEvents(batchLimit, activeOnly, offset),
      (event) => access.sensor(event.sensorId),
      { limit, offset: 0 },
    ) });
  });
  app.post(`${prefix}/alert-events/:id/acknowledge`, (request, response) => {
    const event = database.acknowledgeAlert(request.params.id as string, new Date().toISOString());
    if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
    bus.publish({ type: "alert", data: event });
    response.json({ event });
  });
  app.post(`${prefix}/alerts/:id/acknowledge`, (request, response) => {
    const event = database.acknowledgeAlert(request.params.id as string, new Date().toISOString());
    if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
    bus.publish({ type: "alert", data: event });
    response.json(event);
  });
  app.get(`${prefix}/notification-deliveries`, (request, response) => {
    const access = visibility(response);
    const limit = safeInteger(request.query.limit, 200, 1, 500);
    const deliveries = database.listNotificationDeliveries(limit * 2).filter((delivery) => {
      if (!access.restricted) return true;
      if (delivery.subjectKind !== "alert") return false;
      const event = database.getAlertEvent(delivery.subjectId);
      return Boolean(event && access.sensor(event.sensorId));
    }).slice(0, limit);
    response.json({ deliveries });
  });
  app.post(`${prefix}/notification-deliveries/:id/retry`, (request, response) => {
    if (!database.retryNotificationDelivery(request.params.id as string)) {
      throw new HttpError(409, "NOT_RETRYABLE", "Notification delivery is not dead-lettered or abandoned");
    }
    notificationOutbox.wake();
    const delivery = database.listNotificationDeliveries(500)
      .find((candidate) => candidate.id === request.params.id);
    response.json({ delivery });
  });
  app.get(`${prefix}/action-playbooks`, (request, response) => {
    const metric = typeof request.query.metric === "string" ? measurementId(request.query.metric) : undefined;
    response.json({ playbooks: database.listActionPlaybooks(metric, request.query.enabled === "true") });
  });
  app.post(`${prefix}/action-playbooks`, (request, response) => {
    response.status(201).json({ playbook: database.saveActionPlaybook(parseActionPlaybookInput(request.body) as ActionPlaybookInput) });
  });
  app.patch(`${prefix}/action-playbooks/:id`, (request, response) => {
    const playbook = database.updateActionPlaybook(
      request.params.id as string,
      parseActionPlaybookInput(request.body, true) as Partial<ActionPlaybookInput>,
    );
    if (!playbook) throw new HttpError(404, "NOT_FOUND", "Action playbook not found");
    response.json({ playbook });
  });
  app.get(`${prefix}/alerts/:id/action-playbooks`, (request, response) => {
    const event = database.getAlertEvent(request.params.id as string);
    if (!event) throw new HttpError(404, "NOT_FOUND", "Alert event not found");
    response.json({ playbooks: database.listActionPlaybooks(event.metric, true) });
  });
  app.get(`${prefix}/action-runs`, (request, response) => {
    const access = visibility(response);
    response.json({ runs: database.listActionRuns({
      ...(typeof request.query.sensorId === "string" ? { sensorId: request.query.sensorId } : {}),
      ...(typeof request.query.alertEventId === "string" ? { alertEventId: request.query.alertEventId } : {}),
      activeOnly: request.query.active === "true",
    }).filter((run) => access.sensor(run.sensorId)) });
  });
  app.post(`${prefix}/action-runs`, (request, response) => {
    const run = database.startActionRun(parseActionRunStart(request.body));
    bus.publish({ type: "mutation", data: { method: "POST", resource: `/action-runs/${run.id}`, occurredAt: run.createdAt } });
    response.status(201).json({ run });
  });
  app.post(`${prefix}/action-runs/:id/complete`, (request, response) => {
    const run = database.completeActionRun(request.params.id as string);
    if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
    bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
    response.json({ run });
  });
  app.post(`${prefix}/action-runs/:id/cancel`, (request, response) => {
    const body = request.body === undefined ? {} : bodyObject(request.body);
    const note = body.note === undefined || body.note === null ? null : requiredString(body, "note");
    const run = database.cancelActionRun(request.params.id as string, note);
    if (!run) throw new HttpError(404, "NOT_FOUND", "Action run not found");
    bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/action-runs/${run.id}`, occurredAt: run.updatedAt } });
    response.json({ run });
  });
  app.get(`${prefix}/data-export/preview`, (request, response) => {
    const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel");
    const includeTelemetry = request.query.includeTelemetry === "true";
    response.json({ preview: dataOperations.preview(privacyLevel, includeTelemetry) });
  });
  app.get(`${prefix}/data-export`, async (request, response) => {
    const privacyLevel = enumValue(request.query.privacyLevel ?? "operations", ["structure", "operations", "full"] as const, "privacyLevel") as DataExportPrivacyLevel;
    const includeTelemetry = request.query.includeTelemetry === "true";
    if (includeTelemetry && telemetryRetention) {
      throw new HttpError(409, "ARCHIVE_EXPORT_REQUIRES_BACKUP", "A raw telemetry JSON export is unavailable after SQLite hot retention; use a verified backup, which includes both SQLite and TimescaleDB");
    }
    const generatedAt = new Date().toISOString();
    const preview = dataOperations.preview(privacyLevel, includeTelemetry);
    const controlPlane = dataOperations.bundle(privacyLevel);
    dataOperations.audit("export.started", { privacyLevel, includeTelemetry });
    response.status(200);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-disposition", `attachment; filename="stuga-export-${generatedAt.replace(/[:.]/g, "-")}.json"`);
    response.setHeader("cache-control", "no-store");
    response.flushHeaders();
    const write = async (chunk: string): Promise<boolean> => {
      if (response.destroyed || request.destroyed) return false;
      if (response.write(chunk)) return true;
      await new Promise<void>((resolve) => response.once("drain", resolve));
      return !response.destroyed && !request.destroyed;
    };
    const head = JSON.stringify({
      schemaVersion: "stuga.export/v1",
      generatedAt,
      privacyLevel,
      includesTelemetry: includeTelemetry,
      privacyPreview: preview,
      data: controlPlane,
    });
    if (!includeTelemetry) {
      response.end(head);
      dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
      return;
    }
    if (!await write(`${head.slice(0, -1)},"telemetry":{`)) return;
    const telemetryTables = ["measurement_samples", "readings", "outdoor_temperature_samples", "electricity_price_points"] as const;
    for (let tableIndex = 0; tableIndex < telemetryTables.length; tableIndex += 1) {
      const table = telemetryTables[tableIndex]!;
      if (!await write(`${tableIndex === 0 ? "" : ","}${JSON.stringify(table)}:[`)) return;
      let first = true;
      for (const row of database.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate() as Iterable<Record<string, unknown>>) {
        if (!await write(`${first ? "" : ","}${JSON.stringify(row)}`)) return;
        first = false;
      }
      if (!await write("]")) return;
    }
    response.end("}}");
    dataOperations.audit("export.completed", { privacyLevel, includeTelemetry });
  });
  app.get(`${prefix}/backups/status`, (_request, response) => {
    response.json({ backup: dataOperations.backupStatus() });
  });
  app.post(`${prefix}/backups`, (_request, response) => {
    response.status(202).json({ backup: dataOperations.requestBackup() });
  });
  app.get(`${prefix}/setup/doctor`, (_request, response) => {
    response.json({ report: setupDoctor.report() });
  });
  app.get(`${prefix}/sensors/:id/label`, (request, response) => {
    const label = setupDoctor.sensorLabel(request.params.id as string);
    if (!label) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    response.json({ label });
  });
  app.post(`${prefix}/setup/bulk-sensor-mappings`, (request, response) => {
    const body = bodyObject(request.body);
    const houseId = requiredString(body, "houseId");
    if (!Array.isArray(body.mappings)) throw new HttpError(400, "INVALID_FIELD", "mappings must be an array");
    const mappings = body.mappings.map((candidate) => {
      const mapping = bodyObject(candidate);
      if (!mapping.measurementEntityIds || typeof mapping.measurementEntityIds !== "object" || Array.isArray(mapping.measurementEntityIds)) {
        throw new HttpError(400, "INVALID_FIELD", "measurementEntityIds must be an object");
      }
      return { sensorId: requiredString(mapping, "sensorId"), measurementEntityIds: Object.fromEntries(
        Object.entries(mapping.measurementEntityIds as Record<string, unknown>).map(([metric, entityId]) => {
          if (typeof entityId !== "string") throw new HttpError(400, "INVALID_FIELD", "Entity ids must be strings");
          return [metric, entityId];
        }),
      ) };
    });
    const sensors = database.bulkUpdateSensorBindings(houseId, mappings);
    bus.publish({ type: "mutation", data: { method: "PATCH", resource: `/houses/${houseId}/sensor-mappings`, occurredAt: new Date().toISOString() } });
    response.json({ sensors });
  });

  app.get(`${prefix}/observations`, (request, response) => {
    const access = visibility(response);
    response.json({ observations: database.listObservations(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
      .filter((observation) => access.house(observation.houseId)) });
  });
  app.post(`${prefix}/observations`, (request, response) => {
    const observation = database.createObservation(parseObservationInput(request.body), "local-rest");
    response.status(201).json(observation);
  });
  app.patch(`${prefix}/observations/:id`, (request, response) => {
    const observation = database.updateObservation(
      request.params.id as string,
      parseObservationPatch(request.body),
      "local-rest",
    );
    if (!observation) throw new HttpError(404, "NOT_FOUND", "Observation not found");
    response.json(observation);
  });
  app.get(`${prefix}/observations/:id/revisions`, (request, response) => {
    const id = request.params.id as string;
    const observation = database.getObservation(id);
    const access = visibility(response);
    if (!observation || !access.house(observation.houseId)) throw new HttpError(404, "NOT_FOUND", "Observation not found");
    if (access.restricted) throw new HttpError(403, "GUEST_AUDIT_RESTRICTED", "Guest accounts cannot access revision histories");
    response.json({ revisions: database.listObservationRevisions(id) });
  });
  app.delete(`${prefix}/observations/:id`, (request, response) => {
    if (!database.deleteObservation(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Observation not found");
    response.status(204).end();
  });

  app.get(`${prefix}/maintenance-tasks`, (request, response) => {
    const propertyId = optionalResourceQuery(request.query.propertyId, "propertyId");
    const houseId = optionalResourceQuery(request.query.houseId, "houseId");
    const areaId = optionalResourceQuery(request.query.areaId, "areaId");
    const equipmentId = optionalResourceQuery(request.query.equipmentId, "equipmentId");
    const page = collectionPage(request.query);
    const access = visibility(response);
    response.json({
      maintenanceTasks: visibleCollectionPage(
        (limit, offset) => database.listMaintenanceTasks({
          ...(propertyId ? { propertyId } : {}),
          ...(houseId ? { houseId } : {}),
          ...(areaId ? { areaId } : {}),
          ...(equipmentId ? { equipmentId } : {}),
          limit,
          offset,
        }),
        (task) => access.maintenance(task),
        page,
      ),
    });
  });
  app.post(`${prefix}/maintenance-tasks`, (request, response) => {
    response.status(201).json(database.createMaintenanceTask(parseMaintenanceTaskInput(request.body), "local-rest"));
  });
  app.get(`${prefix}/maintenance-tasks/:id`, (request, response) => {
    const task = database.getMaintenanceTask(request.params.id as string);
    if (!task || !visibility(response).maintenance(task)) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
    response.json(task);
  });
  app.patch(`${prefix}/maintenance-tasks/:id`, (request, response) => {
    const task = database.updateMaintenanceTask(
      request.params.id as string,
      parseMaintenanceTaskPatch(request.body),
      "local-rest",
    );
    if (!task) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
    response.json(task);
  });
  app.get(`${prefix}/maintenance-tasks/:id/revisions`, (request, response) => {
    const id = request.params.id as string;
    const task = database.getMaintenanceTask(id);
    const access = visibility(response);
    if (!task || !access.maintenance(task)) throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
    if (access.restricted) throw new HttpError(403, "GUEST_AUDIT_RESTRICTED", "Guest accounts cannot access revision histories");
    response.json({ revisions: database.listMaintenanceTaskRevisions(id) });
  });
  app.delete(`${prefix}/maintenance-tasks/:id`, (request, response) => {
    if (!database.deleteMaintenanceTask(request.params.id as string)) {
      throw new HttpError(404, "NOT_FOUND", "Maintenance task not found");
    }
    response.status(204).end();
  });

  app.get(`${prefix}/parameters`, (request, response) => {
    const access = visibility(response);
    response.json({ parameters: database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
      .filter((parameter) => access.house(parameter.houseId)) });
  });
  app.post(`${prefix}/parameters`, (request, response) => {
    const body = bodyObject(request.body);
    if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
    const parameter = database.saveParameter({
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      houseId: requiredString(body, "houseId"),
      scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
      scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"),
      value: body.value as StaticParameter["value"], unit: body.unit === null ? null : optionalString(body, "unit") ?? null,
      label: requiredString(body, "label"),
    });
    response.status(200).json({ parameter });
  });
  app.get(`${prefix}/static-parameters`, (request, response) => {
    const access = visibility(response);
    response.json({ parameters: database.listParameters(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
      .filter((parameter) => access.house(parameter.houseId)) });
  });
  app.post(`${prefix}/static-parameters`, (request, response) => {
    const body = bodyObject(request.body);
    if (!["string", "number", "boolean"].includes(typeof body.value)) throw new HttpError(400, "INVALID_FIELD", "value must be a string, number, or boolean");
    const parameter = database.saveParameter({
      houseId: requiredString(body, "houseId"), scopeType: enumValue(body.scopeType, ["house", "floor", "room", "sensor"] as const, "scopeType"),
      scopeId: requiredString(body, "scopeId"), key: requiredString(body, "key"), value: body.value as StaticParameter["value"],
      unit: body.unit === null ? null : optionalString(body, "unit") ?? null, label: requiredString(body, "label"),
    });
    response.status(201).json(parameter);
  });
  app.delete(`${prefix}/parameters/:id`, (request, response) => {
    if (!database.deleteParameter(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Static parameter not found");
    response.status(204).end();
  });

  app.get(`${prefix}/assets`, (request, response) => {
    const access = visibility(response);
    response.json({ assets: database.listAssets(typeof request.query.houseId === "string" ? request.query.houseId : undefined)
      .filter((asset) => access.house(asset.houseId)) });
  });
  app.post(`${prefix}/assets`, (request, response) => {
    const body = bodyObject(request.body);
    const mimeType = requiredString(body, "mimeType").toLowerCase();
    if (!SAFE_ASSET_MIME_TYPES.has(mimeType)) {
      throw new HttpError(415, "UNSUPPORTED_ASSET_TYPE", "Assets must be PNG, JPEG, WebP, glTF, or GLB");
    }
    const encoded = requiredString(body, "data").replace(/^data:[^;]+;base64,/, "");
    const data = Buffer.from(encoded, "base64");
    if (data.length === 0) throw new HttpError(400, "INVALID_ASSET", "data must contain valid base64 bytes");
    if (data.length > 10 * 1024 * 1024) throw new HttpError(413, "ASSET_TOO_LARGE", "Decoded assets are limited to 10 MiB");
    const asset = database.createAsset({
      houseId: requiredString(body, "houseId"), name: requiredString(body, "name"), mimeType,
      kind: enumValue(body.kind, ["floor-plan", "model-3d", "other"] as const, "kind"), data,
    });
    response.status(201).json({ asset, url: `${prefix}/assets/${asset.id}` });
  });
  app.get(`${prefix}/assets/:id`, (request, response) => {
    const asset = database.getAsset(request.params.id as string);
    if (!asset || !visibility(response).house(asset.houseId)) throw new HttpError(404, "NOT_FOUND", "Asset not found");
    response.setHeader("content-type", asset.mimeType);
    response.setHeader("content-length", String(asset.size));
    response.setHeader("content-security-policy", "sandbox; default-src 'none'");
    const disposition = asset.mimeType.startsWith("image/") ? "inline" : "attachment";
    response.setHeader("content-disposition", `${disposition}; filename="${asset.name.replace(/["\r\n]/g, "_")}"`);
    response.send(Buffer.from(asset.data));
  });
  app.delete(`${prefix}/assets/:id`, (request, response) => {
    if (!database.deleteAsset(request.params.id as string)) throw new HttpError(404, "NOT_FOUND", "Asset not found");
    response.status(204).end();
  });

  app.get(`${prefix}/integrations/status`, (request, response) => {
    dataMode.synchronize();
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
    if (houseId && !database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    response.json(integrationStatusForHouse(houseId));
  });
  app.get(`${prefix}/integrations/sensor-data-gaps`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId.trim() : undefined;
    const sensorId = typeof request.query.sensorId === "string" ? request.query.sensorId.trim() : undefined;
    const access = visibility(response);
    if (houseId && (!database.getHouse(houseId) || !access.house(houseId))) {
      throw new HttpError(404, "NOT_FOUND", "House not found");
    }
    const limit = safeInteger(request.query.limit, 100, 1, 1_000);
    const gaps = database.listSensorDataGaps(sensorId, limit)
      .filter((gap) => {
        const sensor = database.getSensor(gap.sensorId);
        return Boolean(sensor && access.sensor(gap.sensorId) && (!houseId || sensor.houseId === houseId));
      });
    response.json({ gaps });
  });
  app.post(`${prefix}/integrations/discover`, async (request, response) => {
    const body = bodyObject(request.body);
    const houseId = body.houseId === undefined ? undefined : requiredString(body, "houseId");
    if (houseId && !database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const hasDraftUsername = body.tpLinkUsername !== undefined;
    const hasDraftPassword = body.tpLinkPassword !== undefined;
    if (hasDraftUsername !== hasDraftPassword) {
      throw new HttpError(400, "INVALID_TP_LINK_CREDENTIALS", "tpLinkUsername and tpLinkPassword must be supplied together");
    }
    const draftCredentials = hasDraftUsername && hasDraftPassword
      ? {
          username: credentialString(body, "tpLinkUsername", 320, true),
          password: credentialString(body, "tpLinkPassword", 4_096),
        }
      : undefined;
    const [homeAssistantResult, tpLinkResult] = await Promise.allSettled([
      discoverHomeAssistant(),
      tpLink.discoverSources(houseId, draftCredentials),
    ]);
    const warnings: string[] = [];
    if (homeAssistantResult.status === "rejected") warnings.push("Home Assistant discovery was unavailable. Enter its address manually.");
    if (tpLinkResult.status === "rejected") warnings.push("TP-Link discovery was unavailable. Enter the hub or energy-device address manually.");
    else warnings.push(...tpLinkResult.value.warnings);
    response.json({
      homeAssistant: homeAssistantResult.status === "fulfilled" ? homeAssistantResult.value : [],
      tpLink: tpLinkResult.status === "fulfilled" ? tpLinkResult.value.sources : [],
      warnings,
    });
  });
  app.post(`${prefix}/integrations/telegram/discover`, async (request, response) => {
    const body = bodyObject(request.body);
    response.json(await telegram.discover(credentialString(body, "botToken", 256, true)));
  });
  app.put(`${prefix}/integrations/telegram/config`, async (request, response) => {
    const generation = ++telegramConfigurationGeneration;
    const body = bodyObject(request.body);
    const botToken = credentialString(body, "botToken", 256, true);
    const chatId = credentialString(body, "chatId", 32, true);
    const identity = await telegram.verify(botToken, chatId);
    if (generation !== telegramConfigurationGeneration) {
      throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer Telegram configuration change superseded this request");
    }
    notificationOutbox.fenceTelegramConfigurationChange();
    updateIntegrationSecrets(config.integrationSecretsFile, { telegram: { botToken, chatId } });
    integrationMetadata.saveTelegramIdentity({
      botUsername: identity.botUsername,
      chatLabel: identity.chatLabel,
    });
    config.telegramBotToken = botToken;
    config.telegramChatId = chatId;
    telegramDeliveryGeneration += 1;
    const telegramStatus = status.value.telegram!;
    telegramStatus.configured = true;
    telegramStatus.connected = false;
    telegramStatus.botUsername = identity.botUsername;
    telegramStatus.chatLabel = identity.chatLabel;
    telegramStatus.lastDeliveryAt = null;
    telegramStatus.error = null;
    status.changed();
    response.json({ ok: true, configured: true, integration: structuredClone(status.value) });
  });
  app.post(`${prefix}/integrations/telegram/test`, async (_request, response) => {
    if (!config.telegramBotToken || !config.telegramChatId) {
      throw new HttpError(409, "TELEGRAM_NOT_CONFIGURED", "Configure a Telegram bot and private chat before sending a test message");
    }
    const botToken = config.telegramBotToken;
    const chatId = config.telegramChatId;
    const telegramStatus = status.value.telegram!;
    try {
      const identity = await telegram.verify(botToken, chatId);
      integrationMetadata.saveTelegramIdentity({
        botUsername: identity.botUsername,
        chatLabel: identity.chatLabel,
        reason: "identity-refreshed",
      });
      await telegram.sendTest(botToken, chatId);
      telegramStatus.connected = true;
      telegramStatus.botUsername = identity.botUsername;
      telegramStatus.chatLabel = identity.chatLabel;
      telegramStatus.lastDeliveryAt = new Date().toISOString();
      telegramStatus.error = null;
      status.changed();
      response.json({ ok: true, message: "The Telegram test message was delivered." });
    } catch (error) {
      telegramStatus.connected = false;
      telegramStatus.error = error instanceof TelegramServiceError ? error.message : "Telegram test delivery failed";
      status.changed();
      throw error;
    }
  });
  app.delete(`${prefix}/integrations/telegram/config`, (_request, response) => {
    telegramConfigurationGeneration += 1;
    notificationOutbox.fenceTelegramConfigurationChange();
    updateIntegrationSecrets(config.integrationSecretsFile, { telegram: null });
    integrationMetadata.retireTelegram();
    config.telegramBotToken = null;
    config.telegramChatId = null;
    telegramDeliveryGeneration += 1;
    const telegramStatus = status.value.telegram!;
    telegramStatus.configured = false;
    telegramStatus.connected = false;
    telegramStatus.botUsername = null;
    telegramStatus.chatLabel = null;
    telegramStatus.lastDeliveryAt = null;
    telegramStatus.error = null;
    status.changed();
    response.json({ ok: true, integration: structuredClone(status.value) });
  });
  app.get(`${prefix}/integrations/telegram/setup`, (_request, response) => response.json({
    available: true,
    configured: status.value.telegram!.configured,
    privateChatsOnly: true,
    steps: [
      "Open @BotFather in Telegram, create a bot, and copy its bot token.",
      "Open the new bot from the intended private Telegram account and send /start.",
      "Enter the bot token in Stuga, discover private chats, select the recipient, and save.",
      "Send a test message, then enable Telegram on each alert rule that should notify this chat.",
    ],
    privacy: [
      "The bot token is write-only through the API and is stored in the protected local integration secrets file, never SQLite.",
      "Alert messages contain only the house and sensor labels, rule, metric, value, threshold, severity, and time; Telegram content protection is enabled.",
      "Mock and replay data never trigger Telegram delivery. Informational alerts are delivered silently.",
    ],
    limitations: [
      "Only one private chat can be configured in this local Stuga instance.",
      "Groups, channels, topics, attachments, and Telegram account credentials are not supported.",
      "Telegram has no idempotency key for Bot API sends. Durable retries are at-least-once, so an ambiguous crash or network failure can produce a duplicate alert.",
    ],
  }));

  app.use(`${prefix}/integrations/apple-notes`, (_request, response, next) => {
    response.setHeader("cache-control", "no-store");
    next();
  });
  app.get(`${prefix}/integrations/apple-notes/grants`, (_request, response) => response.json({
    grants: config.appleNotesGrants.map(appleNotesGrantSummary),
  }));
  app.post(`${prefix}/integrations/apple-notes/grants`, (request, response) => {
    const body = bodyObject(request.body);
    const houseId = requiredString(body, "houseId");
    const deviceLabel = requiredString(body, "deviceLabel");
    if (Array.from(deviceLabel).length > 100) throw new HttpError(400, "INVALID_FIELD", "deviceLabel must be at most 100 characters");
    if (!database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const token = `stuga_notes_${randomBytes(32).toString("base64url")}`;
    const grant: AppleNotesGrantSecret = {
      id: randomUUID(),
      tokenHash: `sha256:${createHash("sha256").update(token).digest("hex")}`,
      deviceLabel,
      houseId,
      createdAt: new Date().toISOString(),
    };
    const secrets = updateIntegrationSecrets(config.integrationSecretsFile, { addAppleNotesGrant: grant });
    integrationMetadata.saveAppleNotesGrant(grant);
    config.appleNotesGrants = secrets.appleNotesGrants ?? [];
    refreshAppleNotesStatus(config, status);
    response.status(201).json({ ...appleNotesGrantSummary(grant), token, integration: structuredClone(status.value) });
  });
  app.delete(`${prefix}/integrations/apple-notes/grants/:id`, (request, response) => {
    const id = request.params.id as string;
    if (!config.appleNotesGrants.some((grant) => grant.id === id)) {
      throw new HttpError(404, "NOT_FOUND", "Apple Notes Shortcut grant not found");
    }
    const secrets = updateIntegrationSecrets(config.integrationSecretsFile, { removeAppleNotesGrantId: id });
    integrationMetadata.retireAppleNotesGrant(id);
    config.appleNotesGrants = secrets.appleNotesGrants ?? [];
    refreshAppleNotesStatus(config, status);
    response.json({ ok: true, integration: structuredClone(status.value) });
  });
  app.get(`${prefix}/integrations/apple-notes/setup`, (_request, response) => response.json({
    available: true,
    snapshotPath: "/integrations/apple-notes/snapshot",
    capturePath: "/integrations/apple-notes/capture",
    steps: [
      "Create a house-scoped Shortcut grant in Stuga and copy its bearer token; the token is shown only once.",
      "In Shortcuts, fetch the snapshot URL with an Authorization: Bearer header containing that token.",
      "Create a new dated Apple Note from the returned text on a schedule or when you run the Shortcut; do not overwrite an existing note.",
      "For quick capture, generate one UUID before any in-run retry block and POST it as operationId in the documented command JSON.",
      "Reuse that UUID variable for every HTTP attempt in the same run; Stuga returns the original task without duplicating it. Restarting the Shortcut generates a new operation unless you persist the UUID, so check Stuga before rerunning after an unknown result.",
    ],
    limitations: [
      "Apple Notes has no server API. This is a user-run iOS Shortcuts bridge, not live Apple Account synchronization.",
      "Stuga is the source of truth. Notes checkboxes and arbitrary note edits are never parsed or applied.",
      "Capture creates maintenance tasks only; completing, verifying, rescheduling, and deleting tasks stays in Stuga.",
      "The iPhone must be able to reach this Stuga address, preferably over private HTTPS or a trusted home network.",
    ],
  }));
  app.get(`${prefix}/integrations/apple-notes/snapshot`, (request, response) => {
    const grant = appleNotesGrant(request, config);
    const houseQuery = request.query.houseId;
    if (typeof houseQuery !== "string" || !houseQuery.trim()) throw new HttpError(400, "INVALID_FIELD", "houseId is required");
    const houseId = houseQuery.trim();
    if (grant.houseId !== houseId) throw new HttpError(403, "APPLE_NOTES_HOUSE_SCOPE", "This Shortcut grant cannot access the requested house");
    const snapshot = appleNotesSnapshot(database, houseId);
    const appleNotes = status.value.appleNotes!;
    appleNotes.lastSyncAt = snapshot.generatedAt;
    appleNotes.error = null;
    status.changed();
    response.json(snapshot);
  });
  app.post(`${prefix}/integrations/apple-notes/capture`, (request, response) => {
    const grant = appleNotesGrant(request, config);
    const capture = appleNotesCaptureInput(request.body);
    if (capture.input.houseId !== grant.houseId) {
      throw new HttpError(403, "APPLE_NOTES_HOUSE_SCOPE", "This Shortcut grant cannot create tasks for the requested house");
    }
    const id = capture.input.id!;
    const { task, created } = database.getOrCreateMaintenanceTask(capture.input, "local-rest");
    const deduplicated = !created;
    if (deduplicated) {
      const original = database.listMaintenanceTaskRevisions(id)[0]?.snapshot;
      if (!original || !appleNotesCaptureMatches(original, capture.input)) {
        throw new HttpError(409, "APPLE_NOTES_OPERATION_CONFLICT", "operationId was already used with different maintenance content");
      }
    }
    const result: AppleNotesMaintenanceCaptureResult = {
      ok: true,
      deduplicated,
      task,
      receipt: `apple-notes:${capture.operationId}`,
    };
    const appleNotes = status.value.appleNotes!;
    appleNotes.lastSyncAt = new Date().toISOString();
    appleNotes.error = null;
    status.changed();
    response.status(deduplicated ? 200 : 201).json(result);
  });
  app.post(`${prefix}/integrations/home-assistant/test-draft`, async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = bodyObject(request.body);
    const url = homeAssistantUrl(credentialString(body, "url", 2_048, true));
    const token = credentialString(body, "token", 8_192);
    response.json(await homeAssistantCredentialTester(url, token));
  });
  app.post(`${prefix}/integrations/tp-link/test-draft`, async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const body = bodyObject(request.body);
    const host = networkHost(credentialString(body, "host", 253, true));
    const username = credentialString(body, "username", 320, true);
    const password = credentialString(body, "password", 4_096);
    response.json(await tpLinkCredentialTester(host, username, password));
  });
  app.put(`${prefix}/integrations/home-assistant/config`, async (request, response) => {
    const body = bodyObject(request.body);
    const houseId = body.houseId === undefined ? database.listHouses()[0]?.id : requiredString(body, "houseId");
    if (!houseId || !database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const generation = (homeAssistantConfigurationGenerations.get(houseId) ?? 0) + 1;
    homeAssistantConfigurationGenerations.set(houseId, generation);
    const url = homeAssistantUrl(credentialString(body, "url", 2_048, true));
    const token = credentialString(body, "token", 8_192);
    const validation = await homeAssistantCredentialTester(url, token);
    if (!validation.ok || !validation.connected) {
      throw new HttpError(422, "INTEGRATION_VALIDATION_FAILED", validation.message);
    }
    if (generation !== homeAssistantConfigurationGenerations.get(houseId)) {
      throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer Home Assistant configuration superseded this request");
    }
    const existingConnections = config.homeAssistantConnections ?? [];
    const replacingLegacy = existingConnections.length === 0 && !config.homeAssistantLegacyDisabled
      && Boolean(config.haUrl && config.haToken);
    const connections = [...existingConnections.filter((connection) => connection.houseId !== houseId), { houseId, url, token }];
    updateIntegrationSecrets(config.integrationSecretsFile, {
      homeAssistant: null,
      homeAssistantConnections: connections,
      ...(replacingLegacy ? { homeAssistantLegacyDisabled: true } : {}),
    });
    if (replacingLegacy) integrationMetadata.retireHomeAssistant(houseId, true);
    integrationMetadata.saveHomeAssistant({ houseId, url });
    config.homeAssistantConnections = connections;
    if (replacingLegacy) config.homeAssistantLegacyDisabled = true;
    status.value.homeAssistant.configured = true;
    status.value.homeAssistant.error = null;
    status.value.homeAssistant.connections = [
      ...(status.value.homeAssistant.connections ?? []).filter((connection) => connection.houseId !== houseId),
      { houseId, configured: true, connected: false, lastEventAt: null, mappedEntities: 0, error: null },
    ];
    const wasRealMode = dataMode.isRealMode;
    dataMode.activate();
    if (wasRealMode) status.changed();
    if (options.startBackground) homeAssistant.restart();
    response.json({ ok: true, configured: true, houseId, integration: structuredClone(status.value) });
  });
  app.put(`${prefix}/integrations/tp-link/config`, async (request, response) => {
    const body = bodyObject(request.body);
    const host = networkHost(credentialString(body, "host", 253, true));
    const username = credentialString(body, "username", 320, true);
    const password = credentialString(body, "password", 4_096);
    const houseId = body.houseId === undefined
      ? database.listHouses()[0]?.id
      : requiredString(body, "houseId");
    if (!houseId || !database.getHouse(houseId)) throw new HttpError(404, "NOT_FOUND", "House not found");
    const requestedConnectionId = body.connectionId === undefined ? null : requiredString(body, "connectionId");
    const generationKey = requestedConnectionId ?? houseId;
    const generation = (tpLinkConfigurationGenerations.get(generationKey) ?? 0) + 1;
    tpLinkConfigurationGenerations.set(generationKey, generation);
    const validation = await tpLinkCredentialTester(host, username, password);
    if (!validation.ok || !validation.connected) {
      throw new HttpError(422, "INTEGRATION_VALIDATION_FAILED", validation.message);
    }
    if (generation !== tpLinkConfigurationGenerations.get(generationKey)) {
      throw new HttpError(409, "INTEGRATION_CONFIG_SUPERSEDED", "A newer TP-Link configuration superseded this request");
    }
    const explicitConnections = config.tpLinkConnections ?? [];
    const legacyHouseId = status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
      ?? database.listHouses()[0]?.id;
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
    const unscopedSensors = database.listSensors(houseId)
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
      const existingDeviceIds = new Set(tpLink.listDiscoveredDevices(houseId)
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
      database.reassignTpLinkSensors(houseId, sensorAssignments);
    }
    try {
      updateIntegrationSecrets(config.integrationSecretsFile, {
        tpLink: null,
        tpLinkConnections: connections,
        ...(legacyConnection ? { tpLinkLegacyDisabled: true } : {}),
      });
    } catch (error) {
      if (sensorAssignments.length > 0) {
        database.reassignTpLinkSensors(houseId, sensorAssignments.map((assignment) => ({
          sensorId: assignment.sensorId,
          fromConnectionId: assignment.toConnectionId,
          toConnectionId: assignment.fromConnectionId,
        })));
      }
      throw error;
    }
    if (legacyConnection && connection.id !== legacyConnection.id) {
      integrationMetadata.saveTpLink({
        id: legacyConnection.id,
        houseId: legacyConnection.houseId,
        host: legacyConnection.host,
        reason: "reconciled",
      });
    }
    integrationMetadata.saveTpLink({ id: connection.id, houseId, host });
    config.tpLinkConnections = connections;
    if (legacyConnection) config.tpLinkLegacyDisabled = true;
    status.value.tpLink.configured = true;
    status.value.tpLink.error = null;
    const previousConnectionStatuses = new Map((status.value.tpLink.connections ?? [])
      .map((candidate) => [candidate.id, candidate] as const));
    status.value.tpLink.connections = connections.map((candidate) => {
      const previous = previousConnectionStatuses.get(candidate.id);
      if (candidate.id !== connection.id && previous) return previous;
      return {
        id: candidate.id, houseId: candidate.houseId, configured: true, connected: false, lastPollAt: null,
        mappedDevices: 0, discoveredDevices: 0, hubModel: null, error: null,
      };
    });
    const wasRealMode = dataMode.isRealMode;
    dataMode.activate();
    if (wasRealMode) status.changed();
    if (options.startBackground) tpLink.restart();
    response.json({ ok: true, configured: true, connectionId: connection.id, houseId, integration: structuredClone(status.value) });
  });
  app.patch(`${prefix}/integrations/tp-link/config/:connectionId`, (request, response) => {
    const connectionId = request.params.connectionId as string;
    const targetHouseId = requiredString(bodyObject(request.body), "houseId");
    if (!database.getHouse(targetHouseId)) throw new HttpError(404, "NOT_FOUND", "Target house not found");
    const existing = config.tpLinkConnections ?? [];
    const explicitConnection = existing.find((candidate) => candidate.id === connectionId);
    const legacyHouseId = status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
      ?? database.listHouses()[0]?.id;
    const legacyConnection = connectionId === "legacy" && existing.length === 0 && !config.tpLinkLegacyDisabled
      && legacyHouseId && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
      ? {
          id: "legacy", houseId: legacyHouseId, host: config.tpLinkHost,
          username: config.tpLinkUsername, password: config.tpLinkPassword,
        }
      : null;
    const connection = explicitConnection ?? legacyConnection;
    if (!connection) throw new HttpError(404, "NOT_FOUND", "TP-Link connection not found");
    if (connection.houseId === targetHouseId) {
      response.json({ ok: true, fromHouseId: connection.houseId, houseId: targetHouseId, detachedSensorIds: [], integration: structuredClone(status.value) });
      return;
    }
    if (existing.some((candidate) => candidate.id !== connectionId
      && candidate.houseId === targetHouseId && candidate.host === connection.host)) {
      throw new HttpError(409, "TP_LINK_ALREADY_ASSIGNED", "This TP-Link system is already assigned to the target house");
    }
    tpLinkConfigurationGenerations.set(connectionId, (tpLinkConfigurationGenerations.get(connectionId) ?? 0) + 1);
    const fromHouseId = connection.houseId;
    const moved = { ...connection, houseId: targetHouseId };
    const migratingLegacy = explicitConnection === undefined && legacyConnection !== null;
    const connections = migratingLegacy
      ? [moved]
      : existing.map((candidate) => candidate.id === connectionId ? moved : candidate);
    updateIntegrationSecrets(config.integrationSecretsFile, {
      tpLink: null,
      tpLinkConnections: connections,
      ...(migratingLegacy ? { tpLinkLegacyDisabled: true } : {}),
    });
    integrationMetadata.moveTpLink(connectionId, targetHouseId, connection.host);
    config.tpLinkConnections = connections;
    if (migratingLegacy) config.tpLinkLegacyDisabled = true;
    const detachedSensorIds = database.detachTpLinkConnection(connectionId, migratingLegacy ? fromHouseId : undefined);
    if (options.startBackground) tpLink.restart();
    else {
      status.value.tpLink.connections = (status.value.tpLink.connections ?? []).map((candidate) => candidate.id === connectionId
        ? {
            ...candidate,
            houseId: targetHouseId,
            connected: false,
            lastPollAt: null,
            mappedDevices: 0,
            discoveredDevices: 0,
            hubModel: null,
            error: null,
          }
        : candidate);
      status.changed();
    }
    response.json({ ok: true, fromHouseId, houseId: targetHouseId, detachedSensorIds, integration: structuredClone(status.value) });
  });
  app.patch(`${prefix}/integrations/home-assistant/config/:houseId`, (request, response) => {
    const fromHouseId = request.params.houseId as string;
    const targetHouseId = requiredString(bodyObject(request.body), "houseId");
    if (!database.getHouse(targetHouseId)) throw new HttpError(404, "NOT_FOUND", "Target house not found");
    const existing = config.homeAssistantConnections ?? [];
    const explicitConnection = existing.find((candidate) => candidate.houseId === fromHouseId);
    const legacyHouseId = status.value.homeAssistant.connections?.find((candidate) => candidate.houseId === fromHouseId)?.houseId
      ?? database.listHouses()[0]?.id;
    const legacyConnection = existing.length === 0 && !config.homeAssistantLegacyDisabled
      && legacyHouseId === fromHouseId && config.haUrl && config.haToken
      ? { houseId: legacyHouseId, url: config.haUrl, token: config.haToken }
      : null;
    const connection = explicitConnection ?? legacyConnection;
    if (!connection) throw new HttpError(404, "NOT_FOUND", "Home Assistant connection not found");
    if (fromHouseId === targetHouseId) {
      response.json({ ok: true, fromHouseId, houseId: targetHouseId, integration: structuredClone(status.value) });
      return;
    }
    if (existing.some((candidate) => candidate.houseId === targetHouseId)) {
      throw new HttpError(409, "HOME_ASSISTANT_ALREADY_ASSIGNED", "The target house already has a Home Assistant connection");
    }
    homeAssistantConfigurationGenerations.set(fromHouseId, (homeAssistantConfigurationGenerations.get(fromHouseId) ?? 0) + 1);
    homeAssistantConfigurationGenerations.set(targetHouseId, (homeAssistantConfigurationGenerations.get(targetHouseId) ?? 0) + 1);
    const migratingLegacy = explicitConnection === undefined && legacyConnection !== null;
    const connections = migratingLegacy
      ? [{ ...connection, houseId: targetHouseId }]
      : existing.map((candidate) => candidate.houseId === fromHouseId
          ? { ...candidate, houseId: targetHouseId }
          : candidate);
    updateIntegrationSecrets(config.integrationSecretsFile, {
      homeAssistant: null,
      homeAssistantConnections: connections,
      ...(migratingLegacy ? { homeAssistantLegacyDisabled: true } : {}),
    });
    if (migratingLegacy) {
      integrationMetadata.retireHomeAssistant(fromHouseId, true);
      integrationMetadata.saveHomeAssistant({ houseId: targetHouseId, url: connection.url, reason: "moved" });
    } else {
      integrationMetadata.moveHomeAssistant(fromHouseId, targetHouseId, connection.url);
    }
    config.homeAssistantConnections = connections;
    if (migratingLegacy) config.homeAssistantLegacyDisabled = true;
    if (options.startBackground) homeAssistant.restart();
    else {
      status.value.homeAssistant.connections = (status.value.homeAssistant.connections ?? []).map((candidate) => candidate.houseId === fromHouseId
        ? { ...candidate, houseId: targetHouseId, connected: false, lastEventAt: null, mappedEntities: 0, error: null }
        : candidate);
      status.changed();
    }
    response.json({ ok: true, fromHouseId, houseId: targetHouseId, integration: structuredClone(status.value) });
  });
  app.delete(`${prefix}/integrations/tp-link/config/:connectionId`, (request, response) => {
    const connectionId = request.params.connectionId as string;
    const existing = config.tpLinkConnections ?? [];
    const explicitConnection = existing.find((candidate) => candidate.id === connectionId);
    const legacyHouseId = status.value.tpLink.connections?.find((candidate) => candidate.id === "legacy")?.houseId
      ?? database.listHouses()[0]?.id;
    const legacyConnection = connectionId === "legacy" && existing.length === 0 && !config.tpLinkLegacyDisabled
      && legacyHouseId && config.tpLinkHost && config.tpLinkUsername && config.tpLinkPassword
      ? {
          id: "legacy", houseId: legacyHouseId, host: config.tpLinkHost,
          username: config.tpLinkUsername, password: config.tpLinkPassword,
        }
      : null;
    const connection = explicitConnection ?? legacyConnection;
    if (!connection) throw new HttpError(404, "NOT_FOUND", "TP-Link connection not found");
    const disconnectingLegacy = explicitConnection === undefined && legacyConnection !== null;
    const connections = disconnectingLegacy ? [] : existing.filter((candidate) => candidate.id !== connectionId);
    updateIntegrationSecrets(config.integrationSecretsFile, {
      tpLink: null,
      tpLinkConnections: connections,
      ...(disconnectingLegacy ? { tpLinkLegacyDisabled: true } : {}),
    });
    integrationMetadata.retireTpLink(connectionId);
    config.tpLinkConnections = connections;
    if (disconnectingLegacy) config.tpLinkLegacyDisabled = true;
    const detachedSensorIds = database.detachTpLinkConnection(connectionId, disconnectingLegacy ? connection.houseId : undefined);
    if (options.startBackground) tpLink.restart();
    else {
      status.value.tpLink.configured = connections.length > 0;
      status.value.tpLink.connections = (status.value.tpLink.connections ?? []).filter((candidate) => candidate.id !== connectionId);
      status.changed();
    }
    response.json({ ok: true, detachedSensorIds, integration: structuredClone(status.value) });
  });
  app.delete(`${prefix}/integrations/home-assistant/config/:houseId`, (request, response) => {
    const houseId = request.params.houseId as string;
    const existing = config.homeAssistantConnections ?? [];
    const explicitConnection = existing.find((connection) => connection.houseId === houseId);
    const legacyHouseId = status.value.homeAssistant.connections?.find((candidate) => candidate.houseId === houseId)?.houseId
      ?? database.listHouses()[0]?.id;
    const disconnectingLegacy = explicitConnection === undefined && existing.length === 0
      && !config.homeAssistantLegacyDisabled && legacyHouseId === houseId && Boolean(config.haUrl && config.haToken);
    if (!explicitConnection && !disconnectingLegacy) {
      throw new HttpError(404, "NOT_FOUND", "Home Assistant connection not found");
    }
    const connections = disconnectingLegacy ? [] : existing.filter((connection) => connection.houseId !== houseId);
    updateIntegrationSecrets(config.integrationSecretsFile, {
      homeAssistant: null,
      homeAssistantConnections: connections,
      ...(disconnectingLegacy ? { homeAssistantLegacyDisabled: true } : {}),
    });
    integrationMetadata.retireHomeAssistant(houseId, disconnectingLegacy);
    config.homeAssistantConnections = connections;
    if (disconnectingLegacy) config.homeAssistantLegacyDisabled = true;
    if (options.startBackground) homeAssistant.restart();
    else {
      status.value.homeAssistant.connections = (status.value.homeAssistant.connections ?? [])
        .filter((connection) => connection.houseId !== houseId);
      status.value.homeAssistant.configured = (status.value.homeAssistant.connections?.length ?? 0) > 0;
      status.changed();
    }
    response.json({ ok: true, integration: structuredClone(status.value) });
  });
  app.post(`${prefix}/integrations/home-assistant/test`, (request, response) => {
    const houseId = typeof request.query.houseId === "string" ? request.query.houseId : undefined;
    const houseStatus = integrationStatusForHouse(houseId).homeAssistant;
    response.json({
    ok: houseStatus.connected,
    message: houseStatus.connected
      ? "Home Assistant is connected and streaming state changes."
      : houseStatus.configured
        ? houseStatus.error ?? "Home Assistant is configured but not connected yet."
        : "Use the setup page to save the Home Assistant URL and token, or configure HA_URL and HA_TOKEN.",
    });
  });
  app.get(`${prefix}/integrations/home-assistant/setup`, (request, response) => response.json({
    configured: integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).homeAssistant.configured,
    steps: [
      "Create a Home Assistant long-lived access token for a dedicated local user.",
      "Use the setup page to discover Home Assistant or enter its local URL, then save the token.",
      "Map each Stuga sensor to legacy climate keys and/or a measurements object keyed by registry id.",
      "Verify /api/v1/integrations/status reports connected=true.",
    ],
    entityMapSchema: {
      entities: [{
        sensorId: "sensor-01", temperature: "sensor.living_room_temperature", humidity: "sensor.living_room_humidity",
        battery: "sensor.living_room_battery", measurements: { co2: "sensor.living_room_co2" },
      }],
    },
    notes: [
      "All entity keys are optional, but each mapping needs at least one entity.",
      "Generic string bindings require the exact canonical unit; use {entityId, unit, scale, offset} for explicit conversions such as ppb to ppm.",
      "Saved credentials are write-only through the API and stored in the protected integration secrets file, outside SQLite.",
      "HA_URL and HA_TOKEN environment variables remain advanced overrides.",
      "Saving a real integration permanently disables mock telemetry for this database and purges existing demo samples and mock-derived alert events.",
    ],
  }));
  app.get(`${prefix}/integrations/tp-link/devices`, (request, response) => response.json({
    devices: tpLink.listDiscoveredDevices(typeof request.query.houseId === "string" ? request.query.houseId : undefined),
  }));

  app.post(`${prefix}/integrations/tp-link/history-export/canary`, requireWorkspaceAdmin, (request, response) => {
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["sensorId", "metric", "from", "to"]), "Tapo history canary");
    const sensorId = requiredString(body, "sensorId");
    const metric = enumValue(body.metric, ["temperature", "humidity"] as const, "metric");
    const fromMs = Date.parse(requiredString(body, "from"));
    const toMs = Date.parse(requiredString(body, "to"));
    const minimumRangeMs = 8 * (config.tapoHistoryExportIntervalMinutes ?? 15) * 60_000;
    const maximumRangeMs = Math.max(7 * 24 * 60 * 60_000, minimumRangeMs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
      || toMs - fromMs < minimumRangeMs || toMs - fromMs > maximumRangeMs
      || toMs > Date.now() + 5 * 60_000) {
      throw new HttpError(
        422,
        "INVALID_TAPO_CANARY_RANGE",
        "Canary range must be explicit, end no more than five minutes in the future, span at least eight export intervals, and stay within the configured bounded acceptance window",
      );
    }
    try {
      const job = tapoHistory.createCanary(
        sensorId,
        metric,
        new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(),
      );
      response.status(202).json({ job: publicTapoHistoryExportJob(job) });
    } catch (error) {
      if (error instanceof TapoHistoryCanaryError) throw new HttpError(409, error.code, error.message);
      throw error;
    }
  });

  app.post(`${prefix}/integrations/tp-link/history-export/backfill`, requireWorkspaceAdmin, (request, response) => {
    const body = bodyObject(request.body);
    rejectUnknownFields(body, new Set(["sensorId", "metric", "from", "to"]), "Tapo history backfill");
    const sensorId = requiredString(body, "sensorId");
    const metric = enumValue(body.metric, ["temperature", "humidity"] as const, "metric");
    const sensor = database.getSensor(sensorId);
    if (!sensor) throw new HttpError(404, "NOT_FOUND", "Sensor not found");
    const definition = database.getMeasurementDefinition(metric);
    if (!sensor.enabled || !definition?.enabled) {
      throw new HttpError(409, "TAPO_BACKFILL_TARGET_DISABLED", "Backfill sensor and metric must both be enabled");
    }
    const fromMs = Date.parse(requiredString(body, "from"));
    const toMs = Date.parse(requiredString(body, "to"));
    const validationNowMs = Date.now();
    const minimumRangeMs = 2 * (config.tapoHistoryExportIntervalMinutes ?? 15) * 60_000;
    const maximumRangeMs = 730 * 24 * 60 * 60_000;
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs
      || toMs - fromMs < minimumRangeMs || toMs - fromMs > maximumRangeMs
      || fromMs < validationNowMs - maximumRangeMs
      || toMs > validationNowMs + 5 * 60_000) {
      throw new HttpError(
        422,
        "INVALID_TAPO_BACKFILL_RANGE",
        "Backfill range must be explicit, fall within the most recent two years, span at least two export intervals, and end no more than five minutes in the future",
      );
    }
    try {
      const gap = tapoHistory.requestBackfill(
        sensorId,
        metric,
        new Date(fromMs).toISOString(),
        new Date(toMs).toISOString(),
      );
      sensorGapRecovery.wake();
      response.status(202).json({ gap });
    } catch (error) {
      if (error instanceof TapoHistoryCanaryError) {
        throw new HttpError(error.code === "INVALID_TAPO_BACKFILL_RANGE" ? 422 : 409, error.code, error.message);
      }
      throw error;
    }
  });

  app.get(`${prefix}/integrations/tp-link/history-export/jobs`, (_request, response) => {
    const jobs = tapoHistory.listJobs(250);
    const lastWorkerJob = jobs.filter((job) => job.deploymentFingerprint)
      .sort((left, right) => (right.heartbeatAt ?? right.updatedAt).localeCompare(left.heartbeatAt ?? left.updatedAt))[0];
    response.json({
      enabled: tapoHistory.enabled,
      automation: {
        operational: tapoHistory.operational,
        canaryPending: database.hasOpenTapoHistoryCanary(),
        waitingEmails: database.countWaitingTapoHistoryExportEmails(),
        maxPendingEmails: config.tapoHistoryMaxPendingEmails ?? 1,
        exportIntervalMinutes: config.tapoHistoryExportIntervalMinutes ?? 15,
        canaryApprovalMaxAgeDays: TAPO_CANARY_APPROVAL_MAX_AGE_MS / (24 * 60 * 60_000),
        mailbox: tapoHistory.mailboxHealth,
        lastWorkerSeenAt: lastWorkerJob?.heartbeatAt ?? lastWorkerJob?.updatedAt ?? null,
        deploymentFingerprintPrefix: lastWorkerJob?.deploymentFingerprint?.slice(0, 12) ?? null,
      },
      jobs: jobs.map(publicTapoHistoryExportJob),
    });
  });

  app.post(`${prefix}/integrations/tp-link/history-export/jobs/:id/retry`, requireWorkspaceAdmin, (request, response) => {
    const id = typeof request.params.id === "string" ? request.params.id : "";
    if (!id || id.length > 200) throw new HttpError(400, "INVALID_FIELD", "Invalid Tapo export job id");
    const job = tapoHistory.retry(id);
    if (!job) throw new HttpError(409, "TAPO_EXPORT_NOT_RETRYABLE", "Tapo export job is not retryable");
    response.json({ job: publicTapoHistoryExportJob(job) });
  });

  app.delete(`${prefix}/integrations/tp-link/history-export/jobs/:id`, requireWorkspaceAdmin, (request, response) => {
    const id = typeof request.params.id === "string" ? request.params.id : "";
    if (!id || id.length > 200) throw new HttpError(400, "INVALID_FIELD", "Invalid Tapo export job id");
    const existing = database.getTapoHistoryExportJob(id);
    if (!existing) throw new HttpError(404, "TAPO_EXPORT_NOT_FOUND", "Tapo export job was not found");
    const job = tapoHistory.cancel(id);
    response.json({ job: job ? publicTapoHistoryExportJob(job) : null });
  });

  app.get(`${prefix}/internal/tapo-history/jobs/claim`, (request, response) => {
    const workerId = typeof request.query.workerId === "string" ? request.query.workerId.trim() : "";
    if (!workerId || workerId.length > 200) throw new HttpError(400, "INVALID_FIELD", "workerId is required and must be at most 200 characters");
    const deploymentFingerprint = typeof request.query.deploymentFingerprint === "string"
      ? request.query.deploymentFingerprint.trim().toLowerCase()
      : "";
    const attestedHeader = request.get("x-tapo-deployment-fingerprint")?.trim().toLowerCase() ?? "";
    if (!/^[a-f0-9]{64}$/u.test(deploymentFingerprint) || attestedHeader !== deploymentFingerprint) {
      throw new HttpError(
        400,
        "INVALID_TAPO_DEPLOYMENT_FINGERPRINT",
        "A matching SHA-256 deployment fingerprint is required in the claim query and header",
      );
    }
    const claim = tapoHistory.claim(workerId, deploymentFingerprint);
    if (!claim) { response.status(204).end(); return; }
    response.json({ job: workerTapoHistoryExportJob(claim.job), leaseToken: claim.leaseToken, serverNow: claim.serverNow });
  });

  app.post(`${prefix}/internal/tapo-history/jobs/:id/heartbeat`, (request, response) => {
    const body = bodyObject(request.body);
    const workerId = requiredString(body, "workerId");
    const leaseToken = requiredString(body, "leaseToken");
    const existing = database.getTapoHistoryExportJob(request.params.id);
    const deploymentFingerprint = request.get("x-tapo-deployment-fingerprint")?.trim().toLowerCase() ?? "";
    if (!existing || existing.leaseOwner !== workerId || !existing.deploymentFingerprint
      || deploymentFingerprint !== existing.deploymentFingerprint) {
      throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
    }
    const renewed = tapoHistory.heartbeat(request.params.id, leaseToken);
    if (!renewed) throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
    response.json({ job: workerTapoHistoryExportJob(renewed.job), serverNow: renewed.serverNow });
  });

  app.post(`${prefix}/internal/tapo-history/jobs/:id/status`, (request, response) => {
    const body = bodyObject(request.body);
    const workerId = requiredString(body, "workerId");
    const leaseToken = requiredString(body, "leaseToken");
    const status = enumValue(body.status, ["running", "waiting-email", "needs-attention", "failed"] as const, "status");
    const detail = body.detail === undefined || body.detail === null ? null : requiredString(body, "detail").slice(0, 1_000);
    const existing = database.getTapoHistoryExportJob(request.params.id);
    const deploymentFingerprint = request.get("x-tapo-deployment-fingerprint")?.trim().toLowerCase() ?? "";
    if (!existing || existing.leaseOwner !== workerId || !existing.deploymentFingerprint
      || deploymentFingerprint !== existing.deploymentFingerprint) {
      throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
    }
    const job = tapoHistory.updateFromWorker(request.params.id, leaseToken, { status, detail });
    if (!job) throw new HttpError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is no longer active");
    response.json({ job: workerTapoHistoryExportJob(job) });
  });
  app.post(`${prefix}/integrations/tp-link/test`, (request, response) => {
    const houseStatus = integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).tpLink;
    response.json({
    ok: houseStatus.connected,
    message: houseStatus.connected
      ? `TP-Link ${houseStatus.hubModel ?? "energy device"} is connected; ${houseStatus.discoveredDevices} devices discovered and ${houseStatus.mappedDevices} mapped.`
      : houseStatus.configured
        ? houseStatus.error ?? "TP-Link credentials are configured, but discovery has not connected yet."
        : "Use the setup page to discover or enter the hub or energy device, then save the TP-Link account credentials.",
    });
  });
  app.get(`${prefix}/integrations/tp-link/setup`, (request, response) => {
    const houseStatus = integrationStatusForHouse(typeof request.query.houseId === "string" ? request.query.houseId : undefined).tpLink;
    response.json({
    configured: houseStatus.configured,
    connections: houseStatus.connections ?? [],
    supportedHubs: ["H100", "H200"],
    supportedClimateSensors: ["T310", "T315"],
    supportedEnergyDevices: "Configured TP-Link/Kasa hosts that python-kasa exposes through Module.Energy",
    steps: [
      "Install python-kasa from apps/api/python/requirements.txt (already included in the Docker image).",
      "Select the owning house, discover an H100/H200 hub or supported energy device, or enter a reserved LAN address, then save the house-scoped TP-Link connection.",
      "Inspect /api/v1/integrations/tp-link/devices for discovered climate children or the configured direct energy device.",
      "Assign a discovered device by PATCHing its stable deviceId into a sensor's tpLinkDeviceId field.",
    ],
    sensorPatchSchema: { tpLinkDeviceId: "hub-child-device-id" },
    deviceMapSchema: { devices: [{ deviceId: "hub-child-device-id", sensorId: "sensor-01" }] },
    notes: [
      "The helper polls the hub over the local LAN; credentials are passed through its process environment and are never returned or stored in SQLite.",
      "Web-saved credentials live in the protected integration secrets file; TP_LINK_* environment variables remain advanced overrides.",
      "TP_LINK_DEVICE_MAP_FILE remains supported as an optional legacy fallback; database sensor bindings take precedence.",
      "Set tpLinkDeviceId to null to unassign a child device without deleting the sensor or its history.",
      "Home Assistant and direct TP-Link bridges can run at the same time, but the same physical child should be mapped through only one path.",
      "Direct smart energy devices provide power when current_consumption is available and cumulative kWh only when consumption_total is available; daily/monthly reset counters are not mapped to energy.",
      "TP-Link provides consumption only. Property electricity prices are fetched separately from the configured price API (Pörssisähkö by default).",
      "LAN Find devices discovers H100/H200 hubs and uses saved or request-scoped draft TP-Link credentials to include devices that python-kasa verifies through Module.Energy; draft credentials are never persisted.",
      "Saving a real integration permanently disables mock telemetry for this database and purges existing demo samples and mock-derived alert events.",
    ],
    });
  });

  app.get(`${prefix}/mock/scenarios`, (_request, response) => {
    dataMode.synchronize();
    response.json({ scenarios: MOCK_SCENARIOS, active: mock.scenario, enabled: status.value.mock.enabled });
  });
  app.put(`${prefix}/mock/scenario`, (request, response) => {
    const scenario = enumValue(bodyObject(request.body).scenario, MOCK_SCENARIOS.map((item) => item.id), "scenario");
    mock.setScenario(scenario);
    response.json({ active: mock.scenario });
  });
  app.post(`${prefix}/mock/scenario`, (request, response) => {
    const body = bodyObject(request.body);
    const scenario = enumValue(body.scenarioId ?? body.scenario, MOCK_SCENARIOS.map((item) => item.id), "scenarioId");
    mock.setScenario(scenario);
    response.json({ ok: true, active: mock.scenario });
  });
  app.post(`${prefix}/mock/tick`, (_request, response) => response.status(201).json({ readings: mock.generate(), scenario: mock.scenario }));

  app.get(`${prefix}/replay`, (_request, response) => response.json({ replay: replay.state }));
  app.post(`${prefix}/replay`, async (request, response) => {
    const body = bodyObject(request.body);
    const sensorIds = Array.isArray(body.sensorIds) ? body.sensorIds.filter((id): id is string => typeof id === "string") : database.listSensors().map((sensor) => sensor.id);
    const to = dateValue(body.to, new Date(), "to");
    const from = dateValue(body.from, new Date(Date.parse(to) - 3_600_000), "from");
    const speed = typeof body.speed === "number" ? body.speed : 60;
    const readings = (await telemetryReader.legacyReadingHistory({ sensorIds, from, to, limit: 50_000 })).records;
    response.status(202).json({ replay: replay.startReadings(readings, from, to, speed) });
  });
  app.delete(`${prefix}/replay`, (_request, response) => response.json({ replay: replay.stop() }));

  registerSpatialLayerRoutes(app, {
    runtime: spatialLayers,
    prefix,
    authorizeScope: (request, response, scope) => {
      const access = request.path === `${prefix}/layers/events`
        ? currentStreamVisibility(request, response)
        : visibility(response);
      if (!access) return false;
      // A property aggregate may contain several houses, so a guest needs the
      // property-level grant. House-specific grants remain usable through the
      // corresponding house layer endpoint.
      return scope.kind === "house" ? access.house(scope.id) : access.hasProperty(scope.id);
    },
    auditActor: (_request, response) => requestPrincipal(response).userId,
    streamAuthorizationFingerprint,
    validateStream: (_request, response) => !rejectEventStreamDuringShutdown(response),
    acquireStream: (_request, response) => acquireEventStream(response),
  });

  app.use(`${prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  app.use(`${v2Prefix}`, (_request, _response, next) => next(new HttpError(404, "NOT_FOUND", "API endpoint not found")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof IncompleteTelemetryHistoryError) {
      response.status(503).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof LocalAuthError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ClimateDataValidationError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof TelemetryValidationError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof MeasurementValidationError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof TelegramServiceError) {
      response.status(error.status).json({ error: { code: `TELEGRAM_${error.code}`, message: error.message } });
      return;
    }
    if (error instanceof HttpError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    const httpError = error as { status?: unknown; type?: unknown };
    if (httpError.status === 413 || httpError.type === "entity.too.large") {
      const limit = typeof response.locals.accountBodyLimit === "string"
        ? response.locals.accountBodyLimit
        : "15 MiB";
      response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds the ${limit} limit` } });
      return;
    }
    if (message.includes("FOREIGN KEY constraint failed")) {
      response.status(409).json({ error: { code: "INVALID_REFERENCE", message: "A referenced resource does not exist" } });
      return;
    }
    if (message.includes("UNIQUE constraint failed")) {
      response.status(409).json({ error: { code: "CONFLICT", message: "A resource with this identifier already exists" } });
      return;
    }
    if (message.includes("DEMO_DATA_DISABLED")) {
      response.status(409).json({ error: { code: "DEMO_DATA_DISABLED", message: "Demo telemetry is permanently disabled for this real-data database" } });
      return;
    }
    if (error instanceof SyntaxError) {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
      return;
    }
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed" } });
  });

  let runtimeReady: Promise<void> = Promise.resolve();
  if (options.startBackground && telemetryArchive) {
    const starting = telemetryArchive.start();
    runtimeReady = config.timeseriesRequired
      ? starting
      : starting.catch(() => {
        // SQLite remains durable and the worker retries. Never log connection
        // configuration because it contains a database credential.
        console.error("[telemetry-archive] Optional TimescaleDB archive is unavailable; SQLite buffering continues");
      });
    void runtimeReady.then(() => telemetryRetention?.start()).catch(() => undefined);
  }

  if (options.startBackground) {
    cloudflareAccess?.start();
    alertEngine.start();
    mock.start();
    homeAssistant.start();
    tpLink.start();
    tapoHistory.start();
    sensorGapRecovery.start();
    electricityPrices.start();
    weatherMonitor.start();
    notifySpatial((runtime) => runtime.start());
  }

  const beginShutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownStarted = true;
    alertEngine.stop();
    mock.stop();
    replay.stop();
    const stoppingSensorGapRecovery = sensorGapRecovery.stop();
    const stoppingTapoHistory = tapoHistory.stop();
    homeAssistant.stop();
    tpLink.stop();
    electricityPrices.stop();
    weatherMonitor.stop();
    for (const closeStream of [...activeEventStreams]) closeStream(true);
    shutdownPromise = Promise.all([
      notificationOutbox.stop(),
      cloudflareAccess?.stop() ?? Promise.resolve(),
      stoppingSensorGapRecovery,
      stoppingTapoHistory,
      weatherRecovery.stop(),
      spatialLayers?.stop() ?? Promise.resolve(),
      (telemetryRetention?.stop() ?? Promise.resolve()).then(() => telemetryArchive?.stop()),
    ]).then(() => undefined);
    return shutdownPromise;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (closed) return Promise.resolve();
    closed = true;
    removeSnapshotMutationWake();
    removeSnapshotMeasurementWake();
    removeNotificationWake();
    removeSpatialLayerWake();
    removeWeatherTelemetryBridge();
    removeWeatherProjector();
    closePromise = beginShutdown().then(() => { database.close(); });
    return closePromise;
  };

  return {
    app, database, integrationMetadata, bus, telemetry, measurements, mock, replay, status, homeAssistant, tpLink, tapoHistory, electricityPrices, telegram, weather, weatherMonitor,
    weatherRecovery, sensorGapRecovery, weatherEvents, dataMode, notificationOutbox, dataOperations, energyOptimizer, energyCost, setupDoctor, cloudflareAccess, spatialLayers, timeseries, telemetryArchive, telemetryReader,
    ready: () => runtimeReady,
    beginShutdown,
    close,
  };
}
