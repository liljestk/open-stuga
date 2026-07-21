import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
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
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "./notification-snapshot.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "./notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord } from "./timeseries/types.js";

type JsonValue = string | number | boolean;
const MIN_SEED_OUTDOOR_READINGS = 48;
const DEMO_TELEMETRY_SOURCES = new Set<MeasurementSample["source"]>(["mock", "replay"]);
const TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY = "sensor-gap-rearm:tp-link-local-climate";
const TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR = "The direct H100/H200 local API does not expose retained T310/T315 measurement history";
// T310/T315 return at most 96 quarter-hour buckets. The oldest bucket is 95
// intervals behind the current bucket, so only fully retained gaps are rearmed.
const TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS = 95 * 15 * 60_000;
const OBSERVATION_CHANGED_FIELDS: readonly ObservationChangedField[] = [
  "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt", "timePrecision",
  "validFrom", "validTo", "source", "sourceDetail", "confidence", "status", "resolutionNote", "resolvedAt",
];
const MAINTENANCE_TASK_CHANGED_FIELDS: readonly MaintenanceTaskChangedField[] = [
  "propertyId", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor", "dueBy",
  "observationIds", "status", "completionNote", "completedAt", "verificationNote", "verifiedAt",
];
const DEFAULT_PROPERTY_ID = "property-main";
const PROPERTY_AREA_KINDS = new Set<PropertyArea["kind"]>([
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road",
  "yard", "building", "other",
]);
const EQUIPMENT_STATUSES = new Set<AreaEquipment["status"]>(["active", "out-of-service", "retired"]);
const PROPERTY_NOTE_KINDS = new Set<PropertyNote["kind"]>(["note", "inspection", "maintenance"]);
const MAX_PROPERTY_AREA_VERTICES = 500;
const DEFAULT_COLLECTION_LIMIT = 500;
const MAX_COLLECTION_LIMIT = 500;

function boundedCollectionLimit(value = DEFAULT_COLLECTION_LIMIT): number {
  if (!Number.isInteger(value)) return DEFAULT_COLLECTION_LIMIT;
  return Math.min(MAX_COLLECTION_LIMIT, Math.max(1, value));
}

function boundedCollectionOffset(value = 0): number {
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

export type NotificationChannel = "webhook" | "telegram";

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
  | "electricity_price_samples";
export type TelemetryArchiveMutableTable = Exclude<TelemetryArchiveTable, "measurement_samples">;
export type TelemetryArchiveWatermarks = Readonly<Record<
  "measurement_samples" | "legacy_readings" | "outdoor_temperature_samples",
  number
>>;

interface HouseRow {
  id: string;
  property_id: string;
  name: string;
  timezone: string;
  location_json: string | null;
  map_placement_json: string | null;
  orientation_degrees: number | null;
  floors_json: string;
  created_at: string;
  updated_at: string;
}

interface SecurityAuditEventRow {
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

interface OpeningStateObservationRow {
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

interface PropertyRow {
  id: string;
  name: string;
  description: string | null;
  location_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PropertyElectricityConfigRow {
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

interface IntegrationMappingSetRow {
  kind: IntegrationMappingKind;
  content_hash: string;
  revision: number;
  mappings_json: string;
  created_at: string;
  updated_at: string;
}

interface ElectricityPricePointRow {
  property_id: string;
  start_at: string;
  end_at: string;
  raw_price_cents_per_kwh: number;
  margin_cents_per_kwh: number;
  fetched_at: string;
}

interface EnergyCostAggregateRow {
  delta_count: number;
  consumption_kwh: number | null;
  priced_consumption_kwh: number | null;
  cost_eur: number | null;
  total_duration_ms: number | null;
  priced_duration_ms: number | null;
  coverage_from: string | null;
  coverage_until: string | null;
}

interface PropertyAreaRow {
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

interface AreaEquipmentRow {
  id: string;
  property_id: string;
  area_id: string;
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

interface PropertyNoteRow {
  id: string;
  property_id: string;
  house_id: string | null;
  area_id: string | null;
  equipment_id: string | null;
  kind: PropertyNote["kind"];
  text: string;
  created_at: string;
  updated_at: string;
}

interface SensorRow {
  id: string;
  house_id: string;
  floor_id: string;
  name: string;
  room_id: string | null;
  room: string;
  model: string;
  x: number;
  y: number;
  z: number;
  temperature_entity_id: string | null;
  humidity_entity_id: string | null;
  battery_entity_id: string | null;
  tp_link_device_id: string | null;
  tp_link_connection_id: string | null;
  measurement_entity_ids_json?: string | null;
  tags_json: string;
  enabled: number;
}

interface MeasurementDefinitionRow {
  id: string;
  labels_json: string;
  unit: string;
  dimension: string;
  allowed_units_json: string;
  kind: NonNullable<MeasurementDefinition["kind"]>;
  default_aggregation: NonNullable<MeasurementDefinition["defaultAggregation"]>;
  generic_history_enabled: number;
  generic_stats_enabled: number;
  precision: number;
  valid_min: number | null;
  valid_max: number | null;
  display_min: number | null;
  display_max: number | null;
  interpolation_delta: number;
  color_scale: MeasurementDefinition["colorScale"];
  builtin: number;
  enabled: number;
  spatial_interpolation: number;
  forecast_supported: number;
}

interface MeasurementSampleRow {
  sensor_id: string;
  metric: string;
  value: number;
  canonical_unit: string;
  timestamp: string;
  source: MeasurementSample["source"];
  quality: MeasurementSample["quality"];
}

interface ReadingRow {
  sensor_id: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  source: Reading["source"];
  quality: Reading["quality"];
}

interface AlertRuleRow {
  id: string;
  name: string;
  sensor_id: string | null;
  metric: AlertRule["metric"];
  operator: AlertRule["operator"];
  threshold: number;
  duration_seconds: number;
  severity: AlertRule["severity"];
  enabled: number;
  webhook_enabled: number;
  telegram_enabled: number;
  delivery_policy_json: string | null;
}

interface AlertEventRow {
  id: string;
  rule_id: string;
  sensor_id: string;
  metric: AlertEvent["metric"];
  value: number;
  threshold: number;
  severity: AlertEvent["severity"];
  started_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

interface ActionPlaybookRow {
  id: string;
  name: string;
  description: string;
  instructions_json: string;
  metric: string;
  goal: ActionPlaybook["goal"];
  minimum_improvement: number;
  target_value: number | null;
  wait_seconds: number;
  verification_window_seconds: number;
  enabled: number;
  built_in: number;
  created_at: string;
  updated_at: string;
}

interface ActionRunRow {
  id: string;
  playbook_id: string;
  alert_event_id: string | null;
  maintenance_task_id: string | null;
  sensor_id: string;
  metric: string;
  status: ActionRun["status"];
  started_at: string;
  action_completed_at: string | null;
  verify_after: string | null;
  verification_deadline: string | null;
  baseline_value: number;
  baseline_timestamp: string;
  result_value: number | null;
  result_timestamp: string | null;
  improvement: number | null;
  sample_count: number;
  operator_note: string | null;
  verification_note: string | null;
  created_at: string;
  updated_at: string;
}

interface ObservationRow {
  id: string;
  house_id: string;
  floor_id: string;
  sensor_id: string | null;
  kind: ManualObservation["kind"];
  severity: ManualObservation["severity"];
  note: string;
  x: number | null;
  y: number | null;
  occurred_at: string;
  created_at: string;
  time_precision: ObservationTimePrecision;
  valid_from: string | null;
  valid_to: string | null;
  source: ObservationSource;
  source_detail: string | null;
  confidence: ObservationConfidence;
  status: NonNullable<ManualObservation["status"]>;
  resolution_note: string | null;
  resolved_at: string | null;
  revision: number;
  updated_at: string | null;
}

interface ObservationRevisionRow {
  observation_id: string;
  revision: number;
  changed_at: string;
  actor: ObservationRevisionActor;
  changed_fields_json: string;
  snapshot_json: string;
}

type StoredObservation = ManualObservation & Required<Pick<ManualObservation,
  | "timePrecision"
  | "validFrom"
  | "validTo"
  | "source"
  | "sourceDetail"
  | "confidence"
  | "status"
  | "resolutionNote"
  | "resolvedAt"
  | "revision"
  | "updatedAt"
>>;
type LocalObservationRevisionActor = Extract<ObservationRevisionActor, "local-rest" | "local-mcp">;

interface MaintenanceTaskRow {
  id: string;
  property_id: string;
  house_id: string | null;
  floor_id: string | null;
  area_id: string | null;
  equipment_id: string | null;
  title: string;
  description: string | null;
  basis: MaintenanceTask["basis"];
  basis_detail: string | null;
  priority: MaintenanceTask["priority"];
  planned_for: string | null;
  due_by: string | null;
  status: MaintenanceTask["status"];
  completion_note: string | null;
  completed_at: string | null;
  verification_note: string | null;
  verified_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface MaintenanceTaskRevisionRow {
  maintenance_task_id: string;
  revision: number;
  changed_at: string;
  actor: MaintenanceTaskRevisionActor;
  changed_fields_json: string;
  snapshot_json: string;
}

type LocalMaintenanceTaskRevisionActor = Extract<
  MaintenanceTaskRevisionActor,
  "local-rest" | "local-mcp" | "system-service"
>;

interface StaticParameterRow {
  id: string;
  house_id: string;
  scope_type: StaticParameter["scopeType"];
  scope_id: string;
  key: string;
  value_json: string;
  unit: string | null;
  label: string;
}

interface OutdoorTemperatureRow {
  house_id: string;
  location_key: string;
  timestamp: string;
  temperature_c: number;
  source: OutdoorTemperatureSample["source"];
  fetched_at: string;
  station_id: string | null;
  station_name: string | null;
  conditions_json: string | null;
}

interface WeatherOutageRow {
  id: number;
  house_id: string;
  location_key: string;
  provider: WeatherProviderName;
  component: WeatherOutageComponent;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  last_error: string;
  backfill_state: WeatherBackfillState;
  backfill_from: string | null;
  backfill_to: string | null;
  recovered_points: number;
  last_attempt_at: string | null;
  backfill_error: string | null;
}

export interface WeatherOutageRecord {
  id: number;
  houseId: string;
  locationKey: string;
  provider: WeatherProviderName;
  component: WeatherOutageComponent;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  lastError: string;
  backfillState: WeatherBackfillState;
  backfillFrom: string | null;
  backfillTo: string | null;
  recoveredPoints: number;
  lastAttemptAt: string | null;
  backfillError: string | null;
}

export type SensorDataGapSource = "home-assistant" | "tp-link";
export type SensorDataGapState = "open" | "pending" | "running" | "complete" | "partial" | "failed" | "not-supported";

interface SensorDataGapRow {
  id: number;
  sensor_id: string;
  metric: string;
  source: SensorDataGapSource;
  started_at: string;
  detected_at: string;
  ended_at: string | null;
  recovery_state: SensorDataGapState;
  recovered_points: number;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  recovery_error: string | null;
}

export interface SensorDataGapRecord {
  id: number;
  sensorId: string;
  metric: string;
  source: SensorDataGapSource;
  startedAt: string;
  detectedAt: string;
  endedAt: string | null;
  recoveryState: SensorDataGapState;
  recoveredPoints: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  recoveryError: string | null;
}

export type TapoHistoryExportProvider = "appium" | "private-cloud";
export type TapoHistoryExportJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting-email"
  | "needs-attention"
  | "completed"
  | "failed"
  | "cancelled";

interface TapoHistoryExportJobRow {
  id: string;
  dedupe_key: string;
  provider: TapoHistoryExportProvider;
  sensor_id: string;
  expected_device_id: string;
  device_name: string;
  time_zone: string;
  metric: string;
  expected_recipient: string | null;
  range_start: string;
  range_end: string;
  interval_minutes: number;
  status: TapoHistoryExportJobStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  submitted_at: string | null;
  deployment_fingerprint: string | null;
  acceptance_revision: string | null;
  mailbox_message_id: string | null;
  source_artifact_sha256: string | null;
  source_artifact_bytes: number | null;
  parser_version: string | null;
  source_schema_signature: string | null;
  expected_schema_signature: string | null;
  staged_sample_count: number;
  consumed_sample_count: number;
  last_error: string | null;
  attention_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface TapoHistoryExportStagedSampleRow {
  id: number;
  job_id: string;
  sensor_id: string;
  metric: string;
  value: number;
  canonical_unit: string;
  timestamp: string;
  source: "tp-link";
  quality: MeasurementSample["quality"];
  source_identity: string;
  created_at: string;
  consumed_at: string | null;
}

export interface TapoHistoryExportJobInput {
  /** Optional caller-generated id, useful when a plus-address must contain the final job id. */
  id?: string;
  provider: TapoHistoryExportProvider;
  sensorId: string;
  expectedDeviceId: string;
  deviceName?: string;
  /** Immutable house-timezone snapshot used for app date selection and CSV parsing. */
  timeZone?: string;
  metric: string;
  expectedRecipient: string | null;
  rangeStart: string;
  rangeEnd: string;
  intervalMinutes: number;
  /** Optional caller-owned idempotency key; otherwise a stable key is derived from the request. */
  dedupeKey?: string;
  maxAttempts?: number;
  availableAt?: string;
}

export interface TapoHistoryExportJob {
  id: string;
  dedupeKey: string;
  /** Acceptance-only jobs are staged for inspection but never reused for gap recovery. */
  canary: boolean;
  provider: TapoHistoryExportProvider;
  sensorId: string;
  expectedDeviceId: string;
  /** Stable-device alias used by the isolated mobile worker protocol. */
  deviceId: string;
  deviceName: string;
  timeZone: string;
  metric: string;
  expectedRecipient: string | null;
  rangeStart: string;
  rangeEnd: string;
  /** Range aliases used by the isolated mobile worker protocol. */
  from: string;
  to: string;
  intervalMinutes: number;
  status: TapoHistoryExportJobStatus;
  attemptCount: number;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  /** API-clock timestamp when the worker confirmed that Tapo accepted this attempt. */
  submittedAt: string | null;
  /** Exact automation deployment that leased this generation; internal audit data. */
  deploymentFingerprint: string | null;
  /** API parser/mailbox acceptance revision snapshotted when this generation was leased. */
  acceptanceRevision: string | null;
  mailboxMessageId: string | null;
  sourceArtifactSha256: string | null;
  sourceArtifactBytes: number | null;
  parserVersion: string | null;
  /** Structural signature of the exact parsed source CSV. */
  sourceSchemaSignature: string | null;
  /** Canary-approved schema snapshot fenced when an ordinary job was leased. */
  expectedSchemaSignature: string | null;
  stagedSampleCount: number;
  consumedSampleCount: number;
  lastError: string | null;
  attentionReason: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TapoHistoryExportClaim {
  job: TapoHistoryExportJob;
  /** Capability token required for worker-owned state changes; deliberately absent from the public job record. */
  leaseToken: string;
}

export interface TapoHistoryExportEnqueueResult {
  job: TapoHistoryExportJob;
  created: boolean;
}

export interface TapoHistoryExportJobFilter {
  statuses?: TapoHistoryExportJobStatus[];
  provider?: TapoHistoryExportProvider;
  sensorId?: string;
  limit?: number;
  oldestFirst?: boolean;
}

export interface TapoHistoryExportStagedSampleInput {
  metric: string;
  value: number;
  canonicalUnit: string;
  timestamp: string;
  /** Stable row identity from the CSV/private response, used to make reparsing idempotent. */
  sourceIdentity: string;
  source?: "tp-link";
  quality?: MeasurementSample["quality"];
}

export interface TapoHistoryExportStagedSample extends MeasurementSample {
  id: number;
  jobId: string;
  source: "tp-link";
  sourceIdentity: string;
  createdAt: string;
  consumedAt: string | null;
}

export interface TapoHistoryExportStagedSampleFilter {
  jobId?: string;
  sensorId?: string;
  metric?: string;
  from?: string;
  to?: string;
  consumed?: boolean;
  limit?: number;
}

export interface TapoHistoryExportTransition {
  status: TapoHistoryExportJobStatus;
  at?: string;
  leaseToken?: string;
  /** Optional mailbox-generation fence for asynchronous poller transitions. */
  expectedRecipient?: string | null;
  /** Optional mailbox-generation fence for asynchronous poller transitions. */
  expectedSubmittedAt?: string | null;
  error?: string | null;
  attentionReason?: string | null;
  /** Retry time used when transitioning to failed or queued. */
  availableAt?: string;
}

export interface TapoHistoryExportStageResult {
  job: TapoHistoryExportJob;
  staged: TapoHistoryExportStagedSample[];
  duplicateCount: number;
}

export interface TapoHistoryExportCompletionOptions {
  mailboxMessageId?: string;
  leaseToken?: string;
  completedAt?: string;
  /** Exact per-attempt mailbox capability observed before the asynchronous fetch. */
  expectedRecipient?: string;
  /** Exact API-clock submission timestamp observed before the asynchronous fetch. */
  expectedSubmittedAt?: string;
  /** SHA-256 of the exact source attachment before parsing. Required for app exports. */
  sourceArtifactSha256?: string;
  /** Exact raw attachment length before parsing. Required for app exports. */
  sourceArtifactBytes?: number;
  /** Versioned parser/schema identity used for this import. Required for app exports. */
  parserVersion?: string;
  /** Canonical structural signature emitted by the parser. Required for app exports. */
  sourceSchemaSignature?: string;
}

export interface TapoHistoryClaimOptions {
  canaryOnly?: boolean;
  preferCanary?: boolean;
  deploymentFingerprint?: string;
  acceptanceRevision?: string;
  requireApprovedTarget?: boolean;
  approvalNotBefore?: string;
  requiredAcceptanceRevision?: string;
  /** Atomic vendor/mailbox traffic slots across claimed, running, and waiting-email Appium jobs. */
  maxOutstandingAppium?: number;
}

export interface HistoricalTelemetryGap {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface AssetRecord {
  id: string;
  houseId: string;
  name: string;
  mimeType: string;
  kind: "floor-plan" | "model-3d" | "other";
  size: number;
  createdAt: string;
}

export class ClimateDataValidationError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type SensorUpdate = Partial<Omit<Sensor, "id" | "tpLinkDeviceId" | "tpLinkConnectionId">> & {
  /** Set null to remove a persisted direct TP-Link child-device binding. */
  tpLinkDeviceId?: string | null;
  /** Set null to remove the house-scoped TP-Link connection binding. */
  tpLinkConnectionId?: string | null;
};

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function securityAuditEventFromRow(row: SecurityAuditEventRow): SecurityAuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    outcome: row.outcome,
    actorUserId: row.actor_user_id,
    actorRole: row.actor_role,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    details: parseJson<SecurityAuditEvent["details"]>(row.details_json),
    createdAt: row.created_at,
  };
}

type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

function canonicalJsonValue(value: unknown): CanonicalJsonValue {
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
function canonicalIntegrationMappingsJson(mappings: readonly unknown[]): string {
  const canonical = mappings.map(canonicalJsonValue)
    .sort((left, right) => {
      const leftJson = JSON.stringify(left);
      const rightJson = JSON.stringify(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
  return JSON.stringify(canonical);
}

type LayoutPoint = { x: number; y: number };

function roomPolygonSelfIntersects(points: LayoutPoint[], coordinateScale: number): boolean {
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

function houseFromRow(row: HouseRow): House {
  return {
    id: row.id,
    propertyId: row.property_id,
    name: row.name,
    timezone: row.timezone,
    ...(row.location_json ? { location: parseJson<HouseLocation>(row.location_json) } : {}),
    ...(row.map_placement_json ? { mapPlacement: parseJson<HouseMapPlacement>(row.map_placement_json) } : {}),
    ...(row.orientation_degrees !== null ? { orientationDegrees: row.orientation_degrees } : {}),
    floors: parseJson<Floor[]>(row.floors_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function openingStateObservationFromRow(row: OpeningStateObservationRow): OpeningStateObservation {
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

function propertyFromRow(row: PropertyRow): Property {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    location: row.location_json ? parseJson<HouseLocation>(row.location_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function electricityConfigFromRow(row: PropertyElectricityConfigRow): PropertyElectricityConfig {
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

function propertyAreaFromRow(row: PropertyAreaRow): PropertyArea {
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

function areaEquipmentFromRow(row: AreaEquipmentRow): AreaEquipment {
  return {
    id: row.id,
    propertyId: row.property_id,
    areaId: row.area_id,
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

function propertyNoteFromRow(row: PropertyNoteRow): PropertyNote {
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

function sensorFromRow(row: SensorRow): Sensor {
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
    tags: parseJson<string[]>(row.tags_json),
    enabled: row.enabled === 1,
  };
}

function measurementDefinitionFromRow(row: MeasurementDefinitionRow): MeasurementDefinition {
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

function measurementSampleFromRow(row: MeasurementSampleRow): MeasurementSample {
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

function readingFromRow(row: ReadingRow): Reading {
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

function ruleFromRow(row: AlertRuleRow): AlertRule {
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

function eventFromRow(row: AlertEventRow): AlertEvent {
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

function actionPlaybookFromRow(row: ActionPlaybookRow): ActionPlaybook {
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

function actionRunFromRow(row: ActionRunRow): ActionRun {
  return {
    id: row.id,
    playbookId: row.playbook_id,
    alertEventId: row.alert_event_id,
    maintenanceTaskId: row.maintenance_task_id,
    sensorId: row.sensor_id,
    metric: row.metric,
    status: row.status,
    startedAt: row.started_at,
    actionCompletedAt: row.action_completed_at,
    verifyAfter: row.verify_after,
    verificationDeadline: row.verification_deadline,
    baselineValue: row.baseline_value,
    baselineTimestamp: row.baseline_timestamp,
    resultValue: row.result_value,
    resultTimestamp: row.result_timestamp,
    improvement: row.improvement,
    sampleCount: row.sample_count,
    operatorNote: row.operator_note,
    verificationNote: row.verification_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function observationFromRow(row: ObservationRow): StoredObservation {
  return {
    id: row.id,
    houseId: row.house_id,
    floorId: row.floor_id,
    sensorId: row.sensor_id,
    kind: row.kind,
    severity: row.severity,
    note: row.note,
    x: row.x,
    y: row.y,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    timePrecision: row.time_precision ?? "exact",
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    source: row.source ?? "unknown",
    sourceDetail: row.source_detail ?? null,
    confidence: row.confidence ?? "uncertain",
    status: row.status ?? "open",
    resolutionNote: row.resolution_note ?? null,
    resolvedAt: row.resolved_at ?? null,
    revision: row.revision ?? 1,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function observationRevisionFromRow(row: ObservationRevisionRow): ObservationRevision {
  const snapshot = parseJson<ManualObservation>(row.snapshot_json);
  return {
    observationId: row.observation_id,
    revision: row.revision,
    changedAt: row.changed_at,
    actor: row.actor,
    changedFields: parseJson<ObservationChangedField[]>(row.changed_fields_json),
    snapshot: {
      ...snapshot,
      status: snapshot.status ?? "open",
      resolutionNote: snapshot.resolutionNote ?? null,
      resolvedAt: snapshot.resolvedAt ?? null,
    },
  };
}

function canonicalMaintenanceObservationIds(observationIds: readonly string[]): string[] {
  return [...new Set(observationIds)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function maintenanceTaskFromRow(row: MaintenanceTaskRow, observationIds: string[]): MaintenanceTask {
  return {
    id: row.id,
    propertyId: row.property_id,
    houseId: row.house_id,
    floorId: row.floor_id,
    areaId: row.area_id ?? null,
    equipmentId: row.equipment_id ?? null,
    title: row.title,
    description: row.description,
    basis: row.basis,
    basisDetail: row.basis_detail,
    priority: row.priority,
    plannedFor: row.planned_for,
    dueBy: row.due_by,
    observationIds: canonicalMaintenanceObservationIds(observationIds),
    status: row.status,
    completionNote: row.completion_note,
    completedAt: row.completed_at,
    verificationNote: row.verification_note,
    verifiedAt: row.verified_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maintenanceTaskRevisionFromRow(row: MaintenanceTaskRevisionRow): MaintenanceTaskRevision {
  return {
    maintenanceTaskId: row.maintenance_task_id,
    revision: row.revision,
    changedAt: row.changed_at,
    actor: row.actor,
    changedFields: parseJson<MaintenanceTaskChangedField[]>(row.changed_fields_json),
    snapshot: parseJson<MaintenanceTask>(row.snapshot_json),
  };
}

interface CanonicalObservationTime {
  occurredAt: string;
  timePrecision: ObservationTimePrecision;
  validFrom: string | null;
  validTo: string | null;
}

interface CanonicalObservationLifecycle {
  status: NonNullable<ManualObservation["status"]>;
  resolutionNote: string | null;
  resolvedAt: string | null;
}

function invalidObservationResolution(message: string): never {
  throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_RESOLUTION", message);
}

function canonicalObservationPatchLifecycle(
  current: StoredObservation,
  patch: ManualObservationPatch,
  changedAt: string,
): CanonicalObservationLifecycle {
  if (patch.status === "open") {
    if (patch.resolutionNote !== undefined && patch.resolutionNote !== null) {
      return invalidObservationResolution("An open observation cannot carry a resolutionNote");
    }
    return { status: "open", resolutionNote: null, resolvedAt: null };
  }

  if (patch.status === "resolved") {
    const resolutionNote = patch.resolutionNote === undefined && current.status === "resolved"
      ? current.resolutionNote ?? ""
      : typeof patch.resolutionNote === "string" ? patch.resolutionNote.trim() : "";
    if (!resolutionNote) {
      return invalidObservationResolution("resolutionNote is required when resolving an observation");
    }
    return {
      status: "resolved",
      resolutionNote,
      resolvedAt: current.status === "resolved" ? current.resolvedAt : changedAt,
    };
  }

  if (patch.resolutionNote !== undefined) {
    if (current.status !== "resolved") {
      if (patch.resolutionNote === null) {
        return { status: "open", resolutionNote: null, resolvedAt: null };
      }
      return invalidObservationResolution("resolutionNote can only be edited on a resolved observation");
    }
    const resolutionNote = typeof patch.resolutionNote === "string" ? patch.resolutionNote.trim() : "";
    if (!resolutionNote) {
      return invalidObservationResolution("A resolved observation must have a non-empty resolutionNote");
    }
    return { status: "resolved", resolutionNote, resolvedAt: current.resolvedAt };
  }

  return {
    status: current.status,
    resolutionNote: current.resolutionNote,
    resolvedAt: current.resolvedAt,
  };
}

const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

type MaintenanceLifecycle = Pick<MaintenanceTask,
  "status" | "completionNote" | "completedAt" | "verificationNote" | "verifiedAt"
>;

function invalidMaintenanceLifecycle(message: string): never {
  throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_LIFECYCLE", message);
}

function canonicalMaintenanceLifecycle(
  current: MaintenanceTask,
  patch: MaintenanceTaskPatch,
  changedAt: string,
): MaintenanceLifecycle {
  const status = patch.status ?? current.status;
  const completionPatch = typeof patch.completionNote === "string"
    ? patch.completionNote.trim()
    : patch.completionNote;
  const verificationPatch = typeof patch.verificationNote === "string"
    ? patch.verificationNote.trim()
    : patch.verificationNote;

  if (status === "planned" || status === "in-progress" || status === "cancelled") {
    if (completionPatch !== undefined && completionPatch !== null) {
      return invalidMaintenanceLifecycle(`${status} maintenance cannot carry a completionNote`);
    }
    if (verificationPatch !== undefined && verificationPatch !== null) {
      return invalidMaintenanceLifecycle(`${status} maintenance cannot carry a verificationNote`);
    }
    return { status, completionNote: null, completedAt: null, verificationNote: null, verifiedAt: null };
  }

  const priorCompletion = current.status === "completed" || current.status === "verified"
    ? current.completionNote
    : null;
  const completionNote = completionPatch === undefined ? priorCompletion : completionPatch;
  if (typeof completionNote !== "string" || !completionNote) {
    return invalidMaintenanceLifecycle("completionNote is required when completing maintenance");
  }
  const completedAt = current.status === "completed" || current.status === "verified"
    ? current.completedAt ?? changedAt
    : changedAt;

  if (status === "completed") {
    if (verificationPatch !== undefined && verificationPatch !== null) {
      return invalidMaintenanceLifecycle("verificationNote can only be recorded when verifying completed maintenance");
    }
    return { status, completionNote, completedAt, verificationNote: null, verifiedAt: null };
  }

  if (current.status !== "completed" && current.status !== "verified") {
    return invalidMaintenanceLifecycle("Only completed maintenance can be verified");
  }
  const priorVerification = current.status === "verified" ? current.verificationNote : null;
  const verificationNote = verificationPatch === undefined ? priorVerification : verificationPatch;
  if (typeof verificationNote !== "string" || !verificationNote) {
    return invalidMaintenanceLifecycle("verificationNote is required when verifying maintenance");
  }
  return {
    status: "verified",
    completionNote,
    completedAt,
    verificationNote,
    verifiedAt: current.status === "verified" ? current.verifiedAt ?? changedAt : changedAt,
  };
}

function maintenanceDate(value: string | null, field: "plannedFor" | "dueBy"): string | null {
  if (value === null) return null;
  const epoch = ISO_DATE_ONLY.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_DATE", `${field} must be a valid YYYY-MM-DD date or null`);
  }
  return value;
}

function observationInstant(value: string | undefined, field: string): string {
  if (!value || !RFC3339_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", `${field} must be an RFC3339 date-time`);
  }
  return new Date(value).toISOString();
}

function observationDate(value: string | null | undefined, field: string): string {
  const epoch = value && ISO_DATE_ONLY.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (!value || !Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", `${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function rejectObservationRange(value: string | null | undefined, field: string, precision: ObservationTimePrecision): void {
  if (value !== undefined && value !== null) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", `${field} is not valid when timePrecision is ${precision}`);
  }
}

function canonicalObservationCreateTime(input: ManualObservationInput, recordedAt: string): CanonicalObservationTime {
  const precision = input.timePrecision ?? "exact";
  if (precision === "exact" || precision === "approximate") {
    rejectObservationRange(input.validFrom, "validFrom", precision);
    rejectObservationRange(input.validTo, "validTo", precision);
    if (precision === "approximate" && input.occurredAt === undefined) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", "occurredAt is required for an approximate observation");
    }
    return {
      occurredAt: observationInstant(input.occurredAt ?? recordedAt, "occurredAt"),
      timePrecision: precision,
      validFrom: null,
      validTo: null,
    };
  }
  if (precision === "date-only") {
    rejectObservationRange(input.validFrom, "validFrom", precision);
    rejectObservationRange(input.validTo, "validTo", precision);
    return {
      occurredAt: observationDate(input.occurredAt, "occurredAt"),
      timePrecision: precision,
      validFrom: null,
      validTo: null,
    };
  }
  if (precision === "date-range") {
    if (input.occurredAt !== undefined) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", "occurredAt is derived from validFrom for a date-range observation");
    }
    const validFrom = observationDate(input.validFrom, "validFrom");
    const validTo = observationDate(input.validTo, "validTo");
    if (validFrom > validTo) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_RANGE", "validFrom must be before or equal to validTo");
    }
    return { occurredAt: validFrom, timePrecision: precision, validFrom, validTo };
  }
  if (input.occurredAt !== undefined) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", "occurredAt must be omitted when timePrecision is unknown");
  }
  rejectObservationRange(input.validFrom, "validFrom", precision);
  rejectObservationRange(input.validTo, "validTo", precision);
  // v1 retains a non-null string field; an empty value explicitly means that no observed time is known.
  return { occurredAt: "", timePrecision: precision, validFrom: null, validTo: null };
}

function canonicalObservationPatchTime(
  current: StoredObservation,
  patch: ManualObservationPatch,
): CanonicalObservationTime {
  const precision = patch.timePrecision ?? current.timePrecision;
  if (precision === "exact" || precision === "approximate") {
    rejectObservationRange(patch.validFrom, "validFrom", precision);
    rejectObservationRange(patch.validTo, "validTo", precision);
    if (current.timePrecision === "unknown" && patch.occurredAt === undefined) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", "occurredAt is required when changing an unknown observation time");
    }
    return {
      occurredAt: observationInstant(patch.occurredAt ?? current.occurredAt, "occurredAt"),
      timePrecision: precision,
      validFrom: null,
      validTo: null,
    };
  }
  if (precision === "date-only") {
    rejectObservationRange(patch.validFrom, "validFrom", precision);
    rejectObservationRange(patch.validTo, "validTo", precision);
    return {
      occurredAt: observationDate(patch.occurredAt ?? current.occurredAt, "occurredAt"),
      timePrecision: precision,
      validFrom: null,
      validTo: null,
    };
  }
  if (precision === "date-range") {
    if (patch.occurredAt !== undefined) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", "occurredAt is derived from validFrom for a date-range observation");
    }
    const validFrom = observationDate(patch.validFrom ?? current.validFrom, "validFrom");
    const validTo = observationDate(patch.validTo ?? current.validTo, "validTo");
    if (validFrom > validTo) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_RANGE", "validFrom must be before or equal to validTo");
    }
    return { occurredAt: validFrom, timePrecision: precision, validFrom, validTo };
  }
  if (patch.occurredAt !== undefined) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", "occurredAt must be omitted when timePrecision is unknown");
  }
  rejectObservationRange(patch.validFrom, "validFrom", precision);
  rejectObservationRange(patch.validTo, "validTo", precision);
  return { occurredAt: "", timePrecision: precision, validFrom: null, validTo: null };
}

function parameterFromRow(row: StaticParameterRow): StaticParameter {
  return {
    id: row.id,
    houseId: row.house_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    key: row.key,
    value: parseJson<JsonValue>(row.value_json),
    unit: row.unit,
    label: row.label,
  };
}

function outdoorTemperatureFromRow(row: OutdoorTemperatureRow): OutdoorTemperatureSample {
  let conditions: OutdoorConditions | undefined;
  try {
    conditions = row.conditions_json ? parseJson<OutdoorConditions>(row.conditions_json) : undefined;
  } catch {
    conditions = undefined;
  }
  return {
    houseId: row.house_id,
    locationKey: row.location_key,
    timestamp: row.timestamp,
    temperatureC: row.temperature_c,
    source: row.source,
    fetchedAt: row.fetched_at,
    stationId: row.station_id,
    stationName: row.station_name,
    ...(conditions ? { conditions } : {}),
  };
}

function weatherOutageFromRow(row: WeatherOutageRow): WeatherOutageRecord {
  return {
    id: row.id,
    houseId: row.house_id,
    locationKey: row.location_key,
    provider: row.provider,
    component: row.component,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
    lastError: row.last_error,
    backfillState: row.backfill_state,
    backfillFrom: row.backfill_from,
    backfillTo: row.backfill_to,
    recoveredPoints: row.recovered_points,
    lastAttemptAt: row.last_attempt_at,
    backfillError: row.backfill_error,
  };
}

function sensorDataGapFromRow(row: SensorDataGapRow): SensorDataGapRecord {
  return {
    id: row.id,
    sensorId: row.sensor_id,
    metric: row.metric,
    source: row.source,
    startedAt: row.started_at,
    detectedAt: row.detected_at,
    endedAt: row.ended_at,
    recoveryState: row.recovery_state,
    recoveredPoints: row.recovered_points,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    recoveryError: row.recovery_error,
  };
}

function tapoHistoryExportJobFromRow(row: TapoHistoryExportJobRow): TapoHistoryExportJob {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    canary: row.dedupe_key.startsWith("canary:"),
    provider: row.provider,
    sensorId: row.sensor_id,
    expectedDeviceId: row.expected_device_id,
    deviceId: row.expected_device_id,
    deviceName: row.device_name,
    timeZone: row.time_zone,
    metric: row.metric,
    expectedRecipient: row.expected_recipient,
    rangeStart: row.range_start,
    rangeEnd: row.range_end,
    from: row.range_start,
    to: row.range_end,
    intervalMinutes: row.interval_minutes,
    status: row.status,
    attemptCount: row.attempt_count,
    attempt: row.attempt_count,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    submittedAt: row.submitted_at,
    deploymentFingerprint: row.deployment_fingerprint,
    acceptanceRevision: row.acceptance_revision,
    mailboxMessageId: row.mailbox_message_id,
    sourceArtifactSha256: row.source_artifact_sha256,
    sourceArtifactBytes: row.source_artifact_bytes,
    parserVersion: row.parser_version,
    sourceSchemaSignature: row.source_schema_signature,
    expectedSchemaSignature: row.expected_schema_signature,
    stagedSampleCount: row.staged_sample_count,
    consumedSampleCount: row.consumed_sample_count,
    lastError: row.last_error,
    attentionReason: row.attention_reason,
    detail: row.attention_reason ?? row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function tapoHistoryExportStagedSampleFromRow(
  row: TapoHistoryExportStagedSampleRow,
): TapoHistoryExportStagedSample {
  return {
    id: row.id,
    jobId: row.job_id,
    sensorId: row.sensor_id,
    metric: row.metric,
    value: row.value,
    canonicalUnit: row.canonical_unit,
    timestamp: row.timestamp,
    source: row.source,
    quality: row.quality,
    sourceIdentity: row.source_identity,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  };
}

const TAPO_HISTORY_EXPORT_TRANSITIONS: Readonly<Record<TapoHistoryExportJobStatus, readonly TapoHistoryExportJobStatus[]>> = {
  queued: ["cancelled"],
  claimed: ["running", "waiting-email", "needs-attention", "completed", "failed", "cancelled"],
  running: ["waiting-email", "needs-attention", "completed", "failed", "cancelled"],
  "waiting-email": ["needs-attention", "completed", "failed", "cancelled"],
  "needs-attention": ["queued", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

function normalizedTapoHistoryTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_TIMESTAMP", `${field} must be an ISO date-time`);
  }
  return new Date(parsed).toISOString();
}

function normalizedTapoHistoryText(value: string, field: string, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || Array.from(normalized).length > maximum) {
    throw new ClimateDataValidationError(
      422,
      "INVALID_TAPO_EXPORT_FIELD",
      `${field} must be a non-empty string of at most ${maximum} characters`,
    );
  }
  return normalized;
}

function normalizedSha256(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_FIELD", `${field} must be a lowercase SHA-256 hex digest`);
  }
  return normalized;
}

/** Opaque stable key prevents old-location weather entering a new calibration. */
export function outdoorLocationKey(location?: HouseLocation): string {
  if (!location) return "unlocated";
  const normalized = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
  return `geo:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export class ClimateDatabase {
  readonly db: DatabaseSync;
  #transactionDepth = 0;

  constructor(path: string, seed = true) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
    const realDataMode = this.isRealDataMode();
    // Never seed a database that has crossed the one-way boundary, including
    // partially restored databases whose seed metadata is missing.
    if (seed && !realDataMode) this.seed();
    if (realDataMode) this.purgeSourceLabelledDemoTelemetry();
    this.backfillLegacyMeasurements();
    if (seed && !realDataMode) this.backfillSeedOutdoorTemperature();
    // A persisted real-data latch is authoritative even if a database was
    // modified outside the application while it was stopped.
    if (this.isRealDataMode()) this.purgeSourceLabelledDemoTelemetry();
  }

  isRealDataMode(): boolean {
    return (this.db.prepare("SELECT value FROM metadata WHERE key = 'data_mode'").get() as { value: string } | undefined)?.value === "real";
  }

  realDataModeActivatedAt(): string | null {
    if (!this.isRealDataMode()) return null;
    return (this.db.prepare("SELECT value FROM metadata WHERE key = 'real_data_mode_activated_at'").get() as { value: string } | undefined)?.value ?? null;
  }

  mockScenarioId(): string | null {
    return (this.db.prepare("SELECT value FROM metadata WHERE key = 'mock_scenario_id'").get() as { value: string } | undefined)?.value ?? null;
  }

  recordSecurityAuditEvent(input: SecurityAuditEventInput): SecurityAuditEvent {
    const subjectId = input.subjectId.trim();
    if (!subjectId || subjectId.length > 512) throw new Error("Security audit subject id must contain 1 to 512 characters");
    if (input.actorUserId !== null && (!input.actorUserId.trim() || input.actorUserId.length > 200)) {
      throw new Error("Security audit actor id must contain 1 to 200 characters when present");
    }
    const details = input.details ?? {};
    const entries = Object.entries(details);
    if (entries.length > 32 || entries.some(([key, value]) => (
      !key || key.length > 80
      || (typeof value === "string" && value.length > 512)
      || (value !== null && !["string", "number", "boolean"].includes(typeof value))
      || (typeof value === "number" && !Number.isFinite(value))
    ))) {
      throw new Error("Security audit details must contain at most 32 bounded scalar fields");
    }
    const detailsJson = JSON.stringify(details);
    if (Buffer.byteLength(detailsJson, "utf8") > 8_192) throw new Error("Security audit details exceed 8 KiB");
    const event: SecurityAuditEvent = {
      id: randomUUID(),
      eventType: input.eventType,
      outcome: input.outcome ?? "succeeded",
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      subjectType: input.subjectType,
      subjectId,
      details,
      createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO security_audit_events
      (id, event_type, outcome, actor_user_id, actor_role, subject_type, subject_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.eventType, event.outcome, event.actorUserId, event.actorRole, event.subjectType,
        event.subjectId, detailsJson, event.createdAt);
    return event;
  }

  listSecurityAuditEvents(limit = 100, offset = 0): SecurityAuditEvent[] {
    const rows = this.db.prepare(`SELECT id, event_type, outcome, actor_user_id, actor_role,
        subject_type, subject_id, details_json, created_at
      FROM security_audit_events ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(boundedCollectionLimit(limit), boundedCollectionOffset(offset)) as unknown as SecurityAuditEventRow[];
    return rows.map(securityAuditEventFromRow);
  }

  setMockScenarioId(scenario: string): void {
    this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('mock_scenario_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(scenario);
  }

  /** Stable identity used only to checkpoint this SQLite telemetry buffer. */
  telemetryArchiveSourceId(): string {
    const key = "telemetry_archive_source_id";
    const existing = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    if (existing?.value) return existing.value;
    const sourceId = randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)").run(key, sourceId);
    return (this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string }).value;
  }

  getIntegrationMappingSet<T>(kind: IntegrationMappingKind): IntegrationMappingSet<T> | null {
    const row = this.db.prepare("SELECT * FROM integration_mapping_sets WHERE kind = ?")
      .get(kind) as unknown as IntegrationMappingSetRow | undefined;
    if (!row) return null;
    let mappings: unknown;
    try {
      mappings = parseJson<unknown>(row.mappings_json);
    } catch {
      throw new Error(`Stored ${kind} integration mappings contain invalid JSON`);
    }
    if (!Array.isArray(mappings)) throw new Error(`Stored ${kind} integration mappings are not an array`);
    const canonicalJson = canonicalIntegrationMappingsJson(mappings);
    if (canonicalJson !== row.mappings_json) throw new Error(`Stored ${kind} integration mappings are not canonical`);
    const actualHash = createHash("sha256").update(row.mappings_json).digest("hex");
    if (actualHash !== row.content_hash) throw new Error(`Stored ${kind} integration mapping hash does not match its content`);
    return {
      kind: row.kind,
      contentHash: row.content_hash,
      revision: row.revision,
      mappings: mappings as T[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Atomically imports a complete validated mapping set; identical content is a no-op. */
  saveIntegrationMappingSet<T>(kind: IntegrationMappingKind, mappings: readonly T[]): IntegrationMappingSet<T> {
    if (kind !== "home-assistant" && kind !== "tp-link") throw new Error("Unsupported integration mapping kind");
    if (!Array.isArray(mappings)) throw new Error("Integration mappings must be an array");
    const mappingsJson = canonicalIntegrationMappingsJson(mappings);
    const contentHash = createHash("sha256").update(mappingsJson).digest("hex");
    return this.immediateTransaction(() => {
      // Read the raw row here instead of the strict getter so a valid source
      // file can repair malformed JSON, a mismatched hash, or old ordering.
      const current = this.db.prepare("SELECT * FROM integration_mapping_sets WHERE kind = ?")
        .get(kind) as unknown as IntegrationMappingSetRow | undefined;
      if (current?.content_hash === contentHash && current.mappings_json === mappingsJson) {
        return this.getIntegrationMappingSet<T>(kind)!;
      }
      const timestamp = new Date().toISOString();
      this.db.prepare(`INSERT INTO integration_mapping_sets
        (kind, content_hash, revision, mappings_json, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT(kind) DO UPDATE SET
          content_hash = excluded.content_hash,
          revision = CASE WHEN integration_mapping_sets.revision >= 1
            THEN integration_mapping_sets.revision + 1 ELSE 1 END,
          mappings_json = excluded.mappings_json,
          updated_at = excluded.updated_at`)
        .run(kind, contentHash, mappingsJson, timestamp, timestamp);
      return this.getIntegrationMappingSet<T>(kind)!;
    });
  }

  telemetryArchiveCheckpoint(table: TelemetryArchiveTable): number {
    const key = `telemetry_archive_checkpoint:${table}`;
    const value = (this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined)?.value;
    const parsed = Number(value ?? 0);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  saveTelemetryArchiveCheckpoint(table: TelemetryArchiveTable, rowId: number): void {
    if (!Number.isSafeInteger(rowId) || rowId < 0) throw new RangeError("Telemetry archive checkpoint is invalid");
    const current = this.telemetryArchiveCheckpoint(table);
    if (rowId <= current) return;
    this.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(`telemetry_archive_checkpoint:${table}`, String(rowId));
  }

  telemetryArchiveDirtyCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM telemetry_archive_dirty_rows")
      .get() as { count: number }).count);
  }

  telemetryArchiveWatermarks(): TelemetryArchiveWatermarks {
    return {
      measurement_samples: this.telemetryArchiveCheckpoint("measurement_samples"),
      legacy_readings: this.telemetryArchiveCheckpoint("legacy_readings"),
      outdoor_temperature_samples: this.telemetryArchiveCheckpoint("outdoor_temperature_samples"),
    };
  }

  /**
   * Permanently latches this database into real-data mode and removes every
   * persisted value that could have been produced by the demo runtime.
   */
  activateRealDataMode(): DemoTelemetryPurgeResult {
    return this.immediateTransaction(() => {
      const currentMode = (this.db.prepare("SELECT value FROM metadata WHERE key = 'data_mode'").get() as { value: string } | undefined)?.value;
      const existingActivatedAt = (this.db.prepare(
        "SELECT value FROM metadata WHERE key = 'real_data_mode_activated_at'",
      ).get() as { value: string } | undefined)?.value;
      if (currentMode === "real") {
        const activatedAt = existingActivatedAt ?? new Date().toISOString();
        if (!existingActivatedAt) {
          this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('real_data_mode_activated_at', ?)").run(activatedAt);
        }
        return {
          activated: false,
          activatedAt,
          readings: 0,
          measurementSamples: 0,
          outdoorTemperatureSamples: 0,
          alertEvents: 0,
        };
      }

      const activatedAt = existingActivatedAt ?? new Date().toISOString();
      const measurementSamples = Number(this.db.prepare(
        "DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')",
      ).run().changes);
      const readings = Number(this.db.prepare(
        "DELETE FROM readings WHERE source IN ('mock', 'replay')",
      ).run().changes);
      const outdoorTemperatureSamples = Number(this.db.prepare(
        "DELETE FROM outdoor_temperature_samples WHERE source = 'mock'",
      ).run().changes);
      // Alert events have no source column. Clear them at the one-way boundary
      // so an event or active condition derived from mock samples cannot cross it.
      const alertEvents = Number(this.db.prepare("DELETE FROM alert_events").run().changes);
      this.db.prepare("DELETE FROM alert_evaluation_state").run();
      this.db.prepare(`INSERT INTO metadata(key, value) VALUES ('data_mode', 'real')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
      this.db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES ('real_data_mode_activated_at', ?)").run(activatedAt);
      return { activated: true, activatedAt, readings, measurementSamples, outdoorTemperatureSamples, alertEvents };
    });
  }

  private purgeSourceLabelledDemoTelemetry(): void {
    this.immediateTransaction(() => {
      this.db.prepare("DELETE FROM measurement_samples WHERE source IN ('mock', 'replay')").run();
      this.db.prepare("DELETE FROM readings WHERE source IN ('mock', 'replay')").run();
      this.db.prepare("DELETE FROM outdoor_temperature_samples WHERE source = 'mock'").run();
    });
  }

  private prepareTelemetrySources(sources: Array<MeasurementSample["source"] | Reading["source"]>): void {
    const hasDemo = sources.some((source) => DEMO_TELEMETRY_SOURCES.has(source));
    const hasReal = sources.some((source) => !DEMO_TELEMETRY_SOURCES.has(source));
    if (hasDemo && hasReal) {
      throw new ClimateDataValidationError(409, "MIXED_DATA_MODES", "Demo and real telemetry cannot be ingested in the same batch");
    }
    if (hasDemo && this.isRealDataMode()) {
      throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Demo telemetry is permanently disabled after a real integration or real sample is accepted");
    }
    if (hasReal && !this.isRealDataMode()) this.activateRealDataMode();
  }

  migrate(): void {
    this.immediateTransaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_mapping_sets (
        kind TEXT PRIMARY KEY CHECK (length(trim(kind)) > 0),
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        mappings_json TEXT NOT NULL CHECK (json_valid(mappings_json) AND json_type(mappings_json) = 'array'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retired_telemetry_resource_ids (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('property', 'house', 'sensor')),
        resource_id TEXT NOT NULL,
        retired_at TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id)
      );
      CREATE TABLE IF NOT EXISTS telemetry_archive_row_ids (
        archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL CHECK (table_name IN ('outdoor_temperature_samples', 'electricity_price_samples')),
        natural_key TEXT NOT NULL,
        UNIQUE (table_name, natural_key)
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_archive_row_ids_page
        ON telemetry_archive_row_ids(table_name, archive_id);
      CREATE TABLE IF NOT EXISTS telemetry_archive_dirty_rows (
        dirty_id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL CHECK (table_name IN ('legacy_readings', 'outdoor_temperature_samples', 'electricity_price_samples')),
        natural_key TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        UNIQUE (table_name, natural_key)
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_archive_dirty_rows_page
        ON telemetry_archive_dirty_rows(table_name, dirty_id);
      CREATE TABLE IF NOT EXISTS local_auth_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_n INTEGER NOT NULL CHECK (password_n >= 16384),
        password_r INTEGER NOT NULL CHECK (password_r >= 8),
        password_p INTEGER NOT NULL CHECK (password_p >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_workspace_members (
        user_id TEXT PRIMARY KEY REFERENCES local_auth_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
        joined_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_workspace_invitations (
        email TEXT PRIMARY KEY COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
        invited_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        invited_by_user_id TEXT REFERENCES local_auth_users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS local_guest_access_grants (
        subject_type TEXT NOT NULL CHECK (subject_type IN ('member', 'invitation')),
        subject_key TEXT NOT NULL COLLATE NOCASE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('property', 'house', 'area')),
        scope_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subject_type, subject_key, scope_type, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_local_guest_access_subject
        ON local_guest_access_grants(subject_type, subject_key);
      CREATE TABLE IF NOT EXISTS local_auth_sessions (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        user_id TEXT NOT NULL REFERENCES local_auth_users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_auth_sessions_user
        ON local_auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_local_auth_sessions_expiry
        ON local_auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS properties (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        description TEXT,
        location_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS property_electricity_configs (
        property_id TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('porssisahko', 'custom')),
        endpoint_url TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        margin_cents_per_kwh REAL NOT NULL DEFAULT 0,
        contract_type TEXT NOT NULL CHECK (contract_type IN ('spot', 'fixed', 'other')),
        contract_name TEXT,
        retailer TEXT,
        monthly_fee_eur REAL CHECK (monthly_fee_eur IS NULL OR monthly_fee_eur >= 0),
        last_fetched_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS electricity_price_points (
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        raw_price_cents_per_kwh REAL NOT NULL,
        margin_cents_per_kwh REAL NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (property_id, start_at)
      );
      CREATE INDEX IF NOT EXISTS idx_electricity_price_property_end
        ON electricity_price_points(property_id, end_at);
      CREATE TABLE IF NOT EXISTS houses (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        location_json TEXT,
        map_placement_json TEXT,
        orientation_degrees REAL CHECK (orientation_degrees >= 0 AND orientation_degrees < 360),
        floors_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS opening_state_observations (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown')),
        open_fraction REAL CHECK (open_fraction IS NULL OR (open_fraction >= 0 AND open_fraction <= 1)),
        source TEXT NOT NULL CHECK (source IN ('manual', 'home-assistant', 'tapo', 'api')),
        observed_at TEXT NOT NULL,
        valid_until TEXT,
        external_id TEXT,
        connection_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opening_state_house_element_time
        ON opening_state_observations(house_id, floor_id, element_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opening_state_external_time
        ON opening_state_observations(source, external_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS property_areas (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        kind TEXT NOT NULL CHECK (kind IN (
          'well', 'beach', 'garage', 'plantation', 'garden', 'field', 'forest', 'shoreline', 'dock', 'road',
          'yard', 'building', 'other'
        )),
        description TEXT,
        location_json TEXT,
        polygon_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(property_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_property_areas_property_name
        ON property_areas(property_id, name, id);
      CREATE TRIGGER IF NOT EXISTS delete_property_guest_grants
        AFTER DELETE ON properties BEGIN
          DELETE FROM local_guest_access_grants WHERE scope_type = 'property' AND scope_id = OLD.id;
        END;
      CREATE TRIGGER IF NOT EXISTS delete_house_guest_grants
        AFTER DELETE ON houses BEGIN
          DELETE FROM local_guest_access_grants WHERE scope_type = 'house' AND scope_id = OLD.id;
        END;
      CREATE TRIGGER IF NOT EXISTS delete_area_guest_grants
        AFTER DELETE ON property_areas BEGIN
          DELETE FROM local_guest_access_grants WHERE scope_type = 'area' AND scope_id = OLD.id;
        END;
      CREATE TABLE IF NOT EXISTS area_equipment (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        area_id TEXT NOT NULL REFERENCES property_areas(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
        manufacturer TEXT,
        model TEXT,
        serial_number TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'out-of-service', 'retired')),
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_area_equipment_property_area_name
        ON area_equipment(property_id, area_id, name, id);
      CREATE INDEX IF NOT EXISTS idx_area_equipment_area_name
        ON area_equipment(area_id, name, id);
      CREATE TABLE IF NOT EXISTS property_notes (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
        area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
        equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('note', 'inspection', 'maintenance')),
        text TEXT NOT NULL CHECK (length(trim(text)) > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_property_notes_property_updated
        ON property_notes(property_id, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_property_notes_house_updated
        ON property_notes(house_id, updated_at DESC, id) WHERE house_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_property_notes_area_updated
        ON property_notes(area_id, updated_at DESC, id) WHERE area_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_property_notes_equipment_updated
        ON property_notes(equipment_id, updated_at DESC, id) WHERE equipment_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS sensors (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        name TEXT NOT NULL,
        room_id TEXT,
        room TEXT NOT NULL,
        model TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        temperature_entity_id TEXT,
        humidity_entity_id TEXT,
        battery_entity_id TEXT,
        tp_link_device_id TEXT,
        tp_link_connection_id TEXT,
        measurement_entity_ids_json TEXT,
        tags_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        temperature REAL NOT NULL,
        humidity REAL NOT NULL,
        battery REAL,
        source TEXT NOT NULL,
        quality TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_readings_sensor_time_id
        ON readings(sensor_id, timestamp DESC, id DESC);
      DROP INDEX IF EXISTS idx_readings_sensor_time;
      CREATE INDEX IF NOT EXISTS idx_readings_time
        ON readings(timestamp, id);
      CREATE TABLE IF NOT EXISTS measurement_definitions (
        id TEXT PRIMARY KEY,
        labels_json TEXT NOT NULL,
        unit TEXT NOT NULL,
        dimension TEXT NOT NULL DEFAULT 'finite_scalar',
        allowed_units_json TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'gauge',
        default_aggregation TEXT NOT NULL DEFAULT 'mean',
        generic_history_enabled INTEGER NOT NULL DEFAULT 1 CHECK (generic_history_enabled IN (0, 1)),
        generic_stats_enabled INTEGER NOT NULL DEFAULT 1 CHECK (generic_stats_enabled IN (0, 1)),
        precision INTEGER NOT NULL,
        valid_min REAL,
        valid_max REAL,
        display_min REAL,
        display_max REAL,
        interpolation_delta REAL NOT NULL,
        color_scale TEXT NOT NULL,
        builtin INTEGER NOT NULL CHECK (builtin IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        spatial_interpolation INTEGER NOT NULL CHECK (spatial_interpolation IN (0, 1)),
        forecast_supported INTEGER NOT NULL CHECK (forecast_supported IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS measurement_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id),
        value REAL NOT NULL,
        canonical_unit TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        quality TEXT NOT NULL,
        UNIQUE(sensor_id, metric, timestamp, source)
      );
      CREATE INDEX IF NOT EXISTS idx_measurement_samples_sensor_metric_time
        ON measurement_samples(sensor_id, metric, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_measurement_samples_time
        ON measurement_samples(timestamp, id);
      CREATE TABLE IF NOT EXISTS sensor_measurement_bindings (
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id),
        entity_id TEXT NOT NULL,
        PRIMARY KEY(sensor_id, metric)
      );
      CREATE INDEX IF NOT EXISTS idx_sensor_measurement_bindings_entity
        ON sensor_measurement_bindings(entity_id);
      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sensor_id TEXT REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        severity TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        webhook_enabled INTEGER NOT NULL,
        telegram_enabled INTEGER NOT NULL DEFAULT 0,
        delivery_policy_json TEXT NOT NULL DEFAULT '{}',
        retired_at TEXT
      );
      CREATE TABLE IF NOT EXISTS alert_events (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        threshold REAL NOT NULL,
        severity TEXT NOT NULL,
        started_at TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alert_events_started ON alert_events(started_at DESC);
      CREATE TABLE IF NOT EXISTS alert_evaluation_state (
        rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        latest_timestamp TEXT NOT NULL,
        condition_since TEXT,
        PRIMARY KEY(rule_id, sensor_id)
      );
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL DEFAULT 'alert' CHECK(subject_kind IN ('alert', 'maintenance', 'action-run')),
        subject_id TEXT NOT NULL,
        event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT,
        stage TEXT NOT NULL DEFAULT 'initial' CHECK(stage IN ('initial', 'escalation', 'reminder', 'due', 'verification')),
        sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0),
        channel TEXT NOT NULL CHECK(channel IN ('webhook', 'telegram')),
        destination_id TEXT NOT NULL DEFAULT 'primary',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 8 CHECK(max_attempts BETWEEN 1 AND 100),
        available_at TEXT NOT NULL,
        locked_at TEXT,
        lock_token TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        payload_json TEXT NOT NULL,
        destination_ref TEXT NOT NULL,
        policy_json TEXT NOT NULL DEFAULT '{}',
        dead_lettered_at TEXT,
        abandoned_at TEXT,
        UNIQUE(subject_kind, subject_id, stage, sequence, channel, destination_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        sensor_id TEXT REFERENCES sensors(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        note TEXT NOT NULL,
        x REAL,
        y REAL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        time_precision TEXT NOT NULL DEFAULT 'exact'
          CHECK (time_precision IN ('exact', 'approximate', 'date-only', 'date-range', 'unknown')),
        valid_from TEXT,
        valid_to TEXT,
        source TEXT NOT NULL DEFAULT 'unknown'
          CHECK (source IN ('owner', 'caretaker', 'contractor', 'sensor', 'imported-document', 'automated-analysis', 'unknown')),
        source_detail TEXT,
        confidence TEXT NOT NULL DEFAULT 'uncertain'
          CHECK (confidence IN ('confirmed', 'probable', 'uncertain', 'awaiting-inspection')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        resolution_note TEXT,
        resolved_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'open' AND resolution_note IS NULL AND resolved_at IS NULL)
          OR
          (status = 'resolved' AND resolution_note IS NOT NULL AND length(trim(resolution_note)) > 0 AND resolved_at IS NOT NULL)
        )
      );
      CREATE TRIGGER IF NOT EXISTS validate_observation_floor_insert
        BEFORE INSERT ON observations
        WHEN NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS validate_observation_floor_update
        BEFORE UPDATE OF house_id, floor_id ON observations
        WHEN NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS validate_observation_bounds_insert
        BEFORE INSERT ON observations
        WHEN NEW.x IS NOT NULL AND NEW.y IS NOT NULL AND EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
            AND (NEW.x < 0 OR NEW.x > CAST(json_extract(floor.value, '$.width') AS REAL)
              OR NEW.y < 0 OR NEW.y > CAST(json_extract(floor.value, '$.height') AS REAL))
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_OUT_OF_BOUNDS'); END;
      CREATE TRIGGER IF NOT EXISTS validate_observation_bounds_update
        BEFORE UPDATE OF house_id, floor_id, x, y ON observations
        WHEN NEW.x IS NOT NULL AND NEW.y IS NOT NULL AND EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
            AND (NEW.x < 0 OR NEW.x > CAST(json_extract(floor.value, '$.width') AS REAL)
              OR NEW.y < 0 OR NEW.y > CAST(json_extract(floor.value, '$.height') AS REAL))
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_OUT_OF_BOUNDS'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_house_floor_orphaned_observation
        BEFORE UPDATE OF floors_json ON houses
        WHEN NEW.floors_json <> OLD.floors_json AND EXISTS (
          SELECT 1 FROM observations AS observation
          WHERE observation.house_id = OLD.id
            AND NOT EXISTS (
              SELECT 1 FROM json_each(NEW.floors_json) AS floor
              WHERE json_extract(floor.value, '$.id') = observation.floor_id
            )
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_OBSERVATION'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_house_floor_excluded_observation
        BEFORE UPDATE OF floors_json ON houses
        WHEN NEW.floors_json <> OLD.floors_json AND EXISTS (
          SELECT 1 FROM observations AS observation
          JOIN json_each(NEW.floors_json) AS floor
            ON json_extract(floor.value, '$.id') = observation.floor_id
          WHERE observation.house_id = OLD.id
            AND observation.x IS NOT NULL AND observation.y IS NOT NULL
            AND (observation.x < 0 OR observation.x > CAST(json_extract(floor.value, '$.width') AS REAL)
              OR observation.y < 0 OR observation.y > CAST(json_extract(floor.value, '$.height') AS REAL))
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_EXCLUDES_OBSERVATION'); END;
      CREATE TABLE IF NOT EXISTS observation_revisions (
        observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        changed_at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service')),
        changed_fields_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (observation_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_observation_revisions_changed
        ON observation_revisions(observation_id, changed_at, revision);
      CREATE TRIGGER IF NOT EXISTS prevent_observation_revision_insert_collision
        BEFORE INSERT ON observation_revisions
        WHEN EXISTS (
          SELECT 1 FROM observation_revisions
          WHERE observation_id = NEW.observation_id AND revision = NEW.revision
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_observation_revision_update
        BEFORE UPDATE ON observation_revisions
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_observation_revision_delete
        BEFORE DELETE ON observation_revisions
        WHEN EXISTS (SELECT 1 FROM observations WHERE id = OLD.observation_id)
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TABLE IF NOT EXISTS maintenance_tasks (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
        floor_id TEXT,
        area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
        equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT,
        basis TEXT NOT NULL CHECK (basis IN ('required', 'scheduled', 'condition-based', 'predictive', 'optional-improvement')),
        basis_detail TEXT,
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        planned_for TEXT,
        due_by TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'in-progress', 'completed', 'verified', 'cancelled')),
        completion_note TEXT,
        completed_at TEXT,
        verification_note TEXT,
        verified_at TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (planned_for IS NULL OR due_by IS NULL OR planned_for <= due_by),
        CHECK (basis <> 'predictive' OR due_by IS NULL),
        CHECK (
          (status IN ('planned', 'in-progress', 'cancelled')
            AND completion_note IS NULL AND completed_at IS NULL
            AND verification_note IS NULL AND verified_at IS NULL)
          OR
          (status = 'completed'
            AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
            AND verification_note IS NULL AND verified_at IS NULL)
          OR
          (status = 'verified'
            AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
            AND verification_note IS NOT NULL AND length(trim(verification_note)) > 0 AND verified_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_house_schedule
        ON maintenance_tasks(house_id, status, planned_for, due_by, updated_at DESC);
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_insert
        BEFORE INSERT ON maintenance_tasks
        WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_update
        BEFORE UPDATE OF floor_id, house_id ON maintenance_tasks
        WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_house_floor_orphaned_maintenance
        BEFORE UPDATE OF floors_json ON houses
        WHEN EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          WHERE task.house_id = OLD.id AND task.floor_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM json_each(NEW.floors_json) AS floor
              WHERE json_extract(floor.value, '$.id') = task.floor_id
            )
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_MAINTENANCE_TASK'); END;
      CREATE TABLE IF NOT EXISTS maintenance_task_observations (
        maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
        observation_id TEXT NOT NULL,
        PRIMARY KEY (maintenance_task_id, observation_id),
        FOREIGN KEY (observation_id) REFERENCES observations(id)
          ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_task_observations_observation
        ON maintenance_task_observations(observation_id, maintenance_task_id);
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_insert
        BEFORE INSERT ON maintenance_task_observations
        WHEN NOT EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          JOIN observations AS observation ON observation.id = NEW.observation_id
          WHERE task.id = NEW.maintenance_task_id
            AND task.house_id = observation.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_update
        BEFORE UPDATE OF maintenance_task_id, observation_id ON maintenance_task_observations
        WHEN NOT EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          JOIN observations AS observation ON observation.id = NEW.observation_id
          WHERE task.id = NEW.maintenance_task_id
            AND task.house_id = observation.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_linked_maintenance_task_house_update
        BEFORE UPDATE OF house_id ON maintenance_tasks
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_observations AS link
          JOIN observations AS observation ON observation.id = link.observation_id
          WHERE link.maintenance_task_id = OLD.id
            AND observation.house_id <> NEW.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_linked_observation_house_update
        BEFORE UPDATE OF house_id ON observations
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_observations AS link
          JOIN maintenance_tasks AS task ON task.id = link.maintenance_task_id
          WHERE link.observation_id = OLD.id
            AND task.house_id <> NEW.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TABLE IF NOT EXISTS maintenance_task_revisions (
        maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        changed_at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service')),
        changed_fields_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (maintenance_task_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_task_revisions_changed
        ON maintenance_task_revisions(maintenance_task_id, changed_at, revision);
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_insert_collision
        BEFORE INSERT ON maintenance_task_revisions
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_revisions
          WHERE maintenance_task_id = NEW.maintenance_task_id AND revision = NEW.revision
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_update
        BEFORE UPDATE ON maintenance_task_revisions
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_delete
        BEFORE DELETE ON maintenance_task_revisions
        WHEN EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = OLD.maintenance_task_id)
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TABLE IF NOT EXISTS static_parameters (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        unit TEXT,
        label TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_parameters_scope_key
        ON static_parameters(house_id, scope_type, scope_id, key);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        data BLOB NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outdoor_temperature_samples (
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        location_key TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        temperature_c REAL NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        station_id TEXT,
        station_name TEXT,
        conditions_json TEXT,
        PRIMARY KEY(house_id, location_key, timestamp, source)
      );
      CREATE INDEX IF NOT EXISTS idx_outdoor_temperature_house_location_time
        ON outdoor_temperature_samples(house_id, location_key, timestamp);
      CREATE TABLE IF NOT EXISTS weather_outages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        location_key TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('fmi', 'open-meteo')),
        component TEXT NOT NULL CHECK (component IN ('service', 'observation', 'forecast', 'short-range', 'warnings')),
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at TEXT,
        last_error TEXT NOT NULL,
        backfill_state TEXT NOT NULL CHECK (backfill_state IN (
          'not-needed', 'pending', 'running', 'complete', 'partial', 'failed', 'not-supported'
        )),
        backfill_from TEXT,
        backfill_to TEXT,
        recovered_points INTEGER NOT NULL DEFAULT 0 CHECK (recovered_points >= 0),
        last_attempt_at TEXT,
        backfill_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_weather_outages_one_open_component
        ON weather_outages(house_id, location_key, provider, component) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_weather_outages_house_location_started
        ON weather_outages(house_id, location_key, started_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS sensor_data_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('home-assistant', 'tp-link')),
        started_at TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        ended_at TEXT,
        recovery_state TEXT NOT NULL CHECK (recovery_state IN (
          'open', 'pending', 'running', 'complete', 'partial', 'failed', 'not-supported'
        )),
        recovered_points INTEGER NOT NULL DEFAULT 0 CHECK (recovered_points >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        recovery_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_data_gaps_one_open_metric
        ON sensor_data_gaps(sensor_id, metric, source) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sensor_data_gaps_recovery_queue
        ON sensor_data_gaps(recovery_state, next_attempt_at, id);
      CREATE INDEX IF NOT EXISTS idx_sensor_data_gaps_sensor_started
        ON sensor_data_gaps(sensor_id, started_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS tapo_history_export_jobs (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE CHECK (length(trim(dedupe_key)) BETWEEN 1 AND 500),
        provider TEXT NOT NULL CHECK (provider IN ('appium', 'private-cloud')),
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        expected_device_id TEXT NOT NULL CHECK (length(trim(expected_device_id)) BETWEEN 1 AND 500),
        device_name TEXT NOT NULL CHECK (length(trim(device_name)) BETWEEN 1 AND 500),
        time_zone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(trim(time_zone)) BETWEEN 1 AND 100),
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
        expected_recipient TEXT COLLATE NOCASE CHECK (
          expected_recipient IS NULL OR length(trim(expected_recipient)) BETWEEN 3 AND 320
        ),
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 525600),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'claimed', 'running', 'waiting-email', 'needs-attention', 'completed', 'failed', 'cancelled'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        submitted_at TEXT,
        deployment_fingerprint TEXT CHECK (
          deployment_fingerprint IS NULL OR length(deployment_fingerprint) = 64
        ),
        acceptance_revision TEXT CHECK (
          acceptance_revision IS NULL OR length(acceptance_revision) = 64
        ),
        mailbox_message_id TEXT,
        source_artifact_sha256 TEXT CHECK (
          source_artifact_sha256 IS NULL OR length(source_artifact_sha256) = 64
        ),
        source_artifact_bytes INTEGER CHECK (source_artifact_bytes IS NULL OR source_artifact_bytes >= 0),
        parser_version TEXT CHECK (parser_version IS NULL OR length(trim(parser_version)) BETWEEN 1 AND 100),
        source_schema_signature TEXT CHECK (
          source_schema_signature IS NULL OR length(source_schema_signature) = 64
        ),
        expected_schema_signature TEXT CHECK (
          expected_schema_signature IS NULL OR length(expected_schema_signature) = 64
        ),
        staged_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (staged_sample_count >= 0),
        consumed_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (consumed_sample_count >= 0),
        last_error TEXT,
        attention_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (range_start < range_end),
        CHECK ((lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
        CHECK (consumed_sample_count <= staged_sample_count)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tapo_history_export_mailbox_message
        ON tapo_history_export_jobs(mailbox_message_id) WHERE mailbox_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_queue
        ON tapo_history_export_jobs(status, available_at, lease_expires_at, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_sensor_range
        ON tapo_history_export_jobs(sensor_id, range_start, range_end, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_retention
        ON tapo_history_export_jobs(status, completed_at, updated_at, dedupe_key);
      CREATE TABLE IF NOT EXISTS tapo_history_canary_approvals (
        deployment_fingerprint TEXT NOT NULL CHECK (length(deployment_fingerprint) = 64),
        canary_job_id TEXT NOT NULL REFERENCES tapo_history_export_jobs(id) ON DELETE CASCADE,
        acceptance_revision TEXT NOT NULL CHECK (length(acceptance_revision) = 64),
        schema_signature TEXT NOT NULL CHECK (length(schema_signature) = 64),
        approved_at TEXT NOT NULL,
        PRIMARY KEY (deployment_fingerprint, canary_job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tapo_history_canary_approvals_approved
        ON tapo_history_canary_approvals(approved_at, deployment_fingerprint);
      CREATE TABLE IF NOT EXISTS tapo_history_export_staged_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES tapo_history_export_jobs(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
        value REAL NOT NULL,
        canonical_unit TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tp-link' CHECK (source = 'tp-link'),
        quality TEXT NOT NULL CHECK (quality IN ('good', 'estimated', 'stale')),
        source_identity TEXT NOT NULL CHECK (length(trim(source_identity)) BETWEEN 1 AND 1000),
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        UNIQUE(job_id, metric, source_identity)
      );
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_staged_lookup
        ON tapo_history_export_staged_samples(sensor_id, metric, timestamp, consumed_at, id);
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_staged_job
        ON tapo_history_export_staged_samples(job_id, consumed_at, id);
      INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
        SELECT 'outdoor_temperature_samples', json_array(house_id, location_key, timestamp, source)
        FROM outdoor_temperature_samples ORDER BY timestamp, house_id, location_key, source;
      INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
        SELECT 'electricity_price_samples', json_array(property_id, start_at)
        FROM electricity_price_points ORDER BY start_at, property_id;
      -- Outdoor/electricity paging originally used SQLite's implicit rowid.
      -- Rewind only those local cursors once when adopting explicit monotonic
      -- IDs so every existing natural key is replayed idempotently.
      DELETE FROM metadata
      WHERE key IN (
        'telemetry_archive_checkpoint:outdoor_temperature_samples',
        'telemetry_archive_checkpoint:electricity_price_samples'
      )
        AND COALESCE((SELECT value FROM metadata
          WHERE key = 'telemetry_archive_cursor_format'), '') <> 'explicit-archive-id-v1';
      INSERT INTO metadata(key, value)
        VALUES ('telemetry_archive_cursor_format', 'explicit-archive-id-v1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_insert
        AFTER INSERT ON outdoor_temperature_samples BEGIN
          INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
          VALUES ('outdoor_temperature_samples', json_array(NEW.house_id, NEW.location_key, NEW.timestamp, NEW.source));
        END;
      CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_delete
        AFTER DELETE ON outdoor_temperature_samples BEGIN
          DELETE FROM telemetry_archive_row_ids
          WHERE table_name = 'outdoor_temperature_samples'
            AND natural_key = json_array(OLD.house_id, OLD.location_key, OLD.timestamp, OLD.source);
          DELETE FROM telemetry_archive_dirty_rows
          WHERE table_name = 'outdoor_temperature_samples'
            AND natural_key = json_array(OLD.house_id, OLD.location_key, OLD.timestamp, OLD.source);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_electricity_price_insert
        AFTER INSERT ON electricity_price_points BEGIN
          INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
          VALUES ('electricity_price_samples', json_array(NEW.property_id, NEW.start_at));
        END;
      CREATE TRIGGER IF NOT EXISTS archive_electricity_price_delete
        AFTER DELETE ON electricity_price_points BEGIN
          DELETE FROM telemetry_archive_row_ids
          WHERE table_name = 'electricity_price_samples'
            AND natural_key = json_array(OLD.property_id, OLD.start_at);
          DELETE FROM telemetry_archive_dirty_rows
          WHERE table_name = 'electricity_price_samples'
            AND natural_key = json_array(OLD.property_id, OLD.start_at);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_legacy_reading_delete
        AFTER DELETE ON readings BEGIN
          DELETE FROM telemetry_archive_dirty_rows
          WHERE table_name = 'legacy_readings'
            AND natural_key = json_array(OLD.sensor_id, OLD.timestamp, OLD.source);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_legacy_reading_update
        AFTER UPDATE ON readings BEGIN
          INSERT INTO telemetry_archive_dirty_rows(table_name, natural_key, changed_at)
          VALUES ('legacy_readings', json_array(NEW.sensor_id, NEW.timestamp, NEW.source),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(table_name, natural_key) DO UPDATE SET
            changed_at = excluded.changed_at, version = telemetry_archive_dirty_rows.version + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_update
        AFTER UPDATE ON outdoor_temperature_samples BEGIN
          INSERT INTO telemetry_archive_dirty_rows(table_name, natural_key, changed_at)
          VALUES ('outdoor_temperature_samples',
            json_array(NEW.house_id, NEW.location_key, NEW.timestamp, NEW.source),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(table_name, natural_key) DO UPDATE SET
            changed_at = excluded.changed_at, version = telemetry_archive_dirty_rows.version + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS archive_electricity_price_update
        AFTER UPDATE ON electricity_price_points BEGIN
          INSERT INTO telemetry_archive_dirty_rows(table_name, natural_key, changed_at)
          VALUES ('electricity_price_samples', json_array(NEW.property_id, NEW.start_at),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(table_name, natural_key) DO UPDATE SET
            changed_at = excluded.changed_at, version = telemetry_archive_dirty_rows.version + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retire_property_telemetry_id
        AFTER DELETE ON properties BEGIN
          INSERT OR IGNORE INTO retired_telemetry_resource_ids(resource_type, resource_id, retired_at)
          VALUES ('property', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        END;
      CREATE TRIGGER IF NOT EXISTS retire_house_telemetry_id
        AFTER DELETE ON houses BEGIN
          INSERT OR IGNORE INTO retired_telemetry_resource_ids(resource_type, resource_id, retired_at)
          VALUES ('house', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        END;
      CREATE TRIGGER IF NOT EXISTS retire_sensor_telemetry_id
        AFTER DELETE ON sensors BEGIN
          INSERT OR IGNORE INTO retired_telemetry_resource_ids(resource_type, resource_id, retired_at)
          VALUES ('sensor', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        END;
      CREATE TRIGGER IF NOT EXISTS prevent_retired_property_telemetry_id
        BEFORE INSERT ON properties
        WHEN EXISTS (SELECT 1 FROM retired_telemetry_resource_ids WHERE resource_type = 'property' AND resource_id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'RETIRED_PROPERTY_ID'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_retired_house_telemetry_id
        BEFORE INSERT ON houses
        WHEN EXISTS (SELECT 1 FROM retired_telemetry_resource_ids WHERE resource_type = 'house' AND resource_id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'RETIRED_HOUSE_ID'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_retired_sensor_telemetry_id
        BEFORE INSERT ON sensors
        WHEN EXISTS (SELECT 1 FROM retired_telemetry_resource_ids WHERE resource_type = 'sensor' AND resource_id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'RETIRED_SENSOR_ID'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_insert_in_real_mode
        BEFORE INSERT ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_update_in_real_mode
        BEFORE UPDATE OF source ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_insert_in_real_mode
        BEFORE INSERT ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_update_in_real_mode
        BEFORE UPDATE OF source ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_outdoor_insert_in_real_mode
        BEFORE INSERT ON outdoor_temperature_samples
        WHEN NEW.source = 'mock'
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_outdoor_update_in_real_mode
        BEFORE UPDATE OF source ON outdoor_temperature_samples
        WHEN NEW.source = 'mock'
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      `);
      const orphanedMaintenanceRevision = this.db.prepare(`
        SELECT revision.maintenance_task_id, revision.revision
        FROM maintenance_task_revisions AS revision
        LEFT JOIN maintenance_tasks AS task ON task.id = revision.maintenance_task_id
        WHERE task.id IS NULL
        ORDER BY revision.maintenance_task_id, revision.revision
        LIMIT 1
      `).get() as { maintenance_task_id: string; revision: number } | undefined;
      if (orphanedMaintenanceRevision) {
        throw new Error(
          `ORPHANED_MAINTENANCE_REVISION: maintenance task ${orphanedMaintenanceRevision.maintenance_task_id} `
          + `is missing for revision ${orphanedMaintenanceRevision.revision}`,
        );
      }
      // Older builds allowed more than one unresolved row per rule/sensor.
      // Resolve all but the newest before enforcing the durable invariant.
      this.db.exec(`
        UPDATE alert_events AS candidate
        SET resolved_at = candidate.started_at
        WHERE candidate.resolved_at IS NULL AND EXISTS (
          SELECT 1 FROM alert_events AS newer
          WHERE newer.rule_id = candidate.rule_id
            AND newer.sensor_id = candidate.sensor_id
            AND newer.resolved_at IS NULL
            AND (newer.started_at > candidate.started_at
              OR (newer.started_at = candidate.started_at AND newer.id > candidate.id))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_events_one_active
          ON alert_events(rule_id, sensor_id) WHERE resolved_at IS NULL;
      `);
    const outdoorColumns = this.db.prepare("PRAGMA table_info(outdoor_temperature_samples)")
      .all() as unknown as Array<{ name: string }>;
    if (!outdoorColumns.some((column) => column.name === "conditions_json")) {
      this.db.exec("ALTER TABLE outdoor_temperature_samples ADD COLUMN conditions_json TEXT");
    }
    const electricityPriceColumns = this.db.prepare("PRAGMA table_info(electricity_price_points)")
      .all() as unknown as Array<{ name: string }>;
    if (!electricityPriceColumns.some((column) => column.name === "margin_cents_per_kwh")) {
      this.db.exec("ALTER TABLE electricity_price_points ADD COLUMN margin_cents_per_kwh REAL NOT NULL DEFAULT 0");
      this.db.exec(`UPDATE electricity_price_points
        SET margin_cents_per_kwh = COALESCE((SELECT config.margin_cents_per_kwh
          FROM property_electricity_configs AS config
          WHERE config.property_id = electricity_price_points.property_id), 0)`);
    }
    const openingStateColumns = this.db.prepare("PRAGMA table_info(opening_state_observations)")
      .all() as unknown as Array<{ name: string }>;
    if (!openingStateColumns.some((column) => column.name === "connection_id")) {
      this.db.exec("ALTER TABLE opening_state_observations ADD COLUMN connection_id TEXT");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_opening_state_source_time
        ON opening_state_observations(house_id, floor_id, element_id, source, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opening_state_provider_time
        ON opening_state_observations(house_id, floor_id, element_id, source, external_id, connection_id, observed_at DESC);
    `);
    const houseColumns = this.db.prepare("PRAGMA table_info(houses)").all() as unknown as Array<{ name: string }>;
    const migrationTimestamp = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO properties
      (id, name, description, location_json, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?)`)
      .run(DEFAULT_PROPERTY_ID, "My property", migrationTimestamp, migrationTimestamp);
    this.db.prepare(`INSERT OR IGNORE INTO property_electricity_configs
      (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
       contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
      SELECT id, 'porssisahko', ?, 1, 0, 'spot', NULL, NULL, NULL, NULL, NULL, ? FROM properties`)
      .run(DEFAULT_ELECTRICITY_PRICE_ENDPOINT, migrationTimestamp);
    if (!houseColumns.some((column) => column.name === "property_id")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN property_id TEXT REFERENCES properties(id) ON DELETE RESTRICT");
    }
    this.db.prepare(`UPDATE houses SET property_id = ?
      WHERE property_id IS NULL OR trim(property_id) = ''
        OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = houses.property_id)`)
      .run(DEFAULT_PROPERTY_ID);
    if (!houseColumns.some((column) => column.name === "location_json")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN location_json TEXT");
    }
    if (!houseColumns.some((column) => column.name === "map_placement_json")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN map_placement_json TEXT");
    }
    if (!houseColumns.some((column) => column.name === "orientation_degrees")) {
      this.db.exec("ALTER TABLE houses ADD COLUMN orientation_degrees REAL CHECK (orientation_degrees >= 0 AND orientation_degrees < 360)");
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_houses_property_name ON houses(property_id, name, id);
      DROP TRIGGER IF EXISTS require_house_property_insert;
      CREATE TRIGGER require_house_property_insert
        BEFORE INSERT ON houses WHEN NEW.property_id IS NULL OR trim(NEW.property_id) = ''
          OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = NEW.property_id)
        BEGIN SELECT RAISE(ABORT, 'HOUSE_PROPERTY_REQUIRED'); END;
      DROP TRIGGER IF EXISTS require_house_property_update;
      CREATE TRIGGER require_house_property_update
        BEFORE UPDATE OF property_id ON houses WHEN NEW.property_id IS NULL OR trim(NEW.property_id) = ''
          OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = NEW.property_id)
        BEGIN SELECT RAISE(ABORT, 'HOUSE_PROPERTY_REQUIRED'); END;
    `);
    const propertyAreaColumns = this.db.prepare("PRAGMA table_info(property_areas)").all() as unknown as Array<{ name: string }>;
    if (!propertyAreaColumns.some((column) => column.name === "location_json")) {
      this.db.exec("ALTER TABLE property_areas ADD COLUMN location_json TEXT");
    }
    const sensorColumns = this.db.prepare("PRAGMA table_info(sensors)").all() as unknown as Array<{ name: string }>;
    if (!sensorColumns.some((column) => column.name === "measurement_entity_ids_json")) {
      this.db.exec("ALTER TABLE sensors ADD COLUMN measurement_entity_ids_json TEXT");
    }
    if (!sensorColumns.some((column) => column.name === "tp_link_device_id")) {
      this.db.exec("ALTER TABLE sensors ADD COLUMN tp_link_device_id TEXT");
    }
    if (!sensorColumns.some((column) => column.name === "tp_link_connection_id")) {
      this.db.exec("ALTER TABLE sensors ADD COLUMN tp_link_connection_id TEXT");
    }
    if (!sensorColumns.some((column) => column.name === "room_id")) {
      this.db.exec("ALTER TABLE sensors ADD COLUMN room_id TEXT");
    }
    const tapoExportColumns = this.db.prepare("PRAGMA table_info(tapo_history_export_jobs)")
      .all() as unknown as Array<{ name: string }>;
    if (!tapoExportColumns.some((column) => column.name === "time_zone")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC'");
      this.db.exec(`UPDATE tapo_history_export_jobs
        SET time_zone = COALESCE((
          SELECT house.timezone FROM sensors AS sensor
          JOIN houses AS house ON house.id = sensor.house_id
          WHERE sensor.id = tapo_history_export_jobs.sensor_id
        ), 'UTC')`);
    }
    if (!tapoExportColumns.some((column) => column.name === "submitted_at")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN submitted_at TEXT");
    }
    if (!tapoExportColumns.some((column) => column.name === "deployment_fingerprint")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN deployment_fingerprint TEXT");
    }
    if (!tapoExportColumns.some((column) => column.name === "acceptance_revision")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN acceptance_revision TEXT");
    }
    if (!tapoExportColumns.some((column) => column.name === "source_artifact_sha256")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_artifact_sha256 TEXT");
    }
    if (!tapoExportColumns.some((column) => column.name === "source_artifact_bytes")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_artifact_bytes INTEGER");
    }
    if (!tapoExportColumns.some((column) => column.name === "parser_version")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN parser_version TEXT");
    }
    if (!tapoExportColumns.some((column) => column.name === "source_schema_signature")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN source_schema_signature TEXT");
    }
    if (!tapoExportColumns.some((column) => column.name === "expected_schema_signature")) {
      this.db.exec("ALTER TABLE tapo_history_export_jobs ADD COLUMN expected_schema_signature TEXT");
    }
    const tapoApprovalColumns = this.db.prepare("PRAGMA table_info(tapo_history_canary_approvals)")
      .all() as unknown as Array<{ name: string }>;
    if (!tapoApprovalColumns.some((column) => column.name === "acceptance_revision")) {
      this.db.exec(`ALTER TABLE tapo_history_canary_approvals
        ADD COLUMN acceptance_revision TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
    }
    if (!tapoApprovalColumns.some((column) => column.name === "schema_signature")) {
      this.db.exec(`ALTER TABLE tapo_history_canary_approvals
        ADD COLUMN schema_signature TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
      // An approval created before schema fencing cannot safely authorize a
      // future vendor CSV. The completed canary remains available for audit.
      this.db.exec("DELETE FROM tapo_history_canary_approvals");
    }
    this.migrateSensorRoomIds();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sensors_house_floor_room
        ON sensors(house_id, floor_id, room_id) WHERE room_id IS NOT NULL;
      DROP TRIGGER IF EXISTS validate_sensor_room_insert;
      CREATE TRIGGER validate_sensor_room_insert
        BEFORE INSERT ON sensors
        WHEN NEW.room_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM houses AS house, json_each(house.floors_json) AS floor,
            json_each(json_extract(floor.value, '$.rooms')) AS room
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
            AND json_extract(room.value, '$.id') = NEW.room_id
            AND json_extract(room.value, '$.name') = NEW.room
        )
        BEGIN SELECT RAISE(ABORT, 'SENSOR_ROOM_MISMATCH'); END;
      DROP TRIGGER IF EXISTS validate_sensor_room_update;
      CREATE TRIGGER validate_sensor_room_update
        BEFORE UPDATE OF house_id, floor_id, room_id, room ON sensors
        WHEN NEW.room_id IS NOT NULL AND NOT EXISTS (
          SELECT 1
          FROM houses AS house, json_each(house.floors_json) AS floor,
            json_each(json_extract(floor.value, '$.rooms')) AS room
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
            AND json_extract(room.value, '$.id') = NEW.room_id
            AND json_extract(room.value, '$.name') = NEW.room
        )
        BEGIN SELECT RAISE(ABORT, 'SENSOR_ROOM_MISMATCH'); END;
      DROP TRIGGER IF EXISTS prevent_house_room_orphaned_sensor;
      CREATE TRIGGER prevent_house_room_orphaned_sensor
        BEFORE UPDATE OF floors_json ON houses
        WHEN EXISTS (
          SELECT 1 FROM sensors AS sensor
          WHERE sensor.house_id = OLD.id AND sensor.room_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(NEW.floors_json) AS floor,
                json_each(json_extract(floor.value, '$.rooms')) AS room
              WHERE json_extract(floor.value, '$.id') = sensor.floor_id
                AND json_extract(room.value, '$.id') = sensor.room_id
            )
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_SENSOR_ROOM'); END;
      DROP TRIGGER IF EXISTS sync_sensor_room_labels_after_house_layout_update;
      CREATE TRIGGER sync_sensor_room_labels_after_house_layout_update
        AFTER UPDATE OF floors_json ON houses
        BEGIN
          UPDATE sensors
          SET room = (
            SELECT json_extract(room.value, '$.name')
            FROM json_each(NEW.floors_json) AS floor,
              json_each(json_extract(floor.value, '$.rooms')) AS room
            WHERE json_extract(floor.value, '$.id') = sensors.floor_id
              AND json_extract(room.value, '$.id') = sensors.room_id
            LIMIT 1
          )
          WHERE house_id = NEW.id AND room_id IS NOT NULL;
        END;
    `);
    const alertRuleColumns = this.db.prepare("PRAGMA table_info(alert_rules)").all() as unknown as Array<{ name: string }>;
    if (!alertRuleColumns.some((column) => column.name === "telegram_enabled")) {
      this.db.exec("ALTER TABLE alert_rules ADD COLUMN telegram_enabled INTEGER NOT NULL DEFAULT 0");
    }
    if (!alertRuleColumns.some((column) => column.name === "retired_at")) {
      this.db.exec("ALTER TABLE alert_rules ADD COLUMN retired_at TEXT");
    }
    if (!alertRuleColumns.some((column) => column.name === "delivery_policy_json")) {
      this.db.exec("ALTER TABLE alert_rules ADD COLUMN delivery_policy_json TEXT NOT NULL DEFAULT '{}'");
    }
    let notificationOutboxColumns = this.db.prepare("PRAGMA table_info(notification_outbox)")
      .all() as unknown as Array<{ name: string }>;
    if (!notificationOutboxColumns.some((column) => column.name === "payload_json")) {
      this.db.exec("ALTER TABLE notification_outbox ADD COLUMN payload_json TEXT");
    }
    if (!notificationOutboxColumns.some((column) => column.name === "destination_ref")) {
      this.db.exec("ALTER TABLE notification_outbox ADD COLUMN destination_ref TEXT");
    }
    if (!notificationOutboxColumns.some((column) => column.name === "abandoned_at")) {
      this.db.exec("ALTER TABLE notification_outbox ADD COLUMN abandoned_at TEXT");
    }
    const legacyNotifications = this.db.prepare(`SELECT id, event_id, channel FROM notification_outbox
      WHERE payload_json IS NULL OR destination_ref IS NULL`).all() as Array<{
        id: string;
        event_id: string;
        channel: NotificationChannel;
      }>;
    for (const queued of legacyNotifications) {
      const event = this.getAlertEvent(queued.event_id);
      const ruleRow = event
        ? this.db.prepare("SELECT * FROM alert_rules WHERE id = ?").get(event.ruleId) as unknown as AlertRuleRow | undefined
        : undefined;
      const rule = ruleRow ? ruleFromRow(ruleRow) : null;
      const sensor = event ? this.getSensor(event.sensorId) : null;
      const house = sensor ? this.getHouse(sensor.houseId) : null;
      const bindings: AlertNotificationBindings = {
        houseLabel: house?.name ?? null,
        sensorLabel: sensor?.name ?? null,
        webhookDestinations: [{
          destinationId: "primary",
          destinationRef: legacyNotificationDestinationRef("webhook"),
        }],
        telegramDestinationRef: legacyNotificationDestinationRef("telegram"),
      };
      const payloadJson = event && rule
        ? notificationSnapshot(queued.channel, event, rule, bindings).payloadJson
        : JSON.stringify({ version: 1, legacyEventId: queued.event_id, unavailable: true });
      this.db.prepare(`UPDATE notification_outbox SET payload_json = ?, destination_ref = ? WHERE id = ?`)
        .run(payloadJson, legacyNotificationDestinationRef(queued.channel), queued.id);
    }
    if (!notificationOutboxColumns.some((column) => column.name === "subject_kind")) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS require_notification_outbox_snapshot_insert;
        DROP TRIGGER IF EXISTS preserve_notification_outbox_snapshot_update;
        CREATE TABLE notification_outbox_next (
          id TEXT PRIMARY KEY,
          subject_kind TEXT NOT NULL CHECK(subject_kind IN ('alert', 'maintenance', 'action-run')),
          subject_id TEXT NOT NULL,
          event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT,
          stage TEXT NOT NULL CHECK(stage IN ('initial', 'escalation', 'reminder', 'due', 'verification')),
          sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0),
          channel TEXT NOT NULL CHECK(channel IN ('webhook', 'telegram')),
          destination_id TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 8 CHECK(max_attempts BETWEEN 1 AND 100),
          available_at TEXT NOT NULL,
          locked_at TEXT,
          lock_token TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          delivered_at TEXT,
          payload_json TEXT NOT NULL,
          destination_ref TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          dead_lettered_at TEXT,
          abandoned_at TEXT,
          UNIQUE(subject_kind, subject_id, stage, sequence, channel, destination_id)
        );
        INSERT INTO notification_outbox_next(
          id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
          attempts, max_attempts, available_at, locked_at, lock_token, last_error,
          created_at, delivered_at, payload_json, destination_ref, policy_json,
          dead_lettered_at, abandoned_at
        )
        SELECT queued.id, 'alert', queued.event_id, queued.event_id, 'initial', 0, queued.channel, 'primary',
          queued.attempts, 8, queued.available_at, queued.locked_at, queued.lock_token, queued.last_error,
          queued.created_at, queued.delivered_at, queued.payload_json, queued.destination_ref,
          COALESCE((
            SELECT rule.delivery_policy_json
            FROM alert_events event JOIN alert_rules rule ON rule.id = event.rule_id
            WHERE event.id = queued.event_id
          ), '{}'), NULL, queued.abandoned_at
        FROM notification_outbox queued;
        DROP TABLE notification_outbox;
        ALTER TABLE notification_outbox_next RENAME TO notification_outbox;
      `);
      notificationOutboxColumns = this.db.prepare("PRAGMA table_info(notification_outbox)")
        .all() as unknown as Array<{ name: string }>;
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
      ON notification_outbox(delivered_at, dead_lettered_at, available_at, locked_at)`);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS require_notification_outbox_snapshot_insert
        BEFORE INSERT ON notification_outbox
        WHEN NEW.payload_json IS NULL OR NEW.payload_json = '' OR NEW.destination_ref IS NULL OR NEW.destination_ref = ''
        BEGIN SELECT RAISE(ABORT, 'NOTIFICATION_SNAPSHOT_REQUIRED'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_notification_outbox_snapshot_update
        BEFORE UPDATE OF subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
          max_attempts, payload_json, destination_ref, policy_json ON notification_outbox
        WHEN NEW.subject_kind IS NOT OLD.subject_kind OR NEW.subject_id IS NOT OLD.subject_id
          OR NEW.event_id IS NOT OLD.event_id OR NEW.stage IS NOT OLD.stage OR NEW.sequence IS NOT OLD.sequence
          OR NEW.channel IS NOT OLD.channel OR NEW.destination_id IS NOT OLD.destination_id
          OR NEW.max_attempts IS NOT OLD.max_attempts OR NEW.payload_json IS NOT OLD.payload_json
          OR NEW.destination_ref IS NOT OLD.destination_ref OR NEW.policy_json IS NOT OLD.policy_json
        BEGIN SELECT RAISE(ABORT, 'NOTIFICATION_SNAPSHOT_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_alert_rule_history_before_delete
        BEFORE DELETE ON alert_rules
        WHEN EXISTS (SELECT 1 FROM alert_events WHERE rule_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'ALERT_RULE_HISTORY_EXISTS'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_alert_sensor_history_before_delete
        BEFORE DELETE ON sensors
        WHEN EXISTS (SELECT 1 FROM alert_events WHERE sensor_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'ALERT_SENSOR_HISTORY_EXISTS'); END;
    `);
    // Removal of the obsolete external forwarding queue is intentionally irreversible;
    // discard legacy queued payloads during startup instead of retaining a
    // dormant copy of local measurements.
    this.db.exec("DROP TABLE IF EXISTS measurement_forward_outbox");
    let maintenanceTaskColumns = this.db.prepare("PRAGMA table_info(maintenance_tasks)")
      .all() as unknown as Array<{ name: string; notnull: number }>;
    if (!maintenanceTaskColumns.some((column) => column.name === "area_id")) {
      this.db.exec("ALTER TABLE maintenance_tasks ADD COLUMN area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT");
    }
    if (!maintenanceTaskColumns.some((column) => column.name === "equipment_id")) {
      this.db.exec("ALTER TABLE maintenance_tasks ADD COLUMN equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT");
    }
    maintenanceTaskColumns = this.db.prepare("PRAGMA table_info(maintenance_tasks)")
      .all() as unknown as Array<{ name: string; notnull: number }>;
    const maintenanceHouseColumn = maintenanceTaskColumns.find((column) => column.name === "house_id");
    if (!maintenanceTaskColumns.some((column) => column.name === "property_id") || maintenanceHouseColumn?.notnull === 1) {
      const propertyExpression = maintenanceTaskColumns.some((column) => column.name === "property_id")
        ? "COALESCE(task.property_id, house.property_id)"
        : "house.property_id";
      this.db.exec(`
        DROP TABLE IF EXISTS temp.maintenance_task_observations_migration;
        DROP TABLE IF EXISTS temp.maintenance_task_revisions_migration;
        CREATE TABLE maintenance_tasks_next (
          id TEXT PRIMARY KEY,
          property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
          house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
          floor_id TEXT,
          area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
          equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT,
          title TEXT NOT NULL CHECK (length(trim(title)) > 0),
          description TEXT,
          basis TEXT NOT NULL CHECK (basis IN ('required', 'scheduled', 'condition-based', 'predictive', 'optional-improvement')),
          basis_detail TEXT,
          priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
          planned_for TEXT,
          due_by TEXT,
          status TEXT NOT NULL CHECK (status IN ('planned', 'in-progress', 'completed', 'verified', 'cancelled')),
          completion_note TEXT,
          completed_at TEXT,
          verification_note TEXT,
          verified_at TEXT,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (planned_for IS NULL OR due_by IS NULL OR planned_for <= due_by),
          CHECK (basis <> 'predictive' OR due_by IS NULL),
          CHECK (
            (status IN ('planned', 'in-progress', 'cancelled')
              AND completion_note IS NULL AND completed_at IS NULL
              AND verification_note IS NULL AND verified_at IS NULL)
            OR
            (status = 'completed'
              AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
              AND verification_note IS NULL AND verified_at IS NULL)
            OR
            (status = 'verified'
              AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
              AND verification_note IS NOT NULL AND length(trim(verification_note)) > 0 AND verified_at IS NOT NULL)
          )
        );
        INSERT INTO maintenance_tasks_next(
          id, property_id, house_id, floor_id, area_id, equipment_id, title, description, basis, basis_detail,
          priority, planned_for, due_by, status, completion_note, completed_at, verification_note, verified_at,
          revision, created_at, updated_at
        )
        SELECT task.id, ${propertyExpression}, task.house_id, task.floor_id, task.area_id, task.equipment_id,
          task.title, task.description, task.basis, task.basis_detail, task.priority, task.planned_for, task.due_by,
          task.status, task.completion_note, task.completed_at, task.verification_note, task.verified_at,
          task.revision, task.created_at, task.updated_at
        FROM maintenance_tasks AS task
        LEFT JOIN houses AS house ON house.id = task.house_id;
        CREATE TEMP TABLE maintenance_task_observations_migration AS
          SELECT maintenance_task_id, observation_id FROM maintenance_task_observations;
        CREATE TEMP TABLE maintenance_task_revisions_migration AS
          SELECT revision.maintenance_task_id, revision.revision, revision.changed_at,
            CASE revision.actor
              WHEN 'hosted-user' THEN 'workspace-user'
              WHEN 'hosted-service' THEN 'system-service'
              ELSE revision.actor
            END AS actor,
            revision.changed_fields_json,
            json_set(revision.snapshot_json,
              '$.propertyId', task.property_id,
              '$.houseId', task.house_id) AS snapshot_json
          FROM maintenance_task_revisions AS revision
          JOIN maintenance_tasks_next AS task ON task.id = revision.maintenance_task_id;
        DROP TRIGGER IF EXISTS validate_maintenance_observation_scope_insert;
        DROP TRIGGER IF EXISTS validate_maintenance_observation_scope_update;
        DROP TRIGGER IF EXISTS prevent_house_floor_orphaned_maintenance;
        DROP TRIGGER IF EXISTS prevent_property_area_property_scope_orphans;
        DROP TRIGGER IF EXISTS prevent_equipment_property_scope_orphans;
        DROP TRIGGER IF EXISTS prevent_equipment_area_scope_orphans;
        DROP TRIGGER IF EXISTS prevent_house_property_scope_orphans;
        DROP TRIGGER IF EXISTS cascade_equipment_scope_move;
        DROP TRIGGER IF EXISTS cascade_property_area_scope_move;
        DROP TRIGGER IF EXISTS cascade_house_property_move;
        DROP TRIGGER IF EXISTS validate_linked_observation_house_update;
        DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_insert_collision;
        DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_update;
        DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_delete;
        DROP TABLE maintenance_task_observations;
        DROP TABLE maintenance_task_revisions;
        DROP TABLE maintenance_tasks;
        ALTER TABLE maintenance_tasks_next RENAME TO maintenance_tasks;
        CREATE TABLE maintenance_task_observations (
          maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
          observation_id TEXT NOT NULL,
          PRIMARY KEY (maintenance_task_id, observation_id),
          FOREIGN KEY (observation_id) REFERENCES observations(id)
            ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
        );
        INSERT INTO maintenance_task_observations(maintenance_task_id, observation_id)
          SELECT maintenance_task_id, observation_id FROM maintenance_task_observations_migration;
        CREATE TABLE maintenance_task_revisions (
          maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          changed_at TEXT NOT NULL,
          actor TEXT NOT NULL CHECK (actor IN ('local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service')),
          changed_fields_json TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (maintenance_task_id, revision)
        );
        INSERT INTO maintenance_task_revisions(
          maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json
        ) SELECT maintenance_task_id, revision, changed_at,
            CASE actor
              WHEN 'hosted-user' THEN 'workspace-user'
              WHEN 'hosted-service' THEN 'system-service'
              WHEN 'local-migration' THEN 'system-service'
              ELSE actor
            END,
            changed_fields_json, snapshot_json
          FROM maintenance_task_revisions_migration;
        DROP TABLE maintenance_task_observations_migration;
        DROP TABLE maintenance_task_revisions_migration;
      `);
    }
    this.migrateRevisionActors();
    const maintenanceTasksWithLegacyPropertyScope = this.maintenanceTasksBeforeScopeMove(`
      NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = maintenance_tasks.property_id)
      OR (house_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM houses house
        WHERE house.id = maintenance_tasks.house_id AND house.property_id = maintenance_tasks.property_id
      ))
      OR (area_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM property_areas area
        WHERE area.id = maintenance_tasks.area_id AND area.property_id = maintenance_tasks.property_id
      ))
      OR (equipment_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM area_equipment equipment
        JOIN property_areas area ON area.id = equipment.area_id
        WHERE equipment.id = maintenance_tasks.equipment_id
          AND equipment.property_id = maintenance_tasks.property_id
          AND area.property_id = equipment.property_id
          AND (maintenance_tasks.area_id IS NULL OR equipment.area_id = maintenance_tasks.area_id)
      ))
    `, []);
    // Repair legacy ownership columns from their closest valid parent before
    // reinstating the scope triggers. Databases created while foreign-key
    // enforcement was disabled can otherwise retain non-empty orphan IDs.
    this.db.exec(`
      DROP TRIGGER IF EXISTS validate_area_equipment_scope_insert;
      DROP TRIGGER IF EXISTS validate_area_equipment_scope_update;
      DROP TRIGGER IF EXISTS validate_property_note_scope_insert;
      DROP TRIGGER IF EXISTS validate_property_note_scope_update;
      DROP TRIGGER IF EXISTS validate_maintenance_property_scope_insert;
      DROP TRIGGER IF EXISTS validate_maintenance_property_scope_update;
      DROP TRIGGER IF EXISTS prevent_property_area_property_scope_orphans;
      DROP TRIGGER IF EXISTS prevent_equipment_property_scope_orphans;
      DROP TRIGGER IF EXISTS prevent_equipment_area_scope_orphans;
      DROP TRIGGER IF EXISTS prevent_house_property_scope_orphans;
      DROP TRIGGER IF EXISTS cascade_equipment_scope_move;
      DROP TRIGGER IF EXISTS cascade_property_area_scope_move;
      DROP TRIGGER IF EXISTS cascade_house_property_move;

      UPDATE property_areas SET property_id = '${DEFAULT_PROPERTY_ID}'
      WHERE property_id IS NULL OR trim(property_id) = ''
        OR NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = property_areas.property_id);

      UPDATE area_equipment
      SET property_id = (SELECT area.property_id FROM property_areas area WHERE area.id = area_equipment.area_id)
      WHERE EXISTS (SELECT 1 FROM property_areas area WHERE area.id = area_equipment.area_id)
        AND property_id <> (SELECT area.property_id FROM property_areas area WHERE area.id = area_equipment.area_id);

      UPDATE property_notes
      SET property_id = COALESCE(
        (SELECT equipment.property_id FROM area_equipment equipment WHERE equipment.id = property_notes.equipment_id),
        (SELECT area.property_id FROM property_areas area WHERE area.id = property_notes.area_id),
        (SELECT house.property_id FROM houses house WHERE house.id = property_notes.house_id),
        CASE WHEN EXISTS (SELECT 1 FROM properties property WHERE property.id = property_notes.property_id)
          THEN property_id ELSE '${DEFAULT_PROPERTY_ID}' END
      );

      UPDATE maintenance_tasks
      SET property_id = COALESCE(
        (SELECT equipment.property_id FROM area_equipment equipment WHERE equipment.id = maintenance_tasks.equipment_id),
        (SELECT area.property_id FROM property_areas area WHERE area.id = maintenance_tasks.area_id),
        (SELECT house.property_id FROM houses house WHERE house.id = maintenance_tasks.house_id),
        CASE WHEN EXISTS (SELECT 1 FROM properties property WHERE property.id = maintenance_tasks.property_id)
          THEN property_id ELSE '${DEFAULT_PROPERTY_ID}' END
      );
    `);
    // Ownership repair is an effective task mutation. Keep live state and its
    // append-only audit history aligned even for databases damaged while
    // foreign-key enforcement or the scope triggers were disabled.
    this.recordScopeMoveMaintenanceRevisions(maintenanceTasksWithLegacyPropertyScope, "system-service");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_house_schedule
        ON maintenance_tasks(house_id, status, planned_for, due_by, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_property_schedule
        ON maintenance_tasks(property_id, status, planned_for, due_by, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_area_schedule
        ON maintenance_tasks(area_id, status, planned_for, due_by, updated_at DESC)
        WHERE area_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_equipment_schedule
        ON maintenance_tasks(equipment_id, status, planned_for, due_by, updated_at DESC)
        WHERE equipment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_list_order
        ON maintenance_tasks(COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_property_list_order
        ON maintenance_tasks(property_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_house_list_order
        ON maintenance_tasks(house_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id)
        WHERE house_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_area_list_order
        ON maintenance_tasks(area_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id)
        WHERE area_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_equipment_list_order
        ON maintenance_tasks(equipment_id, COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id)
        WHERE equipment_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_maintenance_task_observations_observation
        ON maintenance_task_observations(observation_id, maintenance_task_id);
      CREATE INDEX IF NOT EXISTS idx_maintenance_task_revisions_changed
        ON maintenance_task_revisions(maintenance_task_id, changed_at, revision);
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_insert
        BEFORE INSERT ON maintenance_tasks
        WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_update
        BEFORE UPDATE OF floor_id, house_id ON maintenance_tasks
        WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_house_floor_orphaned_maintenance
        BEFORE UPDATE OF floors_json ON houses
        WHEN EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          WHERE task.house_id = OLD.id AND task.floor_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM json_each(NEW.floors_json) AS floor
              WHERE json_extract(floor.value, '$.id') = task.floor_id
            )
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_MAINTENANCE_TASK'); END;
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_insert
        BEFORE INSERT ON maintenance_task_observations
        WHEN NOT EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          JOIN observations AS observation ON observation.id = NEW.observation_id
          WHERE task.id = NEW.maintenance_task_id
            AND task.house_id IS NOT NULL
            AND task.house_id = observation.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_update
        BEFORE UPDATE OF maintenance_task_id, observation_id ON maintenance_task_observations
        WHEN NOT EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          JOIN observations AS observation ON observation.id = NEW.observation_id
          WHERE task.id = NEW.maintenance_task_id
            AND task.house_id IS NOT NULL
            AND task.house_id = observation.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      DROP TRIGGER IF EXISTS validate_linked_maintenance_task_house_update;
      CREATE TRIGGER validate_linked_maintenance_task_house_update
        BEFORE UPDATE OF house_id ON maintenance_tasks
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_observations AS link
          JOIN observations AS observation ON observation.id = link.observation_id
          WHERE link.maintenance_task_id = OLD.id
            AND (NEW.house_id IS NULL OR observation.house_id <> NEW.house_id)
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_linked_observation_house_update
        BEFORE UPDATE OF house_id ON observations
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_observations AS link
          JOIN maintenance_tasks AS task ON task.id = link.maintenance_task_id
          WHERE link.observation_id = OLD.id
            AND (task.house_id IS NULL OR task.house_id <> NEW.house_id)
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_insert_collision
        BEFORE INSERT ON maintenance_task_revisions
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_revisions
          WHERE maintenance_task_id = NEW.maintenance_task_id AND revision = NEW.revision
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_update
        BEFORE UPDATE ON maintenance_task_revisions
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_delete
        BEFORE DELETE ON maintenance_task_revisions
        WHEN EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = OLD.maintenance_task_id)
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS validate_area_equipment_scope_insert
        BEFORE INSERT ON area_equipment
        WHEN NOT EXISTS (
          SELECT 1 FROM property_areas area
          WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
        )
        BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_AREA_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_area_equipment_scope_update
        BEFORE UPDATE OF property_id, area_id ON area_equipment
        WHEN NOT EXISTS (
          SELECT 1 FROM property_areas area
          WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
        )
        BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_AREA_SCOPE_MISMATCH'); END;
      DROP TRIGGER IF EXISTS prevent_property_area_property_scope_orphans;
      DROP TRIGGER IF EXISTS prevent_equipment_property_scope_orphans;
      DROP TRIGGER IF EXISTS prevent_equipment_area_scope_orphans;
      DROP TRIGGER IF EXISTS cascade_equipment_scope_move;
      CREATE TRIGGER cascade_equipment_scope_move
        AFTER UPDATE OF property_id, area_id ON area_equipment
        WHEN OLD.property_id <> NEW.property_id OR OLD.area_id <> NEW.area_id
        BEGIN
          UPDATE property_notes SET property_id = NEW.property_id, updated_at = NEW.updated_at
            WHERE equipment_id = NEW.id;
          UPDATE maintenance_tasks SET
            property_id = NEW.property_id,
            area_id = NEW.area_id,
            floor_id = CASE WHEN house_id IS NULL OR EXISTS (
              SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                AND house.property_id = NEW.property_id
            ) THEN floor_id ELSE NULL END,
            house_id = CASE WHEN house_id IS NULL OR EXISTS (
              SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                AND house.property_id = NEW.property_id
            ) THEN house_id ELSE NULL END
          WHERE equipment_id = NEW.id;
        END;
      DROP TRIGGER IF EXISTS cascade_property_area_scope_move;
      CREATE TRIGGER cascade_property_area_scope_move
        AFTER UPDATE OF property_id ON property_areas
        WHEN OLD.property_id <> NEW.property_id
        BEGIN
          UPDATE area_equipment SET property_id = NEW.property_id, updated_at = NEW.updated_at WHERE area_id = NEW.id;
          UPDATE property_notes SET property_id = NEW.property_id, updated_at = NEW.updated_at WHERE area_id = NEW.id;
          UPDATE maintenance_tasks SET
            property_id = NEW.property_id,
            floor_id = CASE WHEN house_id IS NULL OR EXISTS (
              SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                AND house.property_id = NEW.property_id
            ) THEN floor_id ELSE NULL END,
            house_id = CASE WHEN house_id IS NULL OR EXISTS (
              SELECT 1 FROM houses house WHERE house.id = maintenance_tasks.house_id
                AND house.property_id = NEW.property_id
            ) THEN house_id ELSE NULL END
          WHERE area_id = NEW.id AND equipment_id IS NULL;
        END;
      CREATE TRIGGER IF NOT EXISTS validate_property_note_scope_insert
        BEFORE INSERT ON property_notes
        WHEN ((NEW.house_id IS NOT NULL) + (NEW.area_id IS NOT NULL) + (NEW.equipment_id IS NOT NULL)) > 1
          OR (NEW.house_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM houses house WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
          )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM property_areas area WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
          )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM area_equipment equipment
            WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
              AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
          ))
        BEGIN SELECT RAISE(ABORT, 'PROPERTY_NOTE_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_property_note_scope_update
        BEFORE UPDATE OF property_id, house_id, area_id, equipment_id ON property_notes
        WHEN ((NEW.house_id IS NOT NULL) + (NEW.area_id IS NOT NULL) + (NEW.equipment_id IS NOT NULL)) > 1
          OR (NEW.house_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM houses house WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
          )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM property_areas area WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
          )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM area_equipment equipment
            WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
              AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
          ))
        BEGIN SELECT RAISE(ABORT, 'PROPERTY_NOTE_SCOPE_MISMATCH'); END;
      DROP TRIGGER IF EXISTS validate_maintenance_property_scope_insert;
      DROP TRIGGER IF EXISTS validate_maintenance_property_scope_update;
      CREATE TRIGGER validate_maintenance_property_scope_insert
        BEFORE INSERT ON maintenance_tasks
        WHEN (NEW.house_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM houses house
            WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
          )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM property_areas area
            WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
          )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM area_equipment equipment
            WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
              AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
          ))
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_PROPERTY_SCOPE_MISMATCH'); END;
      CREATE TRIGGER validate_maintenance_property_scope_update
        BEFORE UPDATE OF property_id, house_id, area_id, equipment_id ON maintenance_tasks
        WHEN (NEW.house_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM houses house
            WHERE house.id = NEW.house_id AND house.property_id = NEW.property_id
          )) OR (NEW.area_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM property_areas area
            WHERE area.id = NEW.area_id AND area.property_id = NEW.property_id
          )) OR (NEW.equipment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM area_equipment equipment
            WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
              AND (NEW.area_id IS NULL OR equipment.area_id = NEW.area_id)
          ))
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_PROPERTY_SCOPE_MISMATCH'); END;
      DROP TRIGGER IF EXISTS prevent_house_property_scope_orphans;
      DROP TRIGGER IF EXISTS cascade_house_property_move;
      CREATE TRIGGER cascade_house_property_move
        AFTER UPDATE OF property_id ON houses
        WHEN OLD.property_id <> NEW.property_id
        BEGIN
          UPDATE property_notes SET property_id = NEW.property_id, updated_at = NEW.updated_at WHERE house_id = NEW.id;
          UPDATE maintenance_tasks SET
            property_id = NEW.property_id,
            equipment_id = CASE WHEN equipment_id IS NULL OR EXISTS (
              SELECT 1 FROM area_equipment equipment
              WHERE equipment.id = maintenance_tasks.equipment_id
                AND equipment.property_id = NEW.property_id
            ) THEN equipment_id ELSE NULL END,
            area_id = CASE WHEN area_id IS NULL OR EXISTS (
              SELECT 1 FROM property_areas area
              WHERE area.id = maintenance_tasks.area_id AND area.property_id = NEW.property_id
            ) THEN area_id ELSE NULL END
          WHERE house_id = NEW.id;
        END;
    `);
    const invalidPropertyScope = this.db.prepare(`
      SELECT resource, id FROM (
        SELECT 'property-area' AS resource, area.id AS id
        FROM property_areas area
        WHERE NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = area.property_id)
        UNION ALL
        SELECT 'area-equipment', equipment.id
        FROM area_equipment equipment
        WHERE NOT EXISTS (
          SELECT 1 FROM property_areas area
          WHERE area.id = equipment.area_id AND area.property_id = equipment.property_id
        )
        UNION ALL
        SELECT 'property-note', note.id
        FROM property_notes note
        WHERE NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = note.property_id)
          OR ((note.house_id IS NOT NULL) + (note.area_id IS NOT NULL) + (note.equipment_id IS NOT NULL)) > 1
          OR (note.house_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM houses house WHERE house.id = note.house_id AND house.property_id = note.property_id
          ))
          OR (note.area_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM property_areas area WHERE area.id = note.area_id AND area.property_id = note.property_id
          ))
          OR (note.equipment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM area_equipment equipment
            WHERE equipment.id = note.equipment_id AND equipment.property_id = note.property_id
          ))
        UNION ALL
        SELECT 'maintenance-task', task.id
        FROM maintenance_tasks task
        WHERE NOT EXISTS (SELECT 1 FROM properties property WHERE property.id = task.property_id)
          OR (task.house_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM houses house WHERE house.id = task.house_id AND house.property_id = task.property_id
          ))
          OR (task.area_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM property_areas area WHERE area.id = task.area_id AND area.property_id = task.property_id
          ))
          OR (task.equipment_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM area_equipment equipment
            WHERE equipment.id = task.equipment_id AND equipment.property_id = task.property_id
              AND (task.area_id IS NULL OR equipment.area_id = task.area_id)
          ))
      ) ORDER BY resource, id LIMIT 1
    `).get() as { resource: string; id: string } | undefined;
    if (invalidPropertyScope) {
      throw new Error(
        `INVALID_PROPERTY_SCOPE: ${invalidPropertyScope.resource} ${invalidPropertyScope.id} has an orphaned or conflicting owner`,
      );
    }
    this.db.exec("DROP INDEX IF EXISTS idx_sensors_tp_link_device");
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sensors_tp_link_connection_device
      ON sensors(house_id, COALESCE(tp_link_connection_id, ''), tp_link_device_id)
      WHERE tp_link_device_id IS NOT NULL`);
    const observationColumns = this.db.prepare("PRAGMA table_info(observations)").all() as unknown as Array<{ name: string }>;
    const observationColumnNames = new Set(observationColumns.map((column) => column.name));
    const addObservationColumn = (name: string, sql: string): void => {
      if (!observationColumnNames.has(name)) this.db.exec(sql);
    };
    addObservationColumn("time_precision", `ALTER TABLE observations ADD COLUMN time_precision TEXT NOT NULL DEFAULT 'exact'
      CHECK (time_precision IN ('exact', 'approximate', 'date-only', 'date-range', 'unknown'))`);
    addObservationColumn("valid_from", "ALTER TABLE observations ADD COLUMN valid_from TEXT");
    addObservationColumn("valid_to", "ALTER TABLE observations ADD COLUMN valid_to TEXT");
    addObservationColumn("source", `ALTER TABLE observations ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'
      CHECK (source IN ('owner', 'caretaker', 'contractor', 'sensor', 'imported-document', 'automated-analysis', 'unknown'))`);
    addObservationColumn("source_detail", "ALTER TABLE observations ADD COLUMN source_detail TEXT");
    addObservationColumn("confidence", `ALTER TABLE observations ADD COLUMN confidence TEXT NOT NULL DEFAULT 'uncertain'
      CHECK (confidence IN ('confirmed', 'probable', 'uncertain', 'awaiting-inspection'))`);
    addObservationColumn("status", `ALTER TABLE observations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'resolved'))`);
    addObservationColumn("resolution_note", "ALTER TABLE observations ADD COLUMN resolution_note TEXT");
    addObservationColumn("resolved_at", "ALTER TABLE observations ADD COLUMN resolved_at TEXT");
    addObservationColumn("revision", "ALTER TABLE observations ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)");
    addObservationColumn("updated_at", "ALTER TABLE observations ADD COLUMN updated_at TEXT");
    this.db.prepare("UPDATE observations SET updated_at = created_at WHERE updated_at IS NULL").run();
    this.db.prepare(`UPDATE observations
      SET status = 'open', resolution_note = NULL, resolved_at = NULL
      WHERE status IS NULL
        OR status NOT IN ('open', 'resolved')
        OR (status = 'open' AND (resolution_note IS NOT NULL OR resolved_at IS NOT NULL))
        OR (status = 'resolved' AND (resolution_note IS NULL OR length(trim(resolution_note)) = 0 OR resolved_at IS NULL))`).run();
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS validate_observation_lifecycle_insert
        BEFORE INSERT ON observations
        WHEN NOT (
          (NEW.status = 'open' AND NEW.resolution_note IS NULL AND NEW.resolved_at IS NULL)
          OR
          (NEW.status = 'resolved' AND NEW.resolution_note IS NOT NULL
            AND length(trim(NEW.resolution_note)) > 0 AND NEW.resolved_at IS NOT NULL)
        )
        BEGIN SELECT RAISE(ABORT, 'INVALID_OBSERVATION_LIFECYCLE'); END;
      CREATE TRIGGER IF NOT EXISTS validate_observation_lifecycle_update
        BEFORE UPDATE OF status, resolution_note, resolved_at ON observations
        WHEN NOT (
          (NEW.status = 'open' AND NEW.resolution_note IS NULL AND NEW.resolved_at IS NULL)
          OR
          (NEW.status = 'resolved' AND NEW.resolution_note IS NOT NULL
            AND length(trim(NEW.resolution_note)) > 0 AND NEW.resolved_at IS NOT NULL)
        )
        BEGIN SELECT RAISE(ABORT, 'INVALID_OBSERVATION_LIFECYCLE'); END;
    `);
    const observationRevisionMigration = this.db.prepare(
      "SELECT value FROM metadata WHERE key = 'observation_revisions_v1'",
    ).get();
    if (!observationRevisionMigration) {
      this.immediateTransaction(() => {
        // Another process may have completed this backfill while BEGIN IMMEDIATE
        // waited for the write lock. Recheck under that lock before scanning or
        // inserting the completion marker.
        if (this.db.prepare(
          "SELECT value FROM metadata WHERE key = 'observation_revisions_v1'",
        ).get()) return;
        const insertLegacyRevision = this.db.prepare(`INSERT INTO observation_revisions
          (observation_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
          SELECT ?, 1, ?, 'system-service', ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM observation_revisions WHERE observation_id = ? AND revision = 1
          )`);
        for (const row of this.db.prepare("SELECT * FROM observations").all() as unknown as ObservationRow[]) {
          const observation = observationFromRow(row);
          insertLegacyRevision.run(
            observation.id,
            observation.createdAt,
            JSON.stringify(OBSERVATION_CHANGED_FIELDS),
            JSON.stringify(observation),
            observation.id,
          );
        }
        this.db.prepare("INSERT INTO metadata(key, value) VALUES ('observation_revisions_v1', 'complete')").run();
      });
    }
    const measurementColumns = new Set((this.db.prepare("PRAGMA table_info(measurement_definitions)").all() as Array<{ name: string }>).map((column) => column.name));
    const measurementColumnMigrations = [
      ["dimension", "ALTER TABLE measurement_definitions ADD COLUMN dimension TEXT NOT NULL DEFAULT 'finite_scalar'"],
      ["allowed_units_json", "ALTER TABLE measurement_definitions ADD COLUMN allowed_units_json TEXT NOT NULL DEFAULT '[]'"],
      ["kind", "ALTER TABLE measurement_definitions ADD COLUMN kind TEXT NOT NULL DEFAULT 'gauge'"],
      ["default_aggregation", "ALTER TABLE measurement_definitions ADD COLUMN default_aggregation TEXT NOT NULL DEFAULT 'mean'"],
      ["generic_history_enabled", "ALTER TABLE measurement_definitions ADD COLUMN generic_history_enabled INTEGER NOT NULL DEFAULT 1"],
      ["generic_stats_enabled", "ALTER TABLE measurement_definitions ADD COLUMN generic_stats_enabled INTEGER NOT NULL DEFAULT 1"],
    ] as const;
    for (const [column, sql] of measurementColumnMigrations) {
      if (!measurementColumns.has(column)) this.db.exec(sql);
    }
    const definitionsWithoutAllowedUnits = this.db.prepare(
      "SELECT id, unit FROM measurement_definitions WHERE allowed_units_json = '[]'",
    ).all() as Array<{ id: string; unit: string }>;
    const backfillAllowedUnits = this.db.prepare(
      "UPDATE measurement_definitions SET allowed_units_json = ? WHERE id = ?",
    );
    for (const definition of definitionsWithoutAllowedUnits) {
      backfillAllowedUnits.run(JSON.stringify([definition.unit]), definition.id);
    }
    const insertDefinition = this.db.prepare(`INSERT OR IGNORE INTO measurement_definitions
      (id, labels_json, unit, dimension, allowed_units_json, kind, default_aggregation,
       generic_history_enabled, generic_stats_enabled, precision, valid_min, valid_max, display_min, display_max,
       interpolation_delta, color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
    insertDefinition.run("temperature", JSON.stringify({ en: "Temperature", fi: "Lämpötila" }), "°C", "temperature", JSON.stringify(["°C", "°F"]), "gauge", "mean", 1, -80, 100, 15, 30, 2, "thermal", 1, 1);
    insertDefinition.run("humidity", JSON.stringify({ en: "Humidity", fi: "Ilmankosteus" }), "%", "relative_humidity", JSON.stringify(["%"]), "gauge", "mean", 0, 0, 100, 20, 80, 10, "humidity", 1, 1);
    insertDefinition.run("co2", JSON.stringify({ en: "Carbon dioxide", fi: "Hiilidioksidi" }), "ppm", "co2_concentration", JSON.stringify(["ppm"]), "gauge", "mean", 0, 0, 10_000, 400, 2_000, 250, "air-quality", 1, 1);
    insertDefinition.run("power", JSON.stringify({ en: "Power", fi: "Teho" }), "W", "power", JSON.stringify(["W", "kW"]), "rate", "time_weighted_mean", 1, null, null, 0, 10_000, 500, "sequential", 0, 0);
    insertDefinition.run("energy", JSON.stringify({ en: "Energy (cumulative)", fi: "Energia (kumulatiivinen)" }), "kWh", "energy", JSON.stringify(["Wh", "kWh"]), "cumulative_counter", "delta", 3, 0, null, 0, null, 1, "sequential", 0, 0);
    insertDefinition.run("electricity_price", JSON.stringify({ en: "Electricity price", fi: "Sähkön hinta" }), "€/kWh", "finite_scalar", JSON.stringify(["€/kWh"]), "gauge", "mean", 4, null, null, -0.5, 1, 0.05, "sequential", 0, 0);
    const updateBuiltinAnalytics = this.db.prepare(`UPDATE measurement_definitions SET
      dimension = ?, allowed_units_json = ?, kind = ?, default_aggregation = ?,
      generic_history_enabled = 1, generic_stats_enabled = 1 WHERE id = ?`);
    updateBuiltinAnalytics.run("temperature", JSON.stringify(["°C", "°F"]), "gauge", "mean", "temperature");
    updateBuiltinAnalytics.run("relative_humidity", JSON.stringify(["%"]), "gauge", "mean", "humidity");
    updateBuiltinAnalytics.run("co2_concentration", JSON.stringify(["ppm"]), "gauge", "mean", "co2");
    updateBuiltinAnalytics.run("power", JSON.stringify(["W", "kW"]), "rate", "time_weighted_mean", "power");
    updateBuiltinAnalytics.run("energy", JSON.stringify(["Wh", "kWh"]), "cumulative_counter", "delta", "energy");
    updateBuiltinAnalytics.run("finite_scalar", JSON.stringify(["€/kWh"]), "gauge", "mean", "electricity_price");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_playbooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        instructions_json TEXT NOT NULL,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
        goal TEXT NOT NULL CHECK(goal IN ('decrease', 'increase', 'below', 'above')),
        minimum_improvement REAL NOT NULL DEFAULT 0 CHECK(minimum_improvement >= 0),
        target_value REAL,
        wait_seconds INTEGER NOT NULL CHECK(wait_seconds BETWEEN 0 AND 604800),
        verification_window_seconds INTEGER NOT NULL CHECK(verification_window_seconds BETWEEN 60 AND 2592000),
        enabled INTEGER NOT NULL DEFAULT 1,
        built_in INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((goal IN ('below', 'above') AND target_value IS NOT NULL) OR goal IN ('decrease', 'increase'))
      );
      CREATE TABLE IF NOT EXISTS action_runs (
        id TEXT PRIMARY KEY,
        playbook_id TEXT NOT NULL REFERENCES action_playbooks(id) ON DELETE RESTRICT,
        alert_event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT,
        maintenance_task_id TEXT REFERENCES maintenance_tasks(id) ON DELETE SET NULL,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE RESTRICT,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK(status IN ('active', 'waiting', 'verified', 'not-improved', 'cancelled')),
        started_at TEXT NOT NULL,
        action_completed_at TEXT,
        verify_after TEXT,
        verification_deadline TEXT,
        baseline_value REAL NOT NULL,
        baseline_timestamp TEXT NOT NULL,
        result_value REAL,
        result_timestamp TEXT,
        improvement REAL,
        sample_count INTEGER NOT NULL DEFAULT 0 CHECK(sample_count >= 0),
        operator_note TEXT,
        verification_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_action_runs_sensor_status
        ON action_runs(sensor_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_action_runs_alert
        ON action_runs(alert_event_id, updated_at DESC) WHERE alert_event_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS data_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_data_audit_events_created ON data_audit_events(created_at DESC);
      CREATE TABLE IF NOT EXISTS security_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'denied')),
        actor_user_id TEXT,
        actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('owner', 'admin', 'member', 'guest', 'service')),
        subject_type TEXT NOT NULL CHECK(subject_type IN ('account', 'workspace-member', 'integration', 'integration-grant')),
        subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 512),
        details_json TEXT NOT NULL CHECK(json_valid(details_json) AND json_type(details_json) = 'object'),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_security_audit_events_created
        ON security_audit_events(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_security_audit_events_type_created
        ON security_audit_events(event_type, created_at DESC);
      INSERT OR IGNORE INTO action_playbooks(
        id, name, description, instructions_json, metric, goal, minimum_improvement, target_value,
        wait_seconds, verification_window_seconds, enabled, built_in, created_at, updated_at
      ) VALUES
        ('playbook-humidity-ventilate', 'Ventilate and verify',
         'Reduce persistent indoor humidity with a short, controlled ventilation period.',
         '["Check that outdoor conditions make ventilation appropriate","Open the relevant vents or windows for 15–20 minutes","Close them again and mark the action complete"]',
         'humidity', 'decrease', 3, NULL, 1200, 1800, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('playbook-co2-ventilate', 'Refresh indoor air and verify',
         'Reduce elevated carbon dioxide without claiming occupancy or air-flow certainty.',
         '["Open normal ventilation paths","Ventilate for 15–20 minutes","Close openings and mark the action complete"]',
         'co2', 'decrease', 150, NULL, 1200, 1800, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('playbook-temperature-heat', 'Restore safe temperature and verify',
         'Inspect heating and safely raise a low indoor temperature.',
         '["Check the heater or heat-pump status","Confirm doors and windows are closed","Apply a safe heating adjustment and mark the action complete"]',
         'temperature', 'increase', 1, NULL, 1800, 3600, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('playbook-power-baseload', 'Inspect unusual baseload',
         'Identify and reduce unexpected continuous power use without switching equipment automatically.',
         '["Check the listed plugs and appliances","Turn off only equipment that is safe to stop","Mark the action complete after the load change"]',
         'power', 'decrease', 50, NULL, 300, 900, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
    this.migrateOutdoorLocationKeys();
    this.migrateSensorMeasurementBindings();
    const readingIdentityMigration = this.db.prepare("SELECT value FROM metadata WHERE key = 'reading_identity_v1'").get();
    if (!readingIdentityMigration) {
      if (!this.db.prepare("SELECT value FROM metadata WHERE key = 'reading_identity_v1'").get()) {
        this.db.exec(`
          DELETE FROM readings
          WHERE id NOT IN (SELECT MAX(id) FROM readings GROUP BY sensor_id, timestamp, source);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_identity
            ON readings(sensor_id, timestamp, source);
          INSERT INTO metadata(key, value) VALUES ('reading_identity_v1', 'complete');
        `);
      }
    }
    });
  }

  private migrateRevisionActors(): void {
    const actorExpression = `CASE actor
      WHEN 'hosted-user' THEN 'workspace-user'
      WHEN 'hosted-service' THEN 'system-service'
      WHEN 'local-migration' THEN 'system-service'
      ELSE actor END`;
    const observationSchema = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'observation_revisions'",
    ).get() as { sql: string } | undefined;
    const legacyObservationActor = observationSchema && this.db.prepare(`SELECT 1 FROM observation_revisions
      WHERE actor IN ('hosted-user', 'hosted-service', 'local-migration') LIMIT 1`).get();
    if (observationSchema && (!observationSchema.sql.includes("workspace-user")
      || !observationSchema.sql.includes("system-service") || legacyObservationActor)) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS prevent_observation_revision_insert_collision;
        DROP TRIGGER IF EXISTS prevent_observation_revision_update;
        DROP TRIGGER IF EXISTS prevent_observation_revision_delete;
        DROP TABLE IF EXISTS observation_revisions_next;
        CREATE TABLE observation_revisions_next (
          observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          changed_at TEXT NOT NULL,
          actor TEXT NOT NULL CHECK (actor IN (
            'local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service'
          )),
          changed_fields_json TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (observation_id, revision)
        );
        INSERT INTO observation_revisions_next
          (observation_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
        SELECT observation_id, revision, changed_at, ${actorExpression}, changed_fields_json, snapshot_json
          FROM observation_revisions;
        DROP TABLE observation_revisions;
        ALTER TABLE observation_revisions_next RENAME TO observation_revisions;
        CREATE INDEX idx_observation_revisions_changed
          ON observation_revisions(observation_id, changed_at, revision);
        CREATE TRIGGER prevent_observation_revision_insert_collision
          BEFORE INSERT ON observation_revisions
          WHEN EXISTS (SELECT 1 FROM observation_revisions
            WHERE observation_id = NEW.observation_id AND revision = NEW.revision)
          BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
        CREATE TRIGGER prevent_observation_revision_update
          BEFORE UPDATE ON observation_revisions
          BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
        CREATE TRIGGER prevent_observation_revision_delete
          BEFORE DELETE ON observation_revisions
          WHEN EXISTS (SELECT 1 FROM observations WHERE id = OLD.observation_id)
          BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
      `);
    }
    const maintenanceSchema = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'maintenance_task_revisions'",
    ).get() as { sql: string } | undefined;
    const legacyMaintenanceActor = maintenanceSchema && this.db.prepare(`SELECT 1 FROM maintenance_task_revisions
      WHERE actor IN ('hosted-user', 'hosted-service', 'local-migration') LIMIT 1`).get();
    if (maintenanceSchema && (!maintenanceSchema.sql.includes("workspace-user")
      || !maintenanceSchema.sql.includes("system-service") || legacyMaintenanceActor)) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_insert_collision;
        DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_update;
        DROP TRIGGER IF EXISTS prevent_maintenance_task_revision_delete;
        DROP TABLE IF EXISTS maintenance_task_revisions_next;
        CREATE TABLE maintenance_task_revisions_next (
          maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          changed_at TEXT NOT NULL,
          actor TEXT NOT NULL CHECK (actor IN (
            'local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service'
          )),
          changed_fields_json TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          PRIMARY KEY (maintenance_task_id, revision)
        );
        INSERT INTO maintenance_task_revisions_next
          (maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
        SELECT maintenance_task_id, revision, changed_at, ${actorExpression}, changed_fields_json, snapshot_json
          FROM maintenance_task_revisions;
        DROP TABLE maintenance_task_revisions;
        ALTER TABLE maintenance_task_revisions_next RENAME TO maintenance_task_revisions;
        CREATE INDEX idx_maintenance_task_revisions_changed
          ON maintenance_task_revisions(maintenance_task_id, changed_at, revision);
        CREATE TRIGGER prevent_maintenance_task_revision_insert_collision
          BEFORE INSERT ON maintenance_task_revisions
          WHEN EXISTS (SELECT 1 FROM maintenance_task_revisions
            WHERE maintenance_task_id = NEW.maintenance_task_id AND revision = NEW.revision)
          BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
        CREATE TRIGGER prevent_maintenance_task_revision_update
          BEFORE UPDATE ON maintenance_task_revisions
          BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
        CREATE TRIGGER prevent_maintenance_task_revision_delete
          BEFORE DELETE ON maintenance_task_revisions
          WHEN EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = OLD.maintenance_task_id)
          BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      `);
    }
  }

  private migrateOutdoorLocationKeys(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'outdoor_location_keys_v2'").get();
    if (migrated) return;
    this.immediateTransaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'outdoor_location_keys_v2'").get()) return;
      const houses = this.db.prepare("SELECT id, location_json FROM houses").all() as unknown as Array<{
        id: string;
        location_json: string | null;
      }>;
      const rekey = this.db.prepare(`UPDATE OR REPLACE outdoor_temperature_samples
        SET location_key = ? WHERE house_id = ? AND location_key = ?`);
      const prune = this.db.prepare(`DELETE FROM outdoor_temperature_samples
        WHERE house_id = ? AND location_key <> ?`);
      for (const house of houses) {
        let location: HouseLocation | undefined;
        try {
          location = house.location_json ? JSON.parse(house.location_json) as HouseLocation : undefined;
        } catch {
          location = undefined;
        }
        const allowedKey = outdoorLocationKey(location);
        if (location) {
          const legacyKey = `${location.latitude.toFixed(6)},${location.longitude.toFixed(6)}`;
          rekey.run(allowedKey, house.id, legacyKey);
        }
        // Removes precise historical coordinates and every superseded location.
        prune.run(house.id, allowedKey);
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('outdoor_location_keys_v2', 'complete')").run();
    });
  }

  private backfillLegacyMeasurements(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'measurement_eav_v2'").get();
    if (migrated) return;
    this.immediateTransaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'measurement_eav_v2'").get()) return;
      this.db.exec(`
        INSERT OR IGNORE INTO measurement_samples
          (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        SELECT sensor_id, 'temperature', temperature, '°C', timestamp, source, quality FROM readings;
        INSERT OR IGNORE INTO measurement_samples
          (sensor_id, metric, value, canonical_unit, timestamp, source, quality)
        SELECT sensor_id, 'humidity', humidity, '%', timestamp, source, quality FROM readings;
        INSERT INTO metadata(key, value) VALUES ('measurement_eav_v2', 'complete');
      `);
    });
  }

  /**
   * Gives the bundled demo an explicitly synthetic outdoor boundary so the physics UI is testable.
   * It is never used for a geolocated house and is labelled `mock` in every result.
   */
  private backfillSeedOutdoorTemperature(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_outdoor_temperature_v1'").get();
    if (migrated) return;
    this.immediateTransaction(() => {
    if (this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_outdoor_temperature_v1'").get()) return;
    const house = this.getHouse("house-main");
    const existing = house
      ? this.db.prepare("SELECT 1 FROM outdoor_temperature_samples WHERE house_id = ? LIMIT 1").get(house.id)
      : null;
    if (house && !house.location && !existing) {
      const readings = this.db.prepare(`SELECT timestamp, temperature FROM readings
        WHERE sensor_id = 'sensor-01' AND source = 'mock' ORDER BY timestamp ASC, id ASC`)
        .all() as unknown as Array<{ timestamp: string; temperature: number }>;
      if (readings.length > MIN_SEED_OUTDOOR_READINGS) {
        const tauHours = 8;
        const liftC = 16;
        const insert = this.db.prepare(`INSERT OR IGNORE INTO outdoor_temperature_samples
          (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name)
          VALUES (?, ?, ?, ?, 'mock', ?, NULL, ?)`);
        let lastOutdoorC = readings[0]?.temperature ?? 0;
        for (let index = 0; index < readings.length - 1; index += 1) {
          const current = readings[index];
          const next = readings[index + 1];
          if (!current || !next) continue;
          const dtHours = (Date.parse(next.timestamp) - Date.parse(current.timestamp)) / 3_600_000;
          if (!(dtHours > 0)) continue;
          const memory = Math.exp(-dtHours / tauHours);
          lastOutdoorC = (next.temperature - memory * current.temperature) / (1 - memory) - liftC;
          insert.run(house.id, outdoorLocationKey(), current.timestamp, lastOutdoorC, current.timestamp, "Synthetic demo boundary");
        }
        const latest = readings.at(-1);
        if (latest) insert.run(house.id, outdoorLocationKey(), latest.timestamp, lastOutdoorC, latest.timestamp, "Synthetic demo boundary");
      }
    }
    this.db.prepare("INSERT INTO metadata(key, value) VALUES ('seed_outdoor_temperature_v1', 'complete')").run();
    });
  }

  private migrateSensorMeasurementBindings(): void {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_measurement_bindings_v2'").get();
    if (migrated) return;
    this.immediateTransaction(() => {
      if (this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_measurement_bindings_v2'").get()) return;
      const rows = this.db.prepare(`SELECT id, measurement_entity_ids_json, temperature_entity_id, humidity_entity_id
        FROM sensors`).all() as unknown as Array<{
          id: string;
          measurement_entity_ids_json: string | null;
          temperature_entity_id: string | null;
          humidity_entity_id: string | null;
        }>;
      const insert = this.db.prepare(`INSERT OR IGNORE INTO sensor_measurement_bindings(sensor_id, metric, entity_id)
        VALUES (?, ?, ?)`);
      for (const row of rows) {
        const bindings = row.measurement_entity_ids_json ? parseJson<Record<string, string>>(row.measurement_entity_ids_json) : {};
        if (row.temperature_entity_id) bindings.temperature ??= row.temperature_entity_id;
        if (row.humidity_entity_id) bindings.humidity ??= row.humidity_entity_id;
        for (const [metric, entityId] of Object.entries(bindings)) {
          if (this.getMeasurementDefinition(metric)) insert.run(row.id, metric, entityId);
        }
      }
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('sensor_measurement_bindings_v2', 'complete')").run();
    });
  }

  /**
   * Links legacy room labels only when one room on the sensor's selected floor
   * has the exact same name. The completion marker is important: an explicitly
   * cleared relationship must not be silently recreated on a later restart.
   */
  private migrateSensorRoomIds(): void {
    if (this.db.prepare("SELECT value FROM metadata WHERE key = 'sensor_room_ids_v1'").get()) return;
    const rows = this.db.prepare(`SELECT sensor.id, sensor.floor_id, sensor.room, house.floors_json
      FROM sensors AS sensor
      JOIN houses AS house ON house.id = sensor.house_id
      WHERE sensor.room_id IS NULL
      ORDER BY sensor.id`).all() as unknown as Array<{
        id: string;
        floor_id: string;
        room: string;
        floors_json: string;
      }>;
    const link = this.db.prepare("UPDATE sensors SET room_id = ? WHERE id = ? AND room_id IS NULL");
    for (const row of rows) {
      try {
        const floor = parseJson<Floor[]>(row.floors_json).find((candidate) => candidate.id === row.floor_id);
        const matches = floor?.rooms.filter((candidate) => candidate.name === row.room) ?? [];
        if (matches.length === 1) link.run(matches[0]!.id, row.id);
      } catch {
        // Preserve an unlinked legacy label when old layout JSON cannot be
        // interpreted safely; normal layout validation can repair it later.
      }
    }
    this.db.prepare("INSERT INTO metadata(key, value) VALUES ('sensor_room_ids_v1', 'complete')").run();
  }

  seed(): void {
    const seeded = this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_version'").get() as { value: string } | undefined;
    if (seeded) return;
    this.immediateTransaction(() => {
    if (this.db.prepare("SELECT value FROM metadata WHERE key = 'seed_version'").get()) return;

    const now = new Date().toISOString();
    const floors: Floor[] = [
      {
        id: "floor-ground",
        name: "Ground floor",
        type: "ground",
        width: 14,
        height: 10,
        elevation: 0,
        ceilingHeight: 2.8,
        wallHeight: 2.8,
        walls: [
          { id: "g-n", from: { x: 0, y: 0 }, to: { x: 14, y: 0 } },
          { id: "g-e", from: { x: 14, y: 0 }, to: { x: 14, y: 10 } },
          { id: "g-s", from: { x: 14, y: 10 }, to: { x: 0, y: 10 } },
          { id: "g-w", from: { x: 0, y: 10 }, to: { x: 0, y: 0 } },
          { id: "g-mid-v", from: { x: 8, y: 0 }, to: { x: 8, y: 10 } },
          { id: "g-mid-h", from: { x: 8, y: 5 }, to: { x: 14, y: 5 } },
        ],
        rooms: [
          { id: "living", name: "Living room", points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 10 }, { x: 0, y: 10 }] },
          { id: "kitchen", name: "Kitchen", points: [{ x: 8, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 5 }, { x: 8, y: 5 }] },
          { id: "utility", name: "Utility", points: [{ x: 8, y: 5 }, { x: 14, y: 5 }, { x: 14, y: 10 }, { x: 8, y: 10 }] },
        ],
      },
      {
        id: "floor-upper",
        name: "Upper floor",
        type: "upper",
        width: 14,
        height: 10,
        elevation: 3,
        ceilingHeight: 2.6,
        wallHeight: 2.6,
        walls: [
          { id: "u-n", from: { x: 0, y: 0 }, to: { x: 14, y: 0 } },
          { id: "u-e", from: { x: 14, y: 0 }, to: { x: 14, y: 10 } },
          { id: "u-s", from: { x: 14, y: 10 }, to: { x: 0, y: 10 } },
          { id: "u-w", from: { x: 0, y: 10 }, to: { x: 0, y: 0 } },
          { id: "u-mid-v", from: { x: 7, y: 0 }, to: { x: 7, y: 10 } },
          { id: "u-mid-h", from: { x: 7, y: 5 }, to: { x: 14, y: 5 } },
        ],
        rooms: [
          { id: "bedroom", name: "Bedroom", points: [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 10 }, { x: 0, y: 10 }] },
          { id: "office", name: "Office", points: [{ x: 7, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 5 }, { x: 7, y: 5 }] },
          { id: "bathroom", name: "Bathroom", points: [{ x: 7, y: 5 }, { x: 14, y: 5 }, { x: 14, y: 10 }, { x: 7, y: 10 }] },
        ],
      },
    ];
    const sensors: Sensor[] = [
      ["sensor-01", "Living room — window", "floor-ground", "Living room", 1.5, 2, 1.2],
      ["sensor-02", "Living room — hall", "floor-ground", "Living room", 6.5, 7.5, 1.2],
      ["sensor-03", "Kitchen", "floor-ground", "Kitchen", 11, 2.5, 1.3],
      ["sensor-04", "Utility room", "floor-ground", "Utility", 11, 7.5, 1.3],
      ["sensor-05", "Entrance", "floor-ground", "Living room", 4, 8.5, 1.2],
      ["sensor-06", "Bedroom — window", "floor-upper", "Bedroom", 1.5, 2, 4.2],
      ["sensor-07", "Bedroom — hall", "floor-upper", "Bedroom", 5.5, 7.5, 4.2],
      ["sensor-08", "Office", "floor-upper", "Office", 10.5, 2.5, 4.3],
      ["sensor-09", "Bathroom", "floor-upper", "Bathroom", 10.5, 7.5, 4.3],
      ["sensor-10", "Attic access", "floor-upper", "Bathroom", 13, 9, 5.5],
    ].map(([id, name, floorId, room, x, y, z]) => ({
      id: String(id), houseId: "house-main", floorId: String(floorId), name: String(name), room: String(room),
      model: "TP-Link Tapo T310/T315", x: Number(x), y: Number(y), z: Number(z), tags: ["seeded"], enabled: true,
    }));

      this.db.prepare(`INSERT INTO houses
        (id, property_id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("house-main", DEFAULT_PROPERTY_ID, "My home", "Europe/Helsinki", null, null, null, JSON.stringify(floors), now, now);
      const sensorStatement = this.db.prepare(`INSERT INTO sensors
        (id, house_id, floor_id, name, room_id, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id, tags_json, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const sensor of sensors) {
        const roomId = floors.find((floor) => floor.id === sensor.floorId)?.rooms
          .find((room) => room.name === sensor.room)?.id ?? null;
        sensorStatement.run(sensor.id, sensor.houseId, sensor.floorId, sensor.name, roomId, sensor.room, sensor.model,
          sensor.x, sensor.y, sensor.z, null, null, null, JSON.stringify(sensor.tags), 1);
      }
      const readingStatement = this.db.prepare(`INSERT INTO readings
        (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const end = Date.now();
      for (let step = 288; step >= 0; step -= 1) {
        const timestamp = new Date(end - step * 5 * 60_000).toISOString();
        for (let index = 0; index < sensors.length; index += 1) {
          const phase = (288 - step) / 288 * Math.PI * 2;
          const temperature = 20.4 + Math.sin(phase - 1.1) * 1.25 + (index % 5) * 0.13 + Math.sin(step * 0.31 + index) * 0.12;
          const bathroomPulse = index === 8 && step > 45 && step < 60 ? 17 * Math.sin((step - 45) / 15 * Math.PI) : 0;
          const humidity = 43 + Math.sin(phase + 0.65) * 5 + (index % 3) * 1.4 + bathroomPulse;
          readingStatement.run(sensors[index]!.id, timestamp, Number(temperature.toFixed(2)), Number(humidity.toFixed(2)), 96 - (index % 8), "mock", "good");
        }
      }
      this.db.prepare(`INSERT INTO alert_rules
        (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled, telegram_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("rule-high-humidity", "Persistent high humidity", null, "humidity", "gte", 65, 900, "warning", 1, 1, 0);
      this.db.prepare(`INSERT INTO static_parameters
        (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("parameter-year-built", "house-main", "house", "house-main", "yearBuilt", JSON.stringify(1998), null, "Year built");
      this.db.prepare("INSERT INTO metadata(key, value) VALUES ('seed_version', '1')").run();
    });
  }

  close(): void {
    // Make file-backed shutdown deterministic on Windows as well as POSIX.
    // Schema-rebuild migrations can otherwise leave a WAL checkpoint pending
    // briefly after DatabaseSync.close(), which prevents immediate backup or
    // test-directory rotation even though the connection is closed.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("PRAGMA journal_mode = DELETE");
    } catch { /* The database may be read-only or already closing. */ }
    this.db.close();
  }

  listProperties(limit = DEFAULT_COLLECTION_LIMIT, offset = 0): Property[] {
    const rows = this.db.prepare("SELECT * FROM properties ORDER BY name, id LIMIT ? OFFSET ?")
      .all(boundedCollectionLimit(limit), boundedCollectionOffset(offset)) as unknown as PropertyRow[];
    return rows.map(propertyFromRow);
  }

  getProperty(id: string): Property | null {
    const row = this.db.prepare("SELECT * FROM properties WHERE id = ?").get(id) as unknown as PropertyRow | undefined;
    return row ? propertyFromRow(row) : null;
  }

  private assertTelemetryResourceIdAvailable(
    resourceType: "property" | "house" | "sensor",
    resourceId: string,
  ): void {
    const retired = this.db.prepare(`SELECT 1 FROM retired_telemetry_resource_ids
      WHERE resource_type = ? AND resource_id = ? LIMIT 1`).get(resourceType, resourceId);
    if (!retired) return;
    throw new ClimateDataValidationError(
      409,
      `${resourceType.toUpperCase()}_ID_RETIRED`,
      `The ${resourceType} id ${resourceId} was previously retired and cannot be reused`,
    );
  }

  createProperty(input: PropertyCreateInput): Property {
    const timestamp = new Date().toISOString();
    const property: Property = {
      id: input.id ?? randomUUID(),
      name: this.propertyRequiredText(input.name, "Property name", 200),
      description: this.propertyOptionalText(input.description ?? null, "Property description", 5_000),
      location: input.location ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.assertTelemetryResourceIdAvailable("property", property.id);
    if (property.location) this.validateHouseLocation(property.location);
    return this.immediateTransaction(() => {
      try {
        this.db.prepare(`INSERT INTO properties
          (id, name, description, location_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(property.id, property.name, property.description,
            property.location ? JSON.stringify(property.location) : null, property.createdAt, property.updatedAt);
        this.db.prepare(`INSERT INTO property_electricity_configs
          (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
           contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
          VALUES (?, 'porssisahko', ?, 1, 0, 'spot', NULL, NULL, NULL, NULL, NULL, ?)`)
          .run(property.id, DEFAULT_ELECTRICITY_PRICE_ENDPOINT, timestamp);
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: properties.id")) {
          throw new ClimateDataValidationError(409, "PROPERTY_ID_CONFLICT", `Property ${property.id} already exists`);
        }
        throw error;
      }
      return property;
    });
  }

  getPropertyElectricityConfig(propertyId: string): PropertyElectricityConfig | null {
    const row = this.db.prepare("SELECT * FROM property_electricity_configs WHERE property_id = ?")
      .get(propertyId) as unknown as PropertyElectricityConfigRow | undefined;
    return row ? electricityConfigFromRow(row) : null;
  }

  listPropertyElectricityConfigs(): PropertyElectricityConfig[] {
    const rows = this.db.prepare("SELECT * FROM property_electricity_configs ORDER BY property_id")
      .all() as unknown as PropertyElectricityConfigRow[];
    return rows.map(electricityConfigFromRow);
  }

  updatePropertyElectricityConfig(propertyId: string, input: PropertyElectricityConfigInput): PropertyElectricityConfig | null {
    if (!this.getProperty(propertyId)) return null;
    if (!["porssisahko", "custom"].includes(input.provider)) {
      throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_PROVIDER", "Unsupported electricity price provider");
    }
    let endpoint: URL;
    try { endpoint = new URL(input.endpointUrl); } catch {
      throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_ENDPOINT", "Electricity price endpoint must be a valid URL");
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_ENDPOINT", "Electricity price endpoint must use HTTPS without embedded credentials");
    }
    if (!Number.isFinite(input.marginCentsPerKwh) || input.marginCentsPerKwh < -100 || input.marginCentsPerKwh > 100) {
      throw new ClimateDataValidationError(400, "INVALID_ELECTRICITY_MARGIN", "Electricity margin must be between -100 and 100 cents/kWh");
    }
    if (!["spot", "fixed", "other"].includes(input.contractType)) {
      throw new ClimateDataValidationError(400, "INVALID_CONTRACT_TYPE", "Unsupported electricity contract type");
    }
    if (input.monthlyFeeEur !== undefined && input.monthlyFeeEur !== null
      && (!Number.isFinite(input.monthlyFeeEur) || input.monthlyFeeEur < 0 || input.monthlyFeeEur > 100_000)) {
      throw new ClimateDataValidationError(400, "INVALID_MONTHLY_FEE", "Monthly fee must be between 0 and 100000 euros");
    }
    const timestamp = new Date().toISOString();
    const text = (value: string | null | undefined, label: string): string | null => (
      this.propertyOptionalText(value ?? null, label, 200)
    );
    this.db.prepare(`INSERT INTO property_electricity_configs
      (property_id, provider, endpoint_url, enabled, margin_cents_per_kwh, contract_type,
       contract_name, retailer, monthly_fee_eur, last_fetched_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(property_id) DO UPDATE SET provider = excluded.provider, endpoint_url = excluded.endpoint_url,
        enabled = excluded.enabled, margin_cents_per_kwh = excluded.margin_cents_per_kwh,
        contract_type = excluded.contract_type, contract_name = excluded.contract_name,
        retailer = excluded.retailer, monthly_fee_eur = excluded.monthly_fee_eur,
        last_error = NULL, updated_at = excluded.updated_at`)
      .run(propertyId, input.provider, endpoint.toString(), input.enabled ? 1 : 0, input.marginCentsPerKwh,
        input.contractType, text(input.contractName, "Contract name"), text(input.retailer, "Retailer"),
        input.monthlyFeeEur ?? null, timestamp);
    this.db.prepare(`UPDATE electricity_price_points SET margin_cents_per_kwh = ?
      WHERE property_id = ? AND end_at > ?`).run(input.marginCentsPerKwh, propertyId, timestamp);
    return this.getPropertyElectricityConfig(propertyId);
  }

  storePropertyElectricityPrices(
    propertyId: string,
    prices: Array<{ startAt: string; endAt: string; rawPriceCentsPerKwh: number }>,
    fetchedAt: string,
  ): void {
    const margin = this.getPropertyElectricityConfig(propertyId)?.marginCentsPerKwh ?? 0;
    this.immediateTransaction(() => {
      const statement = this.db.prepare(`INSERT INTO electricity_price_points
        (property_id, start_at, end_at, raw_price_cents_per_kwh, margin_cents_per_kwh, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(property_id, start_at) DO UPDATE SET end_at = excluded.end_at,
          raw_price_cents_per_kwh = excluded.raw_price_cents_per_kwh,
          margin_cents_per_kwh = CASE
            WHEN electricity_price_points.end_at <= excluded.fetched_at THEN electricity_price_points.margin_cents_per_kwh
            ELSE excluded.margin_cents_per_kwh
          END,
          fetched_at = excluded.fetched_at`);
      for (const price of prices) {
        statement.run(propertyId, price.startAt, price.endAt, price.rawPriceCentsPerKwh, margin, fetchedAt);
      }
      this.db.prepare(`UPDATE property_electricity_configs
        SET last_fetched_at = ?, last_error = NULL, updated_at = ? WHERE property_id = ?`)
        .run(fetchedAt, fetchedAt, propertyId);
    });
  }

  setPropertyElectricityFetchError(propertyId: string, message: string): void {
    this.db.prepare("UPDATE property_electricity_configs SET last_error = ?, updated_at = ? WHERE property_id = ?")
      .run(message.slice(0, 1_000), new Date().toISOString(), propertyId);
  }

  listPropertyElectricityPrices(propertyId: string, from: string, to: string): PropertyElectricityPricePoint[] {
    const config = this.getPropertyElectricityConfig(propertyId);
    if (!config) return [];
    const rows = this.db.prepare(`SELECT * FROM electricity_price_points
      WHERE property_id = ? AND end_at >= ? AND start_at <= ? ORDER BY start_at`)
      .all(propertyId, from, to) as unknown as ElectricityPricePointRow[];
    return rows.map((row) => {
      const effective = row.raw_price_cents_per_kwh + row.margin_cents_per_kwh;
      return {
        propertyId: row.property_id,
        startAt: row.start_at,
        endAt: row.end_at,
        rawPriceCentsPerKwh: row.raw_price_cents_per_kwh,
        effectivePriceCentsPerKwh: effective,
        effectivePriceEurPerKwh: effective / 100,
        fetchedAt: row.fetched_at,
      };
    });
  }

  getCurrentPropertyElectricityPrice(propertyId: string, at = new Date().toISOString()): PropertyElectricityPricePoint | null {
    return this.listPropertyElectricityPrices(propertyId, at, at)[0] ?? null;
  }

  /**
   * Prices every cumulative-meter delta by the exact price intervals it overlaps.
   * A delta spanning several price intervals is distributed by overlap duration;
   * counter resets contribute the new post-reset counter value.
   */
  energyCostAggregate(query: EnergyCostAggregateQuery): EnergyCostAggregateRecord {
    const row = this.db.prepare(`WITH boundary_sample AS (
        SELECT id, timestamp, value FROM measurement_samples
        WHERE sensor_id = ? AND metric = 'energy' AND quality <> 'stale' AND timestamp < ?
        ORDER BY timestamp DESC, id DESC LIMIT 1
      ), window_samples AS (
        SELECT id, timestamp, value FROM measurement_samples
        WHERE sensor_id = ? AND metric = 'energy' AND quality <> 'stale'
          AND timestamp >= ? AND timestamp <= ?
      ), deduplicated AS (
        SELECT timestamp, value FROM (
          SELECT id, timestamp, value,
            ROW_NUMBER() OVER (PARTITION BY timestamp ORDER BY id DESC) AS sample_rank
          FROM (SELECT * FROM boundary_sample UNION ALL SELECT * FROM window_samples)
        ) WHERE sample_rank = 1
      ), ordered AS (
        SELECT timestamp AS current_at, value AS current_value,
          LAG(timestamp) OVER (ORDER BY timestamp) AS previous_at,
          LAG(value) OVER (ORDER BY timestamp) AS previous_value
        FROM deduplicated
      ), deltas AS (
        SELECT previous_at, current_at,
          CASE WHEN previous_at < ? THEN ? ELSE previous_at END AS window_start,
          CASE WHEN current_value >= previous_value THEN current_value - previous_value
            ELSE MAX(0, current_value) END AS base_delta_kwh,
          (julianday(current_at) - julianday(previous_at)) * 86400000.0 AS full_duration_ms
        FROM ordered
        WHERE previous_at IS NOT NULL AND current_at > ?
          AND current_value >= 0 AND previous_value >= 0
          AND julianday(current_at) > julianday(previous_at)
      ), normalized AS (
        SELECT *,
          base_delta_kwh * ((julianday(current_at) - julianday(window_start)) * 86400000.0)
            / full_duration_ms AS window_delta_kwh,
          (julianday(current_at) - julianday(window_start)) * 86400000.0 AS window_duration_ms
        FROM deltas
      ), priced AS (
        SELECT normalized.*,
          price.raw_price_cents_per_kwh, price.margin_cents_per_kwh,
          (julianday(MIN(normalized.current_at, price.end_at))
            - julianday(MAX(normalized.window_start, price.start_at))) * 86400000.0 AS overlap_ms
        FROM normalized JOIN electricity_price_points AS price
          ON price.property_id = ?
          AND price.start_at < normalized.current_at
          AND price.end_at > normalized.window_start
      ), allocations AS (
        SELECT overlap_ms,
          base_delta_kwh * overlap_ms / full_duration_ms AS allocated_kwh,
          raw_price_cents_per_kwh + margin_cents_per_kwh AS effective_price_cents_per_kwh
        FROM priced WHERE overlap_ms > 0
      )
      SELECT
        (SELECT COUNT(*) FROM normalized) AS delta_count,
        (SELECT COALESCE(SUM(window_delta_kwh), 0) FROM normalized) AS consumption_kwh,
        (SELECT COALESCE(SUM(allocated_kwh), 0) FROM allocations) AS priced_consumption_kwh,
        (SELECT COALESCE(SUM(allocated_kwh * effective_price_cents_per_kwh / 100.0), 0) FROM allocations) AS cost_eur,
        (SELECT COALESCE(SUM(window_duration_ms), 0) FROM normalized) AS total_duration_ms,
        (SELECT COALESCE(SUM(overlap_ms), 0) FROM allocations) AS priced_duration_ms,
        (SELECT MIN(window_start) FROM normalized) AS coverage_from,
        (SELECT MAX(current_at) FROM normalized) AS coverage_until`)
      .get(query.sensorId, query.from, query.sensorId, query.from, query.to,
        query.from, query.from, query.from, query.propertyId) as unknown as EnergyCostAggregateRow;
    return {
      deltaCount: Number(row.delta_count ?? 0),
      consumptionKwh: Number(row.consumption_kwh ?? 0),
      pricedConsumptionKwh: Number(row.priced_consumption_kwh ?? 0),
      costEur: Number(row.cost_eur ?? 0),
      totalDurationMs: Number(row.total_duration_ms ?? 0),
      pricedDurationMs: Number(row.priced_duration_ms ?? 0),
      coverageFrom: row.coverage_from,
      coverageUntil: row.coverage_until,
    };
  }

  updateProperty(id: string, patch: PropertyPatch): Property | null {
    return this.immediateTransaction(() => {
      const current = this.getProperty(id);
      if (!current) return null;
      const next: Property = { ...current, updatedAt: this.nextUpdatedAt(current.updatedAt) };
      if (patch.name !== undefined) next.name = this.propertyRequiredText(patch.name, "Property name", 200);
      if (patch.description !== undefined) {
        next.description = this.propertyOptionalText(patch.description, "Property description", 5_000);
      }
      if (patch.location !== undefined) next.location = patch.location;
      if (next.location) this.validateHouseLocation(next.location);
      this.db.prepare(`UPDATE properties SET name = ?, description = ?, location_json = ?, updated_at = ? WHERE id = ?`)
        .run(next.name, next.description, next.location ? JSON.stringify(next.location) : null, next.updatedAt, id);
      return next;
    });
  }

  deleteProperty(id: string): boolean {
    if (id === DEFAULT_PROPERTY_ID) {
      throw new ClimateDataValidationError(
        409,
        "DEFAULT_PROPERTY_REQUIRED",
        "The local default property cannot be deleted",
      );
    }
    this.requireImmutableTelemetryLineage("property", id);
    try {
      return Number(this.db.prepare("DELETE FROM properties WHERE id = ?").run(id).changes) > 0;
    } catch (error) {
      if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new ClimateDataValidationError(
          409,
          "PROPERTY_IN_USE",
          `Property ${id} still contains houses, areas, equipment, notes, or maintenance tasks`,
        );
      }
      throw error;
    }
  }

  listPropertyAreas(propertyId?: string, limit = DEFAULT_COLLECTION_LIMIT, offset = 0): PropertyArea[] {
    const rows = (propertyId
      ? this.db.prepare("SELECT * FROM property_areas WHERE property_id = ? ORDER BY name, id LIMIT ? OFFSET ?")
        .all(propertyId, boundedCollectionLimit(limit), boundedCollectionOffset(offset))
      : this.db.prepare("SELECT * FROM property_areas ORDER BY name, id LIMIT ? OFFSET ?")
        .all(boundedCollectionLimit(limit), boundedCollectionOffset(offset))) as unknown as PropertyAreaRow[];
    return rows.map(propertyAreaFromRow);
  }

  getPropertyArea(id: string): PropertyArea | null {
    const row = this.db.prepare("SELECT * FROM property_areas WHERE id = ?").get(id) as unknown as PropertyAreaRow | undefined;
    return row ? propertyAreaFromRow(row) : null;
  }

  createPropertyArea(input: PropertyAreaInput): PropertyArea {
    return this.immediateTransaction(() => {
      if (!this.getProperty(input.propertyId)) {
        throw new ClimateDataValidationError(404, "AREA_PROPERTY_NOT_FOUND", `Property ${input.propertyId} does not exist`);
      }
      const timestamp = new Date().toISOString();
      const area: PropertyArea = {
        id: input.id ?? randomUUID(),
        propertyId: input.propertyId,
        name: this.propertyRequiredText(input.name, "Area name", 200),
        kind: input.kind,
        description: this.propertyOptionalText(input.description ?? null, "Area description", 5_000),
        ...(input.location ? { location: structuredClone(input.location) } : {}),
        polygon: structuredClone(input.polygon),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.validatePropertyArea(area);
      try {
        this.db.prepare(`INSERT INTO property_areas
          (id, property_id, name, kind, description, location_json, polygon_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(area.id, area.propertyId, area.name, area.kind, area.description,
            area.location ? JSON.stringify(area.location) : null, JSON.stringify(area.polygon),
            area.createdAt, area.updatedAt);
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
          throw new ClimateDataValidationError(409, "AREA_ID_CONFLICT", `Area ${area.id} already exists`);
        }
        throw error;
      }
      return area;
    });
  }

  updatePropertyArea(
    id: string,
    patch: PropertyAreaPatch,
    actor: LocalMaintenanceTaskRevisionActor = "local-rest",
  ): PropertyArea | null {
    return this.immediateTransaction(() => {
      const current = this.getPropertyArea(id);
      if (!current) return null;
      if (patch.propertyId !== undefined && !this.getProperty(patch.propertyId)) {
        throw new ClimateDataValidationError(404, "AREA_PROPERTY_NOT_FOUND", `Property ${patch.propertyId} does not exist`);
      }
      if (patch.propertyId !== undefined && patch.propertyId !== current.propertyId) {
        this.ensureScopeMoveCanDetachHouses(
          `task.area_id = ? OR task.equipment_id IN (SELECT id FROM area_equipment WHERE area_id = ?)`,
          [id, id],
          patch.propertyId,
        );
      }
      const affectedTasks = patch.propertyId !== undefined && patch.propertyId !== current.propertyId
        ? this.maintenanceTasksBeforeScopeMove(
          `area_id = ? OR equipment_id IN (SELECT id FROM area_equipment WHERE area_id = ?)`,
          [id, id],
        )
        : [];
      const next: PropertyArea = {
        ...current,
        ...(patch.propertyId !== undefined ? { propertyId: patch.propertyId } : {}),
        ...(patch.name !== undefined ? { name: this.propertyRequiredText(patch.name, "Area name", 200) } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.description !== undefined
          ? { description: this.propertyOptionalText(patch.description, "Area description", 5_000) }
          : {}),
        ...(patch.polygon !== undefined ? { polygon: structuredClone(patch.polygon) } : {}),
        updatedAt: this.nextUpdatedAt(current.updatedAt),
      };
      if (patch.location === null) delete next.location;
      else if (patch.location !== undefined) next.location = structuredClone(patch.location);
      this.validatePropertyArea(next);
      this.db.prepare(`UPDATE property_areas
        SET property_id = ?, name = ?, kind = ?, description = ?, location_json = ?, polygon_json = ?, updated_at = ? WHERE id = ?`)
        .run(next.propertyId, next.name, next.kind, next.description,
          next.location ? JSON.stringify(next.location) : null, JSON.stringify(next.polygon), next.updatedAt, id);
      this.recordScopeMoveMaintenanceRevisions(affectedTasks, actor);
      return next;
    });
  }

  deletePropertyArea(id: string): boolean {
    try {
      return Number(this.db.prepare("DELETE FROM property_areas WHERE id = ?").run(id).changes) > 0;
    } catch (error) {
      if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new ClimateDataValidationError(
          409,
          "AREA_IN_USE",
          `Area ${id} is referenced by equipment, notes, or maintenance tasks`,
        );
      }
      throw error;
    }
  }

  listAreaEquipment(filters: {
    propertyId?: string;
    areaId?: string;
    limit?: number;
    offset?: number;
  } = {}): AreaEquipment[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.propertyId) { clauses.push("property_id = ?"); values.push(filters.propertyId); }
    if (filters.areaId) { clauses.push("area_id = ?"); values.push(filters.areaId); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM area_equipment${where} ORDER BY name, id LIMIT ? OFFSET ?`)
      .all(...values, boundedCollectionLimit(filters.limit), boundedCollectionOffset(filters.offset)) as unknown as AreaEquipmentRow[];
    return rows.map(areaEquipmentFromRow);
  }

  getAreaEquipment(id: string): AreaEquipment | null {
    const row = this.db.prepare("SELECT * FROM area_equipment WHERE id = ?").get(id) as unknown as AreaEquipmentRow | undefined;
    return row ? areaEquipmentFromRow(row) : null;
  }

  createAreaEquipment(input: AreaEquipmentInput): AreaEquipment {
    return this.immediateTransaction(() => {
      const area = this.getPropertyArea(input.areaId);
      if (!area) {
        throw new ClimateDataValidationError(404, "EQUIPMENT_AREA_NOT_FOUND", `Area ${input.areaId} does not exist`);
      }
      const timestamp = new Date().toISOString();
      const equipment: AreaEquipment = {
        id: input.id ?? randomUUID(),
        propertyId: input.propertyId ?? area.propertyId,
        areaId: input.areaId,
        name: this.propertyRequiredText(input.name, "Equipment name", 200),
        kind: this.propertyRequiredText(input.kind, "Equipment kind", 200),
        manufacturer: this.propertyOptionalText(input.manufacturer ?? null, "Equipment manufacturer", 200),
        model: this.propertyOptionalText(input.model ?? null, "Equipment model", 200),
        serialNumber: this.propertyOptionalText(input.serialNumber ?? null, "Equipment serial number", 200),
        status: input.status ?? "active",
        notes: this.propertyOptionalText(input.notes ?? null, "Equipment notes", 5_000),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.validateAreaEquipment(equipment);
      try {
        this.db.prepare(`INSERT INTO area_equipment
          (id, property_id, area_id, name, kind, manufacturer, model, serial_number, status, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(equipment.id, equipment.propertyId, equipment.areaId, equipment.name, equipment.kind,
            equipment.manufacturer, equipment.model, equipment.serialNumber, equipment.status, equipment.notes,
            equipment.createdAt, equipment.updatedAt);
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: area_equipment.id")) {
          throw new ClimateDataValidationError(409, "EQUIPMENT_ID_CONFLICT", `Equipment ${equipment.id} already exists`);
        }
        throw error;
      }
      return equipment;
    });
  }

  updateAreaEquipment(
    id: string,
    patch: AreaEquipmentPatch,
    actor: LocalMaintenanceTaskRevisionActor = "local-rest",
  ): AreaEquipment | null {
    return this.immediateTransaction(() => {
      const current = this.getAreaEquipment(id);
      if (!current) return null;
      const targetArea = patch.areaId === undefined ? null : this.getPropertyArea(patch.areaId);
      if (patch.areaId !== undefined && !targetArea) {
        throw new ClimateDataValidationError(404, "EQUIPMENT_AREA_NOT_FOUND", `Area ${patch.areaId} does not exist`);
      }
      if (targetArea && targetArea.propertyId !== current.propertyId) {
        this.ensureScopeMoveCanDetachHouses("task.equipment_id = ?", [id], targetArea.propertyId);
      }
      const affectedTasks = patch.areaId !== undefined && patch.areaId !== current.areaId
        ? this.maintenanceTasksBeforeScopeMove("equipment_id = ?", [id])
        : [];
      const next: AreaEquipment = {
        ...current,
        ...(targetArea ? { propertyId: targetArea.propertyId } : {}),
        ...(patch.areaId !== undefined ? { areaId: patch.areaId } : {}),
        ...(patch.name !== undefined ? { name: this.propertyRequiredText(patch.name, "Equipment name", 200) } : {}),
        ...(patch.kind !== undefined ? { kind: this.propertyRequiredText(patch.kind, "Equipment kind", 200) } : {}),
        ...(patch.manufacturer !== undefined
          ? { manufacturer: this.propertyOptionalText(patch.manufacturer, "Equipment manufacturer", 200) }
          : {}),
        ...(patch.model !== undefined ? { model: this.propertyOptionalText(patch.model, "Equipment model", 200) } : {}),
        ...(patch.serialNumber !== undefined
          ? { serialNumber: this.propertyOptionalText(patch.serialNumber, "Equipment serial number", 200) }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.notes !== undefined ? { notes: this.propertyOptionalText(patch.notes, "Equipment notes", 5_000) } : {}),
        updatedAt: this.nextUpdatedAt(current.updatedAt),
      };
      this.validateAreaEquipment(next);
      try {
        this.db.prepare(`UPDATE area_equipment SET property_id = ?, area_id = ?, name = ?, kind = ?, manufacturer = ?, model = ?,
          serial_number = ?, status = ?, notes = ?, updated_at = ? WHERE id = ?`)
          .run(next.propertyId, next.areaId, next.name, next.kind, next.manufacturer, next.model, next.serialNumber, next.status,
            next.notes, next.updatedAt, id);
      } catch (error) {
        if (error instanceof Error && error.message.includes("EQUIPMENT_AREA_MOVE_ORPHANS_TASK")) {
          throw new ClimateDataValidationError(
            409,
            "EQUIPMENT_AREA_MOVE_ORPHANS_TASK",
            "Update or remove maintenance tasks bound to this equipment and its current area before moving it",
          );
        }
        throw error;
      }
      this.recordScopeMoveMaintenanceRevisions(affectedTasks, actor);
      return next;
    });
  }

  deleteAreaEquipment(id: string): boolean {
    try {
      return Number(this.db.prepare("DELETE FROM area_equipment WHERE id = ?").run(id).changes) > 0;
    } catch (error) {
      if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new ClimateDataValidationError(
          409,
          "EQUIPMENT_IN_USE",
          `Equipment ${id} is referenced by notes or maintenance tasks`,
        );
      }
      throw error;
    }
  }

  listPropertyNotes(filters: {
    propertyId?: string;
    houseId?: string;
    areaId?: string;
    equipmentId?: string;
    limit?: number;
    offset?: number;
  } = {}): PropertyNote[] {
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, value] of [
      ["property_id", filters.propertyId], ["house_id", filters.houseId], ["area_id", filters.areaId],
      ["equipment_id", filters.equipmentId],
    ] as const) {
      if (value) { clauses.push(`${column} = ?`); values.push(value); }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM property_notes${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
      .all(...values, boundedCollectionLimit(filters.limit), boundedCollectionOffset(filters.offset)) as unknown as PropertyNoteRow[];
    return rows.map(propertyNoteFromRow);
  }

  getPropertyNote(id: string): PropertyNote | null {
    const row = this.db.prepare("SELECT * FROM property_notes WHERE id = ?").get(id) as unknown as PropertyNoteRow | undefined;
    return row ? propertyNoteFromRow(row) : null;
  }

  createPropertyNote(input: PropertyNoteInput): PropertyNote {
    return this.immediateTransaction(() => {
      const timestamp = new Date().toISOString();
      const note: PropertyNote = {
        id: input.id ?? randomUUID(),
        propertyId: input.propertyId,
        houseId: input.houseId ?? null,
        areaId: input.areaId ?? null,
        equipmentId: input.equipmentId ?? null,
        kind: input.kind,
        text: this.propertyRequiredText(input.text, "Property note", 5_000),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.validatePropertyNote(note);
      try {
        this.db.prepare(`INSERT INTO property_notes
          (id, property_id, house_id, area_id, equipment_id, kind, text, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(note.id, note.propertyId, note.houseId, note.areaId, note.equipmentId, note.kind, note.text,
            note.createdAt, note.updatedAt);
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: property_notes.id")) {
          throw new ClimateDataValidationError(409, "PROPERTY_NOTE_ID_CONFLICT", `Property note ${note.id} already exists`);
        }
        throw error;
      }
      return note;
    });
  }

  updatePropertyNote(id: string, patch: PropertyNotePatch): PropertyNote | null {
    return this.immediateTransaction(() => {
      const current = this.getPropertyNote(id);
      if (!current) return null;
      const next: PropertyNote = {
        ...current,
        ...(patch.houseId !== undefined ? { houseId: patch.houseId } : {}),
        ...(patch.areaId !== undefined ? { areaId: patch.areaId } : {}),
        ...(patch.equipmentId !== undefined ? { equipmentId: patch.equipmentId } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.text !== undefined ? { text: this.propertyRequiredText(patch.text, "Property note", 5_000) } : {}),
        updatedAt: this.nextUpdatedAt(current.updatedAt),
      };
      this.validatePropertyNote(next);
      this.db.prepare(`UPDATE property_notes
        SET house_id = ?, area_id = ?, equipment_id = ?, kind = ?, text = ?, updated_at = ? WHERE id = ?`)
        .run(next.houseId, next.areaId, next.equipmentId, next.kind, next.text, next.updatedAt, id);
      return next;
    });
  }

  deletePropertyNote(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM property_notes WHERE id = ?").run(id).changes) > 0;
  }

  private propertyRequiredText(value: string, field: string, maximumLength: number): string {
    if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > maximumLength) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_PROPERTY_FIELD",
        `${field} must be a non-empty string of at most ${maximumLength} characters`,
      );
    }
    return value.trim();
  }

  private propertyOptionalText(value: string | null, field: string, maximumLength: number): string | null {
    if (value === null) return null;
    if (typeof value !== "string" || Array.from(value.trim()).length > maximumLength) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_PROPERTY_FIELD",
        `${field} must be a string of at most ${maximumLength} characters or null`,
      );
    }
    return value.trim() || null;
  }

  private nextUpdatedAt(previous: string): string {
    const previousMs = Date.parse(previous);
    const timestamp = Number.isFinite(previousMs) ? Math.max(Date.now(), previousMs + 1) : Date.now();
    return new Date(timestamp).toISOString();
  }

  private validatePropertyArea(area: PropertyArea): void {
    if (!PROPERTY_AREA_KINDS.has(area.kind)) {
      throw new ClimateDataValidationError(422, "INVALID_AREA_KIND", "Property area kind is not supported");
    }
    if (area.location && (!Number.isFinite(area.location.latitude) || !Number.isFinite(area.location.longitude)
      || area.location.latitude < -90 || area.location.latitude > 90
      || area.location.longitude < -180 || area.location.longitude > 180)) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_ASSET_LOCATION",
        "Fixed asset location must be a finite WGS84 latitude/longitude coordinate",
      );
    }
    const polygon = area.polygon;
    if (!Array.isArray(polygon) || (polygon.length !== 0 && polygon.length < 3) || polygon.length > MAX_PROPERTY_AREA_VERTICES) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_AREA_POLYGON",
        `Area polygon must be empty for a fixed asset or contain between 3 and ${MAX_PROPERTY_AREA_VERTICES} vertices`,
      );
    }
    const keys = new Set<string>();
    for (const point of polygon) {
      if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
        || point.latitude < -90 || point.latitude > 90 || point.longitude < -180 || point.longitude > 180) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_AREA_POLYGON",
          "Every area vertex must be a finite WGS84 latitude/longitude coordinate",
        );
      }
      const key = `${point.latitude},${point.longitude}`;
      if (keys.has(key)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_AREA_POLYGON",
          "Area polygon vertices must be distinct and the first vertex must not be repeated",
        );
      }
      keys.add(key);
    }
    if (polygon.length === 0) return;
    // Perform topology checks in a local metre-scale projection. Using raw
    // longitude/latitude with a global 360-degree tolerance rejects ordinary
    // garden/well polygons whose sides are only a few metres long. Unwrapping
    // longitudes also keeps valid parcels that cross the antimeridian local.
    const referenceLatitudeRadians = polygon.reduce((sum, point) => sum + point.latitude, 0)
      / polygon.length * Math.PI / 180;
    const longitudeScale = 111_320 * Math.max(Math.abs(Math.cos(referenceLatitudeRadians)), 1e-6);
    const latitudeScale = 110_574;
    const unwrappedLongitudes: number[] = [polygon[0]!.longitude];
    for (let index = 1; index < polygon.length; index += 1) {
      let longitude = polygon[index]!.longitude;
      const previous = unwrappedLongitudes[index - 1]!;
      while (longitude - previous > 180) longitude -= 360;
      while (longitude - previous < -180) longitude += 360;
      unwrappedLongitudes.push(longitude);
    }
    const originLongitude = unwrappedLongitudes[0]!;
    const originLatitude = polygon[0]!.latitude;
    const points = polygon.map((point, index) => ({
      x: (unwrappedLongitudes[index]! - originLongitude) * longitudeScale,
      y: (point.latitude - originLatitude) * latitudeScale,
    }));
    const coordinateScale = Math.max(
      ...points.map((point) => Math.abs(point.x)),
      ...points.map((point) => Math.abs(point.y)),
      1,
    );
    const signedArea = points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length]!;
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2;
    const areaTolerance = Math.max(1, coordinateScale * coordinateScale) * 1e-10;
    if (Math.abs(signedArea) <= areaTolerance || roomPolygonSelfIntersects(points, coordinateScale)) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_AREA_POLYGON",
        "Area polygon must enclose a non-zero, non-self-intersecting region",
      );
    }
  }

  private validateAreaEquipment(equipment: AreaEquipment): void {
    if (!this.getProperty(equipment.propertyId)) {
      throw new ClimateDataValidationError(
        404,
        "EQUIPMENT_PROPERTY_NOT_FOUND",
        `Property ${equipment.propertyId} does not exist`,
      );
    }
    const area = this.getPropertyArea(equipment.areaId);
    if (!area) {
      throw new ClimateDataValidationError(404, "EQUIPMENT_AREA_NOT_FOUND", `Area ${equipment.areaId} does not exist`);
    }
    if (area.propertyId !== equipment.propertyId) {
      throw new ClimateDataValidationError(
        409,
        "EQUIPMENT_AREA_SCOPE_MISMATCH",
        `Area ${area.id} does not belong to property ${equipment.propertyId}`,
      );
    }
    if (!EQUIPMENT_STATUSES.has(equipment.status)) {
      throw new ClimateDataValidationError(422, "INVALID_EQUIPMENT_STATUS", "Equipment status is not supported");
    }
  }

  private validatePropertyNote(note: PropertyNote): void {
    if (!this.getProperty(note.propertyId)) {
      throw new ClimateDataValidationError(404, "NOTE_PROPERTY_NOT_FOUND", `Property ${note.propertyId} does not exist`);
    }
    if (!PROPERTY_NOTE_KINDS.has(note.kind)) {
      throw new ClimateDataValidationError(422, "INVALID_PROPERTY_NOTE_KIND", "Property note kind is not supported");
    }
    if ([note.houseId, note.areaId, note.equipmentId].filter((id) => id !== null).length > 1) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_PROPERTY_NOTE_TARGET",
        "A property note may target at most one house, area, or equipment item",
      );
    }
    if (note.houseId !== null) {
      const house = this.getHouse(note.houseId);
      if (!house) throw new ClimateDataValidationError(404, "NOTE_HOUSE_NOT_FOUND", `House ${note.houseId} does not exist`);
      if (house.propertyId !== note.propertyId) {
        throw new ClimateDataValidationError(409, "PROPERTY_NOTE_SCOPE_MISMATCH", "Note house belongs to another property");
      }
    }
    let area: PropertyArea | null = null;
    if (note.areaId !== null) {
      area = this.getPropertyArea(note.areaId);
      if (!area) throw new ClimateDataValidationError(404, "NOTE_AREA_NOT_FOUND", `Area ${note.areaId} does not exist`);
      if (area.propertyId !== note.propertyId) {
        throw new ClimateDataValidationError(409, "PROPERTY_NOTE_SCOPE_MISMATCH", "Note area belongs to another property");
      }
    }
    if (note.equipmentId !== null) {
      const equipment = this.getAreaEquipment(note.equipmentId);
      if (!equipment) {
        throw new ClimateDataValidationError(404, "NOTE_EQUIPMENT_NOT_FOUND", `Equipment ${note.equipmentId} does not exist`);
      }
      if (equipment.propertyId !== note.propertyId || (area && equipment.areaId !== area.id)) {
        throw new ClimateDataValidationError(
          409,
          "PROPERTY_NOTE_SCOPE_MISMATCH",
          "Note equipment belongs to another property or area",
        );
      }
    }
  }

  private ensureDefaultProperty(): Property {
    return this.getProperty(DEFAULT_PROPERTY_ID) ?? this.createProperty({ id: DEFAULT_PROPERTY_ID, name: "My property" });
  }

  listHouses(propertyId?: string): House[] {
    const rows = (propertyId
      ? this.db.prepare("SELECT * FROM houses WHERE property_id = ? ORDER BY name").all(propertyId)
      : this.db.prepare("SELECT * FROM houses ORDER BY name").all()) as unknown as HouseRow[];
    return rows.map(houseFromRow);
  }

  getHouse(id: string): House | null {
    const row = this.db.prepare("SELECT * FROM houses WHERE id = ?").get(id) as unknown as HouseRow | undefined;
    return row ? houseFromRow(row) : null;
  }

  listOpeningStateObservations(houseId: string, limit = 5_000, at?: string | number | Date): OpeningStateObservation[] {
    const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
    if (at === undefined) {
      const rows = this.db.prepare(`SELECT id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id
        FROM opening_state_observations WHERE house_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?`)
        .all(houseId, boundedLimit) as unknown as OpeningStateObservationRow[];
      return rows.map(openingStateObservationFromRow);
    }
    const atMs = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
    if (!Number.isFinite(atMs)) return [];
    const atIso = new Date(atMs).toISOString();
    const house = this.getHouse(houseId);
    if (!house) return [];
    const columns = "id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id";
    const latestBySource = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
      WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ?
        AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
      ORDER BY observed_at DESC, id DESC LIMIT 1`);
    const latestProvider = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
      WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ? AND external_id = ?
        AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
      ORDER BY observed_at DESC, id DESC LIMIT 1`);
    const latestProviderConnection = this.db.prepare(`SELECT ${columns} FROM opening_state_observations
      WHERE house_id = ? AND floor_id = ? AND element_id = ? AND source = ? AND external_id = ? AND connection_id = ?
        AND observed_at <= ? AND (valid_until IS NULL OR valid_until > ?)
      ORDER BY observed_at DESC, id DESC LIMIT 1`);
    const rows: OpeningStateObservationRow[] = [];
    // Each lookup is bounded and uses the house/element/provider indexes. This
    // remains fast after years of adapter heartbeats while retaining an old,
    // still-valid manual state for replay and fallback resolution.
    for (const floor of house.floors) {
      for (const element of floor.planElements ?? []) {
        if (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") continue;
        for (const source of ["manual", "api"] as const) {
          const row = latestBySource.get(houseId, floor.id, element.id, source, atIso, atIso) as unknown as OpeningStateObservationRow | undefined;
          if (row) rows.push(row);
        }
        const binding = element.stateBinding;
        if (!binding) continue;
        const row = binding.connectionId
          ? latestProviderConnection.get(houseId, floor.id, element.id, binding.provider, binding.externalId,
              binding.connectionId, atIso, atIso) as unknown as OpeningStateObservationRow | undefined
          : latestProvider.get(houseId, floor.id, element.id, binding.provider, binding.externalId,
              atIso, atIso) as unknown as OpeningStateObservationRow | undefined;
        if (row) rows.push(row);
      }
    }
    return rows.sort((left, right) => right.observed_at.localeCompare(left.observed_at) || right.id.localeCompare(left.id))
      .slice(0, boundedLimit).map(openingStateObservationFromRow);
  }

  listOpeningStateObservationHistory(
    houseId: string,
    from: string | number | Date,
    to: string | number | Date,
    limit = 10_000,
  ): OpeningStateObservation[] {
    const fromMs = from instanceof Date ? from.getTime() : typeof from === "number" ? from : Date.parse(from);
    const toMs = to instanceof Date ? to.getTime() : typeof to === "number" ? to : Date.parse(to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
    const boundedLimit = Math.min(10_000, Math.max(1, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id
      FROM opening_state_observations
      WHERE house_id = ? AND observed_at >= ? AND observed_at <= ?
      ORDER BY observed_at DESC, id DESC LIMIT ?`)
      .all(houseId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), boundedLimit) as unknown as OpeningStateObservationRow[];
    return rows.map(openingStateObservationFromRow).sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id)
    ));
  }

  recordOpeningStateObservation(houseId: string, input: OpeningStateObservationInput): OpeningStateObservation {
    const house = this.getHouse(houseId);
    if (!house) throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
    const floor = house.floors.find((candidate) => candidate.id === input.floorId);
    if (!floor) throw new ClimateDataValidationError(404, "OPENING_FLOOR_NOT_FOUND", `Floor ${input.floorId} does not exist in house ${houseId}`);
    const element = (floor.planElements ?? []).find((candidate) => candidate.id === input.elementId);
    if (!element || (element.kind !== "door" && element.kind !== "window" && element.kind !== "vent")) {
      throw new ClimateDataValidationError(404, "OPENING_NOT_FOUND", `Opening ${input.elementId} does not exist on floor ${input.floorId}`);
    }
    if (!["open", "closed", "unknown"].includes(input.state)) {
      throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", "Opening state must be open, closed, or unknown");
    }
    if (!["manual", "home-assistant", "tapo", "api"].includes(input.source)) {
      throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE_SOURCE", "Opening state source is not supported");
    }
    const fixedState = fixedPlanElementOpeningState(element);
    if (fixedState !== null && input.state !== fixedState) {
      throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", `${element.variant} openings must remain ${fixedState}`);
    }
    if (input.openFraction !== undefined && (!Number.isFinite(input.openFraction) || input.openFraction < 0 || input.openFraction > 1
      || (input.state !== "open" && input.openFraction !== 0))) {
      throw new ClimateDataValidationError(400, "INVALID_OPENING_FRACTION", "Opening fraction must be from 0 to 1 and non-zero only for an open state");
    }
    const observedAtMs = Date.parse(input.observedAt);
    if (!Number.isFinite(observedAtMs)) throw new ClimateDataValidationError(400, "INVALID_OPENING_OBSERVED_AT", "observedAt must be an ISO 8601 timestamp");
    const observedAt = new Date(observedAtMs).toISOString();
    let validUntil: string | undefined;
    if (input.validUntil !== undefined) {
      const validUntilMs = Date.parse(input.validUntil);
      if (!Number.isFinite(validUntilMs) || validUntilMs <= observedAtMs) {
        throw new ClimateDataValidationError(400, "INVALID_OPENING_VALID_UNTIL", "validUntil must be later than observedAt");
      }
      validUntil = new Date(validUntilMs).toISOString();
    }
    const externalId = input.externalId?.trim();
    if (externalId !== undefined && (!externalId || externalId.length > 255)) {
      throw new ClimateDataValidationError(400, "INVALID_OPENING_EXTERNAL_ID", "externalId must contain 1 to 255 characters");
    }
    const connectionId = input.connectionId?.trim();
    if (connectionId !== undefined && (!connectionId || connectionId.length > 255)) {
      throw new ClimateDataValidationError(400, "INVALID_OPENING_CONNECTION_ID", "connectionId must contain 1 to 255 characters");
    }
    if (input.source === "home-assistant" || input.source === "tapo") {
      if (!element.stateBinding || element.stateBinding.provider !== input.source
        || !externalId || externalId !== element.stateBinding.externalId
        || (element.stateBinding.connectionId !== undefined && connectionId !== element.stateBinding.connectionId)) {
        throw new ClimateDataValidationError(409, "OPENING_BINDING_MISMATCH", "The provider observation does not match this opening's configured sensor binding");
      }
    }
    const id = input.id?.trim() || randomUUID();
    const observation: OpeningStateObservation = {
      id, houseId, floorId: floor.id, elementId: element.id, state: input.state,
      ...(input.openFraction !== undefined ? { openFraction: input.openFraction } : {}),
      source: input.source, observedAt,
      ...(validUntil ? { validUntil } : {}),
      ...(externalId ? { externalId } : {}),
      ...(connectionId ? { connectionId } : {}),
    };
    try {
      this.db.prepare(`INSERT INTO opening_state_observations
        (id, house_id, floor_id, element_id, state, open_fraction, source, observed_at, valid_until, external_id, connection_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(observation.id, houseId, floor.id, element.id, observation.state, observation.openFraction ?? null,
          observation.source, observation.observedAt, observation.validUntil ?? null, observation.externalId ?? null,
          observation.connectionId ?? null, new Date().toISOString());
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: opening_state_observations.id")) {
        throw new ClimateDataValidationError(409, "OPENING_OBSERVATION_ID_CONFLICT", `Opening observation ${id} already exists`);
      }
      throw error;
    }
    return observation;
  }

  createHouse(input: Pick<House, "name" | "timezone" | "floors"> & {
    id?: string;
    propertyId?: string;
    location?: HouseLocation;
    mapPlacement?: HouseMapPlacement;
    orientationDegrees?: number;
  }): House {
    return this.immediateTransaction(() => {
      this.validateFloorDefinitions(input.floors);
      this.validateHouseTimezone(input.timezone);
      if (input.location) this.validateHouseLocation(input.location);
      if (input.mapPlacement) this.validateHouseMapPlacement(input.mapPlacement, input.floors);
      if (input.orientationDegrees !== undefined) this.validateHouseOrientation(input.orientationDegrees);
      const timestamp = new Date().toISOString();
      let propertyId: string;
      if (input.propertyId !== undefined) {
        propertyId = input.propertyId.trim();
        if (!propertyId) {
          throw new ClimateDataValidationError(
            422,
            "HOUSE_PROPERTY_REQUIRED",
            "A non-empty propertyId is required when it is supplied",
          );
        }
      } else {
        const candidates = this.db.prepare("SELECT id FROM properties ORDER BY created_at, id LIMIT 2")
          .all() as Array<{ id: string }>;
        if (candidates.length === 0) propertyId = this.ensureDefaultProperty().id;
        else if (candidates.length === 1) propertyId = candidates[0]!.id;
        else {
          throw new ClimateDataValidationError(
            422,
            "HOUSE_PROPERTY_REQUIRED",
            "propertyId is required when more than one property exists",
          );
        }
      }
      if (!this.getProperty(propertyId)) {
        throw new ClimateDataValidationError(404, "HOUSE_PROPERTY_NOT_FOUND", `Property ${propertyId} does not exist`);
      }
      const house: House = {
        id: input.id ?? randomUUID(), propertyId, name: input.name, timezone: input.timezone,
        ...(input.location ? { location: input.location } : {}),
        ...(input.mapPlacement ? { mapPlacement: input.mapPlacement } : {}),
        ...(input.orientationDegrees !== undefined ? { orientationDegrees: input.orientationDegrees } : {}),
        floors: input.floors,
        createdAt: timestamp, updatedAt: timestamp,
      };
      this.assertTelemetryResourceIdAvailable("house", house.id);
      try {
        this.db.prepare(`INSERT INTO houses
          (id, property_id, name, timezone, location_json, map_placement_json, orientation_degrees, floors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(house.id, propertyId, house.name, house.timezone, house.location ? JSON.stringify(house.location) : null,
            house.mapPlacement ? JSON.stringify(house.mapPlacement) : null,
            house.orientationDegrees ?? null,
            JSON.stringify(house.floors), house.createdAt, house.updatedAt);
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: houses.id")) {
          throw new ClimateDataValidationError(409, "HOUSE_ID_CONFLICT", `House ${house.id} already exists`);
        }
        throw error;
      }
      return house;
    });
  }

  updateHouse(
    id: string,
    patch: Partial<Pick<House, "name" | "timezone" | "floors">> & {
      propertyId?: string;
      location?: HouseLocation | null;
      mapPlacement?: HouseMapPlacement | null;
      orientationDegrees?: number | null;
    },
    actor: LocalMaintenanceTaskRevisionActor = "local-rest",
  ): House | null {
    return this.immediateTransaction(() => {
      const current = this.getHouse(id);
      if (!current) return null;
      const affectedTasks = patch.propertyId !== undefined && patch.propertyId !== current.propertyId
        ? this.maintenanceTasksBeforeScopeMove("house_id = ?", [id])
        : [];
      // Apply nullable optional fields explicitly so `null` never leaks into
      // the public House contract (absence is represented by omission).
      const next: House = { ...current, id, updatedAt: this.nextUpdatedAt(current.updatedAt) };
      if (patch.propertyId !== undefined) {
        const propertyId = patch.propertyId.trim();
        if (!propertyId || !this.getProperty(propertyId)) {
          throw new ClimateDataValidationError(
            404,
            "HOUSE_PROPERTY_NOT_FOUND",
            `Property ${patch.propertyId} does not exist`,
          );
        }
        if (propertyId !== current.propertyId) this.requireImmutableTelemetryLineage("house", id);
        next.propertyId = propertyId;
      }
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.timezone !== undefined) {
        // A legacy database may contain a timezone accepted by an older build.
        // Preserve that value when an unrelated full-form update echoes it, but
        // validate every newly introduced timezone.
        if (patch.timezone !== current.timezone) this.validateHouseTimezone(patch.timezone);
        next.timezone = patch.timezone;
      }
      if (patch.floors !== undefined) next.floors = patch.floors;
      if (patch.orientationDegrees === null) delete next.orientationDegrees;
      else if (patch.orientationDegrees !== undefined) next.orientationDegrees = patch.orientationDegrees;
      if (patch.location === null) delete next.location;
      else if (patch.location !== undefined) next.location = patch.location;
      if (patch.mapPlacement === null) delete next.mapPlacement;
      else if (patch.mapPlacement !== undefined) next.mapPlacement = patch.mapPlacement;
      if (next.location) this.validateHouseLocation(next.location);
      if (next.orientationDegrees !== undefined) this.validateHouseOrientation(next.orientationDegrees);
      this.validateFloorDefinitions(next.floors);
      if (next.mapPlacement) this.validateHouseMapPlacement(next.mapPlacement, next.floors);
      this.validateHouseLayoutForSensors(id, next.floors);
      if (patch.floors !== undefined) {
        this.validateHouseLayoutForObservations(id, next.floors);
        this.validateHouseLayoutForMaintenanceTasks(id, next.floors);
      }
      this.db.prepare("UPDATE houses SET property_id = ?, name = ?, timezone = ?, location_json = ?, map_placement_json = ?, orientation_degrees = ?, floors_json = ?, updated_at = ? WHERE id = ?")
        .run(next.propertyId ?? DEFAULT_PROPERTY_ID, next.name, next.timezone, next.location ? JSON.stringify(next.location) : null,
          next.mapPlacement ? JSON.stringify(next.mapPlacement) : null,
          next.orientationDegrees ?? null,
          JSON.stringify(next.floors), next.updatedAt, id);
      this.recordScopeMoveMaintenanceRevisions(affectedTasks, actor);
      if (patch.location !== undefined && outdoorLocationKey(current.location) !== outdoorLocationKey(next.location)) {
        this.db.prepare("DELETE FROM outdoor_temperature_samples WHERE house_id = ?").run(id);
        this.db.prepare("DELETE FROM weather_outages WHERE house_id = ?").run(id);
      }
      return next;
    });
  }

  deleteHouse(id: string): boolean {
    if (this.db.prepare("SELECT 1 FROM maintenance_tasks WHERE house_id = ? LIMIT 1").get(id)) {
      throw new ClimateDataValidationError(
        409,
        "HOUSE_HAS_MAINTENANCE_TASKS",
        `House ${id} still owns maintenance tasks; reassign or delete them first`,
      );
    }
    this.requireImmutableTelemetryLineage("house", id);
    try {
      return Number(this.db.prepare("DELETE FROM houses WHERE id = ?").run(id).changes) > 0;
    } catch (error) {
      if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
        throw new ClimateDataValidationError(
          409,
          "HOUSE_IN_USE",
          `House ${id} is referenced by notes or maintenance tasks`,
        );
      }
      throw error;
    }
  }

  listSensors(houseId?: string): Sensor[] {
    const rows = (houseId
      ? this.db.prepare("SELECT * FROM sensors WHERE house_id = ? ORDER BY name").all(houseId)
      : this.db.prepare("SELECT * FROM sensors ORDER BY name").all()) as unknown as SensorRow[];
    return rows.map((row) => this.sensorWithMeasurementBindings(row));
  }

  /** Detaches direct bindings owned by one deleted logical connection. */
  detachTpLinkConnection(connectionId: string, unscopedHouseId?: string): string[] {
    return this.immediateTransaction(() => {
      const rows = (unscopedHouseId
        ? this.db.prepare(`SELECT id FROM sensors
            WHERE tp_link_connection_id = ?
              OR (house_id = ? AND tp_link_connection_id IS NULL AND tp_link_device_id IS NOT NULL)
            ORDER BY id`).all(connectionId, unscopedHouseId)
        : this.db.prepare("SELECT id FROM sensors WHERE tp_link_connection_id = ? ORDER BY id").all(connectionId)) as unknown as Array<{ id: string }>;
      if (rows.length > 0) {
        if (unscopedHouseId) {
          this.db.prepare(`UPDATE sensors
            SET tp_link_device_id = NULL, tp_link_connection_id = NULL
            WHERE tp_link_connection_id = ?
              OR (house_id = ? AND tp_link_connection_id IS NULL AND tp_link_device_id IS NOT NULL)`)
            .run(connectionId, unscopedHouseId);
        } else {
          this.db.prepare(`UPDATE sensors
            SET tp_link_device_id = NULL, tp_link_connection_id = NULL
            WHERE tp_link_connection_id = ?`).run(connectionId);
        }
      }
      return rows.map((row) => row.id);
    });
  }

  /**
   * Atomically moves existing direct-device bindings between logical TP-Link
   * connections. The expected owner makes setup migrations fail closed if a
   * concurrent request changed any sensor after it was inspected.
   */
  reassignTpLinkSensors(
    houseId: string,
    assignments: Array<{ sensorId: string; fromConnectionId: string | null; toConnectionId: string | null }>,
  ): Sensor[] {
    if (!this.getHouse(houseId)) {
      throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", "House not found");
    }
    if (assignments.length < 1 || assignments.length > 2_048) {
      throw new ClimateDataValidationError(400, "INVALID_TP_LINK_ASSIGNMENTS", "TP-Link assignment migration requires 1–2,048 sensors");
    }
    return this.immediateTransaction(() => {
      const sensorIds = new Set<string>();
      const prepared = assignments.map((assignment) => {
        const sensor = this.getSensor(assignment.sensorId);
        if (!sensor || sensor.houseId !== houseId || !sensor.tpLinkDeviceId || sensorIds.has(sensor.id)) {
          throw new ClimateDataValidationError(
            409,
            "TP_LINK_BINDING_CHANGED",
            "Every TP-Link assignment must reference one unique bound sensor in the selected house",
          );
        }
        sensorIds.add(sensor.id);
        if ((sensor.tpLinkConnectionId ?? null) !== assignment.fromConnectionId) {
          throw new ClimateDataValidationError(
            409,
            "TP_LINK_BINDING_CHANGED",
            `TP-Link binding ownership changed for sensor ${sensor.id}`,
          );
        }
        if (assignment.toConnectionId !== null
          && (!assignment.toConnectionId.trim() || assignment.toConnectionId !== assignment.toConnectionId.trim())) {
          throw new ClimateDataValidationError(400, "INVALID_TP_LINK_CONNECTION_ID", "TP-Link connection id is invalid");
        }
        return { sensor, toConnectionId: assignment.toConnectionId };
      });
      return prepared.map(({ sensor, toConnectionId }) => this.updateSensor(sensor.id, {
        tpLinkConnectionId: toConnectionId,
      })!);
    });
  }

  getSensor(id: string): Sensor | null {
    const row = this.db.prepare("SELECT * FROM sensors WHERE id = ?").get(id) as unknown as SensorRow | undefined;
    return row ? this.sensorWithMeasurementBindings(row) : null;
  }

  private sensorWithMeasurementBindings(row: SensorRow): Sensor {
    const sensor = sensorFromRow(row);
    const bindings = this.db.prepare("SELECT metric, entity_id FROM sensor_measurement_bindings WHERE sensor_id = ? ORDER BY metric")
      .all(sensor.id) as unknown as Array<{ metric: string; entity_id: string }>;
    return bindings.length > 0
      ? { ...sensor, measurementEntityIds: Object.fromEntries(bindings.map((binding) => [binding.metric, binding.entity_id])) }
      : sensor;
  }

  createSensor(input: Omit<Sensor, "id"> & { id?: string }): Sensor {
    let sensor: Sensor = { ...input, id: input.id ?? randomUUID() };
    return this.immediateTransaction(() => {
      this.assertTelemetryResourceIdAvailable("sensor", sensor.id);
      this.validateSensorPlacement(sensor);
      sensor = this.normalizeSensorRoom(sensor, {
        roomIdProvided: Object.hasOwn(input, "roomId"),
        roomProvided: true,
        resolveLegacyLabel: !Object.hasOwn(input, "roomId"),
      });
      this.validateTpLinkDeviceBinding(sensor);
      this.writeSensor(sensor, true);
      return sensor;
    });
  }

  updateSensor(id: string, patch: SensorUpdate): Sensor | null {
    return this.immediateTransaction(() => {
      const current = this.getSensor(id);
      if (!current) return null;
      const { tpLinkDeviceId, tpLinkConnectionId, ...fields } = patch;
      const sensor: Sensor = { ...current, ...fields, id };
      if (tpLinkDeviceId === null) delete sensor.tpLinkDeviceId;
      else if (tpLinkDeviceId !== undefined) sensor.tpLinkDeviceId = tpLinkDeviceId;
      if (tpLinkConnectionId === null) delete sensor.tpLinkConnectionId;
      else if (tpLinkConnectionId !== undefined) sensor.tpLinkConnectionId = tpLinkConnectionId;
      if (!sensor.tpLinkDeviceId) delete sensor.tpLinkConnectionId;
      this.validateSensorPlacement(sensor);
      if (sensor.houseId !== current.houseId) this.requireImmutableTelemetryLineage("sensor", id);
      const normalizedSensor = this.normalizeSensorRoom(sensor, {
        roomIdProvided: Object.hasOwn(patch, "roomId"),
        roomProvided: Object.hasOwn(patch, "room"),
        resolveLegacyLabel: !Object.hasOwn(patch, "roomId")
          && ["houseId", "floorId", "room"].some((field) => Object.hasOwn(patch, field)),
      });
      this.validateTpLinkDeviceBinding(normalizedSensor);
      this.writeSensor(normalizedSensor, false);
      if (normalizedSensor.enabled && normalizedSensor.tpLinkDeviceId
        && (!current.enabled || !current.tpLinkDeviceId
          || current.tpLinkDeviceId !== normalizedSensor.tpLinkDeviceId)) {
        this.rearmEligibleNotSupportedTapoGaps(normalizedSensor.id, null);
      }
      return normalizedSensor;
    });
  }

  bulkUpdateSensorBindings(
    houseId: string,
    mappings: Array<{ sensorId: string; measurementEntityIds: Record<string, string> }>,
  ): Sensor[] {
    if (!this.getHouse(houseId)) throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", "House not found");
    if (mappings.length < 1 || mappings.length > 100) {
      throw new ClimateDataValidationError(400, "INVALID_BULK_MAPPING", "Bulk mapping requires 1–100 sensors");
    }
    return this.immediateTransaction(() => {
      const sensorIds = new Set<string>();
      const claims = new Set<string>();
      const prepared = mappings.map((mapping) => {
        const sensor = this.getSensor(mapping.sensorId);
        if (!sensor || sensor.houseId !== houseId || sensorIds.has(sensor.id)) {
          throw new ClimateDataValidationError(409, "INVALID_BULK_MAPPING", "Every mapping must reference one unique sensor in the selected house");
        }
        sensorIds.add(sensor.id);
        const normalized: Record<string, string> = {};
        for (const [metric, entityId] of Object.entries(mapping.measurementEntityIds)) {
          if (!this.getMeasurementDefinition(metric) || typeof entityId !== "string" || !entityId.trim() || entityId.length > 500) {
            throw new ClimateDataValidationError(400, "INVALID_BULK_MAPPING", "Every mapping requires a known metric and non-empty entity id");
          }
          const claim = `${metric}\u0000${entityId.trim()}`;
          if (claims.has(claim)) {
            throw new ClimateDataValidationError(409, "DUPLICATE_ENTITY_CLAIM", "One entity cannot be claimed by two sensors for the same metric");
          }
          claims.add(claim);
          normalized[metric] = entityId.trim();
        }
        if (Object.keys(normalized).length === 0) {
          throw new ClimateDataValidationError(400, "INVALID_BULK_MAPPING", "Each sensor requires at least one entity mapping");
        }
        return { sensor, normalized };
      });
      return prepared.map(({ sensor, normalized }) => this.updateSensor(sensor.id, { measurementEntityIds: normalized })!);
    });
  }

  private immediateTransaction<T>(operation: () => T): T {
    if (this.#transactionDepth > 0) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    this.#transactionDepth += 1;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  private validateFloorDefinitions(floors: Floor[]): void {
    if (!Array.isArray(floors)) {
      throw new ClimateDataValidationError(400, "INVALID_FLOORS", "floors must be an array");
    }
    const ids = new Set<string>();
    for (const floor of floors) {
      if (!floor || typeof floor.id !== "string" || floor.id.trim() === "") {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR", "Every floor must have a non-empty id");
      }
      if (ids.has(floor.id)) {
        throw new ClimateDataValidationError(400, "DUPLICATE_FLOOR", `Floor id ${floor.id} is duplicated`);
      }
      ids.add(floor.id);
      if (!Number.isFinite(floor.width) || floor.width <= 0 || !Number.isFinite(floor.height) || floor.height <= 0) {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR_EXTENT", `Floor ${floor.id} width and height must be positive finite numbers`);
      }
      if (floor.metersPerPlanUnit !== undefined
        && (!Number.isFinite(floor.metersPerPlanUnit) || floor.metersPerPlanUnit <= 0 || floor.metersPerPlanUnit > 10_000)) {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR_SCALE", `Floor ${floor.id} metersPerPlanUnit must be a positive finite number no greater than 10000`);
      }
      if (!Number.isFinite(floor.elevation)) {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR_ELEVATION", `Floor ${floor.id} elevation must be finite`);
      }
      if (floor.type !== undefined && !["basement", "ground", "upper", "attic", "mezzanine", "outdoor"].includes(floor.type)) {
        throw new ClimateDataValidationError(400, "INVALID_FLOOR_TYPE", `Floor ${floor.id} has an unsupported type`);
      }
      if (floor.ceilingHeight !== undefined && (!Number.isFinite(floor.ceilingHeight) || floor.ceilingHeight <= 0)) {
        throw new ClimateDataValidationError(400, "INVALID_CEILING_HEIGHT", `Floor ${floor.id} ceilingHeight must be a positive finite number`);
      }
      if (floor.wallHeight !== undefined && (!Number.isFinite(floor.wallHeight) || floor.wallHeight <= 0 || floor.wallHeight > 20)) {
        throw new ClimateDataValidationError(400, "INVALID_WALL_HEIGHT", `Floor ${floor.id} wallHeight must be a positive finite number no greater than 20 metres`);
      }
      if (floor.roof !== undefined) {
        const roof = floor.roof;
        if (!roof || !["gable", "hip", "shed", "flat"].includes(roof.style)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOF_STYLE", `Floor ${floor.id} has an unsupported roof style`);
        }
        if (!Number.isFinite(roof.pitchDegrees) || roof.pitchDegrees < 0 || roof.pitchDegrees > 75
          || (roof.style !== "flat" && roof.pitchDegrees <= 0) || (roof.style === "flat" && roof.pitchDegrees !== 0)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOF_PITCH", `Floor ${floor.id} roof pitch must match its style and be from 0 to 75 degrees`);
        }
        if (!["x", "y"].includes(roof.ridgeAxis)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOF_RIDGE_AXIS", `Floor ${floor.id} roof ridgeAxis must be x or y`);
        }
        if (!Number.isFinite(roof.overhang) || roof.overhang < 0 || !Number.isFinite(roof.eavesHeight) || roof.eavesHeight < 0) {
          throw new ClimateDataValidationError(400, "INVALID_ROOF_DIMENSIONS", `Floor ${floor.id} roof overhang and eavesHeight must be non-negative finite numbers`);
        }
      }
      const pointIsValid = (point: { x: number; y: number } | null | undefined) => Boolean(
        point && Number.isFinite(point.x) && Number.isFinite(point.y)
        && point.x >= 0 && point.x <= floor.width && point.y >= 0 && point.y <= floor.height,
      );
      if (!Array.isArray(floor.walls)) {
        throw new ClimateDataValidationError(400, "INVALID_WALLS", `Floor ${floor.id} walls must be an array`);
      }
      const wallsById = new Map<string, Wall>();
      for (const wall of floor.walls) {
        if (!wall || typeof wall.id !== "string" || wall.id.trim() === "" || wallsById.has(wall.id)) {
          throw new ClimateDataValidationError(400, "INVALID_WALL_ID", `Floor ${floor.id} walls must have unique non-empty ids`);
        }
        if (!pointIsValid(wall.from) || !pointIsValid(wall.to)
          || (Math.abs(wall.from.x - wall.to.x) < 1e-10 && Math.abs(wall.from.y - wall.to.y) < 1e-10)) {
          throw new ClimateDataValidationError(400, "INVALID_WALL_GEOMETRY", `Floor ${floor.id} walls must have distinct in-bounds endpoints`);
        }
        wallsById.set(wall.id, wall);
      }
      if (!Array.isArray(floor.rooms)) {
        throw new ClimateDataValidationError(400, "INVALID_ROOMS", `Floor ${floor.id} rooms must be an array`);
      }
      const roomIds = new Set<string>();
      const roomNames = new Set<string>();
      for (const room of floor.rooms) {
        if (!room || typeof room.id !== "string" || room.id.trim() === "" || roomIds.has(room.id)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_ID", `Floor ${floor.id} rooms must have unique non-empty ids`);
        }
        roomIds.add(room.id);
        if (typeof room.name !== "string" || room.name.trim() === "") {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_NAME", `Floor ${floor.id} rooms must have non-empty names`);
        }
        const normalizedRoomName = room.name.trim().normalize("NFKC").toLowerCase();
        if (roomNames.has(normalizedRoomName)) {
          throw new ClimateDataValidationError(400, "DUPLICATE_ROOM_NAME", `Floor ${floor.id} room names must be unique, ignoring case`);
        }
        roomNames.add(normalizedRoomName);
        if (!Array.isArray(room.points) || room.points.length < 3 || !room.points.every(pointIsValid)) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons need at least three in-bounds points`);
        }
        const distinctPoints = new Set(room.points.map((point) => `${point.x}:${point.y}`));
        const doubledArea = Math.abs(room.points.reduce((area, point, index) => {
          const next = room.points[(index + 1) % room.points.length]!;
          return area + point.x * next.y - next.x * point.y;
        }, 0));
        if (distinctPoints.size !== room.points.length || doubledArea < 1e-10) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons must use distinct vertices and enclose a non-zero area`);
        }
        if (roomPolygonSelfIntersects(room.points, Math.max(floor.width, floor.height))) {
          throw new ClimateDataValidationError(400, "INVALID_ROOM_GEOMETRY", `Floor ${floor.id} room polygons cannot self-intersect`);
        }
      }
      if (floor.planElements !== undefined) {
        if (!Array.isArray(floor.planElements)) {
          throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENTS", `Floor ${floor.id} planElements must be an array`);
        }
        const elementIds = new Set<string>();
        for (const element of floor.planElements) {
          if (!element || typeof element.id !== "string" || element.id.trim() === "" || elementIds.has(element.id)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ID", `Floor ${floor.id} plan elements must have unique non-empty ids`);
          }
          elementIds.add(element.id);
          if (!["door", "window", "fireplace", "vent", "fireEscape"].includes(element.kind)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_KIND", `Floor ${floor.id} has an unsupported plan element kind`);
          }
          if (!element.position || !Number.isFinite(element.position.x) || !Number.isFinite(element.position.y)
            || element.position.x < 0 || element.position.x > floor.width || element.position.y < 0 || element.position.y > floor.height) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_POSITION", `Floor ${floor.id} plan element positions must be within its extent`);
          }
          if (!Number.isFinite(element.rotationDegrees) || element.rotationDegrees < 0 || element.rotationDegrees >= 360) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ROTATION", `Floor ${floor.id} plan element rotations must be from 0 (inclusive) to 360 (exclusive)`);
          }
          if (element.width !== undefined && (!Number.isFinite(element.width) || element.width <= 0)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WIDTH", `Floor ${floor.id} plan element widths must be positive finite numbers`);
          }
          if (element.height !== undefined && (!Number.isFinite(element.height) || element.height <= 0)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_HEIGHT", `Floor ${floor.id} plan element heights must be positive finite numbers`);
          }
          if (element.label !== undefined && (typeof element.label !== "string" || element.label.trim().length === 0 || element.label.length > 120)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_LABEL", `Floor ${floor.id} plan element labels must contain 1 to 120 characters`);
          }
          const isOpening = element.kind === "door" || element.kind === "window";
          const isAirflowElement = isOpening || element.kind === "vent";
          const isFireEscape = element.kind === "fireEscape";
          const isWallAttached = isOpening || isFireEscape;
          const state = "state" in element ? element.state : undefined;
          const openFraction = "openFraction" in element ? element.openFraction : undefined;
          const bottomOffsetM = "bottomOffsetM" in element ? element.bottomOffsetM : undefined;
          const stateBinding = "stateBinding" in element ? element.stateBinding : undefined;
          const variant = "variant" in element ? element.variant : undefined;
          const nominalFlowM3h = "nominalFlowM3h" in element ? element.nominalFlowM3h : undefined;
          if (state !== undefined && (!isAirflowElement || !["open", "closed"].includes(state))) {
            throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", `Floor ${floor.id} opening state must be open or closed`);
          }
          if (openFraction !== undefined && (!isAirflowElement || !Number.isFinite(openFraction) || openFraction < 0 || openFraction > 1)) {
            throw new ClimateDataValidationError(400, "INVALID_OPENING_FRACTION", `Floor ${floor.id} opening fractions must be from 0 to 1`);
          }
          if (bottomOffsetM !== undefined && ((!isAirflowElement && !isFireEscape) || !Number.isFinite(bottomOffsetM) || bottomOffsetM < 0 || bottomOffsetM > (floor.ceilingHeight ?? 2.8))) {
            throw new ClimateDataValidationError(400, "INVALID_OPENING_BOTTOM_OFFSET", `Floor ${floor.id} opening bottom offsets must fit within the level height`);
          }
          if (bottomOffsetM !== undefined && element.height !== undefined && bottomOffsetM + element.height > (floor.ceilingHeight ?? 2.8) + 1e-9) {
            throw new ClimateDataValidationError(400, "INVALID_OPENING_VERTICAL_EXTENT", `Floor ${floor.id} opening height and bottom offset must fit within the level height`);
          }
          if (stateBinding !== undefined) {
            if (!isAirflowElement || !stateBinding || typeof stateBinding !== "object"
              || !["home-assistant", "tapo"].includes(stateBinding.provider)
              || typeof stateBinding.externalId !== "string" || stateBinding.externalId.trim().length === 0 || stateBinding.externalId.length > 255
              || stateBinding.externalId !== stateBinding.externalId.trim()
              || (stateBinding.connectionId !== undefined && (typeof stateBinding.connectionId !== "string" || stateBinding.connectionId.trim().length === 0 || stateBinding.connectionId.length > 255
                || stateBinding.connectionId !== stateBinding.connectionId.trim()))
              || (stateBinding.invert !== undefined && typeof stateBinding.invert !== "boolean")
              || (stateBinding.staleAfterSeconds !== undefined && (!Number.isFinite(stateBinding.staleAfterSeconds) || stateBinding.staleAfterSeconds < 1 || stateBinding.staleAfterSeconds > 2_592_000))) {
              throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE_BINDING", `Floor ${floor.id} opening state bindings require a supported provider and external id`);
            }
          }
          const validVariants = element.kind === "door"
            ? ["interior", "exterior", "sliding", "double", "open-passage"]
            : element.kind === "window"
              ? ["fixed", "casement", "tilt-turn", "sliding"]
              : element.kind === "vent"
                ? ["passive", "supply", "extract", "balanced", "transfer"]
                : element.kind === "fireEscape"
                  ? ["ladder", "stairs"]
                  : [];
          if (variant !== undefined && !validVariants.includes(variant)) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_VARIANT", `Floor ${floor.id} plan element variant is not supported for ${element.kind}`);
          }
          if (isAirflowElement) {
            const fixedState = fixedPlanElementOpeningState(element);
            if (fixedState && state !== undefined && state !== fixedState) {
              throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE", `Floor ${floor.id} ${element.variant} opening state must remain ${fixedState}`);
            }
            if (fixedState && stateBinding !== undefined) {
              throw new ClimateDataValidationError(400, "INVALID_OPENING_STATE_BINDING", `Floor ${floor.id} ${element.variant} openings cannot use a contact-state binding`);
            }
          }
          if (nominalFlowM3h !== undefined && (element.kind !== "vent" || !Number.isFinite(nominalFlowM3h) || nominalFlowM3h < 0 || nominalFlowM3h > 100_000)) {
            throw new ClimateDataValidationError(400, "INVALID_VENT_FLOW", `Floor ${floor.id} vent design flow must be from 0 to 100000 cubic metres per hour`);
          }
          const verticalExtent = "verticalExtent" in element ? element.verticalExtent : undefined;
          const chimneyHeightAboveRoof = "chimneyHeightAboveRoof" in element ? element.chimneyHeightAboveRoof : undefined;
          const chimneyWidth = "chimneyWidth" in element ? element.chimneyWidth : undefined;
          const chimneyDepth = "chimneyDepth" in element ? element.chimneyDepth : undefined;
          const projection = "projection" in element ? element.projection : undefined;
          if (verticalExtent !== undefined && (element.kind !== "fireplace" || !["level", "roof"].includes(verticalExtent))) {
            throw new ClimateDataValidationError(400, "INVALID_FIREPLACE_VERTICAL_EXTENT", `Floor ${floor.id} verticalExtent is only supported for fireplaces`);
          }
          if (chimneyHeightAboveRoof !== undefined && (element.kind !== "fireplace" || !Number.isFinite(chimneyHeightAboveRoof) || chimneyHeightAboveRoof < 0 || chimneyHeightAboveRoof > 5)) {
            throw new ClimateDataValidationError(400, "INVALID_CHIMNEY_HEIGHT", `Floor ${floor.id} chimneyHeightAboveRoof must be from 0 to 5 metres and is only supported for fireplaces`);
          }
          if (chimneyHeightAboveRoof !== undefined && verticalExtent !== "roof") {
            throw new ClimateDataValidationError(400, "INVALID_CHIMNEY_HEIGHT", `Floor ${floor.id} chimneyHeightAboveRoof requires a roof-reaching fireplace`);
          }
          for (const [name, value] of [["chimneyWidth", chimneyWidth], ["chimneyDepth", chimneyDepth]] as const) {
            if (value !== undefined && (element.kind !== "fireplace" || verticalExtent !== "roof" || !Number.isFinite(value) || value <= 0 || value > Math.max(floor.width, floor.height))) {
              throw new ClimateDataValidationError(400, "INVALID_CHIMNEY_DIMENSION", `Floor ${floor.id} ${name} must be positive, fit within the floor extent, and belong to a roof-reaching fireplace`);
            }
          }
          if (projection !== undefined && (!isFireEscape || !Number.isFinite(projection) || projection <= 0 || projection > Math.max(floor.width, floor.height))) {
            throw new ClimateDataValidationError(400, "INVALID_FIRE_ESCAPE_PROJECTION", `Floor ${floor.id} fire escape projection must be positive and fit within the floor extent`);
          }
          if (isWallAttached && (typeof element.wallId !== "string" || !wallsById.has(element.wallId))) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WALL", `Floor ${floor.id} doors, windows, and fire escapes must reference an existing wall`);
          }
          if (!isWallAttached && element.wallId !== undefined) {
            throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_WALL", `Floor ${floor.id} fireplaces and vents cannot be wall-attached`);
          }
          if (isWallAttached) {
            const wall = wallsById.get(element.wallId!);
            if (!wall) continue;
            const dx = wall.to.x - wall.from.x;
            const dy = wall.to.y - wall.from.y;
            const lengthSquared = dx * dx + dy * dy;
            const progress = Math.max(0, Math.min(1, ((element.position.x - wall.from.x) * dx + (element.position.y - wall.from.y) * dy) / lengthSquared));
            const projectedX = wall.from.x + progress * dx;
            const projectedY = wall.from.y + progress * dy;
            const tolerance = Math.max(floor.width, floor.height, 1) * 1e-7;
            const wallAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
            const rotationDelta = ((element.rotationDegrees - wallAngle) % 180 + 180) % 180;
            if (Math.hypot(element.position.x - projectedX, element.position.y - projectedY) > tolerance
              || Math.min(rotationDelta, 180 - rotationDelta) > 1e-6) {
              throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_ALIGNMENT", `Floor ${floor.id} doors, windows, and fire escapes must lie on and align with their wall`);
            }
            if (element.width !== undefined) {
              const wallLength = Math.sqrt(lengthSquared);
              const halfWidth = element.width / 2;
              const distanceFromStart = progress * wallLength;
              const distanceFromEnd = wallLength - distanceFromStart;
              if (element.width > wallLength + tolerance
                || distanceFromStart + tolerance < halfWidth
                || distanceFromEnd + tolerance < halfWidth) {
                throw new ClimateDataValidationError(400, "INVALID_PLAN_ELEMENT_FIT", `Floor ${floor.id} door, window, and fire escape widths must fit fully within their wall`);
              }
            }
          }
        }
      }
    }
  }

  private validateHouseLocation(location: HouseLocation): void {
    if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90) {
      throw new ClimateDataValidationError(422, "INVALID_LATITUDE", "House latitude must be between -90 and 90");
    }
    if (!Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
      throw new ClimateDataValidationError(422, "INVALID_LONGITUDE", "House longitude must be between -180 and 180");
    }
    if (location.label !== undefined && (typeof location.label !== "string" || location.label.trim().length > 200)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_LABEL", "House location label must be at most 200 characters");
    }
    if (location.countryCode !== undefined && !/^[A-Z]{2}$/.test(location.countryCode)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_COUNTRY", "House location countryCode must be a two-letter uppercase code");
    }
    if (location.source !== undefined && !["manual", "place-search", "browser-geolocation", "home-assistant", "map-placement"].includes(location.source)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_SOURCE", "House location source is not supported");
    }
    if (location.confidence !== undefined && !["high", "medium", "low"].includes(location.confidence)) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_CONFIDENCE", "House location confidence is not supported");
    }
    if (location.discoveredAt !== undefined && !Number.isFinite(Date.parse(location.discoveredAt))) {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_DISCOVERED_AT", "House location discoveredAt must be an ISO date-time");
    }
    if (location.userOverridden !== undefined && typeof location.userOverridden !== "boolean") {
      throw new ClimateDataValidationError(422, "INVALID_LOCATION_OVERRIDE", "House location userOverridden must be a boolean");
    }
  }

  private validateHouseTimezone(timezone: string): void {
    if (typeof timezone !== "string" || timezone.length > 100) {
      throw new ClimateDataValidationError(422, "INVALID_TIMEZONE", "House timezone must be a valid IANA timezone name");
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    } catch {
      throw new ClimateDataValidationError(422, "INVALID_TIMEZONE", "House timezone must be a valid IANA timezone name");
    }
  }

  private validateHouseMapPlacement(mapPlacement: HouseMapPlacement, floors: Floor[]): void {
    if (!Number.isFinite(mapPlacement.latitude) || mapPlacement.latitude < -90 || mapPlacement.latitude > 90) {
      throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_LATITUDE", "Map placement latitude must be between -90 and 90");
    }
    if (!Number.isFinite(mapPlacement.longitude) || mapPlacement.longitude < -180 || mapPlacement.longitude > 180) {
      throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_LONGITUDE", "Map placement longitude must be between -180 and 180");
    }
    if (!Number.isFinite(mapPlacement.metersPerPlanUnit) || mapPlacement.metersPerPlanUnit <= 0) {
      throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_SCALE", "Map placement metersPerPlanUnit must be a positive finite number");
    }
    if (mapPlacement.footprintFloorId !== undefined) {
      if (typeof mapPlacement.footprintFloorId !== "string" || mapPlacement.footprintFloorId.trim() === "") {
        throw new ClimateDataValidationError(422, "INVALID_MAP_PLACEMENT_FLOOR", "Map placement footprintFloorId must be a non-empty floor id");
      }
      if (!floors.some((floor) => floor.id === mapPlacement.footprintFloorId)) {
        throw new ClimateDataValidationError(
          422,
          "MAP_PLACEMENT_FLOOR_NOT_FOUND",
          `Map placement footprint floor ${mapPlacement.footprintFloorId} does not exist in this house`,
        );
      }
    }
  }

  private validateHouseOrientation(orientationDegrees: number): void {
    if (!Number.isFinite(orientationDegrees) || orientationDegrees < 0 || orientationDegrees >= 360) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_ORIENTATION",
        "House orientationDegrees must be a finite compass bearing from 0 (inclusive) to 360 (exclusive)",
      );
    }
  }

  private validateHouseLayoutForSensors(houseId: string, floors: Floor[]): void {
    const floorsById = new Map(floors.map((floor) => [floor.id, floor]));
    for (const sensor of this.listSensors(houseId)) {
      const floor = floorsById.get(sensor.floorId);
      if (!floor) {
        throw new ClimateDataValidationError(409, "LAYOUT_ORPHANS_SENSOR", `Floor ${sensor.floorId} cannot be removed while sensor ${sensor.id} uses it`);
      }
      if (sensor.x < 0 || sensor.x > floor.width || sensor.y < 0 || sensor.y > floor.height) {
        throw new ClimateDataValidationError(409, "LAYOUT_EXCLUDES_SENSOR", `Floor ${floor.id} extent would exclude sensor ${sensor.id}`);
      }
      if (sensor.roomId !== null && sensor.roomId !== undefined
        && !floor.rooms.some((room) => room.id === sensor.roomId)) {
        throw new ClimateDataValidationError(
          409,
          "LAYOUT_ORPHANS_SENSOR_ROOM",
          `Room ${sensor.roomId} cannot be removed or moved while sensor ${sensor.id} uses it`,
        );
      }
    }
  }

  private validateHouseLayoutForMaintenanceTasks(houseId: string, floors: Floor[]): void {
    const floorIds = new Set(floors.map((floor) => floor.id));
    const rows = this.db.prepare(`SELECT id, floor_id FROM maintenance_tasks
      WHERE house_id = ? AND floor_id IS NOT NULL ORDER BY id`).all(houseId) as unknown as Array<{
      id: string;
      floor_id: string;
    }>;
    const orphaned = rows.find((row) => !floorIds.has(row.floor_id));
    if (orphaned) {
      throw new ClimateDataValidationError(
        409,
        "LAYOUT_ORPHANS_MAINTENANCE_TASK",
        `Floor ${orphaned.floor_id} cannot be removed while maintenance task ${orphaned.id} uses it`,
      );
    }
  }

  private validateHouseLayoutForObservations(houseId: string, floors: Floor[]): void {
    const floorsById = new Map(floors.map((floor) => [floor.id, floor]));
    const rows = this.db.prepare(`SELECT id, floor_id, x, y FROM observations
      WHERE house_id = ? ORDER BY id`).all(houseId) as unknown as Array<{
      id: string;
      floor_id: string;
      x: number | null;
      y: number | null;
    }>;
    for (const observation of rows) {
      const floor = floorsById.get(observation.floor_id);
      if (!floor) {
        throw new ClimateDataValidationError(
          409,
          "LAYOUT_ORPHANS_OBSERVATION",
          `Floor ${observation.floor_id} cannot be removed while observation ${observation.id} uses it`,
        );
      }
      if (observation.x !== null && observation.y !== null
        && (observation.x < 0 || observation.x > floor.width
          || observation.y < 0 || observation.y > floor.height)) {
        throw new ClimateDataValidationError(
          409,
          "LAYOUT_EXCLUDES_OBSERVATION",
          `Floor ${floor.id} extent would exclude observation ${observation.id}`,
        );
      }
    }
  }

  private validateSensorPlacement(sensor: Sensor): void {
    if (![sensor.x, sensor.y, sensor.z].every(Number.isFinite)) {
      throw new ClimateDataValidationError(400, "INVALID_SENSOR_COORDINATE", "Sensor x, y, and z must be finite numbers");
    }
    const house = this.getHouse(sensor.houseId);
    if (!house) {
      throw new ClimateDataValidationError(404, "SENSOR_HOUSE_NOT_FOUND", `House ${sensor.houseId} does not exist`);
    }
    const floor = house.floors.find((candidate) => candidate.id === sensor.floorId);
    if (!floor) {
      throw new ClimateDataValidationError(422, "SENSOR_FLOOR_NOT_FOUND", `Floor ${sensor.floorId} does not belong to house ${sensor.houseId}`);
    }
    if (sensor.x < 0 || sensor.x > floor.width || sensor.y < 0 || sensor.y > floor.height) {
      throw new ClimateDataValidationError(
        422,
        "SENSOR_OUT_OF_BOUNDS",
        `Sensor x/y must be within floor ${floor.id}: 0 <= x <= ${floor.width}, 0 <= y <= ${floor.height}`,
      );
    }
  }

  private normalizeSensorRoom(
    sensor: Sensor,
    options: { roomIdProvided: boolean; roomProvided: boolean; resolveLegacyLabel: boolean },
  ): Sensor {
    const house = this.getHouse(sensor.houseId);
    const floor = house?.floors.find((candidate) => candidate.id === sensor.floorId);
    // Placement validation runs immediately before this method. Keep this
    // defensive guard so future callers cannot accidentally bypass ownership.
    if (!house || !floor) return { ...sensor, roomId: null };

    if (options.roomIdProvided) {
      if (sensor.roomId === null || sensor.roomId === undefined) return { ...sensor, roomId: null };
      if (typeof sensor.roomId !== "string" || !sensor.roomId.trim() || sensor.roomId !== sensor.roomId.trim()) {
        throw new ClimateDataValidationError(400, "INVALID_SENSOR_ROOM_ID", "roomId must be null or a non-empty trimmed string");
      }
      const linkedRoom = floor.rooms.find((candidate) => candidate.id === sensor.roomId);
      if (!linkedRoom) {
        throw new ClimateDataValidationError(
          422,
          "SENSOR_ROOM_NOT_FOUND",
          `Room ${sensor.roomId} does not belong to floor ${sensor.floorId} in house ${sensor.houseId}`,
        );
      }
      if (options.roomProvided && sensor.room !== linkedRoom.name) {
        throw new ClimateDataValidationError(
          422,
          "SENSOR_ROOM_LABEL_MISMATCH",
          `room must match the linked room name ${linkedRoom.name}`,
        );
      }
      return { ...sensor, roomId: linkedRoom.id, room: linkedRoom.name };
    }

    if (options.resolveLegacyLabel) {
      const matches = floor.rooms.filter((candidate) => candidate.name === sensor.room);
      return { ...sensor, roomId: matches.length === 1 ? matches[0]!.id : null };
    }

    if (sensor.roomId === null || sensor.roomId === undefined) return { ...sensor, roomId: null };
    const linkedRoom = floor.rooms.find((candidate) => candidate.id === sensor.roomId);
    if (!linkedRoom) {
      throw new ClimateDataValidationError(
        422,
        "SENSOR_ROOM_NOT_FOUND",
        `Room ${sensor.roomId} does not belong to floor ${sensor.floorId} in house ${sensor.houseId}`,
      );
    }
    return { ...sensor, roomId: linkedRoom.id, room: linkedRoom.name };
  }

  private validateTpLinkDeviceBinding(sensor: Sensor): void {
    if (sensor.tpLinkDeviceId === undefined) {
      if (sensor.tpLinkConnectionId !== undefined) {
        throw new ClimateDataValidationError(400, "INVALID_TP_LINK_BINDING", "tpLinkConnectionId requires tpLinkDeviceId");
      }
      return;
    }
    if (!sensor.tpLinkDeviceId.trim() || sensor.tpLinkDeviceId !== sensor.tpLinkDeviceId.trim()) {
      throw new ClimateDataValidationError(
        400,
        "INVALID_TP_LINK_DEVICE_ID",
        "tpLinkDeviceId must be a non-empty trimmed string",
      );
    }
    if (sensor.tpLinkConnectionId !== undefined
      && (!sensor.tpLinkConnectionId.trim() || sensor.tpLinkConnectionId !== sensor.tpLinkConnectionId.trim())) {
      throw new ClimateDataValidationError(400, "INVALID_TP_LINK_CONNECTION_ID", "tpLinkConnectionId must be a non-empty trimmed string");
    }
    const existing = this.db.prepare(`SELECT id FROM sensors
      WHERE house_id = ? AND COALESCE(tp_link_connection_id, '') = COALESCE(?, '')
        AND tp_link_device_id = ? AND id <> ?`)
      .get(sensor.houseId, sensor.tpLinkConnectionId ?? null, sensor.tpLinkDeviceId, sensor.id) as unknown as { id: string } | undefined;
    if (existing) {
      throw new ClimateDataValidationError(
        409,
        "TP_LINK_DEVICE_ALREADY_MAPPED",
        `TP-Link child device ${sensor.tpLinkDeviceId} is already mapped to sensor ${existing.id}`,
      );
    }
  }

  private writeSensor(sensor: Sensor, insert: boolean): void {
    const bindings: Record<string, string> = { ...(sensor.measurementEntityIds ?? {}) };
    if (sensor.temperatureEntityId) bindings.temperature ??= sensor.temperatureEntityId;
    if (sensor.humidityEntityId) bindings.humidity ??= sensor.humidityEntityId;
    for (const metric of Object.keys(bindings)) {
      if (!this.getMeasurementDefinition(metric)) {
        throw new ClimateDataValidationError(422, "UNKNOWN_METRIC", `Unknown measurement metric binding: ${metric}`);
      }
    }
    const homeAssistantBindings = { ...bindings };
    if (sensor.batteryEntityId) homeAssistantBindings.battery ??= sensor.batteryEntityId;
    const metricsByEntityId = new Map<string, string>();
    const existingBinding = this.db.prepare(`SELECT binding.sensor_id, binding.metric
      FROM sensor_measurement_bindings binding
      JOIN sensors owner ON owner.id = binding.sensor_id
      WHERE owner.house_id = ? AND TRIM(binding.entity_id) = ? AND binding.sensor_id <> ? LIMIT 1`);
    const legacyBatteryBinding = this.db.prepare(`SELECT id AS sensor_id, 'battery' AS metric FROM sensors
      WHERE house_id = ? AND id <> ? AND TRIM(battery_entity_id) = ?
        AND NOT EXISTS (
          SELECT 1 FROM sensor_measurement_bindings
          WHERE sensor_id = sensors.id AND metric = 'battery'
        )
      LIMIT 1`);
    for (const [metric, rawEntityId] of Object.entries(homeAssistantBindings)) {
      const entityId = rawEntityId.trim();
      const previousMetric = metricsByEntityId.get(entityId);
      if (previousMetric && previousMetric !== metric) {
        throw new ClimateDataValidationError(
          409,
          "HOME_ASSISTANT_ENTITY_ALREADY_MAPPED",
          `Home Assistant entity ${entityId} is mapped to both ${previousMetric} and ${metric} on sensor ${sensor.id}`,
        );
      }
      metricsByEntityId.set(entityId, metric);
      const owner = existingBinding.get(sensor.houseId, entityId, sensor.id) as { sensor_id: string; metric: string } | undefined
        ?? legacyBatteryBinding.get(sensor.houseId, sensor.id, entityId) as { sensor_id: string; metric: string } | undefined;
      if (owner) {
        throw new ClimateDataValidationError(
          409,
          "HOME_ASSISTANT_ENTITY_ALREADY_MAPPED",
          `Home Assistant entity ${entityId} is already mapped to ${owner.metric} on sensor ${owner.sensor_id}`,
        );
      }
    }
    const values = [sensor.houseId, sensor.floorId, sensor.name, sensor.roomId ?? null, sensor.room, sensor.model, sensor.x, sensor.y, sensor.z,
      sensor.temperatureEntityId ?? null, sensor.humidityEntityId ?? null, sensor.batteryEntityId ?? null,
      sensor.tpLinkDeviceId ?? null, sensor.tpLinkConnectionId ?? null,
      null,
      JSON.stringify(sensor.tags), sensor.enabled ? 1 : 0, sensor.id];
    if (insert) {
      this.db.prepare(`INSERT INTO sensors
        (house_id, floor_id, name, room_id, room, model, x, y, z, temperature_entity_id, humidity_entity_id, battery_entity_id, tp_link_device_id, tp_link_connection_id,
         measurement_entity_ids_json, tags_json, enabled, id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values);
    } else {
      this.db.prepare(`UPDATE sensors SET house_id = ?, floor_id = ?, name = ?, room_id = ?, room = ?, model = ?, x = ?, y = ?, z = ?,
        temperature_entity_id = ?, humidity_entity_id = ?, battery_entity_id = ?, tp_link_device_id = ?, tp_link_connection_id = ?, measurement_entity_ids_json = ?,
        tags_json = ?, enabled = ? WHERE id = ?`)
        .run(...values);
    }
    this.db.prepare("DELETE FROM sensor_measurement_bindings WHERE sensor_id = ?").run(sensor.id);
    const insertBinding = this.db.prepare("INSERT INTO sensor_measurement_bindings(sensor_id, metric, entity_id) VALUES (?, ?, ?)");
    for (const [metric, entityId] of Object.entries(bindings)) insertBinding.run(sensor.id, metric, entityId);
  }

  deleteSensor(id: string): boolean {
    return this.immediateTransaction(() => {
      const historicalAlert = this.db.prepare(`SELECT id FROM alert_events
        WHERE sensor_id = ? LIMIT 1`).get(id) as { id: string } | undefined;
      if (historicalAlert) {
        throw new ClimateDataValidationError(
          409,
          "ALERT_HISTORY_EXISTS",
          `Sensor ${id} has historical alert events; disable it instead of deleting it`,
        );
      }
      this.requireImmutableTelemetryLineage("sensor", id);
      const deleted = Number(this.db.prepare("DELETE FROM sensors WHERE id = ?").run(id).changes) > 0;
      if (!deleted) return false;
      this.db.prepare(`DELETE FROM static_parameters
        WHERE scope_type = 'sensor' AND scope_id = ?`).run(id);
      return true;
    });
  }

  listMeasurementDefinitions(includeDisabled = true): MeasurementDefinition[] {
    const rows = (includeDisabled
      ? this.db.prepare("SELECT * FROM measurement_definitions ORDER BY builtin DESC, id").all()
      : this.db.prepare("SELECT * FROM measurement_definitions WHERE enabled = 1 ORDER BY builtin DESC, id").all()) as unknown as MeasurementDefinitionRow[];
    return rows.map(measurementDefinitionFromRow);
  }

  getMeasurementDefinition(id: string): MeasurementDefinition | null {
    const row = this.db.prepare("SELECT * FROM measurement_definitions WHERE id = ?").get(id) as unknown as MeasurementDefinitionRow | undefined;
    return row ? measurementDefinitionFromRow(row) : null;
  }

  createMeasurementDefinition(definition: MeasurementDefinition): MeasurementDefinition {
    this.db.prepare(`INSERT INTO measurement_definitions
      (id, labels_json, unit, dimension, allowed_units_json, kind, default_aggregation,
       generic_history_enabled, generic_stats_enabled, precision, valid_min, valid_max, display_min, display_max,
       interpolation_delta, color_scale, builtin, enabled, spatial_interpolation, forecast_supported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(definition.id, JSON.stringify(definition.labels), definition.unit, definition.dimension ?? "finite_scalar",
        JSON.stringify(definition.allowedUnits ?? [definition.unit]), definition.kind ?? "gauge", definition.defaultAggregation ?? "mean",
        definition.genericHistoryEnabled === false ? 0 : 1, definition.genericStatsEnabled === false ? 0 : 1, definition.precision,
        definition.validMin, definition.validMax, definition.displayMin, definition.displayMax,
        definition.interpolationDelta, definition.colorScale, definition.builtin ? 1 : 0, definition.enabled ? 1 : 0,
        definition.spatialInterpolation ? 1 : 0, definition.forecastSupported ? 1 : 0);
    return this.getMeasurementDefinition(definition.id)!;
  }

  updateMeasurementDefinition(id: string, patch: Partial<Omit<MeasurementDefinition, "id" | "builtin">>): MeasurementDefinition | null {
    const current = this.getMeasurementDefinition(id);
    if (!current) return null;
    const next: MeasurementDefinition = { ...current, ...patch, id, builtin: current.builtin };
    if (next.unit !== current.unit) {
      const usage = this.db.prepare(`SELECT 1 FROM (
        SELECT metric FROM measurement_samples WHERE metric = ?
        UNION ALL SELECT metric FROM sensor_measurement_bindings WHERE metric = ?
        UNION ALL SELECT metric FROM alert_rules WHERE metric = ?
      ) LIMIT 1`).get(id, id, id);
      if (usage) {
        throw new ClimateDataValidationError(
          409,
          "UNIT_IMMUTABLE",
          "Canonical unit cannot change after samples, sensor bindings, or alert rules reference the metric",
        );
      }
    }
    this.db.prepare(`UPDATE measurement_definitions SET labels_json = ?, unit = ?, dimension = ?, allowed_units_json = ?,
      kind = ?, default_aggregation = ?, generic_history_enabled = ?, generic_stats_enabled = ?, precision = ?,
      valid_min = ?, valid_max = ?, display_min = ?, display_max = ?, interpolation_delta = ?, color_scale = ?, enabled = ?,
      spatial_interpolation = ?, forecast_supported = ? WHERE id = ?`)
      .run(JSON.stringify(next.labels), next.unit, next.dimension ?? "finite_scalar", JSON.stringify(next.allowedUnits ?? [next.unit]),
        next.kind ?? "gauge", next.defaultAggregation ?? "mean", next.genericHistoryEnabled === false ? 0 : 1,
        next.genericStatsEnabled === false ? 0 : 1, next.precision, next.validMin, next.validMax, next.displayMin,
        next.displayMax, next.interpolationDelta, next.colorScale, next.enabled ? 1 : 0,
        next.spatialInterpolation ? 1 : 0, next.forecastSupported ? 1 : 0, id);
    if (next.enabled && !current.enabled) this.rearmEligibleNotSupportedTapoGaps(null, id);
    return next;
  }

  disableMeasurementDefinition(id: string): MeasurementDefinition | null {
    const current = this.getMeasurementDefinition(id);
    if (!current) return null;
    this.db.prepare("UPDATE measurement_definitions SET enabled = 0 WHERE id = ?").run(id);
    return { ...current, enabled: false };
  }

  private insertMeasurementSample(sample: MeasurementSample, deduplicateAcrossSources = false): boolean {
    if (deduplicateAcrossSources && this.db.prepare(`SELECT 1 FROM measurement_samples
      WHERE sensor_id = ? AND metric = ? AND timestamp = ? LIMIT 1`)
      .get(sample.sensorId, sample.metric, sample.timestamp)) return false;
    const result = this.db.prepare(`INSERT OR IGNORE INTO measurement_samples
      (sensor_id, metric, value, canonical_unit, timestamp, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sample.sensorId, sample.metric, sample.value, sample.canonicalUnit, sample.timestamp, sample.source, sample.quality);
    return Number(result.changes) > 0;
  }

  insertMeasurementSamples(
    samples: MeasurementSample[],
    options: { deduplicateAcrossSources?: boolean } = {},
  ): MeasurementSample[] {
    return this.immediateTransaction(() => {
      this.prepareTelemetrySources(samples.map((sample) => sample.source));
      const inserted: MeasurementSample[] = [];
      for (const sample of samples) {
        if (this.insertMeasurementSample(sample, options.deduplicateAcrossSources)) inserted.push(sample);
      }
      return inserted;
    });
  }

  latestMeasurementSamples(houseId?: string): MeasurementSample[] {
    const where = houseId ? "WHERE s.house_id = ?" : "";
    const rows = this.db.prepare(`SELECT ms.sensor_id, ms.metric, ms.value, ms.canonical_unit,
        ms.timestamp, ms.source, ms.quality
      FROM sensors s CROSS JOIN measurement_definitions definition
      JOIN measurement_samples ms ON ms.id = (
        SELECT latest.id FROM measurement_samples latest
        WHERE latest.sensor_id = s.id AND latest.metric = definition.id
        ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
      )
      ${where}
      ORDER BY ms.sensor_id, ms.metric`)
      .all(...(houseId ? [houseId] : [])) as unknown as MeasurementSampleRow[];
    return rows.map(measurementSampleFromRow);
  }

  getLatestMeasurementSample(sensorId: string, metric: string): MeasurementSample | null {
    const row = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples WHERE sensor_id = ? AND metric = ? ORDER BY timestamp DESC, id DESC LIMIT 1`)
      .get(sensorId, metric) as unknown as MeasurementSampleRow | undefined;
    return row ? measurementSampleFromRow(row) : null;
  }

  measurementSampleAtOrBefore(
    sensorId: string,
    metric: string,
    source: SensorDataGapSource,
    timestamp: string,
  ): MeasurementSample | null {
    const row = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND source = ? AND timestamp <= ?
      ORDER BY timestamp DESC, id DESC LIMIT 1`)
      .get(sensorId, metric, source, timestamp) as unknown as MeasurementSampleRow | undefined;
    return row ? measurementSampleFromRow(row) : null;
  }

  measurementHistory(sensorId: string, metric: string, from: string, to: string, limit = 20_000): MeasurementSample[] {
    const rows = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality FROM (
      SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC, id DESC LIMIT ?
    ) ORDER BY timestamp ASC, id ASC`).all(sensorId, metric, from, to, limit) as unknown as MeasurementSampleRow[];
    return rows.map(measurementSampleFromRow);
  }

  /**
   * Read-only, batched multi-sensor window used by optional derived engines.
   * It deliberately returns the existing sparse metric contract rather than
   * manufacturing paired climate readings in the core repository.
   */
  measurementWindow(
    sensorIds: string[],
    metrics: string[],
    from: string,
    to: string,
    limit = 100_000,
  ): MeasurementSample[] {
    if (sensorIds.length === 0 || metrics.length === 0) return [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 250_000) {
      throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Measurement window limit must be an integer from 1 to 250000");
    }
    const sensorPlaceholders = sensorIds.map(() => "?").join(",");
    const metricPlaceholders = metrics.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT sensor_id, metric, value, canonical_unit, timestamp, source, quality FROM (
      SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples
      WHERE sensor_id IN (${sensorPlaceholders}) AND metric IN (${metricPlaceholders})
        AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp DESC, id DESC LIMIT ?
    ) ORDER BY timestamp ASC, id ASC`)
      .all(...sensorIds, ...metrics, from, to, limit) as unknown as MeasurementSampleRow[];
    return rows.map(measurementSampleFromRow);
  }

  measurementHistoryBucketed(
    sensorId: string,
    metric: string,
    from: string,
    to: string,
    bucketSeconds: number,
    limit = 20_000,
  ): MeasurementSample[] {
    const rows = this.db.prepare(`WITH source_rows AS (
        SELECT id, timestamp, source,
          CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch, value
        FROM measurement_samples
        WHERE sensor_id = ? AND metric = ? AND timestamp >= ? AND timestamp <= ?
      ), recent_buckets AS (
        SELECT bucket_epoch, AVG(value) AS value, COUNT(*) AS sample_count,
          COUNT(DISTINCT source) AS source_count
        FROM source_rows WHERE bucket_epoch IS NOT NULL
        GROUP BY bucket_epoch ORDER BY bucket_epoch DESC LIMIT ?
      ), chronological_rows AS (
        SELECT id, bucket_epoch,
          ROW_NUMBER() OVER (PARTITION BY bucket_epoch ORDER BY timestamp DESC, id DESC) AS position
        FROM source_rows WHERE bucket_epoch IS NOT NULL
      )
      SELECT recent_buckets.bucket_epoch, recent_buckets.value, recent_buckets.sample_count,
        recent_buckets.source_count,
        latest.canonical_unit, latest.source, latest.quality
      FROM recent_buckets
      JOIN chronological_rows ON chronological_rows.bucket_epoch = recent_buckets.bucket_epoch
        AND chronological_rows.position = 1
      JOIN measurement_samples AS latest ON latest.id = chronological_rows.id
      ORDER BY recent_buckets.bucket_epoch ASC`)
      .all(bucketSeconds, bucketSeconds, sensorId, metric, from, to, limit) as Array<{
        bucket_epoch: number;
        value: number;
        sample_count: number;
        source_count: number;
        canonical_unit: string;
        source: MeasurementSample["source"];
        quality: MeasurementSample["quality"];
      }>;
    return rows.map((row) => ({
      sensorId,
      metric,
      value: row.value,
      canonicalUnit: row.canonical_unit,
      timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
      source: row.source,
      quality: row.sample_count > 1 || row.source_count > 1 ? "estimated" : row.quality,
    }));
  }

  sensorMeasurementPage(sensorId: string, before: { timestamp: string; id: number } | null, limit = 100): {
    samples: MeasurementSample[];
    nextCursor: string | null;
  } {
    const cursorClause = before ? "AND (timestamp < ? OR (timestamp = ? AND id < ?))" : "";
    const parameters = before
      ? [sensorId, before.timestamp, before.timestamp, before.id, limit + 1]
      : [sensorId, limit + 1];
    const rows = this.db.prepare(`SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples WHERE sensor_id = ? ${cursorClause}
      ORDER BY timestamp DESC, id DESC LIMIT ?`).all(...parameters) as unknown as (MeasurementSampleRow & { id: number })[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      samples: page.map(measurementSampleFromRow),
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify([last.timestamp, last.id])).toString("base64url") : null,
    };
  }

  /**
   * Bounded, quality-weighted temperature buckets for synchronous thermal fitting.
   * Aggregation happens in SQLite so dense 2-10 second telemetry never enters the
   * Node calibration loop or consumes the raw-row limit before covering 7 days.
   */
  thermalTemperatureHistory(
    sensorId: string,
    from: string,
    to: string,
    bucketMinutes = 5,
    limit = 5_000,
  ): MeasurementSample[] {
    if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 60) {
      throw new ClimateDataValidationError(400, "INVALID_BUCKET_SIZE", "Thermal bucket size must be 1 to 60 minutes");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 20_000) {
      throw new ClimateDataValidationError(400, "INVALID_LIMIT", "Thermal history limit must be 1 to 20000");
    }
    const bucketSeconds = bucketMinutes * 60;
    const rows = this.db.prepare(`WITH source_rows AS (
        SELECT
          CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch,
          value,
          canonical_unit,
          source,
          quality,
          CASE quality WHEN 'estimated' THEN 0.25 ELSE 1.0 END AS sample_weight
        FROM measurement_samples
        WHERE sensor_id = ? AND metric = 'temperature' AND timestamp >= ? AND timestamp <= ?
          AND quality <> 'stale' AND source <> 'replay'
      ), recent_buckets AS (
        SELECT
          bucket_epoch,
          SUM(value * sample_weight) / SUM(sample_weight) AS value,
          MAX(canonical_unit) AS canonical_unit,
          MIN(source) AS source,
          MAX(CASE WHEN quality = 'good' THEN 1 ELSE 0 END) AS has_good
        FROM source_rows
        WHERE bucket_epoch IS NOT NULL
        GROUP BY bucket_epoch
        ORDER BY bucket_epoch DESC
        LIMIT ?
      )
      SELECT bucket_epoch, value, canonical_unit, source, has_good
      FROM recent_buckets ORDER BY bucket_epoch ASC`)
      .all(bucketSeconds, bucketSeconds, sensorId, from, to, limit) as unknown as Array<{
        bucket_epoch: number;
        value: number;
        canonical_unit: string;
        source: MeasurementSample["source"];
        has_good: number;
      }>;
    return rows.map((row) => ({
      sensorId,
      metric: "temperature",
      value: row.value,
      canonicalUnit: row.canonical_unit,
      timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
      source: row.source,
      quality: row.has_good ? "good" : "estimated",
    }));
  }

  upsertOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample {
    if (![sample.temperatureC, Date.parse(sample.timestamp), Date.parse(sample.fetchedAt)].every(Number.isFinite)) {
      throw new ClimateDataValidationError(400, "INVALID_OUTDOOR_SAMPLE", "Outdoor temperature and timestamps must be finite");
    }
    if (!this.getHouse(sample.houseId)) {
      throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
    }
    return this.immediateTransaction(() => {
      if (sample.source === "mock" && this.isRealDataMode()) {
        throw new ClimateDataValidationError(409, "DEMO_DATA_DISABLED", "Synthetic outdoor samples are permanently disabled in real-data mode");
      }
      if (sample.source !== "mock" && !this.isRealDataMode()) this.activateRealDataMode();
      this.db.prepare(`INSERT INTO outdoor_temperature_samples
        (house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name, conditions_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(house_id, location_key, timestamp, source) DO UPDATE SET
          temperature_c = excluded.temperature_c,
          fetched_at = excluded.fetched_at,
          station_id = excluded.station_id,
          station_name = excluded.station_name,
          conditions_json = excluded.conditions_json`)
        .run(sample.houseId, sample.locationKey, sample.timestamp, sample.temperatureC, sample.source,
          sample.fetchedAt, sample.stationId, sample.stationName,
          sample.conditions ? JSON.stringify(sample.conditions) : null);
      return sample;
    });
  }

  /**
   * Persist a live boundary only while its opaque location key still matches
   * the house's current weather location. The check happens before the
   * irreversible real-data latch in `upsertOutdoorTemperatureSample`.
   */
  upsertCurrentOutdoorTemperatureSample(sample: OutdoorTemperatureSample): OutdoorTemperatureSample {
    const house = this.getHouse(sample.houseId);
    if (!house) {
      throw new ClimateDataValidationError(404, "HOUSE_NOT_FOUND", `House ${sample.houseId} does not exist`);
    }
    if (sample.locationKey !== outdoorLocationKey(house.location)) {
      throw new ClimateDataValidationError(
        409,
        "WEATHER_REQUEST_SUPERSEDED",
        "House location changed while weather was loading; the old-location observation was discarded",
      );
    }
    return this.upsertOutdoorTemperatureSample(sample);
  }

  outdoorTemperatureHistory(
    houseId: string,
    locationKey: string,
    from: string,
    to: string,
    limit = 20_000,
  ): OutdoorTemperatureSample[] {
    const rows = this.db.prepare(`SELECT house_id, location_key, timestamp, temperature_c, source, fetched_at,
      station_id, station_name, conditions_json FROM (
        SELECT rowid, house_id, location_key, timestamp, temperature_c, source, fetched_at, station_id, station_name,
          conditions_json
        FROM outdoor_temperature_samples
        WHERE house_id = ? AND location_key = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC, rowid DESC LIMIT ?
      ) ORDER BY timestamp ASC, rowid ASC`)
      .all(houseId, locationKey, from, to, limit) as unknown as OutdoorTemperatureRow[];
    return rows.map(outdoorTemperatureFromRow);
  }

  outdoorTemperatureGaps(
    houseId: string,
    locationKey: string,
    provider: WeatherProviderName,
    from: string,
    to: string,
    minimumGapMs: number,
    limit = 100,
  ): HistoricalTelemetryGap[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const thresholdSeconds = Math.max(1, minimumGapMs / 1_000);
    const sourcePrefix = provider === "fmi" ? "fmi-%" : "open-meteo-%";
    const rows = this.db.prepare(`WITH sample_times AS (
        SELECT DISTINCT timestamp FROM outdoor_temperature_samples
        WHERE house_id = ? AND location_key = ? AND source LIKE ?
          AND timestamp >= ? AND timestamp <= ?
      ), ordered AS (
        SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS previous_timestamp
        FROM sample_times
      )
      SELECT previous_timestamp AS started_at, timestamp AS ended_at,
        (julianday(timestamp) - julianday(previous_timestamp)) * 86400000.0 AS duration_ms
      FROM ordered
      WHERE previous_timestamp IS NOT NULL
        AND (julianday(timestamp) - julianday(previous_timestamp)) * 86400.0 >= ?
      ORDER BY previous_timestamp LIMIT ?`)
      .all(houseId, locationKey, sourcePrefix, from, to, thresholdSeconds, safeLimit) as unknown as Array<{
        started_at: string;
        ended_at: string;
        duration_ms: number;
      }>;
    return rows.map((row) => ({
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: Math.max(0, Math.round(row.duration_ms)),
    }));
  }

  latestOutdoorTemperatureTimestamp(
    houseId: string,
    locationKey: string,
    provider: WeatherProviderName,
  ): string | null {
    const sourcePrefix = provider === "fmi" ? "fmi-%" : "open-meteo-%";
    const row = this.db.prepare(`SELECT timestamp FROM outdoor_temperature_samples
      WHERE house_id = ? AND location_key = ? AND source LIKE ?
      ORDER BY timestamp DESC LIMIT 1`)
      .get(houseId, locationKey, sourcePrefix) as { timestamp?: string } | undefined;
    return row?.timestamp ?? null;
  }

  noteHistoricalWeatherObservationGap(
    houseId: string,
    locationKey: string,
    provider: WeatherProviderName,
    startedAt: string,
    endedAt: string,
    detectedAt = new Date().toISOString(),
  ): WeatherOutageRecord {
    const existing = this.db.prepare(`SELECT * FROM weather_outages
      WHERE house_id = ? AND location_key = ? AND provider = ?
        AND component = 'observation' AND backfill_from = ? AND backfill_to = ?
      ORDER BY id DESC LIMIT 1`)
      .get(houseId, locationKey, provider, startedAt, endedAt) as unknown as WeatherOutageRow | undefined;
    if (existing) return weatherOutageFromRow(existing);
    const result = this.db.prepare(`INSERT INTO weather_outages
      (house_id, location_key, provider, component, started_at, last_seen_at, ended_at, last_error,
       backfill_state, backfill_from, backfill_to, recovered_points, last_attempt_at, backfill_error)
      VALUES (?, ?, ?, 'observation', ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL)`)
      .run(
        houseId,
        locationKey,
        provider,
        startedAt,
        detectedAt,
        endedAt,
        "A historical observation gap was found in stored weather telemetry",
        startedAt,
        endedAt,
      );
    const inserted = this.db.prepare("SELECT * FROM weather_outages WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as WeatherOutageRow;
    return weatherOutageFromRow(inserted);
  }

  noteWeatherOutage(
    houseId: string,
    locationKey: string,
    provider: WeatherProviderName,
    component: WeatherOutageComponent,
    error: string,
    detectedAt = new Date().toISOString(),
  ): WeatherOutageRecord {
    this.db.prepare(`INSERT INTO weather_outages
      (house_id, location_key, provider, component, started_at, last_seen_at, ended_at, last_error,
       backfill_state, backfill_from, backfill_to, recovered_points, last_attempt_at, backfill_error)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'not-needed', NULL, NULL, 0, NULL, NULL)
      ON CONFLICT(house_id, location_key, provider, component) WHERE ended_at IS NULL DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        last_error = excluded.last_error`)
      .run(houseId, locationKey, provider, component, detectedAt, detectedAt, error);
    const row = this.db.prepare(`SELECT * FROM weather_outages
      WHERE house_id = ? AND location_key = ? AND provider = ? AND component = ? AND ended_at IS NULL`)
      .get(houseId, locationKey, provider, component) as unknown as WeatherOutageRow;
    return weatherOutageFromRow(row);
  }

  resolveWeatherOutages(
    houseId: string,
    locationKey: string,
    provider: WeatherProviderName,
    components: readonly WeatherOutageComponent[],
    endedAt = new Date().toISOString(),
  ): WeatherOutageRecord[] {
    if (components.length === 0) return [];
    const placeholders = components.map(() => "?").join(",");
    this.db.prepare(`UPDATE weather_outages SET
        ended_at = ?,
        backfill_state = CASE WHEN component IN ('service', 'observation') THEN 'pending' ELSE 'not-supported' END,
        backfill_from = CASE WHEN component IN ('service', 'observation') THEN started_at ELSE NULL END,
        backfill_to = CASE WHEN component IN ('service', 'observation') THEN ? ELSE NULL END,
        backfill_error = NULL
      WHERE house_id = ? AND location_key = ? AND provider = ? AND ended_at IS NULL
        AND component IN (${placeholders})`)
      .run(endedAt, endedAt, houseId, locationKey, provider, ...components);
    return this.listWeatherOutages(houseId, locationKey)
      .filter((outage) => outage.endedAt === endedAt && components.includes(outage.component));
  }

  listWeatherOutages(houseId: string, locationKey: string, limit = 50): WeatherOutageRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT * FROM weather_outages
      WHERE house_id = ? AND location_key = ?
      ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(houseId, locationKey, safeLimit) as unknown as WeatherOutageRow[];
    return rows.map(weatherOutageFromRow);
  }

  updateWeatherOutageBackfill(
    id: number,
    state: WeatherBackfillState,
    recoveredPoints: number,
    attemptedAt: string,
    error: string | null,
  ): void {
    this.db.prepare(`UPDATE weather_outages SET backfill_state = ?, recovered_points = ?,
      last_attempt_at = ?, backfill_error = ? WHERE id = ?`)
      .run(state, Math.max(0, Math.trunc(recoveredPoints)), attemptedAt, error, id);
  }

  latestMeasurementTimestamp(sensorId: string, metric: string, source: SensorDataGapSource): string | null {
    const row = this.db.prepare(`SELECT timestamp FROM measurement_samples
      WHERE sensor_id = ? AND metric = ? AND source = ?
      ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sensorId, metric, source) as { timestamp?: string } | undefined;
    return row?.timestamp ?? null;
  }

  sensorSourceMetrics(sensorId: string, source: SensorDataGapSource): string[] {
    const rows = this.db.prepare(`SELECT metric, MAX(timestamp) AS latest_timestamp FROM measurement_samples
      WHERE sensor_id = ? AND source = ? GROUP BY metric ORDER BY metric`)
      .all(sensorId, source) as unknown as Array<{ metric: string; latest_timestamp: string }>;
    return rows.map((row) => row.metric);
  }

  measurementSampleGaps(
    sensorId: string,
    metric: string,
    source: SensorDataGapSource,
    from: string,
    to: string,
    minimumGapMs: number,
    limit = 100,
  ): HistoricalTelemetryGap[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const thresholdSeconds = Math.max(1, minimumGapMs / 1_000);
    const rows = this.db.prepare(`WITH ordered AS (
        SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS previous_timestamp
        FROM measurement_samples
        WHERE sensor_id = ? AND metric = ? AND source = ?
          AND quality = 'good' AND timestamp >= ? AND timestamp <= ?
      )
      SELECT previous_timestamp AS started_at, timestamp AS ended_at,
        (julianday(timestamp) - julianday(previous_timestamp)) * 86400000.0 AS duration_ms
      FROM ordered
      WHERE previous_timestamp IS NOT NULL
        AND (julianday(timestamp) - julianday(previous_timestamp)) * 86400.0 > ?
        AND NOT EXISTS (
          SELECT 1 FROM sensor_data_gaps AS known
          WHERE known.sensor_id = ? AND known.metric = ? AND known.source = ?
            AND known.started_at <= previous_timestamp
            AND COALESCE(known.ended_at, timestamp) >= timestamp
        )
      ORDER BY previous_timestamp LIMIT ?`)
      .all(
        sensorId, metric, source, from, to, thresholdSeconds,
        sensorId, metric, source, safeLimit,
      ) as unknown as Array<{
        started_at: string;
        ended_at: string;
        duration_ms: number;
      }>;
    return rows.map((row) => ({
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationMs: Math.max(0, Math.round(row.duration_ms)),
    }));
  }

  noteHistoricalSensorDataGap(
    sensorId: string,
    metric: string,
    source: SensorDataGapSource,
    startedAt: string,
    endedAt: string,
    detectedAt = new Date().toISOString(),
  ): SensorDataGapRecord {
    const existing = this.db.prepare(`SELECT * FROM sensor_data_gaps
      WHERE sensor_id = ? AND metric = ? AND source = ? AND started_at = ? AND ended_at = ?
      ORDER BY id DESC LIMIT 1`)
      .get(sensorId, metric, source, startedAt, endedAt) as unknown as SensorDataGapRow | undefined;
    if (existing) return sensorDataGapFromRow(existing);
    const result = this.db.prepare(`INSERT INTO sensor_data_gaps
      (sensor_id, metric, source, started_at, detected_at, ended_at, recovery_state,
       recovered_points, attempt_count, last_attempt_at, next_attempt_at, recovery_error)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL, ?, NULL)`)
      .run(sensorId, metric, source, startedAt, detectedAt, endedAt, detectedAt);
    const inserted = this.db.prepare("SELECT * FROM sensor_data_gaps WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as SensorDataGapRow;
    return sensorDataGapFromRow(inserted);
  }

  /** Explicitly rearms one closed historical gap without disturbing an active recovery lease. */
  rearmSensorDataGapRecovery(
    id: number,
    availableAt = new Date().toISOString(),
    resetAttempts = true,
  ): SensorDataGapRecord | null {
    const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
    const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
        attempt_count = CASE WHEN ? = 1 THEN 0 ELSE attempt_count END,
        next_attempt_at = ?, recovery_error = NULL
      WHERE id = ? AND ended_at IS NOT NULL AND recovery_state <> 'running'`)
      .run(resetAttempts ? 1 : 0, at, id);
    return Number(result.changes) > 0 ? this.sensorDataGap(id) : this.sensorDataGap(id);
  }

  /** Rearms persisted TP-Link gaps after a previously unavailable fallback is configured. */
  rearmNotSupportedSensorDataGaps(
    source: SensorDataGapSource,
    capabilityRevision: string,
    availableAt = new Date().toISOString(),
  ): number {
    const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
    const revision = normalizedTapoHistoryText(capabilityRevision, "capabilityRevision", 200);
    const key = `sensor-gap-rearm:${source}`;
    return this.immediateTransaction(() => {
      const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?")
        .get(key) as { value: string } | undefined;
      if (current?.value === revision) return 0;
      const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
          attempt_count = 0, next_attempt_at = ?, recovery_error = NULL
        WHERE id IN (
          SELECT gap.id FROM sensor_data_gaps AS gap
          JOIN sensors AS sensor ON sensor.id = gap.sensor_id
          JOIN measurement_definitions AS definition ON definition.id = gap.metric
          WHERE gap.source = ? AND gap.ended_at IS NOT NULL
            AND gap.recovery_state = 'not-supported'
            AND sensor.enabled = 1 AND definition.enabled = 1
            AND sensor.tp_link_device_id IS NOT NULL AND trim(sensor.tp_link_device_id) <> ''
        )`).run(at, source);
      this.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, revision);
      return Number(result.changes);
    });
  }

  /**
   * Rearms the obsolete T310/T315 capability failure once local retained
   * history becomes available. Gaps outside the hub's retained window remain
   * terminal because retrying them locally can no longer recover the range.
   */
  rearmRetainedTpLinkClimateHistoryGaps(
    capabilityRevision: string,
    availableAt = new Date().toISOString(),
  ): number {
    const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
    const revision = normalizedTapoHistoryText(capabilityRevision, "capabilityRevision", 200);
    const retainedAfter = new Date(Date.parse(at) - TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS).toISOString();
    return this.immediateTransaction(() => {
      const current = this.db.prepare("SELECT value FROM metadata WHERE key = ?")
        .get(TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY) as { value: string } | undefined;
      if (current?.value === revision) return 0;
      const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
          attempt_count = 0, next_attempt_at = ?, recovery_error = NULL
        WHERE id IN (
          SELECT gap.id FROM sensor_data_gaps AS gap
          JOIN sensors AS sensor ON sensor.id = gap.sensor_id
          JOIN measurement_definitions AS definition ON definition.id = gap.metric
          WHERE gap.source = 'tp-link' AND gap.ended_at IS NOT NULL
            AND gap.recovery_state = 'not-supported'
            AND gap.metric IN ('temperature', 'humidity')
            AND gap.recovery_error = ?
            AND gap.started_at >= ? AND gap.ended_at <= ?
            AND sensor.enabled = 1 AND definition.enabled = 1
            AND sensor.tp_link_device_id IS NOT NULL AND trim(sensor.tp_link_device_id) <> ''
        )`).run(at, TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR, retainedAfter, at);
      this.db.prepare(`INSERT INTO metadata(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY, revision);
      return Number(result.changes);
    });
  }

  private rearmEligibleNotSupportedTapoGaps(sensorId: string | null, metric: string | null): number {
    const at = new Date().toISOString();
    const retainedAfter = new Date(Date.parse(at) - TP_LINK_LOCAL_CLIMATE_HISTORY_RETENTION_MS).toISOString();
    const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'pending',
        attempt_count = 0, next_attempt_at = ?, recovery_error = NULL
      WHERE source = 'tp-link' AND ended_at IS NOT NULL AND recovery_state = 'not-supported'
        AND (? IS NULL OR sensor_id = ?) AND (? IS NULL OR metric = ?)
        AND (
          EXISTS (SELECT 1 FROM metadata WHERE key = 'sensor-gap-rearm:tp-link')
          OR (
            EXISTS (SELECT 1 FROM metadata WHERE key = ?)
            AND sensor_data_gaps.metric IN ('temperature', 'humidity')
            AND sensor_data_gaps.recovery_error = ?
            AND sensor_data_gaps.started_at >= ? AND sensor_data_gaps.ended_at <= ?
          )
        )
        AND EXISTS (
          SELECT 1 FROM sensors AS sensor
          WHERE sensor.id = sensor_data_gaps.sensor_id AND sensor.enabled = 1
            AND sensor.tp_link_device_id IS NOT NULL AND trim(sensor.tp_link_device_id) <> ''
        )
        AND EXISTS (
          SELECT 1 FROM measurement_definitions AS definition
          WHERE definition.id = sensor_data_gaps.metric AND definition.enabled = 1
        )`).run(
      at, sensorId, sensorId, metric, metric,
      TP_LINK_LOCAL_CLIMATE_HISTORY_REARM_KEY, TP_LINK_LEGACY_CLIMATE_HISTORY_ERROR, retainedAfter, at,
    );
    return Number(result.changes);
  }

  openSensorDataGap(sensorId: string, metric: string, source: SensorDataGapSource): SensorDataGapRecord | null {
    const row = this.db.prepare(`SELECT * FROM sensor_data_gaps
      WHERE sensor_id = ? AND metric = ? AND source = ? AND ended_at IS NULL LIMIT 1`)
      .get(sensorId, metric, source) as unknown as SensorDataGapRow | undefined;
    return row ? sensorDataGapFromRow(row) : null;
  }

  noteSensorDataGap(
    sensorId: string,
    metric: string,
    source: SensorDataGapSource,
    startedAt: string,
    detectedAt = new Date().toISOString(),
  ): SensorDataGapRecord {
    this.db.prepare(`INSERT INTO sensor_data_gaps
      (sensor_id, metric, source, started_at, detected_at, ended_at, recovery_state,
       recovered_points, attempt_count, last_attempt_at, next_attempt_at, recovery_error)
      VALUES (?, ?, ?, ?, ?, NULL, 'open', 0, 0, NULL, NULL, NULL)
      ON CONFLICT(sensor_id, metric, source) WHERE ended_at IS NULL DO UPDATE SET
        detected_at = excluded.detected_at`)
      .run(sensorId, metric, source, startedAt, detectedAt);
    const gap = this.openSensorDataGap(sensorId, metric, source);
    if (!gap) throw new Error("Could not persist the detected sensor data gap");
    return gap;
  }

  resolveSensorDataGap(
    sensorId: string,
    metric: string,
    source: SensorDataGapSource,
    endedAt = new Date().toISOString(),
  ): SensorDataGapRecord | null {
    const current = this.openSensorDataGap(sensorId, metric, source);
    if (!current) return null;
    const normalizedEnd = Date.parse(endedAt) > Date.parse(current.startedAt) ? endedAt : current.detectedAt;
    this.db.prepare(`UPDATE sensor_data_gaps SET ended_at = ?, recovery_state = 'pending',
      next_attempt_at = ?, recovery_error = NULL WHERE id = ? AND ended_at IS NULL`)
      .run(normalizedEnd, normalizedEnd, current.id);
    return this.sensorDataGap(current.id);
  }

  sensorDataGap(id: number): SensorDataGapRecord | null {
    const row = this.db.prepare("SELECT * FROM sensor_data_gaps WHERE id = ?").get(id) as unknown as SensorDataGapRow | undefined;
    return row ? sensorDataGapFromRow(row) : null;
  }

  listSensorDataGaps(sensorId?: string, limit = 100): SensorDataGapRecord[] {
    const safeLimit = Math.max(1, Math.min(1_000, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT * FROM sensor_data_gaps ${sensorId ? "WHERE sensor_id = ?" : ""}
      ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...(sensorId ? [sensorId, safeLimit] : [safeLimit])) as unknown as SensorDataGapRow[];
    return rows.map(sensorDataGapFromRow);
  }

  recoverableSensorDataGaps(now = new Date().toISOString(), limit = 100): SensorDataGapRecord[] {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`SELECT * FROM sensor_data_gaps
      WHERE ended_at IS NOT NULL
        AND recovery_state IN ('pending', 'failed', 'partial', 'running')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY COALESCE(next_attempt_at, ended_at), id LIMIT ?`)
      .all(now, safeLimit) as unknown as SensorDataGapRow[];
    return rows.map(sensorDataGapFromRow);
  }

  claimSensorDataGapRecovery(id: number, attemptedAt: string, leaseUntil: string): SensorDataGapRecord | null {
    const result = this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = 'running',
      attempt_count = attempt_count + 1, last_attempt_at = ?, next_attempt_at = ?, recovery_error = NULL
      WHERE id = ? AND ended_at IS NOT NULL
        AND recovery_state IN ('pending', 'failed', 'partial', 'running')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`)
      .run(attemptedAt, leaseUntil, id, attemptedAt);
    return Number(result.changes) > 0 ? this.sensorDataGap(id) : null;
  }

  updateSensorDataGapRecovery(
    id: number,
    state: Exclude<SensorDataGapState, "open" | "pending" | "running">,
    recoveredPoints: number,
    attemptedAt: string,
    error: string | null,
    nextAttemptAt: string | null = null,
  ): void {
    this.db.prepare(`UPDATE sensor_data_gaps SET recovery_state = ?, recovered_points = ?,
      last_attempt_at = ?, next_attempt_at = ?, recovery_error = ? WHERE id = ?`)
      .run(state, Math.max(0, Math.trunc(recoveredPoints)), attemptedAt, nextAttemptAt, error, id);
  }

  /** Makes a completed asynchronous export immediately eligible for the gap coordinator's next pass. */
  expediteSensorDataGapRecovery(
    sensorId: string,
    source: SensorDataGapSource,
    from: string,
    to: string,
    now = new Date().toISOString(),
  ): number {
    const rangeStart = normalizedTapoHistoryTimestamp(from, "from");
    const rangeEnd = normalizedTapoHistoryTimestamp(to, "to");
    const attemptedAt = normalizedTapoHistoryTimestamp(now, "now");
    if (Date.parse(rangeStart) > Date.parse(rangeEnd)) {
      throw new ClimateDataValidationError(422, "INVALID_SENSOR_GAP_RANGE", "from must be before or equal to to");
    }
    const result = this.db.prepare(`UPDATE sensor_data_gaps SET next_attempt_at = ?, recovery_error = NULL
      WHERE sensor_id = ? AND source = ? AND ended_at IS NOT NULL
        AND recovery_state IN ('partial', 'failed')
        AND started_at <= ? AND ended_at >= ?`)
      .run(attemptedAt, sensorId, source, rangeEnd, rangeStart);
    return Number(result.changes);
  }

  /** Creates one durable export request, returning the prior job when its idempotency key already exists. */
  enqueueTapoHistoryExportJob(
    input: TapoHistoryExportJobInput,
    createdAt = new Date().toISOString(),
  ): TapoHistoryExportEnqueueResult {
    if (input.provider !== "appium" && input.provider !== "private-cloud") {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_PROVIDER", "Unsupported Tapo history export provider");
    }
    const sensor = this.getSensor(input.sensorId);
    if (!sensor) throw new ClimateDataValidationError(404, "SENSOR_NOT_FOUND", `Sensor ${input.sensorId} does not exist`);
    const expectedDeviceId = normalizedTapoHistoryText(input.expectedDeviceId, "expectedDeviceId", 500);
    if (sensor.tpLinkDeviceId && sensor.tpLinkDeviceId !== expectedDeviceId) {
      throw new ClimateDataValidationError(
        409,
        "TAPO_EXPORT_DEVICE_MISMATCH",
        `Expected device ${expectedDeviceId} does not match sensor ${sensor.id}`,
      );
    }
    const deviceName = normalizedTapoHistoryText(input.deviceName ?? sensor.name, "deviceName", 500);
    const house = this.getHouse(sensor.houseId);
    if (!house) throw new ClimateDataValidationError(409, "TAPO_EXPORT_CONTEXT_MISSING", "Sensor house does not exist");
    const timeZone = normalizedTapoHistoryText(input.timeZone ?? house.timezone, "timeZone", 100);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    } catch {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_TIMEZONE", "timeZone must be a valid IANA timezone");
    }
    const metric = normalizedTapoHistoryText(input.metric, "metric", 200);
    if (!this.getMeasurementDefinition(metric)) {
      throw new ClimateDataValidationError(404, "TAPO_EXPORT_METRIC_NOT_FOUND", `Unknown measurement metric: ${metric}`);
    }
    const expectedRecipient = input.expectedRecipient === null
      ? null
      : normalizedTapoHistoryText(input.expectedRecipient, "expectedRecipient", 320).toLowerCase();
    if (expectedRecipient !== null) {
      const separator = expectedRecipient.lastIndexOf("@");
      if (separator < 1 || separator === expectedRecipient.length - 1) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RECIPIENT", "expectedRecipient must be an email address");
      }
    } else if (input.provider === "appium") {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RECIPIENT", "Appium exports require expectedRecipient");
    }
    const rangeStart = normalizedTapoHistoryTimestamp(input.rangeStart, "rangeStart");
    const rangeEnd = normalizedTapoHistoryTimestamp(input.rangeEnd, "rangeEnd");
    if (Date.parse(rangeStart) >= Date.parse(rangeEnd)) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RANGE", "rangeStart must be before rangeEnd");
    }
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 525_600) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_TAPO_EXPORT_INTERVAL",
        "intervalMinutes must be an integer between 1 and 525600",
      );
    }
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_ATTEMPTS", "maxAttempts must be between 1 and 100");
    }
    const normalizedCreatedAt = normalizedTapoHistoryTimestamp(createdAt, "createdAt");
    const availableAt = normalizedTapoHistoryTimestamp(input.availableAt ?? normalizedCreatedAt, "availableAt");
    const naturalKey = [
      input.provider, sensor.id, expectedDeviceId, deviceName, timeZone, metric, rangeStart, rangeEnd,
      String(input.intervalMinutes),
    ].join("\u0000");
    const dedupeKey = input.dedupeKey === undefined
      ? `request:${createHash("sha256").update(naturalKey).digest("hex")}`
      : normalizedTapoHistoryText(input.dedupeKey, "dedupeKey", 500);

    return this.immediateTransaction(() => {
      const existingRow = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE dedupe_key = ?")
        .get(dedupeKey) as unknown as TapoHistoryExportJobRow | undefined;
      if (existingRow) {
        const existing = tapoHistoryExportJobFromRow(existingRow);
        if (existing.provider !== input.provider || existing.sensorId !== sensor.id
          || existing.expectedDeviceId !== expectedDeviceId || existing.deviceName !== deviceName
          || existing.timeZone !== timeZone || existing.metric !== metric
          || existing.rangeStart !== rangeStart || existing.rangeEnd !== rangeEnd
          || existing.intervalMinutes !== input.intervalMinutes) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_DEDUPE_COLLISION",
            "The Tapo export idempotency key is already associated with a different request",
          );
        }
        return { job: existing, created: false };
      }
      const id = input.id === undefined ? randomUUID() : normalizedTapoHistoryText(input.id, "id", 200);
      if (this.getTapoHistoryExportJob(id)) {
        throw new ClimateDataValidationError(
          409,
          "TAPO_EXPORT_ID_COLLISION",
          "The Tapo export job id is already associated with a different request",
        );
      }
      this.db.prepare(`INSERT INTO tapo_history_export_jobs (
          id, dedupe_key, provider, sensor_id, expected_device_id, device_name, time_zone, metric, expected_recipient,
          range_start, range_end, interval_minutes, status, attempt_count, max_attempts,
          available_at, lease_owner, lease_token, lease_expires_at, heartbeat_at, submitted_at,
          deployment_fingerprint, acceptance_revision, mailbox_message_id, source_artifact_sha256, source_artifact_bytes,
          parser_version, source_schema_signature, expected_schema_signature,
          staged_sample_count, consumed_sample_count, last_error,
          attention_reason, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, ?, ?, NULL)`)
        .run(
          id, dedupeKey, input.provider, sensor.id, expectedDeviceId, deviceName, timeZone, metric, expectedRecipient,
          rangeStart, rangeEnd, input.intervalMinutes, maxAttempts, availableAt,
          normalizedCreatedAt, normalizedCreatedAt,
        );
      if (dedupeKey.startsWith("canary:") && !dedupeKey.startsWith("canary:renewal:")) {
        this.db.prepare(`DELETE FROM tapo_history_canary_approvals
          WHERE canary_job_id IN (
            SELECT prior.id FROM tapo_history_export_jobs AS prior
            WHERE prior.sensor_id = ? AND prior.expected_device_id = ? AND prior.device_name = ?
              AND prior.time_zone = ? AND prior.interval_minutes = ?
          )`).run(sensor.id, expectedDeviceId, deviceName, timeZone, input.intervalMinutes);
        this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'needs-attention',
            attention_reason = 'Target relocked for manual Tapo canary recertification', updated_at = ?
          WHERE id <> ? AND provider = 'appium' AND dedupe_key NOT LIKE 'canary:%'
            AND sensor_id = ? AND expected_device_id = ? AND device_name = ?
            AND time_zone = ? AND interval_minutes = ?
            AND status IN ('claimed', 'running', 'waiting-email')`)
          .run(normalizedCreatedAt, id, sensor.id, expectedDeviceId, deviceName, timeZone, input.intervalMinutes);
      }
      return { job: this.getTapoHistoryExportJob(id)!, created: true };
    });
  }

  getTapoHistoryExportJob(id: string): TapoHistoryExportJob | null {
    const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
      .get(id) as unknown as TapoHistoryExportJobRow | undefined;
    return row ? tapoHistoryExportJobFromRow(row) : null;
  }

  getTapoHistoryExportJobByDedupeKey(dedupeKey: string): TapoHistoryExportJob | null {
    const key = normalizedTapoHistoryText(dedupeKey, "dedupeKey", 500);
    const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE dedupe_key = ?")
      .get(key) as unknown as TapoHistoryExportJobRow | undefined;
    return row ? tapoHistoryExportJobFromRow(row) : null;
  }

  listTapoHistoryExportJobs(filter: TapoHistoryExportJobFilter = {}): TapoHistoryExportJob[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filter.statuses) {
      const statuses = [...new Set(filter.statuses)];
      if (statuses.length === 0) return [];
      if (statuses.some((status) => !(status in TAPO_HISTORY_EXPORT_TRANSITIONS))) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_STATUS", "Unsupported Tapo export status");
      }
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    }
    if (filter.provider) {
      if (filter.provider !== "appium" && filter.provider !== "private-cloud") {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_PROVIDER", "Unsupported Tapo history export provider");
      }
      conditions.push("provider = ?");
      parameters.push(filter.provider);
    }
    if (filter.sensorId) {
      conditions.push("sensor_id = ?");
      parameters.push(filter.sensorId);
    }
    const limit = Math.max(1, Math.min(1_000, Math.trunc(filter.limit ?? 100)));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const direction = filter.oldestFirst === true ? "ASC" : "DESC";
    const rows = this.db.prepare(`SELECT * FROM tapo_history_export_jobs ${where}
      ORDER BY created_at ${direction}, id ${direction} LIMIT ?`).all(...parameters, limit) as unknown as TapoHistoryExportJobRow[];
    return rows.map(tapoHistoryExportJobFromRow);
  }

  hasOpenTapoHistoryCanary(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 AS present FROM tapo_history_export_jobs
      WHERE dedupe_key LIKE 'canary:%' AND status NOT IN ('completed', 'cancelled') LIMIT 1`).get());
  }

  countWaitingTapoHistoryExportEmails(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM tapo_history_export_jobs
      WHERE provider = 'appium' AND status = 'waiting-email'`).get() as { count: number };
    return Number(row.count);
  }

  hasRecentTapoHistoryCanaryApproval(deploymentFingerprint: string, notBefore: string): boolean {
    const fingerprint = normalizedSha256(deploymentFingerprint, "deploymentFingerprint");
    const cutoff = normalizedTapoHistoryTimestamp(notBefore, "notBefore");
    return Boolean(this.db.prepare(`SELECT 1 AS approved FROM tapo_history_canary_approvals AS approval
      JOIN tapo_history_export_jobs AS job ON job.id = approval.canary_job_id
      WHERE approval.deployment_fingerprint = ? AND approval.approved_at >= ?
        AND job.status = 'completed' AND job.dedupe_key LIKE 'canary:%'
      LIMIT 1`).get(fingerprint, cutoff));
  }

  approveTapoHistoryDeploymentFromCanary(
    canaryJobId: string,
    acceptanceRevision: string,
    approvedAt = new Date().toISOString(),
  ): void {
    const at = normalizedTapoHistoryTimestamp(approvedAt, "approvedAt");
    const revision = normalizedSha256(acceptanceRevision, "acceptanceRevision");
    this.immediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
        .get(canaryJobId) as unknown as TapoHistoryExportJobRow | undefined;
      if (!row || row.status !== "completed" || !row.dedupe_key.startsWith("canary:")
        || !row.deployment_fingerprint || !row.source_schema_signature) {
        throw new ClimateDataValidationError(
          409,
          "TAPO_CANARY_NOT_APPROVABLE",
          "Only a completed canary tied to an attested deployment can approve automation",
        );
      }
      const fingerprint = normalizedSha256(row.deployment_fingerprint, "deploymentFingerprint");
      this.db.prepare(`DELETE FROM tapo_history_canary_approvals WHERE deployment_fingerprint = ?
        AND canary_job_id IN (
          SELECT id FROM tapo_history_export_jobs
          WHERE sensor_id = ? AND expected_device_id = ? AND device_name = ?
            AND time_zone = ? AND interval_minutes = ?
        )`).run(
        fingerprint,
        row.sensor_id,
        row.expected_device_id,
        row.device_name,
        row.time_zone,
        row.interval_minutes,
      );
      this.db.prepare(`INSERT INTO tapo_history_canary_approvals
          (deployment_fingerprint, canary_job_id, acceptance_revision, schema_signature, approved_at)
          VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(deployment_fingerprint, canary_job_id) DO UPDATE SET
          acceptance_revision = excluded.acceptance_revision,
          schema_signature = excluded.schema_signature,
          approved_at = excluded.approved_at`)
        .run(fingerprint, canaryJobId, revision, row.source_schema_signature, at);
    });
  }

  /** A newly requested canary durably relocks its exact device/timezone/interval scope. */
  revokeTapoHistoryCanaryApprovalsForTarget(canaryJobId: string): number {
    const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
      .get(canaryJobId) as unknown as TapoHistoryExportJobRow | undefined;
    if (!row || !row.dedupe_key.startsWith("canary:")) {
      throw new ClimateDataValidationError(409, "TAPO_CANARY_NOT_FOUND", "Canary target does not exist");
    }
    const result = this.db.prepare(`DELETE FROM tapo_history_canary_approvals
      WHERE canary_job_id IN (
        SELECT id FROM tapo_history_export_jobs
        WHERE sensor_id = ? AND expected_device_id = ? AND device_name = ?
          AND time_zone = ? AND interval_minutes = ?
      )`).run(row.sensor_id, row.expected_device_id, row.device_name, row.time_zone, row.interval_minutes);
    return Number(result.changes);
  }

  /** Relock an ordinary job's exact target when a vendor CSV drifts from its approved canary. */
  revokeTapoHistoryCanaryApprovalsForJobTarget(jobId: string): number {
    const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
      .get(jobId) as unknown as TapoHistoryExportJobRow | undefined;
    if (!row) {
      throw new ClimateDataValidationError(404, "TAPO_EXPORT_NOT_FOUND", "Tapo export target does not exist");
    }
    const result = this.db.prepare(`DELETE FROM tapo_history_canary_approvals
      WHERE canary_job_id IN (
        SELECT id FROM tapo_history_export_jobs
        WHERE sensor_id = ? AND expected_device_id = ? AND device_name = ?
          AND time_zone = ? AND interval_minutes = ?
      )`).run(row.sensor_id, row.expected_device_id, row.device_name, row.time_zone, row.interval_minutes);
    return Number(result.changes);
  }

  tapoHistoryCanaryRenewalTarget(
    deploymentFingerprint: string,
    acceptanceRevision: string,
    approvedNotAfter: string,
  ): TapoHistoryExportJob | null {
    const fingerprint = normalizedSha256(deploymentFingerprint, "deploymentFingerprint");
    const revision = normalizedSha256(acceptanceRevision, "acceptanceRevision");
    const cutoff = normalizedTapoHistoryTimestamp(approvedNotAfter, "approvedNotAfter");
    const row = this.db.prepare(`SELECT candidate.* FROM tapo_history_export_jobs AS candidate
      WHERE candidate.provider = 'appium' AND candidate.dedupe_key NOT LIKE 'canary:%'
        AND candidate.status IN ('queued', 'failed') AND candidate.attempt_count < candidate.max_attempts
        AND EXISTS (
          SELECT 1 FROM tapo_history_canary_approvals AS approval
          JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
          WHERE approval.deployment_fingerprint = ? AND approval.acceptance_revision = ?
            AND approval.approved_at <= ? AND canary.status = 'completed'
            AND canary.sensor_id = candidate.sensor_id
            AND canary.expected_device_id = candidate.expected_device_id
            AND canary.device_name = candidate.device_name
            AND canary.time_zone = candidate.time_zone
            AND canary.interval_minutes = candidate.interval_minutes
        )
        AND NOT EXISTS (
          SELECT 1 FROM tapo_history_export_jobs AS pending_canary
          WHERE pending_canary.dedupe_key LIKE 'canary:%'
            AND pending_canary.status NOT IN ('completed', 'cancelled')
            AND pending_canary.sensor_id = candidate.sensor_id
            AND pending_canary.expected_device_id = candidate.expected_device_id
            AND pending_canary.device_name = candidate.device_name
            AND pending_canary.time_zone = candidate.time_zone
            AND pending_canary.interval_minutes = candidate.interval_minutes
        )
      ORDER BY candidate.created_at, candidate.id LIMIT 1`)
      .get(fingerprint, revision, cutoff) as unknown as TapoHistoryExportJobRow | undefined;
    return row ? tapoHistoryExportJobFromRow(row) : null;
  }

  /** Atomically leases the oldest runnable job. Expired workers can be reclaimed, but never after maxAttempts. */
  claimNextTapoHistoryExportJob(
    leaseOwner: string,
    claimedAt: string,
    leaseUntil: string,
    providers: readonly TapoHistoryExportProvider[] = ["appium", "private-cloud"],
    reclaimNotAfter = claimedAt,
    options: TapoHistoryClaimOptions = {},
  ): TapoHistoryExportClaim | null {
    const owner = normalizedTapoHistoryText(leaseOwner, "leaseOwner", 500);
    const now = normalizedTapoHistoryTimestamp(claimedAt, "claimedAt");
    const expiresAt = normalizedTapoHistoryTimestamp(leaseUntil, "leaseUntil");
    const reclaimCutoff = normalizedTapoHistoryTimestamp(reclaimNotAfter, "reclaimNotAfter");
    const deploymentFingerprint = options.deploymentFingerprint === undefined
      ? null
      : normalizedSha256(options.deploymentFingerprint, "deploymentFingerprint");
    const acceptanceRevision = options.acceptanceRevision === undefined
      ? null
      : normalizedSha256(options.acceptanceRevision, "acceptanceRevision");
    const approvalNotBefore = options.requireApprovedTarget === true
      ? normalizedTapoHistoryTimestamp(options.approvalNotBefore ?? "", "approvalNotBefore")
      : null;
    const requiredAcceptanceRevision = options.requireApprovedTarget === true
      ? normalizedSha256(options.requiredAcceptanceRevision ?? "", "requiredAcceptanceRevision")
      : null;
    if (options.requireApprovedTarget === true && !deploymentFingerprint) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_TAPO_EXPORT_FIELD",
        "deploymentFingerprint is required when target approval is enforced",
      );
    }
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_LEASE", "leaseUntil must be after claimedAt");
    }
    const allowedProviders = [...new Set(providers)];
    if (allowedProviders.length === 0) return null;
    if (allowedProviders.some((provider) => provider !== "appium" && provider !== "private-cloud")) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_PROVIDER", "Unsupported Tapo history export provider");
    }
    const placeholders = allowedProviders.map(() => "?").join(",");
    const maxOutstandingAppium = options.maxOutstandingAppium ?? null;
    if (maxOutstandingAppium !== null
      && (!Number.isSafeInteger(maxOutstandingAppium) || maxOutstandingAppium < 1 || maxOutstandingAppium > 10)) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_TAPO_EXPORT_FIELD",
        "maxOutstandingAppium must be an integer from 1 through 10",
      );
    }
    const canaryPredicate = options.canaryOnly === true ? "AND dedupe_key LIKE 'canary:%'" : "";
    const canaryOrder = options.preferCanary === true ? "CASE WHEN dedupe_key LIKE 'canary:%' THEN 0 ELSE 1 END," : "";
    const approvalPredicate = options.requireApprovedTarget === true ? `AND dedupe_key NOT LIKE 'canary:%'
      AND EXISTS (
        SELECT 1 FROM tapo_history_canary_approvals AS approval
        JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
        WHERE approval.deployment_fingerprint = ? AND approval.approved_at >= ?
          AND approval.acceptance_revision = ?
          AND length(approval.schema_signature) = 64
          AND canary.status = 'completed' AND canary.dedupe_key LIKE 'canary:%'
          AND canary.sensor_id = tapo_history_export_jobs.sensor_id
          AND canary.expected_device_id = tapo_history_export_jobs.expected_device_id
          AND canary.device_name = tapo_history_export_jobs.device_name
          AND canary.time_zone = tapo_history_export_jobs.time_zone
          AND canary.interval_minutes = tapo_history_export_jobs.interval_minutes
      )` : "";
    return this.immediateTransaction(() => {
      if (maxOutstandingAppium !== null && allowedProviders.includes("appium")) {
        const outstanding = this.db.prepare(`SELECT COUNT(*) AS count FROM tapo_history_export_jobs
          WHERE provider = 'appium' AND (
            status = 'waiting-email'
            OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at > ?)
          )`).get(reclaimCutoff) as { count: number };
        if (Number(outstanding.count) >= maxOutstandingAppium) return null;
      }
      const row = this.db.prepare(`SELECT * FROM tapo_history_export_jobs
        WHERE provider IN (${placeholders}) ${canaryPredicate} AND attempt_count < max_attempts AND (
          (status IN ('queued', 'failed') AND available_at <= ?)
          OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        ) ${approvalPredicate} AND NOT EXISTS (
          SELECT 1 FROM tapo_history_export_jobs active
          WHERE active.lease_owner = ? AND active.lease_expires_at IS NOT NULL
            AND active.lease_expires_at > ?
        )
        ORDER BY ${canaryOrder} CASE WHEN status IN ('claimed', 'running') THEN 0 ELSE 1 END,
          COALESCE(lease_expires_at, available_at), created_at, id LIMIT 1`)
        .get(
          ...allowedProviders,
          now,
          reclaimCutoff,
          ...(options.requireApprovedTarget === true
            ? [deploymentFingerprint!, approvalNotBefore!, requiredAcceptanceRevision!]
            : []),
          owner,
          reclaimCutoff,
        ) as unknown as TapoHistoryExportJobRow | undefined;
      if (!row) return null;
      const approvedSchema = options.requireApprovedTarget === true
        ? this.db.prepare(`SELECT approval.schema_signature FROM tapo_history_canary_approvals AS approval
            JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
            WHERE approval.deployment_fingerprint = ? AND approval.approved_at >= ?
              AND approval.acceptance_revision = ? AND canary.status = 'completed'
              AND canary.dedupe_key LIKE 'canary:%'
              AND canary.sensor_id = ? AND canary.expected_device_id = ?
              AND canary.device_name = ? AND canary.time_zone = ? AND canary.interval_minutes = ?
            ORDER BY approval.approved_at DESC, approval.canary_job_id DESC LIMIT 1`)
          .get(
            deploymentFingerprint!, approvalNotBefore!, requiredAcceptanceRevision!,
            row.sensor_id, row.expected_device_id, row.device_name, row.time_zone, row.interval_minutes,
          ) as { schema_signature: string } | undefined
        : undefined;
      if (options.requireApprovedTarget === true && !approvedSchema) return null;
      const leaseToken = randomUUID();
      const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET
          status = 'claimed', attempt_count = attempt_count + 1, lease_owner = ?, lease_token = ?,
          lease_expires_at = ?, heartbeat_at = ?, deployment_fingerprint = ?, acceptance_revision = ?,
          expected_schema_signature = ?, last_error = NULL, attention_reason = NULL, updated_at = ?
        WHERE id = ? AND attempt_count < max_attempts AND (
          (status IN ('queued', 'failed') AND available_at <= ?)
          OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )`).run(
          owner, leaseToken, expiresAt, now, deploymentFingerprint, acceptanceRevision,
          approvedSchema?.schema_signature ?? null,
          now, row.id, now, reclaimCutoff,
        );
      if (Number(result.changes) === 0) return null;
      if (row.dedupe_key.startsWith("canary:") && !row.dedupe_key.startsWith("canary:renewal:")) {
        this.revokeTapoHistoryCanaryApprovalsForTarget(row.id);
      }
      return { job: this.getTapoHistoryExportJob(row.id)!, leaseToken };
    });
  }

  /** Final-attempt worker crashes must not leave an active-looking lease forever. */
  expireExhaustedTapoHistoryExportLeases(
    now = new Date().toISOString(),
    reclaimNotAfter = now,
  ): number {
    const at = normalizedTapoHistoryTimestamp(now, "now");
    const reclaimCutoff = normalizedTapoHistoryTimestamp(reclaimNotAfter, "reclaimNotAfter");
    const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET
        status = 'failed', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_error = 'The final mobile-worker attempt ended without a terminal status', updated_at = ?
      WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ? AND attempt_count >= max_attempts`).run(at, reclaimCutoff);
    return Number(result.changes);
  }

  heartbeatTapoHistoryExportJob(
    id: string,
    leaseToken: string,
    heartbeatAt: string,
    leaseUntil: string,
  ): TapoHistoryExportJob | null {
    const token = normalizedTapoHistoryText(leaseToken, "leaseToken", 500);
    const heartbeat = normalizedTapoHistoryTimestamp(heartbeatAt, "heartbeatAt");
    const expiresAt = normalizedTapoHistoryTimestamp(leaseUntil, "leaseUntil");
    if (Date.parse(expiresAt) <= Date.parse(heartbeat)) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_LEASE", "leaseUntil must be after heartbeatAt");
    }
    const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET
        heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_token = ? AND status IN ('claimed', 'running')
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(heartbeat, expiresAt, heartbeat, id, token, heartbeat);
    return Number(result.changes) > 0 ? this.getTapoHistoryExportJob(id) : null;
  }

  /** Rotates the mailbox capability for each newly leased mobile attempt. */
  rotateTapoHistoryExportRecipient(
    id: string,
    leaseToken: string,
    expectedRecipient: string,
    rotatedAt = new Date().toISOString(),
  ): TapoHistoryExportJob | null {
    const token = normalizedTapoHistoryText(leaseToken, "leaseToken", 500);
    const recipient = normalizedTapoHistoryText(expectedRecipient, "expectedRecipient", 320).toLowerCase();
    const separator = recipient.lastIndexOf("@");
    if (separator < 1 || separator === recipient.length - 1) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RECIPIENT", "expectedRecipient must be an email address");
    }
    const at = normalizedTapoHistoryTimestamp(rotatedAt, "rotatedAt");
    const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET expected_recipient = ?,
        submitted_at = NULL, mailbox_message_id = NULL, updated_at = ?
      WHERE id = ? AND lease_token = ? AND status = 'claimed'
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
      .run(recipient, at, id, token, at);
    return Number(result.changes) > 0 ? this.getTapoHistoryExportJob(id) : null;
  }

  transitionTapoHistoryExportJob(id: string, transition: TapoHistoryExportTransition): TapoHistoryExportJob | null {
    const at = normalizedTapoHistoryTimestamp(transition.at ?? new Date().toISOString(), "at");
    const hasExpectedRecipient = Object.prototype.hasOwnProperty.call(transition, "expectedRecipient");
    const expectedRecipient = transition.expectedRecipient === null || transition.expectedRecipient === undefined
      ? null
      : normalizedTapoHistoryText(transition.expectedRecipient, "expectedRecipient", 320).toLowerCase();
    const hasExpectedSubmittedAt = Object.prototype.hasOwnProperty.call(transition, "expectedSubmittedAt");
    const expectedSubmittedAt = transition.expectedSubmittedAt === null || transition.expectedSubmittedAt === undefined
      ? null
      : normalizedTapoHistoryTimestamp(transition.expectedSubmittedAt, "expectedSubmittedAt");
    if (!(transition.status in TAPO_HISTORY_EXPORT_TRANSITIONS)) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_STATUS", "Unsupported Tapo export status");
    }
    return this.immediateTransaction(() => {
      const currentRow = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
        .get(id) as unknown as TapoHistoryExportJobRow | undefined;
      if (!currentRow) return null;
      const current = tapoHistoryExportJobFromRow(currentRow);
      if ((hasExpectedRecipient && current.expectedRecipient !== expectedRecipient)
        || (hasExpectedSubmittedAt && current.submittedAt !== expectedSubmittedAt)) {
        throw new ClimateDataValidationError(
          409,
          "TAPO_EXPORT_GENERATION_CHANGED",
          "The Tapo export mailbox attempt changed while an asynchronous operation was in flight",
        );
      }
      const workerOwned = current.status === "claimed" || current.status === "running";
      if (workerOwned && (!transition.leaseToken || transition.leaseToken !== currentRow.lease_token
        || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(at))) {
        throw new ClimateDataValidationError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is missing or expired");
      }
      if (current.status === transition.status) return current;
      if (!TAPO_HISTORY_EXPORT_TRANSITIONS[current.status].includes(transition.status)) {
        throw new ClimateDataValidationError(
          409,
          "INVALID_TAPO_EXPORT_TRANSITION",
          `Cannot transition a Tapo export from ${current.status} to ${transition.status}`,
        );
      }
      const keepLease = transition.status === "running";
      const availableAt = transition.status === "queued" || transition.status === "failed"
        ? normalizedTapoHistoryTimestamp(transition.availableAt ?? at, "availableAt")
        : current.availableAt;
      const error = transition.error === undefined || transition.error === null
        ? null
        : normalizedTapoHistoryText(transition.error, "error", 2_000);
      const attentionReason = transition.attentionReason === undefined || transition.attentionReason === null
        ? null
        : normalizedTapoHistoryText(transition.attentionReason, "attentionReason", 2_000);
      this.db.prepare(`UPDATE tapo_history_export_jobs SET status = ?, available_at = ?,
          lease_owner = ?, lease_token = ?, lease_expires_at = ?, heartbeat_at = ?,
          submitted_at = ?, last_error = ?, attention_reason = ?, updated_at = ?, completed_at = ?
        WHERE id = ?`)
        .run(
          transition.status,
          availableAt,
          keepLease ? currentRow.lease_owner : null,
          keepLease ? currentRow.lease_token : null,
          keepLease ? currentRow.lease_expires_at : null,
          keepLease ? at : currentRow.heartbeat_at,
          transition.status === "waiting-email" ? at : currentRow.submitted_at,
          transition.status === "failed" ? error : null,
          transition.status === "needs-attention" ? attentionReason : null,
          at,
          transition.status === "completed" ? at : null,
          id,
        );
      return this.getTapoHistoryExportJob(id)!;
    });
  }

  /** Cancellation fences worker mutations while retaining the target cool-down tombstone. */
  cancelTapoHistoryExportJob(id: string, cancelledAt = new Date().toISOString()): TapoHistoryExportJob | null {
    const at = normalizedTapoHistoryTimestamp(cancelledAt, "cancelledAt");
    const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'cancelled',
        attention_reason = NULL,
        updated_at = ?, completed_at = NULL
      WHERE id = ? AND status NOT IN ('completed', 'cancelled')`).run(at, id);
    if (Number(result.changes) > 0) return this.getTapoHistoryExportJob(id);
    return this.getTapoHistoryExportJob(id);
  }

  requeueTapoHistoryExportJob(
    id: string,
    availableAt = new Date().toISOString(),
    resetAttempts = false,
  ): TapoHistoryExportJob | null {
    const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
    const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'queued',
        attempt_count = CASE WHEN ? = 1 OR status = 'cancelled' THEN 0 ELSE attempt_count END,
        available_at = ?,
        lease_owner = CASE WHEN status = 'cancelled' THEN lease_owner ELSE NULL END,
        lease_token = CASE WHEN status = 'cancelled' THEN lease_token ELSE NULL END,
        lease_expires_at = CASE WHEN status = 'cancelled' THEN lease_expires_at ELSE NULL END,
        submitted_at = NULL, mailbox_message_id = NULL,
        last_error = NULL, attention_reason = NULL, updated_at = ?, completed_at = NULL
      WHERE id = ? AND status IN ('failed', 'needs-attention', 'cancelled')`).run(resetAttempts ? 1 : 0, at, at, id);
    return Number(result.changes) > 0 ? this.getTapoHistoryExportJob(id) : null;
  }

  attachTapoHistoryExportMailboxMessage(
    id: string,
    mailboxMessageId: string,
    receivedAt = new Date().toISOString(),
  ): TapoHistoryExportJob | null {
    const messageId = normalizedTapoHistoryText(mailboxMessageId, "mailboxMessageId", 1_000);
    const at = normalizedTapoHistoryTimestamp(receivedAt, "receivedAt");
    return this.immediateTransaction(() => {
      const current = this.getTapoHistoryExportJob(id);
      if (!current) return null;
      const owner = this.db.prepare("SELECT id FROM tapo_history_export_jobs WHERE mailbox_message_id = ?")
        .get(messageId) as { id: string } | undefined;
      if (owner && owner.id !== id) {
        throw new ClimateDataValidationError(
          409,
          "TAPO_EXPORT_MAILBOX_MESSAGE_CLAIMED",
          "The mailbox message has already been assigned to another Tapo export job",
        );
      }
      if (current.mailboxMessageId === messageId) return current;
      if (current.mailboxMessageId !== null) {
        throw new ClimateDataValidationError(
          409,
          "TAPO_EXPORT_MAILBOX_MESSAGE_MISMATCH",
          "The Tapo export job is already associated with a different mailbox message",
        );
      }
      if (current.status === "cancelled") {
        throw new ClimateDataValidationError(409, "TAPO_EXPORT_CANCELLED", "A cancelled Tapo export cannot accept mail");
      }
      this.db.prepare("UPDATE tapo_history_export_jobs SET mailbox_message_id = ?, updated_at = ? WHERE id = ?")
        .run(messageId, at, id);
      return this.getTapoHistoryExportJob(id)!;
    });
  }

  listTapoHistoryExportMailboxMessageIds(jobId?: string): string[] {
    const rows = (jobId
      ? this.db.prepare(`SELECT mailbox_message_id FROM tapo_history_export_jobs
          WHERE id = ? AND mailbox_message_id IS NOT NULL`).all(jobId)
      : this.db.prepare(`SELECT mailbox_message_id FROM tapo_history_export_jobs
          WHERE mailbox_message_id IS NOT NULL ORDER BY updated_at, id`).all()) as Array<{ mailbox_message_id: string }>;
    return rows.map((row) => row.mailbox_message_id);
  }

  /**
   * Commits mailbox/private-response identity and every normalized row in one transaction.
   * Reprocessing the same source identities is a no-op; conflicting identities are rejected.
   */
  completeTapoHistoryExportJobWithSamples(
    id: string,
    samples: TapoHistoryExportStagedSampleInput[],
    options: TapoHistoryExportCompletionOptions = {},
  ): TapoHistoryExportStageResult {
    if (!Array.isArray(samples) || samples.length > 250_000) {
      throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_SAMPLES", "A Tapo export may stage at most 250000 samples");
    }
    const completedAt = normalizedTapoHistoryTimestamp(options.completedAt ?? new Date().toISOString(), "completedAt");
    const mailboxMessageId = options.mailboxMessageId === undefined
      ? null
      : normalizedTapoHistoryText(options.mailboxMessageId, "mailboxMessageId", 1_000);
    const expectedRecipient = options.expectedRecipient === undefined
      ? null
      : normalizedTapoHistoryText(options.expectedRecipient, "expectedRecipient", 320).toLowerCase();
    const expectedSubmittedAt = options.expectedSubmittedAt === undefined
      ? null
      : normalizedTapoHistoryTimestamp(options.expectedSubmittedAt, "expectedSubmittedAt");
    const sourceArtifactSha256 = options.sourceArtifactSha256 === undefined
      ? null
      : normalizedSha256(options.sourceArtifactSha256, "sourceArtifactSha256");
    const sourceArtifactBytes = options.sourceArtifactBytes ?? null;
    if (sourceArtifactBytes !== null
      && (!Number.isSafeInteger(sourceArtifactBytes) || sourceArtifactBytes < 0 || sourceArtifactBytes > 100 * 1024 * 1024)) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_TAPO_EXPORT_FIELD",
        "sourceArtifactBytes must be a non-negative safe integer no larger than 100 MiB",
      );
    }
    const parserVersion = options.parserVersion === undefined
      ? null
      : normalizedTapoHistoryText(options.parserVersion, "parserVersion", 100);
    const sourceSchemaSignature = options.sourceSchemaSignature === undefined
      ? null
      : normalizedSha256(options.sourceSchemaSignature, "sourceSchemaSignature");
    return this.immediateTransaction(() => {
      const jobRow = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
        .get(id) as unknown as TapoHistoryExportJobRow | undefined;
      if (!jobRow) throw new ClimateDataValidationError(404, "TAPO_EXPORT_NOT_FOUND", `Tapo export job ${id} does not exist`);
      const job = tapoHistoryExportJobFromRow(jobRow);
      if (job.status === "cancelled") {
        throw new ClimateDataValidationError(409, "TAPO_EXPORT_CANCELLED", "A cancelled Tapo export cannot be completed");
      }
      if (job.provider === "appium") {
        if (!mailboxMessageId) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_MAILBOX_MESSAGE_REQUIRED",
            "An app export can only be completed by a correlated mailbox message",
          );
        }
        if (!sourceArtifactSha256 || sourceArtifactBytes === null || !parserVersion || !sourceSchemaSignature) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_ARTIFACT_AUDIT_REQUIRED",
            "An app export requires its raw attachment hash, byte count, parser version, and schema signature",
          );
        }
        if (job.status === "completed") {
          if (job.mailboxMessageId !== mailboxMessageId) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_MAILBOX_MESSAGE_MISMATCH",
              "A completed Tapo export can only be replayed with its original mailbox message",
            );
          }
          if (job.sourceArtifactSha256 !== sourceArtifactSha256
            || job.sourceArtifactBytes !== sourceArtifactBytes || job.parserVersion !== parserVersion
            || job.sourceSchemaSignature !== sourceSchemaSignature) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_ARTIFACT_MISMATCH",
              "A completed Tapo export can only be replayed with its original audited attachment",
            );
          }
        } else if (job.status !== "waiting-email"
          || !job.expectedRecipient || !job.submittedAt
          || expectedRecipient === null || expectedSubmittedAt === null
          || job.expectedRecipient !== expectedRecipient || job.submittedAt !== expectedSubmittedAt) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_GENERATION_CHANGED",
            "The Tapo export mailbox attempt is no longer current",
          );
        }
        if (!job.canary && job.deploymentFingerprint
          && job.expectedSchemaSignature !== sourceSchemaSignature) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_SCHEMA_DRIFT",
            "The Tapo CSV schema no longer matches the last accepted canary",
          );
        }
        if (!job.canary && job.status !== "completed" && job.deploymentFingerprint) {
          const approvalStillPresent = Boolean(this.db.prepare(`SELECT 1 AS approved
              FROM tapo_history_canary_approvals AS approval
              JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
              WHERE approval.deployment_fingerprint = ? AND approval.acceptance_revision = ?
                AND approval.schema_signature = ? AND canary.status = 'completed'
                AND canary.sensor_id = ? AND canary.expected_device_id = ?
                AND canary.device_name = ? AND canary.time_zone = ? AND canary.interval_minutes = ?
              LIMIT 1`)
            .get(
              job.deploymentFingerprint,
              job.acceptanceRevision,
              job.expectedSchemaSignature,
              job.sensorId,
              job.expectedDeviceId,
              job.deviceName,
              job.timeZone,
              job.intervalMinutes,
            ));
          if (!approvalStillPresent) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_APPROVAL_REVOKED",
              "The Tapo canary approval was revoked before this export completed",
            );
          }
        }
      } else {
        if (mailboxMessageId) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_MAILBOX_MESSAGE_UNEXPECTED",
            "A private-cloud export cannot claim a mailbox message",
          );
        }
        if (job.status !== "queued" && job.status !== "completed") {
          throw new ClimateDataValidationError(
            409,
            "INVALID_TAPO_EXPORT_TRANSITION",
            `Cannot complete a private-cloud Tapo export from ${job.status}`,
          );
        }
      }
      const resolvedMessageId = mailboxMessageId ?? job.mailboxMessageId;
      if (mailboxMessageId) {
        const owner = this.db.prepare("SELECT id FROM tapo_history_export_jobs WHERE mailbox_message_id = ?")
          .get(mailboxMessageId) as { id: string } | undefined;
        if (owner && owner.id !== id) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_MAILBOX_MESSAGE_CLAIMED",
            "The mailbox message has already been assigned to another Tapo export job",
          );
        }
        if (job.mailboxMessageId && job.mailboxMessageId !== mailboxMessageId) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_MAILBOX_MESSAGE_MISMATCH",
            "The Tapo export job is already associated with a different mailbox message",
          );
        }
      }

      const insert = this.db.prepare(`INSERT OR IGNORE INTO tapo_history_export_staged_samples
        (job_id, sensor_id, metric, value, canonical_unit, timestamp, source, quality,
         source_identity, created_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'tp-link', ?, ?, ?, NULL)`);
      const byIdentity = this.db.prepare(`SELECT * FROM tapo_history_export_staged_samples
        WHERE job_id = ? AND metric = ? AND source_identity = ?`);
      const staged: TapoHistoryExportStagedSample[] = [];
      let duplicateCount = 0;
      for (const sample of samples) {
        const metric = normalizedTapoHistoryText(sample.metric, "metric", 200);
        const definition = this.getMeasurementDefinition(metric);
        if (!definition) {
          throw new ClimateDataValidationError(404, "TAPO_EXPORT_METRIC_NOT_FOUND", `Unknown measurement metric: ${metric}`);
        }
        if (sample.canonicalUnit !== definition.unit) {
          throw new ClimateDataValidationError(
            422,
            "TAPO_EXPORT_UNIT_MISMATCH",
            `${metric} canonicalUnit must be ${definition.unit}`,
          );
        }
        if (!Number.isFinite(sample.value)
          || (definition.validMin !== null && sample.value < definition.validMin)
          || (definition.validMax !== null && sample.value > definition.validMax)) {
          throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_VALUE", `${metric} value is outside its valid range`);
        }
        if (sample.source !== undefined && sample.source !== "tp-link") {
          throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_SOURCE", "Tapo export samples must use source tp-link");
        }
        const quality = sample.quality ?? "estimated";
        if (quality !== "good" && quality !== "estimated" && quality !== "stale") {
          throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_QUALITY", "Unsupported sample quality");
        }
        const timestamp = normalizedTapoHistoryTimestamp(sample.timestamp, "sample.timestamp");
        if (Date.parse(timestamp) < Date.parse(job.rangeStart) || Date.parse(timestamp) > Date.parse(job.rangeEnd)) {
          throw new ClimateDataValidationError(
            422,
            "TAPO_EXPORT_SAMPLE_OUTSIDE_RANGE",
            "A staged sample falls outside the export job range",
          );
        }
        const sourceIdentity = normalizedTapoHistoryText(sample.sourceIdentity, "sourceIdentity", 1_000);
        const existing = byIdentity.get(id, metric, sourceIdentity) as unknown as TapoHistoryExportStagedSampleRow | undefined;
        if (existing) {
          if (existing.sensor_id !== job.sensorId || existing.value !== sample.value
            || existing.canonical_unit !== definition.unit || existing.timestamp !== timestamp
            || existing.quality !== quality) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_SOURCE_IDENTITY_COLLISION",
              `Source identity ${sourceIdentity} was reused for different sample content`,
            );
          }
          duplicateCount += 1;
          continue;
        }
        const result = insert.run(
          id, job.sensorId, metric, sample.value, definition.unit, timestamp,
          quality, sourceIdentity, completedAt,
        );
        if (Number(result.changes) === 0) {
          duplicateCount += 1;
          continue;
        }
        const row = this.db.prepare("SELECT * FROM tapo_history_export_staged_samples WHERE id = ?")
          .get(Number(result.lastInsertRowid)) as unknown as TapoHistoryExportStagedSampleRow;
        staged.push(tapoHistoryExportStagedSampleFromRow(row));
      }
      const counts = this.db.prepare(`SELECT COUNT(*) AS staged,
          SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed
        FROM tapo_history_export_staged_samples WHERE job_id = ?`)
        .get(id) as { staged: number; consumed: number | null };
      this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'completed', mailbox_message_id = ?,
          source_artifact_sha256 = ?, source_artifact_bytes = ?, parser_version = ?, source_schema_signature = ?,
          staged_sample_count = ?, consumed_sample_count = ?, lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, last_error = NULL, attention_reason = NULL, updated_at = ?,
          completed_at = COALESCE(completed_at, ?)
        WHERE id = ?`)
        .run(
          resolvedMessageId,
          sourceArtifactSha256 ?? job.sourceArtifactSha256,
          sourceArtifactBytes ?? job.sourceArtifactBytes,
          parserVersion ?? job.parserVersion,
          sourceSchemaSignature ?? job.sourceSchemaSignature,
          Number(counts.staged),
          Number(counts.consumed ?? 0),
          completedAt,
          completedAt,
          id,
        );
      return { job: this.getTapoHistoryExportJob(id)!, staged, duplicateCount };
    });
  }

  /** Read staged rows without mutating them so the recovery coordinator remains the ingestion authority. */
  listTapoHistoryExportStagedSamples(
    filter: TapoHistoryExportStagedSampleFilter = {},
  ): TapoHistoryExportStagedSample[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.jobId) {
      conditions.push("job_id = ?");
      parameters.push(filter.jobId);
    }
    if (filter.sensorId) {
      conditions.push("sensor_id = ?");
      parameters.push(filter.sensorId);
    }
    if (filter.metric) {
      conditions.push("metric = ?");
      parameters.push(filter.metric);
    }
    if (filter.from) {
      conditions.push("timestamp >= ?");
      parameters.push(normalizedTapoHistoryTimestamp(filter.from, "from"));
    }
    if (filter.to) {
      conditions.push("timestamp <= ?");
      parameters.push(normalizedTapoHistoryTimestamp(filter.to, "to"));
    }
    if (filter.consumed !== undefined) conditions.push(filter.consumed ? "consumed_at IS NOT NULL" : "consumed_at IS NULL");
    // A job cannot stage more than 250,000 rows, so this upper bound lets a
    // recovery read prove it has the complete requested metric rather than
    // silently treating a truncated page as complete.
    const limit = Math.max(1, Math.min(250_000, Math.trunc(filter.limit ?? 10_000)));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM tapo_history_export_staged_samples ${where}
      ORDER BY timestamp, metric, id LIMIT ?`).all(...parameters, limit) as unknown as TapoHistoryExportStagedSampleRow[];
    return rows.map(tapoHistoryExportStagedSampleFromRow);
  }

  /** Marks only rows actually accepted by the coordinator; duplicate calls are harmless. */
  markTapoHistoryExportStagedSamplesConsumed(
    jobId: string,
    sampleIds: number[],
    consumedAt = new Date().toISOString(),
  ): number {
    const at = normalizedTapoHistoryTimestamp(consumedAt, "consumedAt");
    const ids = [...new Set(sampleIds)];
    if (ids.length === 0) return 0;
    if (ids.length > 250_000 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_TAPO_EXPORT_SAMPLE_IDS",
        "sampleIds must contain at most 250000 positive integer identifiers",
      );
    }
    return this.immediateTransaction(() => {
      let changed = 0;
      // Stay below SQLite's host-parameter ceiling even for a maximum-size job.
      for (let offset = 0; offset < ids.length; offset += 5_000) {
        const batch = ids.slice(offset, offset + 5_000);
        const placeholders = batch.map(() => "?").join(",");
        const result = this.db.prepare(`UPDATE tapo_history_export_staged_samples SET consumed_at = ?
          WHERE job_id = ? AND consumed_at IS NULL AND id IN (${placeholders})`).run(at, jobId, ...batch);
        changed += Number(result.changes);
      }
      const counts = this.db.prepare(`SELECT COUNT(*) AS staged,
          SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed
        FROM tapo_history_export_staged_samples WHERE job_id = ?`)
        .get(jobId) as { staged: number; consumed: number | null };
      this.db.prepare(`UPDATE tapo_history_export_jobs SET staged_sample_count = ?,
        consumed_sample_count = ?, updated_at = ? WHERE id = ?`)
        .run(Number(counts.staged), Number(counts.consumed ?? 0), at, jobId);
      return changed;
    });
  }

  /**
   * Bounds operational history while retaining recent audit evidence. Pending
   * recovery rows survive 180 days; cancellation/attention tombstones survive a year.
   */
  pruneTapoHistoryExportHistory(options: {
    consumedBefore: string;
    completedBefore: string;
    canaryBefore: string;
  }): { samples: number; jobs: number } {
    const consumedBefore = normalizedTapoHistoryTimestamp(options.consumedBefore, "consumedBefore");
    const completedBefore = normalizedTapoHistoryTimestamp(options.completedBefore, "completedBefore");
    const canaryBefore = normalizedTapoHistoryTimestamp(options.canaryBefore, "canaryBefore");
    return this.immediateTransaction(() => {
      const eligible = `status IN ('needs-attention', 'cancelled') AND updated_at <= :canaryBefore
        OR status = 'failed' AND updated_at <= :completedBefore
        OR status = 'completed' AND (
          dedupe_key LIKE 'canary:%' AND COALESCE(completed_at, updated_at) <= :canaryBefore
          OR dedupe_key NOT LIKE 'canary:%' AND (
            COALESCE(completed_at, updated_at) <= :completedBefore
            OR COALESCE(completed_at, updated_at) <= :consumedBefore AND NOT EXISTS (
              SELECT 1 FROM tapo_history_export_staged_samples pending
              WHERE pending.job_id = tapo_history_export_jobs.id AND pending.consumed_at IS NULL
            )
          )
        )`;
      const parameters = { consumedBefore, completedBefore, canaryBefore };
      const sampleCount = this.db.prepare(`SELECT COUNT(*) AS count
        FROM tapo_history_export_staged_samples staged
        WHERE EXISTS (
          SELECT 1 FROM tapo_history_export_jobs
          WHERE tapo_history_export_jobs.id = staged.job_id AND (${eligible})
        )`).get(parameters) as { count: number };
      // Delete the coverage authority and its rows together. Keeping an empty
      // completed job would otherwise block a future recovery forever.
      const jobs = this.db.prepare(`DELETE FROM tapo_history_export_jobs WHERE ${eligible}`).run(parameters);
      return { samples: Number(sampleCount.count), jobs: Number(jobs.changes) };
    });
  }

  private insertReading(reading: Reading): boolean {
    const inserted = this.insertLegacyReadingUnchecked(reading);
    if (inserted) {
      const values: Record<string, number> = {
        ...(reading.measurements ?? {}),
        temperature: reading.temperature,
        humidity: reading.humidity,
      };
      for (const [metric, value] of Object.entries(values)) {
        const definition = this.getMeasurementDefinition(metric);
        if (!definition) continue;
        this.insertMeasurementSample({
          sensorId: reading.sensorId,
          metric,
          value,
          canonicalUnit: definition.unit,
          timestamp: reading.timestamp,
          source: reading.source,
          quality: reading.quality,
        });
      }
    }
    return inserted;
  }

  insertLegacyReading(reading: Reading): boolean {
    return this.immediateTransaction(() => {
      this.prepareTelemetrySources([reading.source]);
      return this.insertLegacyReadingUnchecked(reading);
    });
  }

  upsertLegacyReading(reading: Reading): boolean {
    return this.immediateTransaction(() => {
      this.prepareTelemetrySources([reading.source]);
      const result = this.db.prepare(`INSERT INTO readings
        (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(sensor_id, timestamp, source) DO UPDATE SET
          temperature = excluded.temperature,
          humidity = excluded.humidity,
          battery = excluded.battery,
          quality = excluded.quality`)
        .run(reading.sensorId, reading.timestamp, reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality);
      return Number(result.changes) > 0;
    });
  }

  private insertLegacyReadingUnchecked(reading: Reading): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO readings
      (sensor_id, timestamp, temperature, humidity, battery, source, quality) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(reading.sensorId, reading.timestamp, reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality);
    return Number(result.changes) > 0;
  }

  insertReadings(readings: Reading[]): Reading[] {
    return this.immediateTransaction(() => {
      this.prepareTelemetrySources(readings.map((reading) => reading.source));
      const inserted: Reading[] = [];
      for (const reading of readings) {
        if (this.insertReading(reading)) inserted.push(reading);
      }
      return inserted;
    });
  }

  latestReadings(sensorIds?: string[]): Reading[] {
    const filter = sensorIds?.length ? `WHERE s.id IN (${sensorIds.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`SELECT reading.sensor_id, reading.timestamp, reading.temperature,
        reading.humidity, reading.battery, reading.source, reading.quality
      FROM sensors s JOIN readings reading ON reading.id = (
        SELECT latest.id FROM readings latest WHERE latest.sensor_id = s.id
        ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
      )
      ${filter}
      ORDER BY reading.sensor_id`)
      .all(...(sensorIds ?? [])) as unknown as ReadingRow[];
    return rows.map(readingFromRow);
  }

  getLatestReading(sensorId: string): Reading | null {
    const row = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
      FROM readings WHERE sensor_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1`).get(sensorId) as unknown as ReadingRow | undefined;
    return row ? readingFromRow(row) : null;
  }

  history(sensorIds: string[], from: string, to: string, limit = 20_000): Reading[] {
    if (sensorIds.length === 0) return [];
    const placeholders = sensorIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT sensor_id, timestamp, temperature, humidity, battery, source, quality
      FROM (
        SELECT id, sensor_id, timestamp, temperature, humidity, battery, source, quality
        FROM readings WHERE sensor_id IN (${placeholders}) AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp DESC, id DESC LIMIT ?
      ) ORDER BY timestamp ASC, id ASC`).all(...sensorIds, from, to, limit) as unknown as ReadingRow[];
    return rows.map(readingFromRow);
  }

  historyBucketed(sensorIds: string[], from: string, to: string, bucketSeconds: number, limit = 20_000): Reading[] {
    if (sensorIds.length === 0) return [];
    const placeholders = sensorIds.map(() => "?").join(",");
    const rows = this.db.prepare(`WITH source_rows AS (
        SELECT id, sensor_id, timestamp, source,
          CAST(CAST(strftime('%s', timestamp) AS INTEGER) / ? AS INTEGER) * ? AS bucket_epoch,
          temperature, humidity
        FROM readings WHERE sensor_id IN (${placeholders}) AND timestamp >= ? AND timestamp <= ?
      ), recent_buckets AS (
        SELECT sensor_id, bucket_epoch, AVG(temperature) AS temperature, AVG(humidity) AS humidity,
          COUNT(*) AS sample_count, COUNT(DISTINCT source) AS source_count
        FROM source_rows WHERE bucket_epoch IS NOT NULL
        GROUP BY sensor_id, bucket_epoch ORDER BY bucket_epoch DESC, sensor_id LIMIT ?
      ), chronological_rows AS (
        SELECT id, sensor_id, bucket_epoch,
          ROW_NUMBER() OVER (PARTITION BY sensor_id, bucket_epoch ORDER BY timestamp DESC, id DESC) AS position
        FROM source_rows WHERE bucket_epoch IS NOT NULL
      )
      SELECT recent_buckets.sensor_id, recent_buckets.bucket_epoch, recent_buckets.temperature,
        recent_buckets.humidity, recent_buckets.sample_count, recent_buckets.source_count,
        latest.battery, latest.source, latest.quality
      FROM recent_buckets
      JOIN chronological_rows ON chronological_rows.sensor_id = recent_buckets.sensor_id
        AND chronological_rows.bucket_epoch = recent_buckets.bucket_epoch AND chronological_rows.position = 1
      JOIN readings AS latest ON latest.id = chronological_rows.id
      ORDER BY recent_buckets.bucket_epoch ASC, recent_buckets.sensor_id`)
      .all(bucketSeconds, bucketSeconds, ...sensorIds, from, to, limit) as Array<{
        sensor_id: string;
        bucket_epoch: number;
        temperature: number;
        humidity: number;
        sample_count: number;
        source_count: number;
        battery: number | null;
        source: Reading["source"];
        quality: Reading["quality"];
      }>;
    return rows.map((row) => ({
      sensorId: row.sensor_id,
      timestamp: new Date(row.bucket_epoch * 1_000).toISOString(),
      temperature: row.temperature,
      humidity: row.humidity,
      battery: row.battery,
      source: row.source,
      quality: row.sample_count > 1 || row.source_count > 1 ? "estimated" : row.quality,
    }));
  }

  /**
   * Monotonic pages for the optional durable telemetry archive. The SQLite
   * database remains the crash-safe local buffer until the remote checkpoint
   * has advanced beyond each row.
   */
  measurementArchivePage(afterRowId: number, limit: number): TelemetryArchiveRow<MeasurementSample>[] {
    const pageSize = this.telemetryArchivePageSize(limit);
    const rows = this.db.prepare(`SELECT id, sensor_id, metric, value, canonical_unit, timestamp, source, quality
      FROM measurement_samples WHERE id > ? ORDER BY id LIMIT ?`)
      .all(afterRowId, pageSize) as unknown as (MeasurementSampleRow & { id: number })[];
    return rows.map((row) => ({ rowId: row.id, record: measurementSampleFromRow(row) }));
  }

  readingArchivePage(afterRowId: number, limit: number, since?: string): TelemetryArchiveRow<Reading>[] {
    const pageSize = this.telemetryArchivePageSize(limit);
    const recentClause = since ? "AND timestamp >= ?" : "";
    const parameters = since ? [afterRowId, since, pageSize] : [afterRowId, pageSize];
    const rows = this.db.prepare(`SELECT id, sensor_id, timestamp, temperature, humidity, battery, source, quality
      FROM readings WHERE id > ? ${recentClause} ORDER BY id LIMIT ?`)
      .all(...parameters) as unknown as (ReadingRow & { id: number })[];
    return rows.map((row) => ({ rowId: row.id, record: readingFromRow(row) }));
  }

  outdoorTemperatureArchivePage(
    afterRowId: number,
    limit: number,
    since?: string,
  ): TelemetryArchiveRow<OutdoorTemperatureSample>[] {
    const pageSize = this.telemetryArchivePageSize(limit);
    const recentClause = since ? "AND sample.timestamp >= ?" : "";
    const parameters = since ? [afterRowId, since, pageSize] : [afterRowId, pageSize];
    const rows = this.db.prepare(`SELECT archive.archive_id AS archive_row_id, sample.house_id,
        sample.location_key, sample.timestamp, sample.temperature_c, sample.source, sample.fetched_at,
        sample.station_id, sample.station_name, sample.conditions_json
      FROM telemetry_archive_row_ids AS archive
      JOIN outdoor_temperature_samples AS sample
        ON sample.house_id = json_extract(archive.natural_key, '$[0]')
        AND sample.location_key = json_extract(archive.natural_key, '$[1]')
        AND sample.timestamp = json_extract(archive.natural_key, '$[2]')
        AND sample.source = json_extract(archive.natural_key, '$[3]')
      WHERE archive.table_name = 'outdoor_temperature_samples'
        AND archive.archive_id > ? ${recentClause}
      ORDER BY archive.archive_id LIMIT ?`)
      .all(...parameters) as unknown as (OutdoorTemperatureRow & { archive_row_id: number })[];
    return rows.map((row) => ({ rowId: row.archive_row_id, record: outdoorTemperatureFromRow(row) }));
  }

  electricityPriceArchivePage(
    afterRowId: number,
    limit: number,
    since?: string,
  ): TelemetryArchiveRow<ElectricityPriceArchiveRecord>[] {
    const pageSize = this.telemetryArchivePageSize(limit);
    const recentClause = since ? "AND price.start_at >= ?" : "";
    const parameters = since ? [afterRowId, since, pageSize] : [afterRowId, pageSize];
      const rows = this.db.prepare(`SELECT archive.archive_id AS archive_row_id, price.property_id,
        price.start_at, price.end_at, price.raw_price_cents_per_kwh, price.margin_cents_per_kwh, price.fetched_at
      FROM telemetry_archive_row_ids AS archive
      JOIN electricity_price_points AS price
        ON price.property_id = json_extract(archive.natural_key, '$[0]')
        AND price.start_at = json_extract(archive.natural_key, '$[1]')
      WHERE archive.table_name = 'electricity_price_samples'
        AND archive.archive_id > ? ${recentClause}
      ORDER BY archive.archive_id LIMIT ?`)
      .all(...parameters) as unknown as (ElectricityPricePointRow & { archive_row_id: number })[];
    return rows.map((row) => ({
      rowId: row.archive_row_id,
      record: {
        propertyId: row.property_id,
        startAt: row.start_at,
        endAt: row.end_at,
        rawPriceCentsPerKwh: row.raw_price_cents_per_kwh,
        marginCentsPerKwh: row.margin_cents_per_kwh,
        source: "sqlite",
        fetchedAt: row.fetched_at,
      },
    }));
  }

  readingArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<Reading>[] {
    const pageSize = this.telemetryArchivePageSize(limit);
    const rows = this.db.prepare(`SELECT dirty.dirty_id, dirty.version, reading.sensor_id, reading.timestamp,
        reading.temperature, reading.humidity, reading.battery, reading.source, reading.quality
      FROM telemetry_archive_dirty_rows AS dirty
      JOIN readings AS reading
        ON reading.sensor_id = json_extract(dirty.natural_key, '$[0]')
        AND reading.timestamp = json_extract(dirty.natural_key, '$[1]')
        AND reading.source = json_extract(dirty.natural_key, '$[2]')
      WHERE dirty.table_name = 'legacy_readings'
      ORDER BY dirty.dirty_id LIMIT ?`).all(pageSize) as unknown as (ReadingRow & { dirty_id: number; version: number })[];
    return rows.map((row) => ({ dirtyId: row.dirty_id, version: row.version, record: readingFromRow(row) }));
  }

  outdoorTemperatureArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<OutdoorTemperatureSample>[] {
    const pageSize = this.telemetryArchivePageSize(limit);
    const rows = this.db.prepare(`SELECT dirty.dirty_id, dirty.version, sample.house_id, sample.location_key,
        sample.timestamp, sample.temperature_c, sample.source, sample.fetched_at, sample.station_id, sample.station_name,
        sample.conditions_json
      FROM telemetry_archive_dirty_rows AS dirty
      JOIN outdoor_temperature_samples AS sample
        ON sample.house_id = json_extract(dirty.natural_key, '$[0]')
        AND sample.location_key = json_extract(dirty.natural_key, '$[1]')
        AND sample.timestamp = json_extract(dirty.natural_key, '$[2]')
        AND sample.source = json_extract(dirty.natural_key, '$[3]')
      WHERE dirty.table_name = 'outdoor_temperature_samples'
      ORDER BY dirty.dirty_id LIMIT ?`).all(pageSize) as unknown as (OutdoorTemperatureRow & { dirty_id: number; version: number })[];
    return rows.map((row) => ({ dirtyId: row.dirty_id, version: row.version, record: outdoorTemperatureFromRow(row) }));
  }

  electricityPriceArchiveDirtyPage(limit: number): TelemetryArchiveDirtyRow<ElectricityPriceArchiveRecord>[] {
    const pageSize = this.telemetryArchivePageSize(limit);
    const rows = this.db.prepare(`SELECT dirty.dirty_id, dirty.version, price.property_id, price.start_at, price.end_at,
        price.raw_price_cents_per_kwh, price.margin_cents_per_kwh, price.fetched_at
      FROM telemetry_archive_dirty_rows AS dirty
      JOIN electricity_price_points AS price
        ON price.property_id = json_extract(dirty.natural_key, '$[0]')
        AND price.start_at = json_extract(dirty.natural_key, '$[1]')
      WHERE dirty.table_name = 'electricity_price_samples'
      ORDER BY dirty.dirty_id LIMIT ?`).all(pageSize) as unknown as (ElectricityPricePointRow & { dirty_id: number; version: number })[];
    return rows.map((row) => ({
      dirtyId: row.dirty_id,
      version: row.version,
      record: {
        propertyId: row.property_id,
        startAt: row.start_at,
        endAt: row.end_at,
        rawPriceCentsPerKwh: row.raw_price_cents_per_kwh,
        marginCentsPerKwh: row.margin_cents_per_kwh,
        source: "sqlite",
        fetchedAt: row.fetched_at,
      },
    }));
  }

  acknowledgeTelemetryArchiveDirtyRows(
    table: TelemetryArchiveMutableTable,
    rows: Array<{ dirtyId: number; version: number }>,
  ): number {
    if (rows.length === 0) return 0;
    if (rows.length > 10_000 || rows.some(({ dirtyId, version }) => !Number.isSafeInteger(dirtyId)
      || dirtyId < 1 || !Number.isSafeInteger(version) || version < 1)) {
      throw new RangeError("Telemetry archive dirty row versions are invalid");
    }
    const remove = this.db.prepare(`DELETE FROM telemetry_archive_dirty_rows
      WHERE table_name = ? AND dirty_id = ? AND version = ?`);
    return this.immediateTransaction(() => rows.reduce(
      (deleted, row) => deleted + Number(remove.run(table, row.dirtyId, row.version).changes),
      0,
    ));
  }

  /** Cheap change token used to prove an archive pass observed a stable buffer. */
  telemetryArchiveStateToken(): string {
    const row = this.db.prepare(`SELECT
        COALESCE((SELECT MAX(id) FROM measurement_samples), 0) AS measurement_max,
        COALESCE((SELECT MAX(id) FROM readings), 0) AS reading_max,
        COALESCE((SELECT MAX(archive_id) FROM telemetry_archive_row_ids
          WHERE table_name = 'outdoor_temperature_samples'), 0) AS outdoor_max,
        COALESCE((SELECT MAX(archive_id) FROM telemetry_archive_row_ids
          WHERE table_name = 'electricity_price_samples'), 0) AS electricity_max,
        COALESCE((SELECT COUNT(*) FROM telemetry_archive_dirty_rows), 0) AS dirty_count,
        COALESCE((SELECT MAX(dirty_id) FROM telemetry_archive_dirty_rows), 0) AS dirty_max,
        COALESCE((SELECT SUM(version) FROM telemetry_archive_dirty_rows), 0) AS dirty_versions`)
      .get() as Record<string, number>;
    return [
      row.measurement_max,
      row.reading_max,
      row.outdoor_max,
      row.electricity_max,
      row.dirty_count,
      row.dirty_max,
      row.dirty_versions,
    ].join(":");
  }

  /** True when a destructive control-plane mutation would erase real telemetry from SQLite. */
  hasRealTelemetryForCascade(scope: TelemetryCascadeScope, resourceId: string): boolean {
    const selected = scope === "sensor"
      ? this.db.prepare(`SELECT
          EXISTS(SELECT 1 FROM measurement_samples
            WHERE sensor_id = ? AND source NOT IN ('mock', 'replay'))
          OR EXISTS(SELECT 1 FROM readings
            WHERE sensor_id = ? AND source NOT IN ('mock', 'replay')) AS found`).get(resourceId, resourceId)
      : scope === "house-location"
        ? this.db.prepare(`SELECT EXISTS(SELECT 1 FROM outdoor_temperature_samples
            WHERE house_id = ? AND source <> 'mock') AS found`).get(resourceId)
        : scope === "house"
          ? this.db.prepare(`SELECT
              EXISTS(SELECT 1 FROM measurement_samples sample JOIN sensors sensor ON sensor.id = sample.sensor_id
                WHERE sensor.house_id = ? AND sample.source NOT IN ('mock', 'replay'))
              OR EXISTS(SELECT 1 FROM readings reading JOIN sensors sensor ON sensor.id = reading.sensor_id
                WHERE sensor.house_id = ? AND reading.source NOT IN ('mock', 'replay'))
              OR EXISTS(SELECT 1 FROM outdoor_temperature_samples
                WHERE house_id = ? AND source <> 'mock') AS found`).get(resourceId, resourceId, resourceId)
          : this.db.prepare(`SELECT
              EXISTS(SELECT 1 FROM measurement_samples sample
                JOIN sensors sensor ON sensor.id = sample.sensor_id
                JOIN houses house ON house.id = sensor.house_id
                WHERE house.property_id = ? AND sample.source NOT IN ('mock', 'replay'))
              OR EXISTS(SELECT 1 FROM readings reading
                JOIN sensors sensor ON sensor.id = reading.sensor_id
                JOIN houses house ON house.id = sensor.house_id
                WHERE house.property_id = ? AND reading.source NOT IN ('mock', 'replay'))
              OR EXISTS(SELECT 1 FROM outdoor_temperature_samples sample
                JOIN houses house ON house.id = sample.house_id
                WHERE house.property_id = ? AND sample.source <> 'mock')
              OR EXISTS(SELECT 1 FROM electricity_price_points WHERE property_id = ?) AS found`)
            .get(resourceId, resourceId, resourceId, resourceId);
    return Number((selected as { found: number } | undefined)?.found ?? 0) === 1;
  }

  private requireImmutableTelemetryLineage(
    scope: Exclude<TelemetryCascadeScope, "house-location">,
    resourceId: string,
  ): void {
    if (!this.hasRealTelemetryForCascade(scope, resourceId)) return;
    throw new ClimateDataValidationError(
      409,
      "TELEMETRY_LINEAGE_REQUIRED",
      "Resources with real telemetry cannot be moved or deleted until immutable historical ownership context is available; disable the resource instead",
    );
  }

  private telemetryArchivePageSize(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("Telemetry archive page size must be an integer from 1 to 10000");
    }
    return limit;
  }

  purgeReadingsBefore(
    timestamp: string,
    batchSize = 5_000,
    archivedThrough?: TelemetryArchiveWatermarks,
  ): number {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50_000) {
      throw new ClimateDataValidationError(400, "INVALID_BATCH_SIZE", "Retention batch size must be an integer from 1 to 50000");
    }
    const deleteBatches = (table: "measurement_samples" | "readings"): number => {
      const archiveTable = table === "readings" ? "legacy_readings" : table;
      const watermarkClause = archivedThrough ? "AND candidate.id <= ?" : "";
      const partition = table === "measurement_samples" ? "sensor_id, metric" : "sensor_id";
      const statement = this.db.prepare(`DELETE FROM ${table} WHERE id IN (
        SELECT candidate.id FROM ${table} candidate WHERE candidate.timestamp < ? ${watermarkClause}
          AND candidate.id != (
            SELECT latest.id FROM ${table} latest
            WHERE ${partition.split(", ").map((column) => `latest.${column} = candidate.${column}`).join(" AND ")}
            ORDER BY latest.timestamp DESC, latest.id DESC LIMIT 1
          )
        ORDER BY candidate.timestamp, candidate.id LIMIT ?
      )`);
      let deleted = 0;
      while (true) {
        const parameters = archivedThrough
          ? [timestamp, archivedThrough[archiveTable], batchSize]
          : [timestamp, batchSize];
        const changes = Number(statement.run(...parameters).changes);
        deleted += changes;
        if (changes < batchSize) return deleted;
      }
    };
    const outdoorStatement = archivedThrough
      ? this.db.prepare(`DELETE FROM outdoor_temperature_samples WHERE rowid IN (
          SELECT sample.rowid
          FROM telemetry_archive_row_ids AS archive
          JOIN outdoor_temperature_samples AS sample
            ON sample.house_id = json_extract(archive.natural_key, '$[0]')
            AND sample.location_key = json_extract(archive.natural_key, '$[1]')
            AND sample.timestamp = json_extract(archive.natural_key, '$[2]')
            AND sample.source = json_extract(archive.natural_key, '$[3]')
          WHERE archive.table_name = 'outdoor_temperature_samples'
            AND sample.timestamp < ? AND archive.archive_id <= ?
            AND sample.rowid != (
              SELECT latest.rowid FROM outdoor_temperature_samples latest
              WHERE latest.house_id = sample.house_id AND latest.location_key = sample.location_key
              ORDER BY latest.timestamp DESC, latest.rowid DESC LIMIT 1
            )
          ORDER BY sample.timestamp, archive.archive_id LIMIT ?
        )`)
      : this.db.prepare(`DELETE FROM outdoor_temperature_samples WHERE rowid IN (
          SELECT sample.rowid FROM outdoor_temperature_samples sample WHERE sample.timestamp < ?
            AND sample.rowid != (
              SELECT latest.rowid FROM outdoor_temperature_samples latest
              WHERE latest.house_id = sample.house_id AND latest.location_key = sample.location_key
              ORDER BY latest.timestamp DESC, latest.rowid DESC LIMIT 1
            )
          ORDER BY sample.timestamp, sample.rowid LIMIT ?
        )`);
    let outdoorDeleted = 0;
    while (true) {
      const parameters = archivedThrough
        ? [timestamp, archivedThrough.outdoor_temperature_samples, batchSize]
        : [timestamp, batchSize];
      const changes = Number(outdoorStatement.run(...parameters).changes);
      outdoorDeleted += changes;
      if (changes < batchSize) break;
    }
    return deleteBatches("measurement_samples") + deleteBatches("readings") + outdoorDeleted;
  }

  listAlertRules(): AlertRule[] {
    return (this.db.prepare("SELECT * FROM alert_rules WHERE retired_at IS NULL ORDER BY name")
      .all() as unknown as AlertRuleRow[]).map(ruleFromRow);
  }

  getAlertRule(id: string): AlertRule | null {
    const row = this.db.prepare("SELECT * FROM alert_rules WHERE id = ? AND retired_at IS NULL")
      .get(id) as unknown as AlertRuleRow | undefined;
    return row ? ruleFromRow(row) : null;
  }

  saveAlertRule(input: Omit<AlertRule, "id"> & { id?: string }): AlertRule {
    const deliveryPolicy = normalizeAlertDeliveryPolicy(input.deliveryPolicy);
    const rule: AlertRule = {
      ...input,
      id: input.id ?? randomUUID(),
      deliveryPolicy,
    };
    this.db.prepare(`INSERT INTO alert_rules
      (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled,
       telegram_enabled, delivery_policy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(rule.id, rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds,
        rule.severity, rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0, rule.telegramEnabled ? 1 : 0,
        policyJson(deliveryPolicy));
    return rule;
  }

  updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null {
    return this.immediateTransaction(() => {
      const current = this.getAlertRule(id);
      if (!current) return null;
      const deliveryPolicy = normalizeAlertDeliveryPolicy(patch.deliveryPolicy ?? current.deliveryPolicy);
      const rule: AlertRule = {
        ...current,
        ...patch,
        id,
        deliveryPolicy,
      };
      this.db.prepare(`UPDATE alert_rules SET name = ?, sensor_id = ?, metric = ?, operator = ?, threshold = ?,
        duration_seconds = ?, severity = ?, enabled = ?, webhook_enabled = ?, telegram_enabled = ?,
        delivery_policy_json = ? WHERE id = ?`)
        .run(rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds, rule.severity,
          rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0, rule.telegramEnabled ? 1 : 0,
          policyJson(deliveryPolicy), id);
      if (Object.keys(patch).some((key) => !["name", "severity", "webhookEnabled", "telegramEnabled"].includes(key))) {
        this.db.prepare("DELETE FROM alert_evaluation_state WHERE rule_id = ?").run(id);
      }
      return rule;
    });
  }

  deleteAlertRule(id: string): boolean {
    return this.immediateTransaction(() => {
      const retiredAt = new Date().toISOString();
      const retired = Number(this.db.prepare(`UPDATE alert_rules SET retired_at = ?, enabled = 0
        WHERE id = ? AND retired_at IS NULL`).run(retiredAt, id).changes) > 0;
      if (!retired) return false;
      this.db.prepare("DELETE FROM alert_evaluation_state WHERE rule_id = ?").run(id);
      this.db.prepare(`UPDATE alert_events SET resolved_at = COALESCE(
        resolved_at, CASE WHEN started_at > ? THEN started_at ELSE ? END
      ) WHERE rule_id = ?`).run(retiredAt, retiredAt, id);
      return true;
    });
  }

  createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent {
    const event: AlertEvent = { ...input, id: randomUUID(), acknowledgedAt: null, resolvedAt: null };
    this.db.prepare(`INSERT INTO alert_events
      (id, rule_id, sensor_id, metric, value, threshold, severity, started_at, acknowledged_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.ruleId, event.sensorId, event.metric, event.value, event.threshold, event.severity,
        event.startedAt, null, null);
    return event;
  }

  applyAlertSample(
    rule: AlertRule,
    sample: MeasurementSample,
    conditionMet: boolean,
    notificationBindings?: AlertNotificationBindings,
  ): AlertTransition {
    return this.immediateTransaction(() => {
      const state = this.db.prepare(`SELECT latest_timestamp, condition_since FROM alert_evaluation_state
        WHERE rule_id = ? AND sensor_id = ?`).get(rule.id, sample.sensorId) as {
          latest_timestamp: string;
          condition_since: string | null;
        } | undefined;
      const sampleMs = Date.parse(sample.timestamp);
      if (state && sampleMs <= Date.parse(state.latest_timestamp)) {
        return { ignoredAsStale: true, created: null, resolved: null };
      }
      const active = this.activeAlert(rule.id, sample.sensorId);
      const conditionSince = conditionMet ? state?.condition_since ?? sample.timestamp : null;
      this.db.prepare(`INSERT INTO alert_evaluation_state(rule_id, sensor_id, latest_timestamp, condition_since)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(rule_id, sensor_id) DO UPDATE SET
          latest_timestamp = excluded.latest_timestamp,
          condition_since = excluded.condition_since`)
        .run(rule.id, sample.sensorId, sample.timestamp, conditionSince);

      if (!conditionMet) {
        if (!active) return { ignoredAsStale: false, created: null, resolved: null };
        const resolvedAt = new Date(Math.max(sampleMs, Date.parse(active.startedAt))).toISOString();
        this.db.prepare("UPDATE alert_events SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?")
          .run(resolvedAt, active.id);
        return { ignoredAsStale: false, created: null, resolved: this.getAlertEvent(active.id) };
      }
      if (active || !conditionSince || sampleMs - Date.parse(conditionSince) < rule.durationSeconds * 1_000) {
        return { ignoredAsStale: false, created: null, resolved: null };
      }
      const created = this.createAlertEvent({
        ruleId: rule.id,
        sensorId: sample.sensorId,
        metric: rule.metric,
        value: sample.value,
        threshold: rule.threshold,
        severity: rule.severity,
        startedAt: conditionSince,
      });
      if (sample.source !== "mock" && sample.source !== "replay") {
        const now = new Date();
        const policy = normalizeAlertDeliveryPolicy(rule.deliveryPolicy);
        const schedule = notificationScheduleDecision(policy, created.severity, now);
        const sensor = notificationBindings ? null : this.getSensor(created.sensorId);
        const house = sensor ? this.getHouse(sensor.houseId) : null;
        const bindings = notificationBindings ?? alertNotificationBindings(undefined, {
          houseLabel: house?.name ?? null,
          sensorLabel: sensor?.name ?? null,
        });
        const enqueue = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
          (id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id, attempts, max_attempts,
           available_at, locked_at, lock_token, last_error, created_at, delivered_at, payload_json,
           destination_ref, policy_json, dead_lettered_at, abandoned_at)
          VALUES (?, 'alert', ?, ?, 'initial', 0, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL)`);
        if (rule.webhookEnabled) {
          for (const destination of bindings.webhookDestinations) {
            const snapshot = notificationSnapshot(
              "webhook", created, rule, bindings, schedule.silent, "initial", destination.destinationId,
            );
            enqueue.run(randomUUID(), created.id, created.id, "webhook", destination.destinationId, policy.maxAttempts,
              schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson, snapshot.destinationRef, policyJson(policy));
          }
        }
        if (rule.telegramEnabled) {
          const snapshot = notificationSnapshot("telegram", created, rule, bindings, schedule.silent);
          enqueue.run(randomUUID(), created.id, created.id, "telegram", "primary", policy.maxAttempts,
            schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson, snapshot.destinationRef, policyJson(policy));
        }
      }
      return { ignoredAsStale: false, created, resolved: null };
    });
  }

  listDueAlertConditions(now = new Date(), limit = 500): DueAlertCondition[] {
    const rows = this.db.prepare(`SELECT rule.*, state.sensor_id AS pending_sensor_id,
        state.condition_since AS pending_condition_since, state.latest_timestamp AS pending_latest_timestamp
      FROM alert_evaluation_state state
      JOIN alert_rules rule ON rule.id = state.rule_id
      WHERE rule.enabled = 1 AND rule.retired_at IS NULL AND state.condition_since IS NOT NULL
        AND datetime(state.condition_since, '+' || rule.duration_seconds || ' seconds') <= datetime(?)
        AND NOT EXISTS (
          SELECT 1 FROM alert_events event
          WHERE event.rule_id = rule.id AND event.sensor_id = state.sensor_id AND event.resolved_at IS NULL
        )
      ORDER BY state.condition_since LIMIT ?`).all(now.toISOString(), boundedCollectionLimit(limit)) as unknown as Array<AlertRuleRow & {
        pending_sensor_id: string;
        pending_condition_since: string;
        pending_latest_timestamp: string;
      }>;
    return rows.map((row) => ({
      rule: ruleFromRow(row),
      sensorId: row.pending_sensor_id,
      conditionSince: row.pending_condition_since,
      latestTimestamp: row.pending_latest_timestamp,
    }));
  }

  enqueueAlertFollowup(
    event: AlertEvent,
    rule: AlertRule,
    stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">,
    sequence: number,
    bindings: AlertNotificationBindings,
    now = new Date(),
  ): number {
    if (event.resolvedAt || event.acknowledgedAt || sequence < 0 || !Number.isInteger(sequence)) return 0;
    const policy = normalizeAlertDeliveryPolicy(rule.deliveryPolicy);
    const schedule = notificationScheduleDecision(policy, event.severity, now);
    const enqueue = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
      (id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id, attempts, max_attempts,
       available_at, locked_at, lock_token, last_error, created_at, delivered_at, payload_json, destination_ref,
       policy_json, dead_lettered_at, abandoned_at)
      VALUES (?, 'alert', ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL)`);
    let inserted = 0;
    if (rule.webhookEnabled) {
      for (const destination of bindings.webhookDestinations) {
        const snapshot = notificationSnapshot(
          "webhook", event, rule, bindings, schedule.silent, stage, destination.destinationId,
        );
        inserted += Number(enqueue.run(randomUUID(), event.id, event.id, stage, sequence, "webhook",
          destination.destinationId, policy.maxAttempts, schedule.deliverAt.toISOString(), now.toISOString(),
          snapshot.payloadJson, snapshot.destinationRef, policyJson(policy)).changes);
      }
    }
    if (rule.telegramEnabled) {
      const snapshot = notificationSnapshot("telegram", event, rule, bindings, schedule.silent, stage);
      inserted += Number(enqueue.run(randomUUID(), event.id, event.id, stage, sequence, "telegram", "primary", policy.maxAttempts,
        schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson, snapshot.destinationRef, policyJson(policy)).changes);
    }
    return inserted;
  }

  enqueueOperationalNotification(input: {
    subjectKind: Extract<NotificationSubjectKind, "maintenance" | "action-run">;
    subjectId: string;
    stage: Extract<NotificationDeliveryStage, "due" | "verification">;
    sequence?: number;
    policy?: AlertDeliveryPolicy;
    severity?: "info" | "warning" | "critical";
    webhookEnabled: boolean;
    telegramEnabled: boolean;
    config?: import("./config.js").AppConfig;
    type: "maintenance.due" | "action.verification";
    text: string;
    data: unknown;
    now?: Date;
  }): number {
    const sequence = input.sequence ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !input.subjectId) return 0;
    const now = input.now ?? new Date();
    const policy = normalizeAlertDeliveryPolicy(input.policy ?? DEFAULT_ALERT_DELIVERY_POLICY);
    const schedule = notificationScheduleDecision(policy, input.severity ?? "warning", now);
    const enqueue = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
      (id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id, attempts, max_attempts,
       available_at, locked_at, lock_token, last_error, created_at, delivered_at, payload_json, destination_ref,
       policy_json, dead_lettered_at, abandoned_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL)`);
    let inserted = 0;
    if (input.webhookEnabled) {
      const destinations = alertNotificationBindings(input.config, { houseLabel: null, sensorLabel: null })
        .webhookDestinations;
      for (const destination of destinations) {
        const snapshot = operationalNotificationSnapshot("webhook", input.config, {
          type: input.type,
          subjectId: input.subjectId,
          text: input.text,
          data: input.data,
          silent: schedule.silent || input.severity === "info",
        }, destination.destinationId);
        inserted += Number(enqueue.run(randomUUID(), input.subjectKind, input.subjectId, input.stage, sequence,
          "webhook", destination.destinationId, policy.maxAttempts, schedule.deliverAt.toISOString(), now.toISOString(),
          snapshot.payloadJson, snapshot.destinationRef, policyJson(policy)).changes);
      }
    }
    if (input.telegramEnabled) {
      const snapshot = operationalNotificationSnapshot("telegram", input.config, {
        type: input.type,
        subjectId: input.subjectId,
        text: input.text,
        data: input.data,
        silent: schedule.silent || input.severity === "info",
      });
      inserted += Number(enqueue.run(randomUUID(), input.subjectKind, input.subjectId, input.stage, sequence, "telegram",
        "primary", policy.maxAttempts, schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson,
        snapshot.destinationRef, policyJson(policy)).changes);
    }
    return inserted;
  }

  clearAlertEvaluationState(): void {
    this.db.prepare("DELETE FROM alert_evaluation_state").run();
  }

  listAlertEvents(limit = 200, activeOnly = false, offset = 0): AlertEvent[] {
    const rows = this.db.prepare(`SELECT * FROM alert_events ${activeOnly ? "WHERE resolved_at IS NULL" : ""}
      ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as unknown as AlertEventRow[];
    return rows.map(eventFromRow);
  }

  activeAlert(ruleId: string, sensorId: string): AlertEvent | null {
    const row = this.db.prepare(`SELECT * FROM alert_events
      WHERE rule_id = ? AND sensor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1`)
      .get(ruleId, sensorId) as unknown as AlertEventRow | undefined;
    return row ? eventFromRow(row) : null;
  }

  acknowledgeAlert(id: string, timestamp: string): AlertEvent | null {
    this.db.prepare("UPDATE alert_events SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?").run(timestamp, id);
    return this.getAlertEvent(id);
  }

  resolveAlert(id: string, timestamp: string): AlertEvent | null {
    const current = this.getAlertEvent(id);
    if (!current) return null;
    const safeTimestamp = new Date(Math.max(Date.parse(timestamp), Date.parse(current.startedAt))).toISOString();
    this.db.prepare("UPDATE alert_events SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?").run(safeTimestamp, id);
    return this.getAlertEvent(id);
  }

  getAlertEvent(id: string): AlertEvent | null {
    const row = this.db.prepare("SELECT * FROM alert_events WHERE id = ?").get(id) as unknown as AlertEventRow | undefined;
    return row ? eventFromRow(row) : null;
  }

  claimNotificationOutbox(limit = 20, now = new Date()): NotificationOutboxItem[] {
    return this.immediateTransaction(() => {
      const nowIso = now.toISOString();
      const staleLock = new Date(now.getTime() - 5 * 60_000).toISOString();
      const rows = this.db.prepare(`SELECT id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
          payload_json, destination_ref, policy_json, max_attempts, attempts FROM notification_outbox
        WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL AND available_at <= ?
          AND (locked_at IS NULL OR locked_at <= ?)
        ORDER BY available_at, created_at LIMIT ?`).all(nowIso, staleLock, limit) as Array<{
          id: string;
          subject_kind: NotificationSubjectKind;
          subject_id: string;
          event_id: string | null;
          stage: NotificationDeliveryStage;
          sequence: number;
          channel: NotificationChannel;
          destination_id: string;
          payload_json: string;
          destination_ref: string;
          policy_json: string;
          max_attempts: number;
          attempts: number;
        }>;
      return rows.flatMap((row) => {
        const lockToken = randomUUID();
        const changed = Number(this.db.prepare(`UPDATE notification_outbox SET locked_at = ?, lock_token = ?
          WHERE id = ? AND delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL
            AND (locked_at IS NULL OR locked_at <= ?)`)
          .run(nowIso, lockToken, row.id, staleLock).changes);
        return changed ? [{
          id: row.id,
          subjectKind: row.subject_kind,
          subjectId: row.subject_id,
          eventId: row.event_id,
          stage: row.stage,
          sequence: row.sequence,
          channel: row.channel,
          destinationId: row.destination_id,
          payloadJson: row.payload_json,
          destinationRef: row.destination_ref,
          policy: policyFromJson(row.policy_json),
          maxAttempts: row.max_attempts,
          attempts: row.attempts,
          lockToken,
        }] : [];
      });
    });
  }

  completeNotificationOutbox(id: string, lockToken: string, deliveredAt = new Date()): boolean {
    return Number(this.db.prepare(`UPDATE notification_outbox SET delivered_at = ?, locked_at = NULL, lock_token = NULL,
      last_error = NULL WHERE id = ? AND lock_token = ? AND delivered_at IS NULL`)
      .run(deliveredAt.toISOString(), id, lockToken).changes) > 0;
  }

  failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean {
    return Number(this.db.prepare(`UPDATE notification_outbox SET attempts = attempts + 1, available_at = ?,
      locked_at = NULL, lock_token = NULL, last_error = ? WHERE id = ? AND lock_token = ? AND delivered_at IS NULL`)
      .run(retryAt.toISOString(), error.slice(0, 500), id, lockToken).changes) > 0;
  }

  deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at = new Date()): boolean {
    return Number(this.db.prepare(`UPDATE notification_outbox SET attempts = attempts + 1, dead_lettered_at = ?,
      locked_at = NULL, lock_token = NULL, last_error = ?
      WHERE id = ? AND lock_token = ? AND delivered_at IS NULL AND dead_lettered_at IS NULL`)
      .run(at.toISOString(), error.slice(0, 500), id, lockToken).changes) > 0;
  }

  listNotificationDeliveries(limit = 200): NotificationDeliveryStatus[] {
    return (this.db.prepare(`SELECT id, subject_kind, subject_id, stage, sequence, channel, destination_id, attempts, max_attempts,
        available_at, created_at, delivered_at, dead_lettered_at, abandoned_at, last_error
      FROM notification_outbox ORDER BY created_at DESC LIMIT ?`).all(boundedCollectionLimit(limit)) as Array<{
        id: string; subject_kind: NotificationSubjectKind; subject_id: string; stage: NotificationDeliveryStage; sequence: number;
        channel: NotificationChannel; destination_id: string; attempts: number; max_attempts: number; available_at: string;
        created_at: string; delivered_at: string | null; dead_lettered_at: string | null;
        abandoned_at: string | null; last_error: string | null;
      }>).map((row) => ({
        id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, stage: row.stage, sequence: row.sequence,
        channel: row.channel, destinationId: row.destination_id, attempts: row.attempts, maxAttempts: row.max_attempts,
        availableAt: row.available_at, createdAt: row.created_at, deliveredAt: row.delivered_at,
        deadLetteredAt: row.dead_lettered_at, abandonedAt: row.abandoned_at, lastError: row.last_error,
      }));
  }

  retryNotificationDelivery(id: string, at = new Date()): boolean {
    return Number(this.db.prepare(`UPDATE notification_outbox SET attempts = 0, available_at = ?, locked_at = NULL,
      lock_token = NULL, dead_lettered_at = NULL, abandoned_at = NULL, last_error = NULL
      WHERE id = ? AND delivered_at IS NULL AND (dead_lettered_at IS NOT NULL OR abandoned_at IS NOT NULL)`)
      .run(at.toISOString(), id).changes) > 0;
  }

  releaseNotificationOutbox(id: string, lockToken: string, availableAt = new Date()): boolean {
    return Number(this.db.prepare(`UPDATE notification_outbox SET available_at = ?, locked_at = NULL,
      lock_token = NULL WHERE id = ? AND lock_token = ? AND delivered_at IS NULL`)
      .run(availableAt.toISOString(), id, lockToken).changes) > 0;
  }

  abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt = new Date()): boolean {
    return Number(this.db.prepare(`UPDATE notification_outbox SET abandoned_at = ?, locked_at = NULL,
      lock_token = NULL, last_error = ? WHERE id = ? AND lock_token = ? AND delivered_at IS NULL
        AND abandoned_at IS NULL`)
      .run(abandonedAt.toISOString(), reason.slice(0, 500), id, lockToken).changes) > 0;
  }

  pendingNotificationCount(): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS count FROM notification_outbox
      WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL`)
      .get() as { count: number }).count);
  }

  listActionPlaybooks(metric?: string, enabledOnly = false): ActionPlaybook[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (metric) { clauses.push("metric = ?"); parameters.push(metric); }
    if (enabledOnly) clauses.push("enabled = 1");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM action_playbooks ${where} ORDER BY built_in DESC, name`)
      .all(...parameters) as unknown as ActionPlaybookRow[]).map(actionPlaybookFromRow);
  }

  getActionPlaybook(id: string): ActionPlaybook | null {
    const row = this.db.prepare("SELECT * FROM action_playbooks WHERE id = ?").get(id) as unknown as ActionPlaybookRow | undefined;
    return row ? actionPlaybookFromRow(row) : null;
  }

  saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook {
    if (!this.getMeasurementDefinition(input.metric)) {
      throw new ClimateDataValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${input.metric}`);
    }
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    const instructions = [...new Set(input.instructions.map((item) => item.trim()).filter(Boolean))];
    if (!input.name.trim() || !input.description.trim() || instructions.length === 0 || instructions.length > 20) {
      throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", "A playbook requires a name, description, and 1–20 instructions");
    }
    this.db.prepare(`INSERT INTO action_playbooks(
      id, name, description, instructions_json, metric, goal, minimum_improvement, target_value,
      wait_seconds, verification_window_seconds, enabled, built_in, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(id, input.name.trim(), input.description.trim(), JSON.stringify(instructions), input.metric, input.goal,
        input.minimumImprovement, input.targetValue, input.waitSeconds, input.verificationWindowSeconds,
        input.enabled === false ? 0 : 1, now, now);
    return this.getActionPlaybook(id)!;
  }

  updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null {
    const current = this.getActionPlaybook(id);
    if (!current) return null;
    const next: ActionPlaybookInput = {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      instructions: patch.instructions ?? current.instructions,
      metric: patch.metric ?? current.metric,
      goal: patch.goal ?? current.goal,
      minimumImprovement: patch.minimumImprovement ?? current.minimumImprovement,
      targetValue: patch.targetValue === undefined ? current.targetValue : patch.targetValue,
      waitSeconds: patch.waitSeconds ?? current.waitSeconds,
      verificationWindowSeconds: patch.verificationWindowSeconds ?? current.verificationWindowSeconds,
      enabled: patch.enabled ?? current.enabled,
    };
    if (!this.getMeasurementDefinition(next.metric)) {
      throw new ClimateDataValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${next.metric}`);
    }
    const instructions = [...new Set(next.instructions.map((item) => item.trim()).filter(Boolean))];
    if (!next.name.trim() || !next.description.trim() || instructions.length === 0 || instructions.length > 20) {
      throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", "A playbook requires a name, description, and 1–20 instructions");
    }
    this.db.prepare(`UPDATE action_playbooks SET name = ?, description = ?, instructions_json = ?, metric = ?,
      goal = ?, minimum_improvement = ?, target_value = ?, wait_seconds = ?, verification_window_seconds = ?,
      enabled = ?, updated_at = ? WHERE id = ?`)
      .run(next.name.trim(), next.description.trim(), JSON.stringify(instructions), next.metric, next.goal,
        next.minimumImprovement, next.targetValue, next.waitSeconds, next.verificationWindowSeconds,
        next.enabled === false ? 0 : 1, new Date().toISOString(), id);
    return this.getActionPlaybook(id);
  }

  listActionRuns(options: { sensorId?: string; alertEventId?: string; activeOnly?: boolean } = {}): ActionRun[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (options.sensorId) { clauses.push("sensor_id = ?"); parameters.push(options.sensorId); }
    if (options.alertEventId) { clauses.push("alert_event_id = ?"); parameters.push(options.alertEventId); }
    if (options.activeOnly) clauses.push("status IN ('active', 'waiting')");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM action_runs ${where} ORDER BY updated_at DESC LIMIT 500`)
      .all(...parameters) as unknown as ActionRunRow[]).map(actionRunFromRow);
  }

  getActionRun(id: string): ActionRun | null {
    const row = this.db.prepare("SELECT * FROM action_runs WHERE id = ?").get(id) as unknown as ActionRunRow | undefined;
    return row ? actionRunFromRow(row) : null;
  }

  startActionRun(input: ActionRunStartInput, now = new Date()): ActionRun {
    const playbook = this.getActionPlaybook(input.playbookId);
    if (!playbook || !playbook.enabled) throw new ClimateDataValidationError(404, "PLAYBOOK_NOT_FOUND", "Action playbook not found");
    const sensor = this.getSensor(input.sensorId);
    if (!sensor || !sensor.enabled) throw new ClimateDataValidationError(404, "SENSOR_NOT_FOUND", "Sensor not found or disabled");
    const baseline = this.getLatestMeasurementSample(sensor.id, playbook.metric);
    if (!baseline || baseline.quality === "stale") {
      throw new ClimateDataValidationError(409, "BASELINE_UNAVAILABLE", "A fresh baseline sample is required before starting this action");
    }
    if (input.alertEventId) {
      const event = this.getAlertEvent(input.alertEventId);
      if (!event || event.sensorId !== sensor.id || event.metric !== playbook.metric) {
        throw new ClimateDataValidationError(409, "ALERT_MISMATCH", "The alert does not match the selected sensor and playbook metric");
      }
    }
    if (input.maintenanceTaskId && !this.getMaintenanceTask(input.maintenanceTaskId)) {
      throw new ClimateDataValidationError(404, "MAINTENANCE_TASK_NOT_FOUND", "Maintenance task not found");
    }
    const duplicate = this.db.prepare(`SELECT 1 FROM action_runs
      WHERE playbook_id = ? AND sensor_id = ? AND status IN ('active', 'waiting') LIMIT 1`)
      .get(playbook.id, sensor.id);
    if (duplicate) throw new ClimateDataValidationError(409, "ACTION_ALREADY_ACTIVE", "This action is already active for the sensor");
    const timestamp = now.toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO action_runs(
      id, playbook_id, alert_event_id, maintenance_task_id, sensor_id, metric, status, started_at,
      action_completed_at, verify_after, verification_deadline, baseline_value, baseline_timestamp,
      result_value, result_timestamp, improvement, sample_count, operator_note, verification_note,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, 0, ?, NULL, ?, ?)`)
      .run(id, playbook.id, input.alertEventId ?? null, input.maintenanceTaskId ?? null, sensor.id, playbook.metric,
        timestamp, baseline.value, baseline.timestamp, input.operatorNote?.trim() || null, timestamp, timestamp);
    return this.getActionRun(id)!;
  }

  completeActionRun(id: string, now = new Date()): ActionRun | null {
    const run = this.getActionRun(id);
    if (!run) return null;
    if (run.status !== "active") {
      throw new ClimateDataValidationError(409, "INVALID_ACTION_STATE", "Only an active action can be marked complete");
    }
    const playbook = this.getActionPlaybook(run.playbookId)!;
    const verifyAfter = new Date(now.getTime() + playbook.waitSeconds * 1_000);
    const deadline = new Date(verifyAfter.getTime() + playbook.verificationWindowSeconds * 1_000);
    this.db.prepare(`UPDATE action_runs SET status = 'waiting', action_completed_at = ?, verify_after = ?,
      verification_deadline = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(now.toISOString(), verifyAfter.toISOString(), deadline.toISOString(), now.toISOString(), id);
    return this.getActionRun(id);
  }

  cancelActionRun(id: string, note: string | null = null, now = new Date()): ActionRun | null {
    const run = this.getActionRun(id);
    if (!run) return null;
    if (!['active', 'waiting'].includes(run.status)) return run;
    this.db.prepare(`UPDATE action_runs SET status = 'cancelled', verification_note = ?, updated_at = ? WHERE id = ?`)
      .run(note?.trim() || "Cancelled by operator", now.toISOString(), id);
    return this.getActionRun(id);
  }

  verifyDueActionRuns(now = new Date()): ActionRun[] {
    const due = (this.db.prepare(`SELECT * FROM action_runs
      WHERE status = 'waiting' AND verify_after <= ? ORDER BY verify_after LIMIT 200`)
      .all(now.toISOString()) as unknown as ActionRunRow[]).map(actionRunFromRow);
    const changed: ActionRun[] = [];
    for (const run of due) {
      const playbook = this.getActionPlaybook(run.playbookId);
      if (!playbook || !run.verifyAfter || !run.verificationDeadline) continue;
      const windowEnd = new Date(Math.min(now.getTime(), Date.parse(run.verificationDeadline))).toISOString();
      const evidenceFrom = new Date(Math.max(Date.parse(run.verifyAfter), Date.parse(run.baselineTimestamp) + 1)).toISOString();
      const samples = this.measurementHistory(run.sensorId, run.metric, evidenceFrom, windowEnd, 10_000)
        .filter((sample) => sample.quality !== "stale");
      const latest = samples.at(-1) ?? null;
      let improvement: number | null = null;
      let succeeded = false;
      if (latest) {
        improvement = playbook.goal === "decrease" || playbook.goal === "below"
          ? run.baselineValue - latest.value
          : latest.value - run.baselineValue;
        succeeded = playbook.goal === "decrease"
          ? improvement >= playbook.minimumImprovement
          : playbook.goal === "increase"
            ? improvement >= playbook.minimumImprovement
            : playbook.goal === "below"
              ? latest.value <= (playbook.targetValue ?? -Infinity)
              : latest.value >= (playbook.targetValue ?? Infinity);
      }
      const expired = now.getTime() >= Date.parse(run.verificationDeadline);
      const status = succeeded ? "verified" : expired ? "not-improved" : "waiting";
      const note = succeeded
        ? "The measured result met the playbook verification goal."
        : expired
          ? latest ? "The verification window ended without meeting the goal." : "No fresh verification samples arrived before the deadline."
          : null;
      this.db.prepare(`UPDATE action_runs SET status = ?, result_value = ?, result_timestamp = ?, improvement = ?,
        sample_count = ?, verification_note = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`)
        .run(status, latest?.value ?? null, latest?.timestamp ?? null, improvement, samples.length, note,
          now.toISOString(), run.id);
      const updated = this.getActionRun(run.id)!;
      if (updated.status !== run.status || updated.sampleCount !== run.sampleCount || updated.resultValue !== run.resultValue) changed.push(updated);
    }
    return changed;
  }

  listObservations(houseId?: string): ManualObservation[] {
    const rows = (houseId
      ? this.db.prepare("SELECT * FROM observations WHERE house_id = ? ORDER BY occurred_at DESC").all(houseId)
      : this.db.prepare("SELECT * FROM observations ORDER BY occurred_at DESC").all()) as unknown as ObservationRow[];
    return rows.map(observationFromRow);
  }

  getObservation(id: string): StoredObservation | null {
    const row = this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as unknown as ObservationRow | undefined;
    return row ? observationFromRow(row) : null;
  }

  listObservationRevisions(observationId: string): ObservationRevision[] {
    const rows = this.db.prepare(`SELECT * FROM observation_revisions
      WHERE observation_id = ? ORDER BY revision`).all(observationId) as unknown as ObservationRevisionRow[];
    return rows.map(observationRevisionFromRow);
  }

  createObservation(input: ManualObservationInput, actor: LocalObservationRevisionActor = "local-rest"): ManualObservation {
    return this.immediateTransaction(() => {
      const createdAt = new Date().toISOString();
      const temporal = canonicalObservationCreateTime(input, createdAt);
      const observation: StoredObservation = {
        id: input.id ?? randomUUID(),
        houseId: input.houseId,
        floorId: input.floorId,
        sensorId: input.sensorId ?? null,
        kind: input.kind,
        severity: input.severity,
        note: input.note,
        x: input.x ?? null,
        y: input.y ?? null,
        ...temporal,
        createdAt,
        source: input.source ?? "unknown",
        sourceDetail: input.sourceDetail ?? null,
        confidence: input.confidence ?? "uncertain",
        status: "open",
        resolutionNote: null,
        resolvedAt: null,
        revision: 1,
        updatedAt: createdAt,
      };
      this.validateObservation(observation);
      this.db.prepare(`INSERT INTO observations
        (id, house_id, floor_id, sensor_id, kind, severity, note, x, y, occurred_at, created_at,
         time_precision, valid_from, valid_to, source, source_detail, confidence, revision, updated_at,
         status, resolution_note, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(observation.id, observation.houseId, observation.floorId, observation.sensorId, observation.kind,
          observation.severity, observation.note, observation.x, observation.y, observation.occurredAt,
          observation.createdAt, observation.timePrecision, observation.validFrom, observation.validTo,
          observation.source, observation.sourceDetail, observation.confidence, observation.revision, observation.updatedAt,
          observation.status, observation.resolutionNote, observation.resolvedAt);
      this.insertObservationRevision(observation, actor, [...OBSERVATION_CHANGED_FIELDS]);
      return observation;
    });
  }

  updateObservation(
    id: string,
    patch: ManualObservationPatch,
    actor: LocalObservationRevisionActor = "local-rest",
  ): ManualObservation | null {
    return this.immediateTransaction(() => {
      const current = this.getObservation(id);
      if (!current) return null;
      if (patch.baseRevision !== current.revision) {
        throw new ClimateDataValidationError(
          409,
          "OBSERVATION_REVISION_CONFLICT",
          `Observation ${id} is at revision ${current.revision}; reload it before applying this change`,
        );
      }
      const temporal = canonicalObservationPatchTime(current, patch);
      const changedAt = new Date().toISOString();
      const lifecycle = canonicalObservationPatchLifecycle(current, patch, changedAt);
      const next: StoredObservation = {
        ...current,
        ...(patch.floorId !== undefined ? { floorId: patch.floorId } : {}),
        ...(patch.sensorId !== undefined ? { sensorId: patch.sensorId } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.x !== undefined ? { x: patch.x } : {}),
        ...(patch.y !== undefined ? { y: patch.y } : {}),
        ...temporal,
        ...(patch.source !== undefined ? { source: patch.source } : {}),
        ...(patch.sourceDetail !== undefined ? { sourceDetail: patch.sourceDetail } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...lifecycle,
      };
      this.validateObservation(
        next,
        (patch.sensorId !== undefined && patch.sensorId !== current.sensorId)
          || (patch.floorId !== undefined && patch.floorId !== current.floorId),
      );
      const changedFields = OBSERVATION_CHANGED_FIELDS.filter((field) => !Object.is(current[field], next[field]));
      if (changedFields.length === 0) return current;
      next.revision = current.revision + 1;
      next.updatedAt = changedAt;
      const result = this.db.prepare(`UPDATE observations SET
        floor_id = ?, sensor_id = ?, kind = ?, severity = ?, note = ?, x = ?, y = ?, occurred_at = ?,
        time_precision = ?, valid_from = ?, valid_to = ?, source = ?, source_detail = ?, confidence = ?,
        status = ?, resolution_note = ?, resolved_at = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?`)
        .run(next.floorId, next.sensorId, next.kind, next.severity, next.note, next.x, next.y, next.occurredAt,
          next.timePrecision, next.validFrom, next.validTo, next.source, next.sourceDetail, next.confidence,
          next.status, next.resolutionNote, next.resolvedAt, next.revision, next.updatedAt, id, patch.baseRevision);
      if (Number(result.changes) !== 1) {
        throw new ClimateDataValidationError(409, "OBSERVATION_REVISION_CONFLICT", "Observation changed while the patch was being applied");
      }
      this.insertObservationRevision(next, actor, changedFields);
      return next;
    });
  }

  deleteObservation(id: string): boolean {
    const linked = this.db.prepare(`SELECT maintenance_task_id FROM maintenance_task_observations
      WHERE observation_id = ? ORDER BY maintenance_task_id LIMIT 1`).get(id) as { maintenance_task_id: string } | undefined;
    if (linked) {
      throw new ClimateDataValidationError(
        409,
        "OBSERVATION_LINKED_TO_MAINTENANCE",
        `Observation ${id} is linked to maintenance task ${linked.maintenance_task_id}; unlink it before deletion`,
      );
    }
    return Number(this.db.prepare("DELETE FROM observations WHERE id = ?").run(id).changes) > 0;
  }

  private insertObservationRevision(
    observation: StoredObservation,
    actor: LocalObservationRevisionActor,
    changedFields: ObservationChangedField[],
  ): void {
    this.db.prepare(`INSERT INTO observation_revisions
      (observation_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(observation.id, observation.revision, observation.updatedAt, actor,
        JSON.stringify(changedFields), JSON.stringify(observation));
  }

  private validateObservation(observation: StoredObservation, validateSensorRelation = true): void {
    const house = this.getHouse(observation.houseId);
    if (!house) {
      throw new ClimateDataValidationError(404, "OBSERVATION_HOUSE_NOT_FOUND", `House ${observation.houseId} does not exist`);
    }
    const floor = house.floors.find((candidate) => candidate.id === observation.floorId);
    if (!floor) {
      throw new ClimateDataValidationError(
        422,
        "OBSERVATION_FLOOR_NOT_FOUND",
        `Floor ${observation.floorId} does not belong to house ${observation.houseId}`,
      );
    }
    if ((observation.x === null) !== (observation.y === null)) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_POSITION", "Observation x and y must either both be set or both be null");
    }
    if (observation.x !== null && observation.y !== null) {
      if (![observation.x, observation.y].every(Number.isFinite)
        || observation.x < 0 || observation.x > floor.width || observation.y < 0 || observation.y > floor.height) {
        throw new ClimateDataValidationError(
          422,
          "OBSERVATION_OUT_OF_BOUNDS",
          `Observation x/y must be within floor ${floor.id}: 0 <= x <= ${floor.width}, 0 <= y <= ${floor.height}`,
        );
      }
    }
    if (validateSensorRelation && observation.sensorId !== null) {
      const sensor = this.getSensor(observation.sensorId);
      if (!sensor) {
        throw new ClimateDataValidationError(404, "OBSERVATION_SENSOR_NOT_FOUND", `Sensor ${observation.sensorId} does not exist`);
      }
      if (sensor.houseId !== observation.houseId || sensor.floorId !== observation.floorId) {
        throw new ClimateDataValidationError(
          409,
          "OBSERVATION_SENSOR_SCOPE_MISMATCH",
          `Sensor ${sensor.id} does not belong to house ${observation.houseId} and floor ${observation.floorId}`,
        );
      }
    }
    if (![
      "owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown",
    ].includes(observation.source)) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_SOURCE", "Observation source is not supported");
    }
    if (!["confirmed", "probable", "uncertain", "awaiting-inspection"].includes(observation.confidence)) {
      throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_CONFIDENCE", "Observation confidence is not supported");
    }
    if (observation.status === "open") {
      if (observation.resolutionNote !== null || observation.resolvedAt !== null) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_OBSERVATION_RESOLUTION",
          "An open observation cannot contain resolutionNote or resolvedAt",
        );
      }
    } else if (!observation.resolutionNote?.trim() || !observation.resolvedAt) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_OBSERVATION_RESOLUTION",
        "A resolved observation requires a non-empty resolutionNote and a server-recorded resolvedAt",
      );
    }
  }

  listMaintenanceTasks(filters: string | {
    propertyId?: string;
    houseId?: string;
    areaId?: string;
    equipmentId?: string;
    limit?: number;
    offset?: number;
  } = {}): MaintenanceTask[] {
    const options = typeof filters === "string" ? { houseId: filters } : filters;
    const clauses: string[] = [];
    const values: string[] = [];
    for (const [column, value] of [
      ["property_id", options.propertyId], ["house_id", options.houseId], ["area_id", options.areaId],
      ["equipment_id", options.equipmentId],
    ] as const) {
      if (value) { clauses.push(`${column} = ?`); values.push(value); }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM maintenance_tasks${where}
      ORDER BY COALESCE(due_by, planned_for, '9999-12-31'), updated_at DESC, id LIMIT ? OFFSET ?`)
      .all(...values, boundedCollectionLimit(options.limit), boundedCollectionOffset(options.offset)) as unknown as MaintenanceTaskRow[];
    if (rows.length === 0) return [];
    const taskIds = rows.map((row) => row.id);
    const placeholders = taskIds.map(() => "?").join(", ");
    const links = this.db.prepare(`SELECT maintenance_task_id, observation_id FROM maintenance_task_observations
      WHERE maintenance_task_id IN (${placeholders}) ORDER BY maintenance_task_id, observation_id`)
      .all(...taskIds) as unknown as Array<{
        maintenance_task_id: string;
        observation_id: string;
      }>;
    const observationIdsByTask = new Map<string, string[]>();
    for (const link of links) {
      const observationIds = observationIdsByTask.get(link.maintenance_task_id) ?? [];
      observationIds.push(link.observation_id);
      observationIdsByTask.set(link.maintenance_task_id, observationIds);
    }
    return rows.map((row) => maintenanceTaskFromRow(row, observationIdsByTask.get(row.id) ?? []));
  }

  getMaintenanceTask(id: string): MaintenanceTask | null {
    const row = this.db.prepare("SELECT * FROM maintenance_tasks WHERE id = ?").get(id) as unknown as MaintenanceTaskRow | undefined;
    return row ? maintenanceTaskFromRow(row, this.maintenanceTaskObservationIds(id)) : null;
  }

  listMaintenanceTaskRevisions(maintenanceTaskId: string): MaintenanceTaskRevision[] {
    const rows = this.db.prepare(`SELECT * FROM maintenance_task_revisions
      WHERE maintenance_task_id = ? ORDER BY revision`).all(maintenanceTaskId) as unknown as MaintenanceTaskRevisionRow[];
    return rows.map(maintenanceTaskRevisionFromRow);
  }

  getOrCreateMaintenanceTask(
    input: MaintenanceTaskInput,
    actor: LocalMaintenanceTaskRevisionActor = "local-rest",
  ): { task: MaintenanceTask; created: boolean } {
    return this.immediateTransaction(() => {
      const id = input.id;
      if (id) {
        const existing = this.getMaintenanceTask(id);
        if (existing) return { task: existing, created: false };
      }
      return { task: this.createMaintenanceTask(input, actor), created: true };
    });
  }

  createMaintenanceTask(
    input: MaintenanceTaskInput,
    actor: LocalMaintenanceTaskRevisionActor = "local-rest",
  ): MaintenanceTask {
    return this.immediateTransaction(() => {
      const createdAt = new Date().toISOString();
      const requestedHouseId = input.houseId ?? null;
      const house = requestedHouseId === null ? null : this.getHouse(requestedHouseId);
      if (requestedHouseId !== null && !house) {
        throw new ClimateDataValidationError(
          404,
          "MAINTENANCE_HOUSE_NOT_FOUND",
          `House ${requestedHouseId} does not exist`,
        );
      }
      const propertyId = input.propertyId?.trim() || house?.propertyId;
      if (!propertyId) {
        throw new ClimateDataValidationError(
          422,
          "MAINTENANCE_PROPERTY_REQUIRED",
          "propertyId is required when a maintenance task has no house",
        );
      }
      if (!this.getProperty(propertyId)) {
        throw new ClimateDataValidationError(404, "MAINTENANCE_PROPERTY_NOT_FOUND", `Property ${propertyId} does not exist`);
      }
      if (house && house.propertyId !== propertyId) {
        throw new ClimateDataValidationError(
          409,
          "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
          `House ${house.id} does not belong to property ${propertyId}`,
        );
      }
      const task: MaintenanceTask = {
        id: input.id ?? randomUUID(),
        propertyId,
        houseId: requestedHouseId,
        floorId: input.floorId ?? null,
        areaId: input.areaId ?? null,
        equipmentId: input.equipmentId ?? null,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        basis: input.basis,
        basisDetail: input.basisDetail?.trim() || null,
        priority: input.priority ?? "normal",
        plannedFor: maintenanceDate(input.plannedFor ?? null, "plannedFor"),
        dueBy: maintenanceDate(input.dueBy ?? null, "dueBy"),
        observationIds: canonicalMaintenanceObservationIds(input.observationIds ?? []),
        status: "planned",
        completionNote: null,
        completedAt: null,
        verificationNote: null,
        verifiedAt: null,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
      };
      this.validateMaintenanceTask(task);
      try {
        this.db.prepare(`INSERT INTO maintenance_tasks
          (id, property_id, house_id, floor_id, area_id, equipment_id, title, description, basis, basis_detail, priority, planned_for, due_by,
           status, completion_note, completed_at, verification_note, verified_at, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          task.id, task.propertyId, task.houseId, task.floorId, task.areaId ?? null, task.equipmentId ?? null, task.title, task.description, task.basis, task.basisDetail,
          task.priority, task.plannedFor, task.dueBy, task.status, task.completionNote, task.completedAt,
          task.verificationNote, task.verifiedAt, task.revision, task.createdAt, task.updatedAt,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed: maintenance_tasks.id")) {
          throw new ClimateDataValidationError(409, "MAINTENANCE_ID_CONFLICT", `Maintenance task ${task.id} already exists`);
        }
        throw error;
      }
      this.replaceMaintenanceTaskObservationLinks(task.id, task.observationIds);
      this.insertMaintenanceTaskRevision(task, actor, [...MAINTENANCE_TASK_CHANGED_FIELDS]);
      return task;
    });
  }

  updateMaintenanceTask(
    id: string,
    patch: MaintenanceTaskPatch,
    actor: LocalMaintenanceTaskRevisionActor = "local-rest",
  ): MaintenanceTask | null {
    return this.immediateTransaction(() => {
      const current = this.getMaintenanceTask(id);
      if (!current) return null;
      if (patch.baseRevision !== current.revision) {
        throw new ClimateDataValidationError(
          409,
          "MAINTENANCE_REVISION_CONFLICT",
          `Maintenance task ${id} is at revision ${current.revision}; reload it before applying this change`,
        );
      }
      const changedAt = new Date().toISOString();
      const lifecycle = canonicalMaintenanceLifecycle(current, patch, changedAt);
      const next: MaintenanceTask = {
        ...current,
        ...(patch.houseId !== undefined ? { houseId: patch.houseId } : {}),
        ...(patch.floorId !== undefined ? { floorId: patch.floorId } : {}),
        ...(patch.areaId !== undefined ? { areaId: patch.areaId } : {}),
        ...(patch.equipmentId !== undefined ? { equipmentId: patch.equipmentId } : {}),
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
        ...(patch.basis !== undefined ? { basis: patch.basis } : {}),
        ...(patch.basisDetail !== undefined ? { basisDetail: patch.basisDetail?.trim() || null } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.plannedFor !== undefined ? { plannedFor: maintenanceDate(patch.plannedFor, "plannedFor") } : {}),
        ...(patch.dueBy !== undefined ? { dueBy: maintenanceDate(patch.dueBy, "dueBy") } : {}),
        ...(patch.observationIds !== undefined
          ? { observationIds: canonicalMaintenanceObservationIds(patch.observationIds) }
          : {}),
        ...lifecycle,
      };
      this.validateMaintenanceTask(next);
      const changedFields = MAINTENANCE_TASK_CHANGED_FIELDS.filter((field) => (
        field === "observationIds"
          ? JSON.stringify(current.observationIds) !== JSON.stringify(next.observationIds)
          : !Object.is(current[field], next[field])
      ));
      if (changedFields.length === 0) return current;
      next.revision = current.revision + 1;
      next.updatedAt = changedAt;
      const result = this.db.prepare(`UPDATE maintenance_tasks SET
        house_id = ?, floor_id = ?, area_id = ?, equipment_id = ?, title = ?, description = ?, basis = ?, basis_detail = ?, priority = ?, planned_for = ?, due_by = ?,
        status = ?, completion_note = ?, completed_at = ?, verification_note = ?, verified_at = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?`).run(
        next.houseId, next.floorId, next.areaId ?? null, next.equipmentId ?? null, next.title, next.description, next.basis, next.basisDetail, next.priority, next.plannedFor,
        next.dueBy, next.status, next.completionNote, next.completedAt, next.verificationNote, next.verifiedAt,
        next.revision, next.updatedAt, id, patch.baseRevision,
      );
      if (Number(result.changes) !== 1) {
        throw new ClimateDataValidationError(
          409,
          "MAINTENANCE_REVISION_CONFLICT",
          "Maintenance task changed while the patch was being applied",
        );
      }
      if (changedFields.includes("observationIds")) {
        this.replaceMaintenanceTaskObservationLinks(id, next.observationIds);
      }
      this.insertMaintenanceTaskRevision(next, actor, changedFields);
      return next;
    });
  }

  deleteMaintenanceTask(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM maintenance_tasks WHERE id = ?").run(id).changes) > 0;
  }

  private maintenanceTaskObservationIds(maintenanceTaskId: string): string[] {
    const rows = this.db.prepare(`SELECT observation_id FROM maintenance_task_observations
      WHERE maintenance_task_id = ? ORDER BY observation_id`).all(maintenanceTaskId) as unknown as Array<{ observation_id: string }>;
    return rows.map((row) => row.observation_id);
  }

  private replaceMaintenanceTaskObservationLinks(maintenanceTaskId: string, observationIds: string[]): void {
    this.db.prepare("DELETE FROM maintenance_task_observations WHERE maintenance_task_id = ?").run(maintenanceTaskId);
    const insert = this.db.prepare(`INSERT INTO maintenance_task_observations
      (maintenance_task_id, observation_id) VALUES (?, ?)`);
    for (const observationId of observationIds) insert.run(maintenanceTaskId, observationId);
  }

  private insertMaintenanceTaskRevision(
    task: MaintenanceTask,
    actor: MaintenanceTaskRevisionActor,
    changedFields: MaintenanceTaskChangedField[],
  ): void {
    this.db.prepare(`INSERT INTO maintenance_task_revisions
      (maintenance_task_id, revision, changed_at, actor, changed_fields_json, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      task.id, task.revision, task.updatedAt, actor, JSON.stringify(changedFields), JSON.stringify(task),
    );
  }

  /** Capture tasks before a parent move so trigger-cascaded scope changes remain visible in revision history. */
  private ensureScopeMoveCanDetachHouses(where: string, values: string[], propertyId: string): void {
    const linked = this.db.prepare(`SELECT task.id FROM maintenance_tasks task
      JOIN houses house ON house.id = task.house_id
      JOIN maintenance_task_observations link ON link.maintenance_task_id = task.id
      WHERE (${where}) AND house.property_id <> ? LIMIT 1`).get(...values, propertyId) as { id: string } | undefined;
    if (linked) {
      throw new ClimateDataValidationError(
        409,
        "PROPERTY_MOVE_HAS_LINKED_EVIDENCE",
        `Maintenance task ${linked.id} has house observation evidence; move or unlink that task before moving this resource`,
      );
    }
  }

  private maintenanceTasksBeforeScopeMove(where: string, values: string[]): MaintenanceTask[] {
    const rows = this.db.prepare(`SELECT id FROM maintenance_tasks WHERE ${where}`).all(...values) as Array<{ id: string }>;
    return rows.flatMap(({ id }) => {
      const task = this.getMaintenanceTask(id);
      return task ? [task] : [];
    });
  }

  private recordScopeMoveMaintenanceRevisions(
    previousTasks: readonly MaintenanceTask[],
    actor: MaintenanceTaskRevisionActor = "local-rest",
  ): void {
    for (const previous of previousTasks) {
      const cascaded = this.getMaintenanceTask(previous.id);
      if (!cascaded) continue;
      const changedFields = MAINTENANCE_TASK_CHANGED_FIELDS.filter((field) => (
        field === "observationIds"
          ? JSON.stringify(previous.observationIds) !== JSON.stringify(cascaded.observationIds)
          : !Object.is(previous[field], cascaded[field])
      ));
      if (changedFields.length === 0) continue;
      const next: MaintenanceTask = {
        ...cascaded,
        revision: cascaded.revision + 1,
        updatedAt: this.nextUpdatedAt(cascaded.updatedAt),
      };
      this.db.prepare("UPDATE maintenance_tasks SET revision = ?, updated_at = ? WHERE id = ?")
        .run(next.revision, next.updatedAt, next.id);
      this.insertMaintenanceTaskRevision(next, actor, changedFields);
    }
  }

  private validateMaintenanceTask(task: MaintenanceTask): void {
    if (!this.getProperty(task.propertyId)) {
      throw new ClimateDataValidationError(
        404,
        "MAINTENANCE_PROPERTY_NOT_FOUND",
        `Property ${task.propertyId} does not exist`,
      );
    }
    const house = task.houseId === null ? null : this.getHouse(task.houseId);
    if (task.houseId !== null && !house) {
      throw new ClimateDataValidationError(
        404,
        "MAINTENANCE_HOUSE_NOT_FOUND",
        `House ${task.houseId} does not exist`,
      );
    }
    if (house && house.propertyId !== task.propertyId) {
      throw new ClimateDataValidationError(
        409,
        "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
        `House ${house.id} does not belong to property ${task.propertyId}`,
      );
    }
    if (task.floorId !== null && !house) {
      throw new ClimateDataValidationError(
        422,
        "MAINTENANCE_HOUSE_REQUIRED",
        "A maintenance floor requires a house",
      );
    }
    if (task.floorId !== null && house && !house.floors.some((floor) => floor.id === task.floorId)) {
      throw new ClimateDataValidationError(
        422,
        "MAINTENANCE_FLOOR_NOT_FOUND",
        `Floor ${task.floorId} does not belong to house ${task.houseId}`,
      );
    }
    const areaId = task.areaId ?? null;
    const equipmentId = task.equipmentId ?? null;
    let area: PropertyArea | null = null;
    if (areaId !== null) {
      area = this.getPropertyArea(areaId);
      if (!area) {
        throw new ClimateDataValidationError(404, "MAINTENANCE_AREA_NOT_FOUND", `Area ${areaId} does not exist`);
      }
      if (area.propertyId !== task.propertyId) {
        throw new ClimateDataValidationError(
          409,
          "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
          `Area ${areaId} does not belong to property ${task.propertyId}`,
        );
      }
    }
    if (equipmentId !== null) {
      const equipment = this.getAreaEquipment(equipmentId);
      if (!equipment) {
        throw new ClimateDataValidationError(
          404,
          "MAINTENANCE_EQUIPMENT_NOT_FOUND",
          `Equipment ${equipmentId} does not exist`,
        );
      }
      if (equipment.propertyId !== task.propertyId || (area && equipment.areaId !== area.id)) {
        throw new ClimateDataValidationError(
          409,
          "MAINTENANCE_PROPERTY_SCOPE_MISMATCH",
          `Equipment ${equipmentId} does not belong to the selected property and area`,
        );
      }
    }
    if (!task.title.trim() || Array.from(task.title).length > 200) {
      throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_TITLE", "Maintenance title must be 1 to 200 characters");
    }
    for (const [field, value] of [
      ["description", task.description], ["basisDetail", task.basisDetail],
      ["completionNote", task.completionNote], ["verificationNote", task.verificationNote],
    ] as const) {
      if (value !== null && (!value.trim() || Array.from(value).length > 5_000)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_MAINTENANCE_TEXT",
          `${field} must be a non-empty string of at most 5000 characters or null`,
        );
      }
    }
    if (!["required", "scheduled", "condition-based", "predictive", "optional-improvement"].includes(task.basis)) {
      throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_BASIS", "Maintenance basis is not supported");
    }
    if (!["low", "normal", "high", "urgent"].includes(task.priority)) {
      throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_PRIORITY", "Maintenance priority is not supported");
    }
    maintenanceDate(task.plannedFor, "plannedFor");
    maintenanceDate(task.dueBy, "dueBy");
    if (task.plannedFor !== null && task.dueBy !== null && task.plannedFor > task.dueBy) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_MAINTENANCE_SCHEDULE",
        "plannedFor must be before or equal to dueBy",
      );
    }
    if (task.basis === "predictive" && task.dueBy !== null) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_MAINTENANCE_SCHEDULE",
        "Predictive maintenance cannot claim a formal dueBy date",
      );
    }
    if (task.observationIds.length > 100
      || task.observationIds.length !== new Set(task.observationIds).size
      || task.observationIds.some((id) => !id.trim() || Array.from(id).length > 200)) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_MAINTENANCE_OBSERVATIONS",
        "observationIds must contain at most 100 unique, non-empty identifiers of at most 200 characters",
      );
    }
    if (task.observationIds.length > 0 && !house) {
      throw new ClimateDataValidationError(
        422,
        "MAINTENANCE_HOUSE_REQUIRED",
        "Maintenance observation evidence requires a house",
      );
    }
    for (const observationId of task.observationIds) {
      const observation = this.getObservation(observationId);
      if (!observation) {
        throw new ClimateDataValidationError(
          404,
          "MAINTENANCE_OBSERVATION_NOT_FOUND",
          `Observation ${observationId} does not exist`,
        );
      }
      if (observation.houseId !== house!.id) {
        throw new ClimateDataValidationError(
          409,
          "MAINTENANCE_OBSERVATION_SCOPE_MISMATCH",
          `Observation ${observationId} does not belong to house ${task.houseId}`,
        );
      }
    }
    const lifecycleIsValid = task.status === "completed"
      ? Boolean(task.completionNote?.trim() && task.completedAt && task.verificationNote === null && task.verifiedAt === null)
      : task.status === "verified"
        ? Boolean(task.completionNote?.trim() && task.completedAt && task.verificationNote?.trim() && task.verifiedAt)
        : task.completionNote === null && task.completedAt === null
          && task.verificationNote === null && task.verifiedAt === null;
    if (!lifecycleIsValid) {
      throw new ClimateDataValidationError(
        422,
        "INVALID_MAINTENANCE_LIFECYCLE",
        "Maintenance completion and verification fields do not match its status",
      );
    }
  }

  listParameters(houseId?: string): StaticParameter[] {
    const rows = (houseId
      ? this.db.prepare("SELECT * FROM static_parameters WHERE house_id = ? ORDER BY label").all(houseId)
      : this.db.prepare("SELECT * FROM static_parameters ORDER BY label").all()) as unknown as StaticParameterRow[];
    return rows.map(parameterFromRow);
  }

  saveParameter(input: Omit<StaticParameter, "id"> & { id?: string }): StaticParameter {
    const parameter: StaticParameter = { ...input, id: input.id ?? randomUUID() };
    this.db.prepare(`INSERT INTO static_parameters
      (id, house_id, scope_type, scope_id, key, value_json, unit, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(house_id, scope_type, scope_id, key) DO UPDATE SET
        value_json = excluded.value_json, unit = excluded.unit, label = excluded.label`)
      .run(parameter.id, parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key,
        JSON.stringify(parameter.value), parameter.unit, parameter.label);
    const row = this.db.prepare(`SELECT * FROM static_parameters
      WHERE house_id = ? AND scope_type = ? AND scope_id = ? AND key = ?`)
      .get(parameter.houseId, parameter.scopeType, parameter.scopeId, parameter.key) as unknown as StaticParameterRow;
    return parameterFromRow(row);
  }

  deleteParameter(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM static_parameters WHERE id = ?").run(id).changes) > 0;
  }

  createAsset(input: Omit<AssetRecord, "id" | "size" | "createdAt"> & { data: Uint8Array }): AssetRecord {
    const asset: AssetRecord = {
      id: randomUUID(), houseId: input.houseId, name: input.name, mimeType: input.mimeType, kind: input.kind,
      size: input.data.byteLength, createdAt: new Date().toISOString(),
    };
    this.db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(asset.id, asset.houseId, asset.name, asset.mimeType, asset.kind, input.data, asset.size, asset.createdAt);
    return asset;
  }

  listAssets(houseId?: string): AssetRecord[] {
    const sql = `SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size, created_at as createdAt
      FROM assets ${houseId ? "WHERE house_id = ?" : ""} ORDER BY created_at DESC`;
    return (houseId ? this.db.prepare(sql).all(houseId) : this.db.prepare(sql).all()) as unknown as AssetRecord[];
  }

  getAsset(id: string): (AssetRecord & { data: Uint8Array }) | null {
    const row = this.db.prepare(`SELECT id, house_id as houseId, name, mime_type as mimeType, kind, size,
      created_at as createdAt, data FROM assets WHERE id = ?`).get(id);
    return row as unknown as (AssetRecord & { data: Uint8Array }) | null;
  }

  deleteAsset(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM assets WHERE id = ?").run(id).changes) > 0;
  }
}
