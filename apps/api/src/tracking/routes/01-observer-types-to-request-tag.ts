import type { Application, Request, Response } from "express";
import type {
  EquipmentBorrowInput,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocationInput,
  TrackingEvent,
  TrackingObserverPatch,
  TrackingObserverRegisterInput,
  TrackingPropertySettings,
  TrackingTagCapabilities,
  TrackingTagCreateInput,
} from "@climate-twin/contracts";
import { TrackingService, type TrackingIngestionActor } from "../service.js";
import {
  TrackingError,
  type AuthenticatedTrackingObserver,
} from "../store.js";

export const OBSERVER_TYPES = [
  "esp32-gateway",
  "linux-gateway",
  "android-gateway",
  "android-phone",
  "ios-phone",
] as const;

export const OBSERVER_STATUSES = ["online", "offline", "degraded", "disabled"] as const;

export interface TrackingRoutePrincipal {
  userId: string;
  label: string;
  role: "owner" | "admin" | "member" | "guest" | "service";
}

export interface TrackingRouteOptions {
  service: TrackingService;
  prefix?: string;
  principal: (response: Response) => TrackingRoutePrincipal | null;
  machineObserver: (response: Response) => AuthenticatedTrackingObserver | null;
  authorizeProperty: (response: Response, propertyId: string) => boolean;
  authorizeEquipment: (response: Response, equipmentId: string) => boolean;
  assertPropertyWriteAllowed: (propertyId: string) => void;
  streamAuthorizationFingerprint?: (request: Request, response: Response) => string | null;
  /** Return false after sending a terminal response. */
  validateStream?: (request: Request, response: Response) => boolean;
  acquireStream?: (request: Request, response: Response) => (() => void) | null;
  registerStream?: (
    request: Request,
    response: Response,
    dispose: () => void,
    release: () => void,
  ) => void;
}

export function bodyObject(value: unknown, label = "Request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrackingError(400, "INVALID_BODY", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(
  body: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const allowed = new Set(fields);
  const unknown = Object.keys(body).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new TrackingError(
      400,
      "UNKNOWN_FIELD",
      `${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

export function requiredString(body: Record<string, unknown>, field: string, maximum = 200): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new TrackingError(
      400,
      "INVALID_FIELD",
      `${field} must contain between 1 and ${maximum} characters`,
    );
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  maximum = 200,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be a string of at most ${maximum} characters`);
  }
  return value;
}

export function nullableString(
  body: Record<string, unknown>,
  field: string,
  maximum = 200,
): string | null | undefined {
  const value = body[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > maximum) {
    throw new TrackingError(
      400,
      "INVALID_FIELD",
      `${field} must be null or a string of at most ${maximum} characters`,
    );
  }
  return value;
}

export function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be a finite number`);
  }
  return value;
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be a boolean`);
  }
  return value;
}

export function coordinate(value: unknown, field: string): GeoCoordinate {
  const body = bodyObject(value, field);
  rejectUnknown(body, ["latitude", "longitude"], field);
  const latitude = body.latitude;
  const longitude = body.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must contain a valid WGS84 coordinate`);
  }
  return { latitude, longitude };
}

export function metadata(
  value: unknown,
  field: string,
): Record<string, string | number | boolean | null> | undefined {
  if (value === undefined) return undefined;
  const body = bodyObject(value, field);
  if (Object.keys(body).length > 50) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} may contain at most 50 entries`);
  }
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(body)) {
    if (key.length > 100
      || (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")
      || (typeof item === "number" && !Number.isFinite(item))
      || (typeof item === "string" && item.length > 1_000)) {
      throw new TrackingError(400, "INVALID_FIELD", `${field} contains an invalid entry`);
    }
    output[key] = item as string | number | boolean | null;
  }
  return output;
}

export function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function tagCapabilities(value: unknown): Partial<TrackingTagCapabilities> | undefined {
  if (value === undefined) return undefined;
  const body = bodyObject(value, "capabilities");
  const fields = ["motion", "battery", "buzzer", "button", "tamper", "connectable"] as const;
  rejectUnknown(body, fields, "Tag capabilities");
  const output: Partial<TrackingTagCapabilities> = {};
  for (const field of fields) {
    const parsed = optionalBoolean(body, field);
    if (parsed !== undefined) output[field] = parsed;
  }
  return output;
}

