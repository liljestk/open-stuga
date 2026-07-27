import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, resolvePlanElementOpeningState } from "@climate-twin/contracts";
import type { StugubyRole, StugubySummary } from "@climate-twin/stuguby-protocol";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  AlertRule,
  Floor,
  GeoCoordinate,
  HouseLocation,
  HouseMapPlacement,
  HouseWeather,
  MaintenanceTask,
  ManualObservation,
  MeasurementDefinition,
  MeasurementSample,
  MeasurementSnapshotEntry,
  Property,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  Reading,
  Sensor,
  StaticParameter,
} from "@climate-twin/contracts";
import {
  parseAlertRule,
  parseMeasurementDefinition,
  parseMeasurementSample,
  parseMaintenanceTaskInput,
  parseMaintenanceTaskPatch,
  parseObservationInput,
  parseObservationPatch,
  parseReading,
  parseSensorPatch,
} from "../app.js";
import { loadConfig } from "../config.js";
import { DataOperationsService } from "../data-operations.js";
import { ClimateDatabase, outdoorLocationKey } from "../db.js";
import { discoverHomeAssistant } from "../discovery.js";
import { EnergyCostService } from "../energy-cost.js";
import { EnergyOptimizer } from "../energy-optimizer.js";
import { publicElectricityConfiguration } from "../electricity-prices.js";
import { TelemetryBus } from "../events.js";
import { HomeAssistantBridge } from "../home-assistant.js";
import { McpOperationTracker } from "../mcp-lifecycle.js";
import {
  mcpToolAnnotations,
  mcpBoundedInteger,
  mcpBoundedNumber,
  mcpIsoDate,
  mcpLanguage,
  mcpLocationQuery,
  mcpOptionalFiniteNumber,
  mcpThermalDateRange,
  requireMcpHouse,
  requireMcpHouseSensor,
  requireMcpConfirmation,
  requireMcpMeasurementTarget,
  requireMcpSensor,
  summarizeMcpAreaEquipment,
  summarizeMcpHouse,
  summarizeMcpProperty,
  summarizeMcpPropertyArea,
  validateMcpToolRegistry,
  validateMcpDateRange,
} from "../mcp-validation.js";
import { LocationDiscoveryService } from "../location-discovery.js";
import { AutomaticWeatherProvider, OpenMeteoWeatherProvider } from "../open-meteo.js";
import {
  AlertEngine,
  DataModeCoordinator,
  forecast,
  forecastMeasurement,
  MeasurementService,
  MOCK_SCENARIOS,
  MockEngine,
  ReplayEngine,
  RuntimeStatus,
  TelemetryService,
} from "../services.js";
import { SetupDoctor } from "../setup-doctor.js";
import { HybridTelemetryReader } from "../timeseries/read-facade.js";
import { runThermalIsolation } from "../thermal-isolation.js";
import { runThermalSimulation } from "../thermal-simulation.js";
import { TpLinkBridge } from "../tp-link.js";
import { SYSTEM_VERSION } from "../version.js";
import { FmiWeatherProvider, WeatherRequestSupersededError, WeatherService } from "../weather.js";
import type { StugubyService } from "../stuguby/service.js";
import { StugubyStore } from "../stuguby/store.js";
import { areaEquipmentStatuses, database, measurements, propertyAreaKinds, status, stuguby, stugubyStore } from "./01-config-to-get-house-weather.js";

export const pointSchema = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
} as const;

export const houseLocationSchema = {
  type: "object",
  properties: {
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    label: { type: "string", maxLength: 200 },
    countryCode: { type: "string", pattern: "^[A-Za-z]{2}$" },
    source: { enum: ["manual", "place-search", "browser-geolocation", "home-assistant", "map-placement"] },
    confidence: { enum: ["high", "medium", "low"] },
    discoveredAt: { type: "string", format: "date-time" },
    userOverridden: { type: "boolean" },
  },
  required: ["latitude", "longitude"],
  additionalProperties: false,
} as const;

