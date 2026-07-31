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

export interface EquipmentAttachmentRow {
  id: string;
  equipment_id: string;
  kind: EquipmentAttachment["kind"];
  name: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export interface EquipmentAttachmentDataRow extends EquipmentAttachmentRow {
  data: Uint8Array;
}

export interface EquipmentLinkRow {
  id: string;
  equipment_id: string;
  label: string;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface PropertyNoteRow {
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

export interface SensorRow {
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
  energy_meter_role?: "whole_home" | "submeter" | "standalone";
  tags_json: string;
  enabled: number;
}

export interface MeasurementDefinitionRow {
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

export interface MeasurementSampleRow {
  sensor_id: string;
  metric: string;
  value: number;
  canonical_unit: string;
  timestamp: string;
  source: MeasurementSample["source"];
  quality: MeasurementSample["quality"];
}

export interface ReadingRow {
  sensor_id: string;
  timestamp: string;
  temperature: number;
  humidity: number;
  battery: number | null;
  source: Reading["source"];
  quality: Reading["quality"];
}

export interface AlertRuleRow {
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

export interface AlertEventRow {
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

export interface IOSNotificationRegistrationRow {
  id: string;
  user_id: string;
  device_token: string;
  environment: IOSNotificationRegistration["environment"];
  minimum_severity: IOSNotificationRegistration["minimumSeverity"];
  include_details: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ActionPlaybookRow {
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

export interface ActionRunRow {
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

export interface ObservationRow {
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

export interface ObservationRevisionRow {
  observation_id: string;
  revision: number;
  changed_at: string;
  actor: ObservationRevisionActor;
  changed_fields_json: string;
  snapshot_json: string;
}

export type StoredObservation = ManualObservation & Required<Pick<ManualObservation,
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

export type LocalObservationRevisionActor = Extract<ObservationRevisionActor, "local-rest" | "local-mcp" | "system-service">;

export interface MaintenanceTaskRow {
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

export interface MaintenanceTaskRevisionRow {
  maintenance_task_id: string;
  revision: number;
  changed_at: string;
  actor: MaintenanceTaskRevisionActor;
  changed_fields_json: string;
  snapshot_json: string;
}

export type LocalMaintenanceTaskRevisionActor = Extract<
  MaintenanceTaskRevisionActor,
  "local-rest" | "local-mcp" | "system-service"
>;

export interface StaticParameterRow {
  id: string;
  house_id: string;
  scope_type: StaticParameter["scopeType"];
  scope_id: string;
  key: string;
  value_json: string;
  unit: string | null;
  label: string;
}

export interface OutdoorTemperatureRow {
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

export interface WeatherOutageRow {
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

export type SensorDataGapCompleteness = "unknown" | "none" | "partial" | "complete";