export function tagInput(value: unknown): TrackingTagCreateInput {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "propertyId",
    "serialNumber",
    "hardwareModel",
    "firmwareVersion",
    "protocolVersion",
    "rotationWindowMinutes",
    "batteryType",
    "capabilities",
  ], "Tag input");
  const protocolVersion = optionalNumber(body, "protocolVersion");
  const rotationWindowMinutes = optionalNumber(body, "rotationWindowMinutes");
  return {
    propertyId: requiredString(body, "propertyId"),
    serialNumber: requiredString(body, "serialNumber"),
    hardwareModel: requiredString(body, "hardwareModel"),
    ...(body.firmwareVersion !== undefined
      ? { firmwareVersion: optionalString(body, "firmwareVersion")! }
      : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(rotationWindowMinutes !== undefined ? { rotationWindowMinutes } : {}),
    ...(body.batteryType !== undefined ? { batteryType: optionalString(body, "batteryType")! } : {}),
    ...(body.capabilities !== undefined ? { capabilities: tagCapabilities(body.capabilities)! } : {}),
  };
}

export function observerInput(value: unknown): TrackingObserverRegisterInput {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "propertyId",
    "type",
    "name",
    "trustLevel",
    "fixedPosition",
    "fixedPositionAccuracyMeters",
    "zoneId",
    "appInstallationId",
    "hardwareMetadata",
  ], "Observer input");
  const trustLevel = optionalNumber(body, "trustLevel");
  const accuracy = optionalNumber(body, "fixedPositionAccuracyMeters");
  const fixedPosition = body.fixedPosition === undefined ? undefined : coordinate(body.fixedPosition, "fixedPosition");
  const hardwareMetadata = metadata(body.hardwareMetadata, "hardwareMetadata");
  return {
    propertyId: requiredString(body, "propertyId"),
    type: enumValue(body.type, OBSERVER_TYPES, "type"),
    name: requiredString(body, "name"),
    ...(trustLevel !== undefined ? { trustLevel } : {}),
    ...(fixedPosition ? { fixedPosition } : {}),
    ...(accuracy !== undefined ? { fixedPositionAccuracyMeters: accuracy } : {}),
    ...(body.zoneId !== undefined ? { zoneId: requiredString(body, "zoneId") } : {}),
    ...(body.appInstallationId !== undefined
      ? { appInstallationId: requiredString(body, "appInstallationId") }
      : {}),
    ...(hardwareMetadata ? { hardwareMetadata } : {}),
  };
}

export function observerPatch(value: unknown): TrackingObserverPatch {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "name",
    "trustLevel",
    "fixedPosition",
    "fixedPositionAccuracyMeters",
    "zoneId",
    "hardwareMetadata",
    "status",
  ], "Observer patch");
  if (Object.keys(body).length === 0) {
    throw new TrackingError(400, "INVALID_FIELD", "Observer patch must contain at least one field");
  }
  const trustLevel = optionalNumber(body, "trustLevel");
  const accuracy = body.fixedPositionAccuracyMeters === null
    ? null
    : optionalNumber(body, "fixedPositionAccuracyMeters");
  const hardwareMetadata = metadata(body.hardwareMetadata, "hardwareMetadata");
  return {
    ...(body.name !== undefined ? { name: requiredString(body, "name") } : {}),
    ...(trustLevel !== undefined ? { trustLevel } : {}),
    ...(body.fixedPosition !== undefined
      ? { fixedPosition: body.fixedPosition === null ? null : coordinate(body.fixedPosition, "fixedPosition") }
      : {}),
    ...(accuracy !== undefined ? { fixedPositionAccuracyMeters: accuracy } : {}),
    ...(body.zoneId !== undefined ? { zoneId: nullableString(body, "zoneId") ?? null } : {}),
    ...(hardwareMetadata ? { hardwareMetadata } : {}),
    ...(body.status !== undefined ? { status: enumValue(body.status, OBSERVER_STATUSES, "status") } : {}),
  };
}

