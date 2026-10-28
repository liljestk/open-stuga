import { bodyObject, enumValue, requiredString, rejectUnknownFields } from "../../request-fields.js";
import { OBSERVATION_CONFIDENCES, OBSERVATION_KINDS, OBSERVATION_SEVERITIES, OBSERVATION_SOURCES, OBSERVATION_STATUSES, OBSERVATION_TIME_PRECISIONS, MAX_OBSERVATION_RESOLUTION_NOTE_LENGTH, type ManualObservationInput, type ManualObservationPatch } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";

export const OBSERVATION_CREATE_FIELDS = new Set([
  "id", "houseId", "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt",
  "timePrecision", "validFrom", "validTo", "source", "sourceDetail", "confidence",
]);

export const OBSERVATION_PATCH_FIELDS = new Set([
  "baseRevision", "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt",
  "timePrecision", "validFrom", "validTo", "source", "sourceDetail", "confidence", "status", "resolutionNote",
]);

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