export const geoCoordinateSchema = {
  type: "object",
  properties: {
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
  },
  required: ["latitude", "longitude"],
  additionalProperties: false,
} as const;

export const propertyAreaMutableProperties = {
  propertyId: { type: "string", minLength: 1, maxLength: 200 },
  name: { type: "string", minLength: 1, maxLength: 200 },
  kind: { enum: propertyAreaKinds },
  description: { type: ["string", "null"], maxLength: 5_000 },
  location: { oneOf: [geoCoordinateSchema, { type: "null" }] },
  polygon: { type: "array", minItems: 0, maxItems: 500, items: geoCoordinateSchema },
} as const;

export const areaEquipmentMutableProperties = {
  areaId: { type: "string", minLength: 1, maxLength: 200 },
  name: { type: "string", minLength: 1, maxLength: 200 },
  kind: { type: "string", minLength: 1, maxLength: 200 },
  manufacturer: { type: ["string", "null"], maxLength: 200 },
  model: { type: ["string", "null"], maxLength: 200 },
  serialNumber: { type: ["string", "null"], maxLength: 200 },
  status: { enum: areaEquipmentStatuses },
  notes: { type: ["string", "null"], maxLength: 5_000 },
} as const;

export const houseMapPlacementSchema = {
  type: "object",
  properties: {
    latitude: { type: "number", minimum: -90, maximum: 90 },
    longitude: { type: "number", minimum: -180, maximum: 180 },
    metersPerPlanUnit: { type: "number", exclusiveMinimum: 0 },
    footprintFloorId: { type: "string", minLength: 1 },
  },
  required: ["latitude", "longitude", "metersPerPlanUnit"],
  additionalProperties: false,
} as const;

export const floorSchema = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 },
    type: { enum: ["basement", "ground", "upper", "attic", "mezzanine", "outdoor"] },
    width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
    elevation: { type: "number" }, ceilingHeight: { type: "number", exclusiveMinimum: 0 },
    wallHeight: { type: "number", exclusiveMinimum: 0, maximum: 20 },
    roof: {
      type: "object",
      properties: {
        style: { enum: ["gable", "hip", "shed", "flat"] },
        pitchDegrees: { type: "number", minimum: 0, maximum: 75 },
        ridgeAxis: { enum: ["x", "y"] },
        overhang: { type: "number", minimum: 0 },
        eavesHeight: { type: "number", minimum: 0 },
      },
      required: ["style", "pitchDegrees", "ridgeAxis", "overhang", "eavesHeight"],
      additionalProperties: false,
    },
    walls: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 }, from: pointSchema, to: pointSchema },
        required: ["id", "from", "to"],
        additionalProperties: false,
      },
    },
    rooms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, kind: { type: "string" },
          points: { type: "array", minItems: 3, items: pointSchema },
        },
        required: ["id", "name", "points"],
        additionalProperties: false,
      },
    },
    planElements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { enum: ["door", "window", "fireplace", "vent", "fireEscape"] },
          position: pointSchema,
          rotationDegrees: { type: "number", minimum: 0, exclusiveMaximum: 360 },
          width: { type: "number", exclusiveMinimum: 0 },
          height: { type: "number", exclusiveMinimum: 0, description: "Physical element height in metres for the 3D representation." },
          label: { type: "string", minLength: 1, maxLength: 120 },
          wallId: { type: "string", minLength: 1 },
          variant: { enum: ["interior", "exterior", "sliding", "double", "open-passage", "fixed", "casement", "tilt-turn", "passive", "supply", "extract", "balanced", "transfer", "ladder", "stairs"] },
          bottomOffsetM: { type: "number", minimum: 0 },
          verticalExtent: { enum: ["level", "roof"] },
          chimneyHeightAboveRoof: { type: "number", minimum: 0, maximum: 5 },
          chimneyWidth: { type: "number", exclusiveMinimum: 0 },
          chimneyDepth: { type: "number", exclusiveMinimum: 0 },
          projection: { type: "number", exclusiveMinimum: 0 },
        },
        required: ["id", "kind", "position", "rotationDegrees"],
        additionalProperties: false,
      },
    },
    backgroundImage: { type: "string" },
  },
  required: ["id", "name", "width", "height", "elevation", "walls", "rooms"],
  additionalProperties: false,
} as const;

