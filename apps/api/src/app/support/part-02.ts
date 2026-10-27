import type {
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachmentUploadInput,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  GeoCoordinate,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
} from "@climate-twin/contracts";
import { AREA_EQUIPMENT_STATUSES, HttpError, PROPERTY_AREA_KINDS, PROPERTY_NOTE_KINDS, bodyObject, enumValue, houseLocationValue, requiredNumber, requiredString } from "./part-01.js";

export function propertyText(
  body: Record<string, unknown>,
  key: string,
  maximumLength: number,
  nullable = false,
): string | null {
  const value = body[key];
  if (nullable && value === null) return null;
  if (typeof value !== "string" || (!nullable && !value.trim()) || Array.from(value.trim()).length > maximumLength) {
    throw new HttpError(
      400,
      "INVALID_FIELD",
      `${key} must be ${nullable ? "a string" : "a non-empty string"} of at most ${maximumLength} characters${nullable ? " or null" : ""}`,
    );
  }
  return value.trim() || null;
}

export function propertyPolygon(value: unknown): GeoCoordinate[] {
  if (!Array.isArray(value) || (value.length !== 0 && value.length < 3) || value.length > 500) {
    throw new HttpError(400, "INVALID_FIELD", "polygon must be empty for a fixed asset or contain between 3 and 500 coordinate objects");
  }
  return value.map((candidate) => {
    const point = bodyObject(candidate);
    rejectUnknownFields(point, new Set(["latitude", "longitude"]), "Area polygon coordinate");
    return { latitude: requiredNumber(point, "latitude"), longitude: requiredNumber(point, "longitude") };
  });
}

export function propertyCoordinate(value: unknown, nullable = false): GeoCoordinate | null {
  if (nullable && value === null) return null;
  const point = bodyObject(value);
  rejectUnknownFields(point, new Set(["latitude", "longitude"]), "Fixed asset coordinate");
  return { latitude: requiredNumber(point, "latitude"), longitude: requiredNumber(point, "longitude") };
}

export function parsePropertyInput(value: unknown): PropertyCreateInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set(["id", "name", "description", "location"]), "Property input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    name: propertyText(body, "name", 200) as string,
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.location !== undefined ? { location: houseLocationValue(body.location, true) } : {}),
  };
}

export function parsePropertyPatch(value: unknown): PropertyPatch {
  const body = bodyObject(value);
  const fields = new Set(["name", "description", "defaultHouseId", "location"]);
  rejectUnknownFields(body, fields, "Property patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Property patch must contain at least one mutable field");
  }
  return {
    ...(body.name !== undefined ? { name: propertyText(body, "name", 200) as string } : {}),
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.defaultHouseId !== undefined ? {
      defaultHouseId: body.defaultHouseId === null
        ? null
        : propertyText(body, "defaultHouseId", 200) as string,
    } : {}),
    ...(body.location !== undefined ? { location: houseLocationValue(body.location, true) } : {}),
  };
}

export function parsePropertyAreaInput(value: unknown): PropertyAreaInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set(["id", "propertyId", "name", "kind", "description", "location", "polygon"]), "Property area input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    propertyId: propertyText(body, "propertyId", 200) as string,
    name: propertyText(body, "name", 200) as string,
    kind: enumValue(body.kind, PROPERTY_AREA_KINDS, "kind"),
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.location !== undefined ? { location: propertyCoordinate(body.location) as GeoCoordinate } : {}),
    polygon: propertyPolygon(body.polygon),
  };
}

export function parsePropertyAreaPatch(value: unknown): PropertyAreaPatch {
  const body = bodyObject(value);
  const fields = new Set(["propertyId", "name", "kind", "description", "location", "polygon"]);
  rejectUnknownFields(body, fields, "Property area patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Property area patch must contain at least one mutable field");
  }
  return {
    ...(body.propertyId !== undefined ? { propertyId: propertyText(body, "propertyId", 200) as string } : {}),
    ...(body.name !== undefined ? { name: propertyText(body, "name", 200) as string } : {}),
    ...(body.kind !== undefined ? { kind: enumValue(body.kind, PROPERTY_AREA_KINDS, "kind") } : {}),
    ...(body.description !== undefined ? { description: propertyText(body, "description", 5_000, true) } : {}),
    ...(body.location !== undefined ? { location: propertyCoordinate(body.location, true) } : {}),
    ...(body.polygon !== undefined ? { polygon: propertyPolygon(body.polygon) } : {}),
  };
}

