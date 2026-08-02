import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { AreaEquipmentRow, HouseRow, OpeningStateObservationRow, PropertyAreaRow, PropertyElectricityConfigRow, PropertyRow } from "./01-json-value-to-area-equipment-row.js";
import { ActionPlaybookRow, AlertEventRow, AlertRuleRow, EquipmentAttachmentRow, EquipmentLinkRow, IOSNotificationRegistrationRow, MeasurementDefinitionRow, MeasurementSampleRow, PropertyNoteRow, ReadingRow, SensorRow } from "./02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { CanonicalJsonValue, parseJson } from "./03-sensor-data-gap-row-to-canonical-json-value.js";

export function canonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Integration mappings must contain only finite JSON numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") throw new Error("Integration mappings must be JSON-compatible");
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
}

/** Top-level mappings are a set; nested arrays retain their declared order. */
export function canonicalIntegrationMappingsJson(mappings: readonly unknown[]): string {
  const canonical = mappings.map(canonicalJsonValue)
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
  return JSON.stringify(canonical);
}

export type LayoutPoint = { x: number; y: number };

export function roomPolygonSelfIntersects(points: LayoutPoint[], coordinateScale: number): boolean {
  const linearTolerance = Math.max(1, coordinateScale) * 1e-10;
  const crossTolerance = Math.max(1, coordinateScale * coordinateScale) * 1e-10;
  const cross = (a: LayoutPoint, b: LayoutPoint, c: LayoutPoint) => (
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  );
  const onSegment = (a: LayoutPoint, b: LayoutPoint, point: LayoutPoint) => (
    Math.abs(cross(a, b, point)) <= crossTolerance
    && point.x >= Math.min(a.x, b.x) - linearTolerance
    && point.x <= Math.max(a.x, b.x) + linearTolerance
    && point.y >= Math.min(a.y, b.y) - linearTolerance
    && point.y <= Math.max(a.y, b.y) + linearTolerance
  );
  const segmentsIntersect = (a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint) => {
    const abC = cross(a, b, c);
    const abD = cross(a, b, d);
    const cdA = cross(c, d, a);
    const cdB = cross(c, d, b);
    const crossesProperly = ((abC > crossTolerance && abD < -crossTolerance) || (abC < -crossTolerance && abD > crossTolerance))
      && ((cdA > crossTolerance && cdB < -crossTolerance) || (cdA < -crossTolerance && cdB > crossTolerance));
    return crossesProperly
      || onSegment(a, b, c)
      || onSegment(a, b, d)
      || onSegment(c, d, a)
      || onSegment(c, d, b);
  };

  for (let firstIndex = 0; firstIndex < points.length; firstIndex += 1) {
    const firstNext = (firstIndex + 1) % points.length;
    for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex += 1) {
      const secondNext = (secondIndex + 1) % points.length;
      // Consecutive edges are expected to meet at their shared vertex.
      if (firstNext === secondIndex || secondNext === firstIndex) continue;
      if (segmentsIntersect(points[firstIndex]!, points[firstNext]!, points[secondIndex]!, points[secondNext]!)) return true;
    }
  }
  return false;
}

function stugubyLinkFromJson<T extends { stugubyId: string }>(value: string): T {
  const link = parseJson<Record<string, unknown>>(value);
  if (typeof link.stugubyId !== "string" && typeof link.stugbyId === "string") {
    link.stugubyId = link.stugbyId;
    delete link.stugbyId;
  }
  return link as T;
}