export const sensorProperties = {
  houseId: { type: "string", minLength: 1 }, floorId: { type: "string", minLength: 1 },
  name: { type: "string", minLength: 1 }, roomId: { type: ["string", "null"], minLength: 1 },
  room: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 },
  x: { type: "number" }, y: { type: "number" }, z: { type: "number" },
  temperatureEntityId: { type: "string", minLength: 1 }, humidityEntityId: { type: "string", minLength: 1 },
  batteryEntityId: { type: "string", minLength: 1 }, tpLinkDeviceId: { type: ["string", "null"] },
  measurementEntityIds: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
  tags: { type: "array", items: { type: "string" } }, enabled: { type: "boolean" },
} as const;

export const measurementDefinitionProperties = {
  labels: { type: "object", minProperties: 1, additionalProperties: { type: "string", minLength: 1 } },
  unit: { type: "string", minLength: 1 }, precision: { type: "integer", minimum: 0, maximum: 6 },
  validMin: { type: ["number", "null"] }, validMax: { type: ["number", "null"] },
  displayMin: { type: ["number", "null"] }, displayMax: { type: ["number", "null"] },
  interpolationDelta: { type: "number", exclusiveMinimum: 0 },
  colorScale: { enum: ["thermal", "humidity", "air-quality", "sequential"] },
  enabled: { type: "boolean" }, spatialInterpolation: { type: "boolean" }, forecastSupported: { type: "boolean" },
} as const;

export const measurementSampleSchema = {
  type: "object",
  properties: {
    sensorId: { type: "string", minLength: 1 }, metric: { type: "string", minLength: 1 }, value: { type: "number" },
    canonicalUnit: { type: "string", minLength: 1 }, timestamp: { type: "string", format: "date-time" },
    quality: { enum: ["good", "estimated", "stale"] },
  },
  required: ["sensorId", "metric", "value"],
  additionalProperties: false,
} as const;

export const readingInputSchema = {
  type: "object",
  properties: {
    sensorId: { type: "string", minLength: 1 }, timestamp: { type: "string", format: "date-time" },
    temperature: { type: "number", minimum: -80, maximum: 100 }, humidity: { type: "number", minimum: 0, maximum: 100 },
    battery: { type: ["number", "null"], minimum: 0, maximum: 100 },
    quality: { enum: ["good", "estimated", "stale"] },
    measurements: { type: "object", additionalProperties: { type: "number" } },
  },
  required: ["sensorId", "temperature", "humidity"],
  additionalProperties: false,
} as const;

export const alertRuleProperties = {
  name: { type: "string", minLength: 1 }, sensorId: { type: ["string", "null"] }, metric: { type: "string", minLength: 1 },
  operator: { enum: ["gt", "gte", "lt", "lte"] }, threshold: { type: "number" },
  durationSeconds: { type: "integer", minimum: 1, maximum: 31_536_000 },
  severity: { enum: ["info", "warning", "critical"] }, enabled: { type: "boolean" }, webhookEnabled: { type: "boolean" }, telegramEnabled: { type: "boolean" },
} as const;

export const observationCreateProperties = {
  floorId: { type: "string", minLength: 1 }, sensorId: { type: ["string", "null"] },
  kind: { enum: ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] },
  severity: { enum: ["info", "warning", "critical"] }, note: { type: "string", minLength: 1 },
  x: { type: ["number", "null"] }, y: { type: ["number", "null"] },
  occurredAt: { oneOf: [{ type: "string", format: "date-time" }, { type: "string", format: "date" }] },
  timePrecision: { enum: ["exact", "approximate", "date-only", "date-range", "unknown"] },
  validFrom: { type: ["string", "null"], format: "date" },
  validTo: { type: ["string", "null"], format: "date" },
  source: { enum: ["owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown"] },
  sourceDetail: { type: ["string", "null"] },
  confidence: { enum: ["confirmed", "probable", "uncertain", "awaiting-inspection"] },
} as const;

