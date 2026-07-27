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
import { HttpError, bodyObject, requiredString } from "./part-01.js";
import { parseMaintenanceTaskInput } from "./part-03.js";
import { notePlainLine, noteTaskBlock } from "./part-05.js";

export function appleNotesSnapshot(database: ClimateDatabase, houseId: string): AppleNotesSnapshot {
  const house = database.getHouse(houseId);
  if (!house) throw new HttpError(404, "NOT_FOUND", "House not found");
  const generatedAt = new Date().toISOString();
  const maintenanceTasks = database.listMaintenanceTasks(houseId);
  const title = `${notePlainLine(house.name)} maintenance — ${generatedAt.slice(0, 10)} — Stugu`;
  const lines = [
    title,
    `Generated by Stugu: ${generatedAt}`,
    "Stugu is the source of truth. Use this export to create a new dated generated note; checkboxes and edits in Notes are not imported.",
    "",
    ...(maintenanceTasks.length ? maintenanceTasks.map(noteTaskBlock) : ["No maintenance tasks."]),
  ];
  return { schema: "stugu.apple-notes-snapshot/v1", generatedAt, houseId, title, text: lines.join("\n"), maintenanceTasks };
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function appleNotesCaptureInput(
  value: unknown,
): { operationId: string; input: MaintenanceTaskInput & { houseId: string } } {
  const body = bodyObject(value);
  if (body.schema !== "stugu.apple-notes-command/v1") {
    throw new HttpError(400, "INVALID_FIELD", "schema must be stugu.apple-notes-command/v1");
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

export function appleNotesCaptureMatches(task: MaintenanceTask, input: MaintenanceTaskInput): boolean {
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

export const SAFE_ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "model/gltf+json",
  "model/gltf-binary",
]);

export const SAFE_EQUIPMENT_PHOTO_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const SAFE_EQUIPMENT_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/rtf",
  "text/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
]);

export const MAX_EQUIPMENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function equipmentAttachmentData(input: EquipmentAttachmentUploadInput): Buffer {
  const dataUrl = input.data.match(/^data:([^;,]+);base64,(.*)$/su);
  if (dataUrl && dataUrl[1]?.toLowerCase() !== input.mimeType) {
    throw new HttpError(400, "ATTACHMENT_MEDIA_TYPE_MISMATCH", "The data URL media type must match mimeType");
  }
  const encoded = dataUrl?.[2] ?? input.data;
  if (encoded.length > Math.ceil(MAX_EQUIPMENT_ATTACHMENT_BYTES / 3) * 4 + 4) {
    throw new HttpError(413, "ATTACHMENT_TOO_LARGE", "Equipment attachments are limited to 10 MiB");
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new HttpError(400, "INVALID_ATTACHMENT", "data must contain valid base64 bytes");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.length === 0) throw new HttpError(400, "INVALID_ATTACHMENT", "data must contain valid base64 bytes");
  if (data.length > MAX_EQUIPMENT_ATTACHMENT_BYTES) {
    throw new HttpError(413, "ATTACHMENT_TOO_LARGE", "Equipment attachments are limited to 10 MiB");
  }
  return data;
}

export function assertEquipmentAttachmentMediaType(input: EquipmentAttachmentUploadInput): void {
  const allowed = input.kind === "photo"
    ? SAFE_EQUIPMENT_PHOTO_MIME_TYPES
    : SAFE_EQUIPMENT_DOCUMENT_MIME_TYPES;
  if (!allowed.has(input.mimeType)) {
    throw new HttpError(
      415,
      "UNSUPPORTED_ATTACHMENT_TYPE",
      input.kind === "photo"
        ? "Photos must be PNG, JPEG, or WebP"
        : "Documents must be PDF, text, Markdown, RTF, Word, DOCX, or OpenDocument text",
    );
  }
}

export function equipmentAttachmentDisposition(kind: "photo" | "document", name: string): string {
  const fallback = name
    .replace(/[^\x20-\x7E]/gu, "_")
    .replace(/["\\]/gu, "_")
    .slice(0, 180)
    .trim() || "attachment";
  const encoded = [...Buffer.from(name, "utf8")]
    .map((byte) => `%${byte.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("");
  return `${kind === "photo" ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export const RESERVED_MEASUREMENT_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const MEASUREMENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export function measurementId(value: unknown, field = "metric"): string {
  if (typeof value !== "string" || value.length > 64 || !MEASUREMENT_ID_PATTERN.test(value) || RESERVED_MEASUREMENT_IDS.has(value)) {
    throw new HttpError(400, "INVALID_MEASUREMENT_ID", `${field} must be a safe lowercase registry identifier`);
  }
  return value;
}

export function stringMap(value: unknown, field: string): Record<string, string> {
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

export function measurementNumberMap(value: unknown, field: string): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "number" || !Number.isFinite(item)) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be finite`);
    result[id] = item;
  }
  return result;
}

export function measurementStringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value)) {
    const id = measurementId(key, `${field} key`);
    if (typeof item !== "string" || !item.trim()) throw new HttpError(400, "INVALID_FIELD", `${field}.${key} must be a non-empty entity id`);
    result[id] = item.trim();
  }
  return result;
}

export function nullableFinite(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${field} must be finite or null`);
  return value;
}

export function validateMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
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

export function measurementUnits(value: unknown, canonicalUnit: string, current?: string[]): string[] {
  if (value === undefined) return current ?? [canonicalUnit];
  if (!Array.isArray(value) || value.length === 0 || value.length > 50
    || value.some((unit) => typeof unit !== "string" || !unit.trim() || unit.length > 50)) {
    throw new HttpError(400, "INVALID_FIELD", "allowedUnits must contain between 1 and 50 non-empty unit strings");
  }
  return [...new Set(value.map((unit) => (unit as string).trim()))];
}
