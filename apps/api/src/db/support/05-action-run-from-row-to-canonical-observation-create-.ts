import type {
  ActionRun,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  ObservationChangedField,
  ObservationRevision,
  ObservationTimePrecision,
} from "@climate-twin/contracts";
import { ActionRunRow, MaintenanceTaskRevisionRow, MaintenanceTaskRow, ObservationRevisionRow, ObservationRow, StoredObservation } from "./02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError, parseJson } from "./03-sensor-data-gap-row-to-canonical-json-value.js";

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

export function canonicalMaintenanceObservationIds(observationIds: readonly string[]): string[] {
  return [...new Set(observationIds)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
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

export interface CanonicalObservationTime {
  occurredAt: string;
  timePrecision: ObservationTimePrecision;
  validFrom: string | null;
  validTo: string | null;
}

export interface CanonicalObservationLifecycle {
  status: NonNullable<ManualObservation["status"]>;
  resolutionNote: string | null;
  resolvedAt: string | null;
}

export function invalidObservationResolution(message: string): never {
  throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_RESOLUTION", message);
}

export function canonicalObservationPatchLifecycle(
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

export const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type MaintenanceLifecycle = Pick<MaintenanceTask,
  "status" | "completionNote" | "completedAt" | "verificationNote" | "verifiedAt"
>;

export function invalidMaintenanceLifecycle(message: string): never {
  throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_LIFECYCLE", message);
}

export function canonicalMaintenanceLifecycle(
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

export function maintenanceDate(value: string | null, field: "plannedFor" | "dueBy"): string | null {
  if (value === null) return null;
  const epoch = ISO_DATE_ONLY.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw new ClimateDataValidationError(422, "INVALID_MAINTENANCE_DATE", `${field} must be a valid YYYY-MM-DD date or null`);
  }
  return value;
}

export function observationInstant(value: string | undefined, field: string): string {
  if (!value || !RFC3339_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", `${field} must be an RFC3339 date-time`);
  }
  return new Date(value).toISOString();
}

export function observationDate(value: string | null | undefined, field: string): string {
  const epoch = value && ISO_DATE_ONLY.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : Number.NaN;
  if (!value || !Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", `${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

export function rejectObservationRange(value: string | null | undefined, field: string, precision: ObservationTimePrecision): void {
  if (value !== undefined && value !== null) {
    throw new ClimateDataValidationError(422, "INVALID_OBSERVATION_TIME", `${field} is not valid when timePrecision is ${precision}`);
  }
}

export function canonicalObservationCreateTime(input: ManualObservationInput, recordedAt: string): CanonicalObservationTime {
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