export function parseAreaEquipmentInput(value: unknown): AreaEquipmentInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set([
    "id", "propertyId", "areaId", "houseId", "location", "name", "kind",
    "manufacturer", "model", "serialNumber", "status", "notes",
  ]), "Area equipment input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    ...(body.propertyId !== undefined ? { propertyId: propertyText(body, "propertyId", 200) as string } : {}),
    ...(body.areaId !== undefined ? { areaId: propertyText(body, "areaId", 200, true) } : {}),
    ...(body.houseId !== undefined ? { houseId: propertyText(body, "houseId", 200, true) } : {}),
    ...(body.location !== undefined ? { location: propertyCoordinate(body.location) as GeoCoordinate } : {}),
    name: propertyText(body, "name", 200) as string,
    kind: propertyText(body, "kind", 200) as string,
    ...(body.manufacturer !== undefined ? { manufacturer: propertyText(body, "manufacturer", 200, true) } : {}),
    ...(body.model !== undefined ? { model: propertyText(body, "model", 200, true) } : {}),
    ...(body.serialNumber !== undefined ? { serialNumber: propertyText(body, "serialNumber", 200, true) } : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, AREA_EQUIPMENT_STATUSES, "status") } : {}),
    ...(body.notes !== undefined ? { notes: propertyText(body, "notes", 5_000, true) } : {}),
  };
}

export function parseAreaEquipmentPatch(value: unknown): AreaEquipmentPatch {
  const body = bodyObject(value);
  const fields = new Set([
    "areaId", "houseId", "location", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes",
  ]);
  rejectUnknownFields(body, fields, "Area equipment patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Area equipment patch must contain at least one mutable field");
  }
  return {
    ...(body.areaId !== undefined ? { areaId: propertyText(body, "areaId", 200, true) } : {}),
    ...(body.houseId !== undefined ? { houseId: propertyText(body, "houseId", 200, true) } : {}),
    ...(body.location !== undefined ? { location: propertyCoordinate(body.location, true) } : {}),
    ...(body.name !== undefined ? { name: propertyText(body, "name", 200) as string } : {}),
    ...(body.kind !== undefined ? { kind: propertyText(body, "kind", 200) as string } : {}),
    ...(body.manufacturer !== undefined ? { manufacturer: propertyText(body, "manufacturer", 200, true) } : {}),
    ...(body.model !== undefined ? { model: propertyText(body, "model", 200, true) } : {}),
    ...(body.serialNumber !== undefined ? { serialNumber: propertyText(body, "serialNumber", 200, true) } : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, AREA_EQUIPMENT_STATUSES, "status") } : {}),
    ...(body.notes !== undefined ? { notes: propertyText(body, "notes", 5_000, true) } : {}),
  };
}

export function parseEquipmentAttachmentUpload(value: unknown): EquipmentAttachmentUploadInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set(["kind", "name", "mimeType", "data"]), "Equipment attachment upload");
  return {
    kind: enumValue(body.kind, ["photo", "document"] as const, "kind"),
    name: propertyText(body, "name", 255) as string,
    mimeType: propertyText(body, "mimeType", 200)!.toLowerCase(),
    data: requiredString(body, "data"),
  };
}

export function parseEquipmentLinkInput(value: unknown): EquipmentLinkInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set(["label", "url"]), "Equipment link input");
  return {
    label: propertyText(body, "label", 200) as string,
    url: propertyText(body, "url", 2_048) as string,
  };
}

