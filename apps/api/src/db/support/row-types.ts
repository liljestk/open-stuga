import type { AlertEvent, AlertRule, AreaEquipment, MeasurementSample, OpeningStateObservation, PropertyArea, PropertyElectricityConfig, PropertyNote, SecurityAuditEvent, EquipmentAttachment, ActionPlaybook, ActionRun, IOSNotificationRegistration, MaintenanceTask, MaintenanceTaskRevisionActor, ManualObservation, MeasurementDefinition, ObservationConfidence, ObservationRevisionActor, ObservationSource, ObservationTimePrecision, OutdoorTemperatureSample, Reading, StaticParameter, WeatherBackfillState, WeatherOutageComponent, WeatherProviderName, SensorDataGapCompleteness, SensorDataGapSource, SensorDataGapState } from "@climate-twin/contracts";
import type { IntegrationMappingKind } from "./record-types.js";

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

export interface SensorDataGapRow {
  id: number;
  sensor_id: string;
  metric: string;
  source: SensorDataGapSource;
  started_at: string;
  detected_at: string;
  ended_at: string | null;
  recovery_state: SensorDataGapState;
  recoverable_until: string | null;
  recovery_completeness: SensorDataGapCompleteness;
  recovered_points: number;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  recovery_error: string | null;
}
