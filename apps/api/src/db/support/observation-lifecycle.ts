import type { MaintenanceTask, MaintenanceTaskPatch, ManualObservation, ManualObservationInput, ManualObservationPatch, ObservationTimePrecision } from "@climate-twin/contracts";
import { compareCodeUnits } from "../../text-order.js";
import { ClimateDataValidationError } from "./validation-errors.js";
import type { StoredObservation } from "./record-types.js";

export function canonicalMaintenanceObservationIds(observationIds: readonly string[]): string[] {
  return [...new Set(observationIds)].sort(compareCodeUnits);
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