export function settingsPatch(value: unknown): Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">> {
  const body = bodyObject(value);
  const fields = [
    "enabled",
    "propertyBoundary",
    "liveNearbySeconds",
    "recentlySeenSeconds",
    "staleSeconds",
    "unknownSeconds",
    "movementThresholdMeters",
    "movementMaximumIntervalSeconds",
    "minimumMovementConfidence",
    "exitAlertDebounceSeconds",
  ] as const;
  rejectUnknown(body, fields, "Tracking settings");
  if (Object.keys(body).length === 0) {
    throw new TrackingError(400, "INVALID_FIELD", "Tracking settings patch must contain at least one field");
  }
  const output: Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">> = {};
  if (body.enabled !== undefined) output.enabled = optionalBoolean(body, "enabled")!;
  if (body.propertyBoundary !== undefined) {
    if (!Array.isArray(body.propertyBoundary)) {
      throw new TrackingError(400, "INVALID_FIELD", "propertyBoundary must be an array");
    }
    output.propertyBoundary = body.propertyBoundary.map((point, index) => (
      coordinate(point, `propertyBoundary[${index}]`)
    ));
  }
  for (const field of fields) {
    if (field === "enabled" || field === "propertyBoundary" || body[field] === undefined) continue;
    Object.assign(output, { [field]: optionalNumber(body, field)! });
  }
  return output;
}

export function equipmentBorrowInput(value: unknown): EquipmentBorrowInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["expectedReturnAt", "note"], "Equipment borrowing");
  return {
    ...(body.expectedReturnAt !== undefined
      ? { expectedReturnAt: nullableString(body, "expectedReturnAt", 100) ?? null }
      : {}),
    ...(body.note !== undefined ? { note: nullableString(body, "note", 1_000) ?? null } : {}),
  };
}

export function equipmentReturnInput(value: unknown): EquipmentReturnInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["note"], "Equipment return");
  return {
    ...(body.note !== undefined ? { note: nullableString(body, "note", 1_000) ?? null } : {}),
  };
}

export function memberLocationInput(value: unknown): PropertyMemberLocationInput {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "coordinate",
    "horizontalAccuracyMeters",
    "reducedAccuracy",
    "capturedAt",
    "sharingUntil",
  ], "Member location");
  const horizontalAccuracyMeters = optionalNumber(body, "horizontalAccuracyMeters");
  if (horizontalAccuracyMeters === undefined) {
    throw new TrackingError(400, "INVALID_FIELD", "horizontalAccuracyMeters is required");
  }
  return {
    coordinate: coordinate(body.coordinate, "coordinate"),
    horizontalAccuracyMeters,
    reducedAccuracy: optionalBoolean(body, "reducedAccuracy") ?? false,
    capturedAt: requiredString(body, "capturedAt", 100),
    sharingUntil: requiredString(body, "sharingUntil", 100),
  };
}

export function requireMember(
  options: TrackingRouteOptions,
  response: Response,
): TrackingRoutePrincipal {
  const principal = options.principal(response);
  if (!principal || principal.role === "guest" || principal.role === "service") {
    throw new TrackingError(403, "FORBIDDEN", "A Property member is required");
  }
  return principal;
}

export function requireAdministrator(options: TrackingRouteOptions, response: Response): TrackingRoutePrincipal {
  const principal = options.principal(response);
  if (!principal || (principal.role !== "owner" && principal.role !== "admin")) {
    throw new TrackingError(403, "FORBIDDEN", "Tracking administration requires an Owner or Admin account");
  }
  return principal;
}

export function requireProperty(
  options: TrackingRouteOptions,
  response: Response,
  propertyId: string,
): void {
  if (!options.authorizeProperty(response, propertyId)
    || !options.service.store.core.getProperty(propertyId)) {
    throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
  }
}

export function requireEquipment(
  options: TrackingRouteOptions,
  response: Response,
  equipmentId: string,
): void {
  if (!options.authorizeEquipment(response, equipmentId)
    || !options.service.store.core.getAreaEquipment(equipmentId)) {
    throw new TrackingError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found");
  }
}

export function requestTag(options: TrackingRouteOptions, response: Response, tagId: string) {
  const tag = options.service.store.getTag(tagId);
  if (!tag || !options.authorizeProperty(response, tag.propertyId)) {
    throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
  }
  return tag;
}
