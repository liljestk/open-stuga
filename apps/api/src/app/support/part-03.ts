import { MAINTENANCE_TASK_BASES, MAINTENANCE_TASK_PRIORITIES, MAINTENANCE_TASK_STATUSES, OBSERVATION_CONFIDENCES, OBSERVATION_KINDS, OBSERVATION_SEVERITIES, OBSERVATION_SOURCES, OBSERVATION_STATUSES, OBSERVATION_TIME_PRECISIONS } from "@climate-twin/contracts";
import { MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH } from "@climate-twin/contracts";
import type {
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  ManualObservationInput,
  ManualObservationPatch,
} from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";
import { bodyObject, enumValue, requiredString } from "./part-01.js";
import { OBSERVATION_CREATE_FIELDS, OBSERVATION_PATCH_FIELDS, propertyText, rejectUnknownFields } from "./part-02.js";
import { compareCodeUnits } from "../../text-order.js";

export function optionalNullableString(
  body: Record<string, unknown>,
  key: string,
  maximumLength?: number,
): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "string"
    || !value.trim()
    || (maximumLength !== undefined && Array.from(value).length > maximumLength)
  ) {
    const bound = maximumLength === undefined ? "" : ` of at most ${maximumLength} characters`;
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty string${bound} or null`);
  }
  return value.trim();
}

export function optionalNullableNumber(body: Record<string, unknown>, key: string): number | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, "INVALID_FIELD", `${key} must be a finite number or null`);
  return value;
}

export function optionalObservationDate(body: Record<string, unknown>, key: "occurredAt" | "validFrom" | "validTo"): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "INVALID_FIELD", `${key} must be a non-empty date string or null`);
  return value.trim();
}

/**
 * Optional observation fields shared by create and patch: the sensor, plan
 * position, time (occurredAt, precision, validity range), source and
 * confidence. Each is present in the result only when present in the body.
 */
function optionalObservationFields(body: Record<string, unknown>): Partial<ManualObservationInput> {
  const occurredAt = optionalObservationDate(body, "occurredAt");
  if (occurredAt === null) throw new HttpError(400, "INVALID_FIELD", "occurredAt must be a date string when provided");
  return {
    ...(body.sensorId !== undefined ? { sensorId: optionalNullableString(body, "sensorId") ?? null } : {}),
    ...(body.x !== undefined ? { x: optionalNullableNumber(body, "x") ?? null } : {}),
    ...(body.y !== undefined ? { y: optionalNullableNumber(body, "y") ?? null } : {}),
    ...(occurredAt !== undefined ? { occurredAt } : {}),
    ...(body.timePrecision !== undefined
      ? { timePrecision: enumValue(body.timePrecision, OBSERVATION_TIME_PRECISIONS, "timePrecision") }
      : {}),
    ...(body.validFrom !== undefined ? { validFrom: optionalObservationDate(body, "validFrom") ?? null } : {}),
    ...(body.validTo !== undefined ? { validTo: optionalObservationDate(body, "validTo") ?? null } : {}),
    ...(body.source !== undefined ? { source: enumValue(body.source, OBSERVATION_SOURCES, "source") } : {}),
    ...(body.sourceDetail !== undefined ? { sourceDetail: optionalNullableString(body, "sourceDetail") ?? null } : {}),
    ...(body.confidence !== undefined
      ? { confidence: enumValue(body.confidence, OBSERVATION_CONFIDENCES, "confidence") }
      : {}),
  };
}

export function parseObservationInput(value: unknown): ManualObservationInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, OBSERVATION_CREATE_FIELDS, "Observation input");
  return {
    ...(typeof body.id === "string" ? { id: requiredString(body, "id") } : {}),
    houseId: requiredString(body, "houseId"),
    floorId: requiredString(body, "floorId"),
    kind: enumValue(body.kind, OBSERVATION_KINDS, "kind"),
    severity: enumValue(body.severity, OBSERVATION_SEVERITIES, "severity"),
    note: requiredString(body, "note"),
    ...optionalObservationFields(body),
  };
}

export function parseObservationPatch(value: unknown): ManualObservationPatch {
  const body = bodyObject(value);
  rejectUnknownFields(body, OBSERVATION_PATCH_FIELDS, "Observation patch");
  const baseRevision = body.baseRevision;
  if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 1) {
    throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a positive integer");
  }
  if (![...OBSERVATION_PATCH_FIELDS].some((field) => field !== "baseRevision" && body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Observation patch must contain at least one mutable field");
  }
  return {
    baseRevision,
    ...(body.floorId !== undefined ? { floorId: requiredString(body, "floorId") } : {}),
    ...(body.kind !== undefined ? { kind: enumValue(body.kind, OBSERVATION_KINDS, "kind") } : {}),
    ...(body.severity !== undefined ? { severity: enumValue(body.severity, OBSERVATION_SEVERITIES, "severity") } : {}),
    ...(body.note !== undefined ? { note: requiredString(body, "note") } : {}),
    ...optionalObservationFields(body),
    ...(body.status !== undefined ? { status: enumValue(body.status, OBSERVATION_STATUSES, "status") } : {}),
    ...(body.resolutionNote !== undefined
      ? {
          resolutionNote: optionalNullableString(
            body,
            "resolutionNote",
            MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH,
          ) ?? null,
        }
      : {}),
  };
}

export const MAINTENANCE_CREATE_FIELDS = new Set([
  "id", "propertyId", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor",
  "dueBy", "observationIds",
]);

export const MAINTENANCE_PATCH_FIELDS = new Set([
  "baseRevision", "houseId", "floorId", "areaId", "equipmentId", "title", "description", "basis", "basisDetail", "priority", "plannedFor",
  "dueBy", "observationIds", "status", "completionNote", "verificationNote",
]);

export function maintenanceText(
  body: Record<string, unknown>,
  key: string,
  maximumLength = 5_000,
): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || Array.from(value).length > maximumLength) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a string of at most ${maximumLength} characters or null`);
  }
  return value.trim() || null;
}

