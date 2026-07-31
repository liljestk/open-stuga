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
import { JsonValue } from "./01-json-value-to-area-equipment-row.js";
import { OutdoorTemperatureRow, StaticParameterRow, StoredObservation, WeatherOutageRecord, WeatherOutageRow } from "./02-equipment-attachment-row-to-sensor-data-gap-state.js";
import type { TapoHistoryExportJob, TapoHistoryExportJobRow, TapoHistoryExportJobStatus, TapoHistoryExportStagedSample, TapoHistoryExportStagedSampleRow } from "../tapo-history-export-types.js";
import { ClimateDataValidationError, SensorDataGapRecord, SensorDataGapRow, parseJson } from "./03-sensor-data-gap-row-to-canonical-json-value.js";
import { CanonicalObservationTime, observationDate, observationInstant, rejectObservationRange } from "./05-action-run-from-row-to-canonical-observation-create-.js";

export function canonicalObservationPatchTime(
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

export const TAPO_HISTORY_EXPORT_TRANSITIONS: Readonly<Record<TapoHistoryExportJobStatus, readonly TapoHistoryExportJobStatus[]>> = {
  queued: ["cancelled"],
  claimed: ["running", "waiting-email", "needs-attention", "completed", "failed", "cancelled"],
  running: ["waiting-email", "needs-attention", "completed", "failed", "cancelled"],
  "waiting-email": ["needs-attention", "completed", "failed", "cancelled"],
  "needs-attention": ["queued", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

export function normalizedTapoHistoryTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_TIMESTAMP", `${field} must be an ISO date-time`);
  }
  return new Date(parsed).toISOString();
}

export function normalizedTapoHistoryText(value: string, field: string, maximum: number): string {
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

export function normalizedSha256(value: string, field: string): string {
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
