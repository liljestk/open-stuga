import type { SecurityAuditEvent, Sensor, AreaEquipment, EquipmentAttachment, EquipmentLink, ActionPlaybook, AlertEvent, AlertRule, Floor, GeoCoordinate, House, HouseLocation, HouseMapPlacement, IOSNotificationRegistration, MeasurementDefinition, MeasurementSample, OpeningStateObservation, Property, PropertyElectricityConfig, PropertyArea, PropertyNote, Reading, StugubyHouseLink, StugubyPropertyLink, ActionRun, MaintenanceTask, MaintenanceTaskChangedField, MaintenanceTaskRevision, ManualObservation, ObservationChangedField, ObservationRevision, OutdoorConditions, OutdoorTemperatureSample, StaticParameter } from "@climate-twin/contracts";
import { policyFromJson } from "../../notification-policy.js";
import type { TapoHistoryExportJob, TapoHistoryExportJobRow, TapoHistoryExportStagedSample, TapoHistoryExportStagedSampleRow } from "../tapo-history-export-types.js";
import type { ActionPlaybookRow, ActionRunRow, AlertEventRow, AlertRuleRow, AreaEquipmentRow, EquipmentAttachmentRow, EquipmentLinkRow, HouseRow, IOSNotificationRegistrationRow, MaintenanceTaskRevisionRow, MaintenanceTaskRow, MeasurementDefinitionRow, MeasurementSampleRow, ObservationRevisionRow, ObservationRow, OpeningStateObservationRow, OutdoorTemperatureRow, PropertyAreaRow, PropertyElectricityConfigRow, PropertyNoteRow, PropertyRow, ReadingRow, SecurityAuditEventRow, SensorDataGapRow, SensorRow, StaticParameterRow, WeatherOutageRow } from "./row-types.js";
import { type JsonValue, parseJson } from "./json-values.js";
import type { SensorDataGapRecord, StoredObservation, WeatherOutageRecord } from "./record-types.js";
import { canonicalMaintenanceObservationIds } from "./observation-lifecycle.js";

export function securityAuditEventFromRow(row: SecurityAuditEventRow): SecurityAuditEvent {
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

export function actionRunFromRow(row: ActionRunRow): ActionRun {
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

export function observationFromRow(row: ObservationRow): StoredObservation {
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

export function observationRevisionFromRow(row: ObservationRevisionRow): ObservationRevision {
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

export function maintenanceTaskFromRow(row: MaintenanceTaskRow, observationIds: string[]): MaintenanceTask {
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

export function maintenanceTaskRevisionFromRow(row: MaintenanceTaskRevisionRow): MaintenanceTaskRevision {
  return {
    maintenanceTaskId: row.maintenance_task_id,
    revision: row.revision,
    changedAt: row.changed_at,
    actor: row.actor,
    changedFields: parseJson<MaintenanceTaskChangedField[]>(row.changed_fields_json),
    snapshot: parseJson<MaintenanceTask>(row.snapshot_json),
  };
}

export function parameterFromRow(row: StaticParameterRow): StaticParameter {
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

export function outdoorTemperatureFromRow(row: OutdoorTemperatureRow): OutdoorTemperatureSample {
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

export function weatherOutageFromRow(row: WeatherOutageRow): WeatherOutageRecord {
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

export function sensorDataGapFromRow(row: SensorDataGapRow): SensorDataGapRecord {
  return {
    id: row.id,
    sensorId: row.sensor_id,
    metric: row.metric,
    source: row.source,
    startedAt: row.started_at,
    detectedAt: row.detected_at,
    endedAt: row.ended_at,
    recoveryState: row.recovery_state,
    recoverableUntil: row.recoverable_until,
    recoveryCompleteness: row.recovery_completeness,
    recoveredPoints: row.recovered_points,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    recoveryError: row.recovery_error,
  };
}

export function tapoHistoryExportJobFromRow(row: TapoHistoryExportJobRow): TapoHistoryExportJob {
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

export function tapoHistoryExportStagedSampleFromRow(
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