export function maintenanceDateValue(body: Record<string, unknown>, key: "plannedFor" | "dueBy"): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "INVALID_FIELD", `${key} must be a YYYY-MM-DD string or null`);
  }
  return value.trim();
}

export function maintenanceObservationIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => (
    typeof id !== "string" || !id.trim() || Array.from(id.trim()).length > 200
  ))) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      "observationIds must contain at most 100 non-empty identifiers of at most 200 characters",
    );
  }
  return [...new Set(value.map((id) => (id as string).trim()))]
    .sort(compareCodeUnits);
}

export function maintenanceTitle(body: Record<string, unknown>): string {
  const title = requiredString(body, "title");
  if (Array.from(title).length > 200) {
    throw new HttpError(400, "INVALID_FIELD", "title must be at most 200 characters");
  }
  return title;
}

export function parseMaintenanceTaskInput(value: unknown): MaintenanceTaskInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, MAINTENANCE_CREATE_FIELDS, "Maintenance task input");
  const propertyId = body.propertyId === undefined ? undefined : propertyText(body, "propertyId", 200) as string;
  const houseId = body.houseId === undefined ? undefined : optionalNullableString(body, "houseId", 200) ?? null;
  if (!propertyId && !houseId) {
    throw new HttpError(400, "INVALID_FIELD", "propertyId or houseId is required");
  }
  const common = {
    ...(body.id !== undefined ? { id: requiredString(body, "id") } : {}),
    ...(body.floorId !== undefined ? { floorId: optionalNullableString(body, "floorId", 200) ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: optionalNullableString(body, "areaId", 200) ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: optionalNullableString(body, "equipmentId", 200) ?? null } : {}),
    title: maintenanceTitle(body),
    ...(body.description !== undefined ? { description: maintenanceText(body, "description") ?? null } : {}),
    basis: enumValue(body.basis, MAINTENANCE_TASK_BASES, "basis"),
    ...(body.basisDetail !== undefined ? { basisDetail: maintenanceText(body, "basisDetail") ?? null } : {}),
    ...(body.priority !== undefined ? { priority: enumValue(body.priority, MAINTENANCE_TASK_PRIORITIES, "priority") } : {}),
    ...(body.plannedFor !== undefined ? { plannedFor: maintenanceDateValue(body, "plannedFor") ?? null } : {}),
    ...(body.dueBy !== undefined ? { dueBy: maintenanceDateValue(body, "dueBy") ?? null } : {}),
    ...(body.observationIds !== undefined ? { observationIds: maintenanceObservationIds(body.observationIds) } : {}),
  };
  return propertyId
    ? { ...common, propertyId, ...(houseId !== undefined ? { houseId } : {}) }
    : { ...common, houseId: houseId! };
}

export function parseMaintenanceTaskPatch(value: unknown): MaintenanceTaskPatch {
  const body = bodyObject(value);
  rejectUnknownFields(body, MAINTENANCE_PATCH_FIELDS, "Maintenance task patch");
  const baseRevision = body.baseRevision;
  if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 1) {
    throw new HttpError(400, "INVALID_FIELD", "baseRevision must be a positive integer");
  }
  if (![...MAINTENANCE_PATCH_FIELDS].some((field) => field !== "baseRevision" && body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Maintenance task patch must contain at least one mutable field");
  }
  return {
    baseRevision,
    ...(body.houseId !== undefined ? { houseId: optionalNullableString(body, "houseId", 200) ?? null } : {}),
    ...(body.floorId !== undefined ? { floorId: optionalNullableString(body, "floorId", 200) ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: optionalNullableString(body, "areaId", 200) ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: optionalNullableString(body, "equipmentId", 200) ?? null } : {}),
    ...(body.title !== undefined ? { title: maintenanceTitle(body) } : {}),
    ...(body.description !== undefined ? { description: maintenanceText(body, "description") ?? null } : {}),
    ...(body.basis !== undefined ? { basis: enumValue(body.basis, MAINTENANCE_TASK_BASES, "basis") } : {}),
    ...(body.basisDetail !== undefined ? { basisDetail: maintenanceText(body, "basisDetail") ?? null } : {}),
    ...(body.priority !== undefined ? { priority: enumValue(body.priority, MAINTENANCE_TASK_PRIORITIES, "priority") } : {}),
    ...(body.plannedFor !== undefined ? { plannedFor: maintenanceDateValue(body, "plannedFor") ?? null } : {}),
    ...(body.dueBy !== undefined ? { dueBy: maintenanceDateValue(body, "dueBy") ?? null } : {}),
    ...(body.observationIds !== undefined ? { observationIds: maintenanceObservationIds(body.observationIds) } : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, MAINTENANCE_TASK_STATUSES, "status") } : {}),
    ...(body.completionNote !== undefined ? { completionNote: maintenanceText(body, "completionNote") ?? null } : {}),
    ...(body.verificationNote !== undefined ? { verificationNote: maintenanceText(body, "verificationNote") ?? null } : {}),
  };
}

export function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return [];
}

export function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function boundedQueryInteger(value: unknown, field: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be an integer from ${min} to ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function collectionPage(query: Record<string, unknown>): { limit: number; offset: number } {
  return {
    limit: boundedQueryInteger(query.limit, "limit", 1, 500) ?? 500,
    offset: boundedQueryInteger(query.offset, "offset", 0, 1_000_000) ?? 0,
  };
}