export function parseEquipmentLinkPatch(value: unknown): EquipmentLinkPatch {
  const body = bodyObject(value);
  const fields = new Set(["label", "url"]);
  rejectUnknownFields(body, fields, "Equipment link patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Equipment link patch must contain label or url");
  }
  return {
    ...(body.label !== undefined ? { label: propertyText(body, "label", 200) as string } : {}),
    ...(body.url !== undefined ? { url: propertyText(body, "url", 2_048) as string } : {}),
  };
}

export function nullablePropertyTarget(body: Record<string, unknown>, key: string): string | null | undefined {
  if (body[key] === undefined) return undefined;
  return propertyText(body, key, 200, true);
}

export function parsePropertyNoteInput(value: unknown): PropertyNoteInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, new Set([
    "id", "propertyId", "houseId", "areaId", "equipmentId", "kind", "text",
  ]), "Property note input");
  return {
    ...(body.id !== undefined ? { id: propertyText(body, "id", 200) as string } : {}),
    propertyId: propertyText(body, "propertyId", 200) as string,
    ...(body.houseId !== undefined ? { houseId: nullablePropertyTarget(body, "houseId") ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: nullablePropertyTarget(body, "areaId") ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: nullablePropertyTarget(body, "equipmentId") ?? null } : {}),
    kind: enumValue(body.kind, PROPERTY_NOTE_KINDS, "kind"),
    text: propertyText(body, "text", 5_000) as string,
  };
}

export function parsePropertyNotePatch(value: unknown): PropertyNotePatch {
  const body = bodyObject(value);
  const fields = new Set(["houseId", "areaId", "equipmentId", "kind", "text"]);
  rejectUnknownFields(body, fields, "Property note patch");
  if (![...fields].some((field) => body[field] !== undefined)) {
    throw new HttpError(400, "INVALID_FIELD", "Property note patch must contain at least one mutable field");
  }
  return {
    ...(body.houseId !== undefined ? { houseId: nullablePropertyTarget(body, "houseId") ?? null } : {}),
    ...(body.areaId !== undefined ? { areaId: nullablePropertyTarget(body, "areaId") ?? null } : {}),
    ...(body.equipmentId !== undefined ? { equipmentId: nullablePropertyTarget(body, "equipmentId") ?? null } : {}),
    ...(body.kind !== undefined ? { kind: enumValue(body.kind, PROPERTY_NOTE_KINDS, "kind") } : {}),
    ...(body.text !== undefined ? { text: propertyText(body, "text", 5_000) as string } : {}),
  };
}

export function optionalResourceQuery(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new HttpError(400, "INVALID_FIELD", `${field} must be a non-empty string of at most 200 characters`);
  }
  return value.trim();
}

export function dateValue(value: unknown, fallback: Date, field: string): string {
  if (value === undefined) return fallback.toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, "INVALID_FIELD", `${field} must be an ISO date-time`);
  return new Date(value).toISOString();
}

export const OBSERVATION_KINDS = ["leak", "condensation", "mould", "ventilation", "maintenance", "note"] as const;

export const OBSERVATION_SEVERITIES = ["info", "warning", "critical"] as const;

export const OBSERVATION_TIME_PRECISIONS = ["exact", "approximate", "date-only", "date-range", "unknown"] as const;

export const OBSERVATION_SOURCES = [
  "owner", "caretaker", "contractor", "sensor", "imported-document", "automated-analysis", "unknown",
] as const;

export const OBSERVATION_CONFIDENCES = ["confirmed", "probable", "uncertain", "awaiting-inspection"] as const;

export const OBSERVATION_STATUSES = ["open", "resolved"] as const;

export const OBSERVATION_CREATE_FIELDS = new Set([
  "id", "houseId", "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt",
  "timePrecision", "validFrom", "validTo", "source", "sourceDetail", "confidence",
]);

export const OBSERVATION_PATCH_FIELDS = new Set([
  "baseRevision", "floorId", "sensorId", "kind", "severity", "note", "x", "y", "occurredAt",
  "timePrecision", "validFrom", "validTo", "source", "sourceDetail", "confidence", "status", "resolutionNote",
]);

export function rejectUnknownFields(body: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new HttpError(400, "INVALID_FIELD", `${name} does not accept: ${unknown.join(", ")}`);
}
