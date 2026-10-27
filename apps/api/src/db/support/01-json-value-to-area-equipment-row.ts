import type { AlertDeliveryPolicy, AlertEvent, AlertRule, AreaEquipment, DailyAnalyticsFindingsSnapshot, MaintenanceTaskChangedField, MeasurementSample, NotificationChannel, NotificationDeliveryStage, NotificationSubjectKind, ObservationChangedField, OpeningStateObservation, PropertyArea, PropertyElectricityConfig, PropertyNote, SecurityAuditEvent, SecurityAuditEventType, SecurityAuditOutcome, SecurityAuditSubjectType } from "@climate-twin/contracts";

export type JsonValue = string | number | boolean;

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

export interface DemoTelemetryPurgeResult {
  activated: boolean;
  activatedAt: string;
  readings: number;
  measurementSamples: number;
  outdoorTemperatureSamples: number;
  alertEvents: number;
}

export interface StoredDailyAnalyticsFindings {
  snapshot: DailyAnalyticsFindingsSnapshot | null;
  lastAttemptAt: string;
  lastError: string | null;
}

export interface PropertyMigrationResult {
  sourcePropertyId: string;
  targetPropertyId: string;
  houseIds: string[];
  areaIds: string[];
  equipmentIds: string[];
  noteIds: string[];
  maintenanceTaskIds: string[];
}

export interface OpeningStateActivityRecord {
  floorId: string;
  elementId: string;
  source: OpeningStateObservation["source"];
  externalId: string | null;
  connectionId: string | null;
  observationCount: number;
  openedCount: number;
  closedCount: number;
}

export interface SecurityAuditEventInput {
  eventType: SecurityAuditEventType;
  outcome?: SecurityAuditOutcome;
  actorUserId: string | null;
  actorRole: SecurityAuditEvent["actorRole"];
  subjectType: SecurityAuditSubjectType;
  subjectId: string;
  details?: SecurityAuditEvent["details"];
  createdAt?: string;
}

export interface NotificationOutboxItem {
  id: string;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  eventId: string | null;
  stage: NotificationDeliveryStage;
  sequence: number;
  channel: NotificationChannel;
  destinationId: string;
  payloadJson: string;
  destinationRef: string;
  policy: AlertDeliveryPolicy;
  maxAttempts: number;
  attempts: number;
  lockToken: string;
}

export interface AlertTransition {
  ignoredAsStale: boolean;
  created: AlertEvent | null;
  resolved: AlertEvent | null;
}

export interface DueAlertCondition {
  rule: AlertRule;
  sensorId: string;
  conditionSince: string;
  latestTimestamp: string;
}

export interface TelemetryArchiveRow<T> {
  rowId: number;
  record: T;
}

export interface TelemetryArchiveDirtyRow<T> {
  dirtyId: number;
  version: number;
  record: T;
}

export interface ElectricityPriceArchiveRecord {
  propertyId: string;
  startAt: string;
  endAt: string;
  rawPriceCentsPerKwh: number;
  marginCentsPerKwh: number;
  source: string;
  fetchedAt: string;
}

export interface OpeningStateArchiveRecord {
  observationId: string;
  houseId: string;
  floorId: string;
  elementId: string;
  state: OpeningStateObservation["state"];
  openFraction: number | null;
  source: OpeningStateObservation["source"];
  observedAt: string;
  validUntil: string | null;
  externalId: string | null;
  connectionId: string | null;
  recordedAt: string;
}

export type IntegrationMappingKind = "home-assistant" | "tp-link";

/**
 * A validated, non-secret compatibility mapping imported from a JSON file.
 * The source path is deliberately not retained: the SQLite copy is the
 * durable control-plane record once the file has been accepted.
 */
export interface IntegrationMappingSet<T = unknown> {
  kind: IntegrationMappingKind;
  contentHash: string;
  revision: number;
  mappings: T[];
  createdAt: string;
  updatedAt: string;
}

export type TelemetryCascadeScope = "sensor" | "house" | "house-location" | "property";

export type TelemetryArchiveTable =
  | "measurement_samples"
  | "legacy_readings"
  | "outdoor_temperature_samples"
  | "electricity_price_samples"
  | "opening_state_samples"
  | "heat_pump_state_samples";

export type TelemetryArchiveMutableTable = Exclude<
  TelemetryArchiveTable,
  "measurement_samples" | "opening_state_samples" | "heat_pump_state_samples"
>;

export type TelemetryArchiveWatermarks = Readonly<Record<
  TelemetryArchiveTable,
  number
>>;

export interface HouseRow {
  id: string;
  property_id: string;
  name: string;
  timezone: string;
  location_json: string | null;
  map_placement_json: string | null;
  orientation_degrees: number | null;
  floors_json: string;
  stugby_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SecurityAuditEventRow {
  id: string;
  event_type: SecurityAuditEvent["eventType"];
  outcome: SecurityAuditEvent["outcome"];
  actor_user_id: string | null;
  actor_role: SecurityAuditEvent["actorRole"];
  subject_type: SecurityAuditEvent["subjectType"];
  subject_id: string;
  details_json: string;
  created_at: string;
}

export interface OpeningStateObservationRow {
  id: string;
  house_id: string;
  floor_id: string;
  element_id: string;
  state: OpeningStateObservation["state"];
  open_fraction: number | null;
  source: OpeningStateObservation["source"];
  observed_at: string;
  valid_until: string | null;
  external_id: string | null;
  connection_id: string | null;
}

export interface PropertyRow {
  id: string;
  name: string;
  description: string | null;
  default_house_id: string | null;
  location_json: string | null;
  stugby_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyElectricityConfigRow {
  property_id: string;
  provider: PropertyElectricityConfig["provider"];
  endpoint_url: string;
  enabled: number;
  margin_cents_per_kwh: number;
  contract_type: PropertyElectricityConfig["contractType"];
  contract_name: string | null;
  retailer: string | null;
  monthly_fee_eur: number | null;
  last_fetched_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface IntegrationMappingSetRow {
  kind: IntegrationMappingKind;
  content_hash: string;
  revision: number;
  mappings_json: string;
  created_at: string;
  updated_at: string;
}

export interface ElectricityPricePointRow {
  property_id: string;
  start_at: string;
  end_at: string;
  raw_price_cents_per_kwh: number;
  margin_cents_per_kwh: number;
  fetched_at: string;
}

export interface EnergyCostAggregateRow {
  delta_count: number;
  consumption_kwh: number | null;
  priced_consumption_kwh: number | null;
  cost_eur: number | null;
  total_duration_ms: number | null;
  priced_duration_ms: number | null;
  maximum_interval_duration_ms: number | null;
  coverage_from: string | null;
  coverage_until: string | null;
  /** JSON `[[startAt, endAt, kwh], ...]` of every delta's in-window share. */
  usage_json?: string | null;
  /** JSON `[[startAt, endAt, kwh, rawCentsPerKwh], ...]` of every priced overlap. */
  priced_json?: string | null;
}

export interface PropertyAreaRow {
  id: string;
  property_id: string;
  name: string;
  kind: PropertyArea["kind"];
  description: string | null;
  location_json: string | null;
  polygon_json: string;
  created_at: string;
  updated_at: string;
}

export interface AreaEquipmentRow {
  id: string;
  property_id: string;
  area_id: string | null;
  house_id: string | null;
  location_json: string | null;
  name: string;
  kind: string;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  status: AreaEquipment["status"];
  notes: string | null;
  created_at: string;
  updated_at: string;
}
