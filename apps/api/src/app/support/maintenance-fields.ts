import { bodyObject, enumValue, presentFields, rejectUnknownFields, requiredString } from "../../request-fields.js";
import { MAINTENANCE_TASK_BASES, MAINTENANCE_TASK_PRIORITIES, MAINTENANCE_TASK_STATUSES, type MaintenanceTaskInput, type MaintenanceTaskPatch } from "@climate-twin/contracts";
import { HttpError } from "../../http-error.js";
import { compareCodeUnits } from "../../text-order.js";
import { propertyText } from "./property-fields.js";
import { optionalNullableString } from "./observation-fields.js";

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

export function maintenanceDateValue(body: Record<string, unknown>, key: string): string | null | undefined {
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

const nullableId = (body: Record<string, unknown>, key: string) => optionalNullableString(body, key, 200) ?? null;
const nullableText = (body: Record<string, unknown>, key: string) => maintenanceText(body, key) ?? null;
const nullableDate = (body: Record<string, unknown>, key: string) => maintenanceDateValue(body, key) ?? null;

/** Optional fields that a create and a patch both accept. */
const OPTIONAL_TASK_FIELDS = {
  floorId: nullableId,
  areaId: nullableId,
  equipmentId: nullableId,
  description: nullableText,
  basisDetail: nullableText,
  priority: (body: Record<string, unknown>) => enumValue(body.priority, MAINTENANCE_TASK_PRIORITIES, "priority"),
  plannedFor: nullableDate,
  dueBy: nullableDate,
  observationIds: (body: Record<string, unknown>) => maintenanceObservationIds(body.observationIds),
};

/** Fields only a patch may change; title and basis are required on create. */
const PATCH_ONLY_TASK_FIELDS = {
  houseId: nullableId,
  title: (body: Record<string, unknown>) => maintenanceTitle(body),
  basis: (body: Record<string, unknown>) => enumValue(body.basis, MAINTENANCE_TASK_BASES, "basis"),
  status: (body: Record<string, unknown>) => enumValue(body.status, MAINTENANCE_TASK_STATUSES, "status"),
  completionNote: nullableText,
  verificationNote: nullableText,
};

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
    title: maintenanceTitle(body),
    basis: enumValue(body.basis, MAINTENANCE_TASK_BASES, "basis"),
    ...presentFields(body, OPTIONAL_TASK_FIELDS),
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
  return { baseRevision, ...presentFields(body, OPTIONAL_TASK_FIELDS), ...presentFields(body, PATCH_ONLY_TASK_FIELDS) };
}
