import type { AreaEquipment, MaintenanceTaskChangedField, MeasurementSample, ObservationChangedField, PropertyArea, PropertyNote } from "@climate-twin/contracts";

export const MIN_SEED_OUTDOOR_READINGS = 48;

export const MAX_ACTIVE_IOS_REGISTRATIONS_PER_USER = 20;

export const DEMO_TELEMETRY_SOURCES = new Set<MeasurementSample["source"]>(["mock", "replay"]);

export const TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY = "sensor-gap-rearm:tp-link-local-climate";

export const TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR = "The direct H100/H200 local API does not expose retained T310/T315 measurement history";

// T310/T315 return at most 96 quarter-hour buckets. The oldest bucket is 95
// intervals behind the current bucket, so only fully retained gaps are rearmed.
export const TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS = 95 * 15 * 60_000;

export const OBSERVATION_CHANGED_FIELDS: readonly ObservationChangedField[] = [
  "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt", "timePrecision",
  "validFrom", "validTo", "source", "sourceDetail", "confidence", "status", "resolutionNote", "resolvedAt",
];

export const MAINTENANCE_TASK_CHANGED_FIELDS: readonly MaintenanceTaskChangedField[] = [
  "propertyId", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor", "dueBy",
  "observationIds", "status", "completionNote", "completedAt", "verificationNote", "verifiedAt",
];

export const DEFAULT_PROPERTY_ID = "property-main";

export const PROPERTY_AREA_KINDS = new Set<PropertyArea["kind"]>([
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road",
  "yard", "building", "other",
]);

export const EQUIPMENT_STATUSES = new Set<AreaEquipment["status"]>(["active", "out-of-service", "retired"]);

export const PROPERTY_NOTE_KINDS = new Set<PropertyNote["kind"]>(["note", "inspection", "maintenance"]);

export const MAX_PROPERTY_AREA_VERTICES = 500;

export const DEFAULT_COLLECTION_LIMIT = 500;

export const MAX_COLLECTION_LIMIT = 500;

export function boundedCollectionLimit(value = DEFAULT_COLLECTION_LIMIT): number {
  if (!Number.isInteger(value)) return DEFAULT_COLLECTION_LIMIT;
  return Math.min(MAX_COLLECTION_LIMIT, Math.max(1, value));
}

export function boundedCollectionOffset(value = 0): number {
  if (!Number.isInteger(value)) return 0;
  return Math.min(1_000_000, Math.max(0, value));
}