export function houseFromRow(row: HouseRow): House {
  return {
    id: row.id,
    propertyId: row.property_id,
    name: row.name,
    timezone: row.timezone,
    ...(row.location_json ? { location: parseJson<HouseLocation>(row.location_json) } : {}),
    ...(row.map_placement_json ? { mapPlacement: parseJson<HouseMapPlacement>(row.map_placement_json) } : {}),
    ...(row.orientation_degrees !== null ? { orientationDegrees: row.orientation_degrees } : {}),
    floors: parseJson<Floor[]>(row.floors_json),
    ...(row.stugby_json ? { stuguby: stugubyLinkFromJson<StugubyHouseLink>(row.stugby_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openingStateObservationFromRow(row: OpeningStateObservationRow): OpeningStateObservation {
  return {
    id: row.id,
    houseId: row.house_id,
    floorId: row.floor_id,
    elementId: row.element_id,
    state: row.state,
    ...(row.open_fraction !== null ? { openFraction: row.open_fraction } : {}),
    source: row.source,
    observedAt: row.observed_at,
    ...(row.valid_until ? { validUntil: row.valid_until } : {}),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    ...(row.connection_id ? { connectionId: row.connection_id } : {}),
  };
}

export function propertyFromRow(row: PropertyRow): Property {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultHouseId: row.default_house_id,
    location: row.location_json ? parseJson<HouseLocation>(row.location_json) : null,
    ...(row.stugby_json ? { stuguby: stugubyLinkFromJson<StugubyPropertyLink>(row.stugby_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function electricityConfigFromRow(row: PropertyElectricityConfigRow): PropertyElectricityConfig {
  return {
    propertyId: row.property_id,
    provider: row.provider,
    endpointUrl: row.endpoint_url,
    enabled: row.enabled === 1,
    marginCentsPerKwh: row.margin_cents_per_kwh,
    contractType: row.contract_type,
    contractName: row.contract_name,
    retailer: row.retailer,
    monthlyFeeEur: row.monthly_fee_eur,
    lastFetchedAt: row.last_fetched_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function propertyAreaFromRow(row: PropertyAreaRow): PropertyArea {
  return {
    id: row.id,
    propertyId: row.property_id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    ...(row.location_json ? { location: parseJson<GeoCoordinate>(row.location_json) } : {}),
    polygon: parseJson<GeoCoordinate[]>(row.polygon_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function areaEquipmentFromRow(row: AreaEquipmentRow): AreaEquipment {
  return {
    id: row.id,
    propertyId: row.property_id,
    areaId: row.area_id,
    houseId: row.house_id,
    ...(row.location_json ? { location: parseJson<GeoCoordinate>(row.location_json) } : {}),
    name: row.name,
    kind: row.kind,
    manufacturer: row.manufacturer,
    model: row.model,
    serialNumber: row.serial_number,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function equipmentAttachmentFromRow(row: EquipmentAttachmentRow): EquipmentAttachment {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

export function equipmentLinkFromRow(row: EquipmentLinkRow): EquipmentLink {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    label: row.label,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function propertyNoteFromRow(row: PropertyNoteRow): PropertyNote {
  return {
    id: row.id,
    propertyId: row.property_id,
    houseId: row.house_id,
    areaId: row.area_id,
    equipmentId: row.equipment_id,
    kind: row.kind,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function sensorFromRow(row: SensorRow): Sensor {
  return {
    id: row.id,
    houseId: row.house_id,
    floorId: row.floor_id,
    name: row.name,
    roomId: row.room_id,
    room: row.room,
    model: row.model,
    x: row.x,
    y: row.y,
    z: row.z,
    ...(row.temperature_entity_id ? { temperatureEntityId: row.temperature_entity_id } : {}),
    ...(row.humidity_entity_id ? { humidityEntityId: row.humidity_entity_id } : {}),
    ...(row.battery_entity_id ? { batteryEntityId: row.battery_entity_id } : {}),
    ...(row.tp_link_device_id ? { tpLinkDeviceId: row.tp_link_device_id } : {}),
    ...(row.tp_link_connection_id ? { tpLinkConnectionId: row.tp_link_connection_id } : {}),
    energyMeterRole: row.energy_meter_role === "whole_home" || row.energy_meter_role === "submeter"
      ? row.energy_meter_role
      : "standalone",
    tags: parseJson<string[]>(row.tags_json),
    enabled: row.enabled === 1,
  };
}

export function measurementDefinitionFromRow(row: MeasurementDefinitionRow): MeasurementDefinition {
  return {
    id: row.id,
    labels: parseJson<Record<string, string>>(row.labels_json),
    unit: row.unit,
    dimension: row.dimension,
    allowedUnits: parseJson<string[]>(row.allowed_units_json),
    kind: row.kind,
    defaultAggregation: row.default_aggregation,
    genericHistoryEnabled: row.generic_history_enabled === 1,
    genericStatsEnabled: row.generic_stats_enabled === 1,
    precision: row.precision,
    validMin: row.valid_min,
    validMax: row.valid_max,
    displayMin: row.display_min,
    displayMax: row.display_max,
    interpolationDelta: row.interpolation_delta,
    colorScale: row.color_scale,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1,
    spatialInterpolation: row.spatial_interpolation === 1,
    forecastSupported: row.forecast_supported === 1,
  };
}

export function measurementSampleFromRow(row: MeasurementSampleRow): MeasurementSample {
  return {
    sensorId: row.sensor_id,
    metric: row.metric,
    value: row.value,
    canonicalUnit: row.canonical_unit,
    timestamp: row.timestamp,
    source: row.source,
    quality: row.quality,
  };
}

export function readingFromRow(row: ReadingRow): Reading {
  return {
    sensorId: row.sensor_id,
    timestamp: row.timestamp,
    temperature: row.temperature,
    humidity: row.humidity,
    battery: row.battery,
    source: row.source,
    quality: row.quality,
  };
}

export function ruleFromRow(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    sensorId: row.sensor_id,
    metric: row.metric,
    operator: row.operator,
    threshold: row.threshold,
    durationSeconds: row.duration_seconds,
    severity: row.severity,
    enabled: row.enabled === 1,
    webhookEnabled: row.webhook_enabled === 1,
    telegramEnabled: row.telegram_enabled === 1,
    deliveryPolicy: policyFromJson(row.delivery_policy_json),
  };
}

export function eventFromRow(row: AlertEventRow): AlertEvent {
  return {
    id: row.id,
    ruleId: row.rule_id,
    sensorId: row.sensor_id,
    metric: row.metric,
    value: row.value,
    threshold: row.threshold,
    severity: row.severity,
    startedAt: row.started_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
  };
}

export function iosNotificationRegistrationFromRow(
  row: IOSNotificationRegistrationRow,
  homeIds: string[],
): IOSNotificationRegistration {
  return {
    id: row.id,
    environment: row.environment,
    homeIds,
    minimumSeverity: row.minimum_severity,
    includeDetails: row.include_details === 1,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
  };
}

export function actionPlaybookFromRow(row: ActionPlaybookRow): ActionPlaybook {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: parseJson<string[]>(row.instructions_json),
    metric: row.metric,
    goal: row.goal,
    minimumImprovement: row.minimum_improvement,
    targetValue: row.target_value,
    waitSeconds: row.wait_seconds,
    verificationWindowSeconds: row.verification_window_seconds,
    enabled: row.enabled === 1,
    builtIn: row.built_in === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