export const observationPatchProperties = {
  ...observationCreateProperties,
  status: { enum: ["open", "resolved"] },
  resolutionNote: {
    type: ["string", "null"],
    minLength: 1,
    maxLength: MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
  },
} as const;

export const maintenanceTaskCreateProperties = {
  floorId: { type: ["string", "null"], maxLength: 200 },
  areaId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
  equipmentId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
  title: { type: "string", minLength: 1, maxLength: 200 },
  description: { type: ["string", "null"], maxLength: 5_000 },
  basis: { enum: ["required", "scheduled", "condition-based", "predictive", "optional-improvement"] },
  basisDetail: { type: ["string", "null"], maxLength: 5_000 },
  priority: { enum: ["low", "normal", "high", "urgent"] },
  plannedFor: { type: ["string", "null"], format: "date" },
  dueBy: { type: ["string", "null"], format: "date" },
  observationIds: {
    type: "array", maxItems: 100,
    items: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

export const maintenanceTaskPatchProperties = {
  ...maintenanceTaskCreateProperties,
  houseId: { type: ["string", "null"], minLength: 1, maxLength: 200 },
  status: { enum: ["planned", "in-progress", "completed", "verified", "cancelled"] },
  completionNote: { type: ["string", "null"], maxLength: 5_000 },
  verificationNote: { type: ["string", "null"], maxLength: 5_000 },
} as const;

export const confirmationProperty = { confirm: { const: true, description: "Must be true to authorize this destructive operation." } } as const;

export function stugubySide(role: StugubyRole): "host" | "client" {
  return role === "steward" ? "host" : "client";
}

export function activeStugubyGrant(grant: ReturnType<StugubyStore["listGrants"]>[number]): boolean {
  return !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now());
}

export function recommendedOverviewGrant(grant: ReturnType<StugubyStore["listGrants"]>[number]): boolean {
  const enabled = grant.datasets.filter((dataset) => dataset.enabled);
  return grant.housePolicy.editPolicy === "read-only"
    && grant.housePolicy.recoveryMode === "none"
    && enabled.length === 3
    && ["home.directory.v1", "home.sensor-catalog.v1", "home.structure.v1"]
      .every((dataset) => enabled.some((candidate) => candidate.dataset === dataset
        && !candidate.includeLocalIds
        && candidate.allowReplicaCache
        && candidate.retentionDays === 30));
}

export function summarizeMcpStuguby(summary: StugubySummary): object {
  const adoption = stugubyStore.getPropertyAdoption(summary.id);
  const houses = database.listHouses().filter((house) => house.stuguby?.stugubyId === summary.id);
  const grants = stugubyStore.listGrants(summary.id);
  return {
    id: summary.id,
    name: summary.name,
    descriptionConfigured: summary.description !== null,
    coordinatorUrl: summary.coordinatorUrl,
    side: stugubySide(summary.localRole),
    accessRole: summary.localRole,
    memberState: summary.localMemberState,
    memberCount: summary.memberCount,
    adoptedPropertyId: adoption?.state === "adopted" ? adoption.localPropertyId : null,
    ownedHomeCount: houses.filter((house) => house.stuguby?.ownership === "local").length,
    sharedHomeCount: houses.filter((house) => house.stuguby?.ownership === "shared").length,
    activeGrantCount: grants.filter(activeStugubyGrant).length,
    lastSyncAt: summary.lastSyncAt,
    lastSyncError: summary.lastSyncError,
    updatedAt: summary.updatedAt,
  };
}
