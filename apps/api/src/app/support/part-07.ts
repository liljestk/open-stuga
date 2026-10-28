import express from "express";
import type {
  ActionPlaybookInput,
  ActionRunStartInput,
  AlertRule,
  AlertDeliveryPolicy,
  MeasurementDefinition,
  MeasurementSample,
  Reading,
} from "@climate-twin/contracts";
import {
  ClimateDatabase,
  type SensorUpdate,
} from "../../db.js";
import { TelemetryBus } from "../../events.js";
import { HomeAssistantBridge } from "../../home-assistant.js";
import { TpLinkBridge } from "../../tp-link.js";
import { GreeBridge } from "../../gree.js";
import { HeatPumpStateStore } from "../../heat-pump-state.js";
import { TuyaBridge } from "../../tuya.js";
import { ConnectedDeviceStore } from "../../connected-device-store.js";
import { IntegrationMetadataStore } from "../../integration-metadata.js";
import {
  WeatherService,
} from "../../weather.js";
import {
  DataModeCoordinator,
  MeasurementService,
  MockEngine,
  ReplayEngine,
  RuntimeStatus,
  TelemetryService,
} from "../../services.js";
import { SystemUpdateService } from "../../system-updates.js";
import { SystemStorageService } from "../../system-storage.js";
import { HostSystemMonitor } from "../../host-system.js";
import { SystemErrorLog } from "../../system-error-log.js";
import { WeatherMonitor } from "../../weather-monitor.js";
import { DailyAnalyticsFindingsWorker } from "../../daily-analytics-findings.js";
import { ScheduledDataExportService } from "../../scheduled-data-exports.js";
import { WeatherRecoveryCoordinator } from "../../weather-recovery.js";
import { SensorGapRecoveryCoordinator } from "../../sensor-gap-recovery.js";
import {
  TapoHistoryExportService,
} from "../../tapo-history-export.js";
import {
  type WeatherEventBroker,
} from "../../weather-events.js";
import { TelegramService } from "../../telegram.js";
import { NotificationOutboxWorker } from "../../outbox.js";
import { normalizeAlertDeliveryPolicy } from "../../notification-policy.js";
import {
  ElectricityPriceService,
} from "../../electricity-prices.js";
import { CloudflareAccessGroupSynchronizer } from "../../cloudflare-access.js";
import {
  CloudflareSetupService,
} from "../../cloudflare-setup.js";
import {
  type LocalSpatialLayerRuntime,
} from "../../spatial-layers/index.js";
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
} from "../../timeseries/read-facade.js";
import { StugubyService } from "../../stuguby/service.js";
import { TrackingService } from "../../tracking/service.js";
import { HttpError } from "../../http-error.js";
import { bodyObject, enumValue, optionalBoolean, requiredNumber, requiredString } from "./part-01.js";
import { dateValue } from "./part-02.js";
import { alertDurationSeconds } from "./part-04.js";
import { measurementId, measurementNumberMap, measurementStringMap, measurementUnits, nullableFinite, stringMap, validateMeasurementDefinition } from "./part-06.js";

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

export function parseAlertDeliveryPolicy(value: unknown, fallbackTimeZone = "UTC"): AlertDeliveryPolicy {
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new HttpError(400, "INVALID_FIELD", "deliveryPolicy must be an object");
  }
  try {
    return normalizeAlertDeliveryPolicy(value as Partial<AlertDeliveryPolicy> | undefined, fallbackTimeZone);
  } catch (error) {
    throw new HttpError(400, "INVALID_FIELD", error instanceof Error ? error.message : "deliveryPolicy is invalid");
  }
}

export function parseActionPlaybookInput(value: unknown, partial = false): ActionPlaybookInput | Partial<ActionPlaybookInput> {
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

export function parseActionRunStart(value: unknown): ActionRunStartInput {
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
  if (body.energyMeterRole !== undefined) {
    patch.energyMeterRole = enumValue(
      body.energyMeterRole,
      ["whole_home", "submeter", "standalone"] as const,
      "energyMeterRole",
    );
  }
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
  gree: GreeBridge;
  heatPumpStates: HeatPumpStateStore;
  tuya: TuyaBridge;
  connectedDevices: ConnectedDeviceStore;
  tapoHistory: TapoHistoryExportService;
  electricityPrices: ElectricityPriceService;
  telegram: TelegramService;
  weather: WeatherService;
  weatherMonitor: WeatherMonitor;
  dailyAnalyticsFindings: DailyAnalyticsFindingsWorker;
  derivedAnalytics: import("../../analytics/derived-artifacts/coordinator.js").DerivedAnalyticsCoordinator;
  scheduledDataExports: ScheduledDataExportService;
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
  cloudflareSetup: CloudflareSetupService;
  spatialLayers: LocalSpatialLayerRuntime | null;
  timeseries: TimeseriesStore | null;
  telemetryArchive: TelemetryArchiveWorker | null;
  telemetryReader: HybridTelemetryReader;
  stuguby: StugubyService;
  tracking: TrackingService;
  systemUpdates: SystemUpdateService;
  systemStorage: SystemStorageService;
  hostSystem: HostSystemMonitor;
  systemErrorLog: SystemErrorLog;
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
