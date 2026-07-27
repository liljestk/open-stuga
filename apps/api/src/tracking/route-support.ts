import type { Request, Response } from "express";
import type {
  EquipmentBorrowInput,
  EquipmentManualLocationInput,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocationInput,
  TrackingCompatibilityAssessmentInput,
  TrackingEndpointEnrollmentInput,
  TrackingObserverPatch,
  TrackingObserverRegisterInput,
  TrackingPropertySettings,
} from "@climate-twin/contracts";
import { TrackingError, type AuthenticatedTrackingObserver } from "./store.js";
import { TrackingService, type TrackingIngestionActor } from "./service.js";

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
    throw new TrackingError(400, "UNKNOWN_FIELD", `${label} contains unknown fields: ${unknown.join(", ")}`);
  }
}

export function requiredString(body: Record<string, unknown>, field: string, maximum = 200): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must contain between 1 and ${maximum} characters`);
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
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be null or a string of at most ${maximum} characters`);
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
  if (typeof value !== "boolean") throw new TrackingError(400, "INVALID_FIELD", `${field} must be a boolean`);
  return value;
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
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
    if (!key || key.length > 100
      || (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")
      || (typeof item === "number" && !Number.isFinite(item))
      || (typeof item === "string" && item.length > 1_000)) {
      throw new TrackingError(400, "INVALID_FIELD", `${field} contains an invalid entry`);
    }
    output[key] = item as string | number | boolean | null;
  }
  return output;
}

export function endpointEnrollmentInput(value: unknown): TrackingEndpointEnrollmentInput {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "propertyId", "profileId", "profileVersion", "identityFields", "observerScopeId",
    "displayName", "manufacturer", "model", "firmwareVersion", "proof",
  ], "Endpoint enrollment");
  const identity = bodyObject(body.identityFields, "identityFields");
  const identityFields: Record<string, string> = {};
  if (Object.keys(identity).length > 20) {
    throw new TrackingError(400, "INVALID_FIELD", "identityFields may contain at most 20 fields");
  }
  for (const [key, item] of Object.entries(identity)) {
    if (!key || key.length > 100 || typeof item !== "string" || !item.trim() || item.length > 512) {
      throw new TrackingError(400, "INVALID_FIELD", "identityFields contains an invalid field");
    }
    identityFields[key] = item.trim();
  }
  const proof = bodyObject(body.proof, "proof");
  rejectUnknown(proof, ["kind", "challengeId", "response", "attestation"], "Endpoint proof");
  const kind = enumValue(proof.kind, [
    "PHYSICAL_ACCESS", "GATT_CHALLENGE", "VENDOR_ATTESTATION",
    "CRYPTOGRAPHIC_CHALLENGE", "EXTERNAL_ACCOUNT",
  ] as const, "proof.kind");
  return {
    propertyId: requiredString(body, "propertyId"),
    profileId: requiredString(body, "profileId"),
    profileVersion: requiredString(body, "profileVersion"),
    identityFields,
    ...(body.observerScopeId === undefined ? {} : { observerScopeId: requiredString(body, "observerScopeId") }),
    displayName: requiredString(body, "displayName"),
    ...(body.manufacturer === undefined ? {} : { manufacturer: optionalString(body, "manufacturer")! }),
    ...(body.model === undefined ? {} : { model: optionalString(body, "model")! }),
    ...(body.firmwareVersion === undefined ? {} : { firmwareVersion: optionalString(body, "firmwareVersion")! }),
    proof: {
      kind,
      ...(proof.challengeId === undefined ? {} : { challengeId: requiredString(proof, "challengeId", 500) }),
      ...(proof.response === undefined ? {} : { response: requiredString(proof, "response", 2_000) }),
      ...(proof.attestation === undefined ? {} : { attestation: requiredString(proof, "attestation", 10_000) }),
    },
  };
}

export function compatibilityInput(value: unknown): TrackingCompatibilityAssessmentInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["profileId", "profileVersion", "platform", "scanContext", "osVersion"], "Assessment");
  return {
    profileId: requiredString(body, "profileId"),
    profileVersion: requiredString(body, "profileVersion"),
    platform: enumValue(body.platform, ["ios", "android", "gateway", "web"] as const, "platform"),
    scanContext: enumValue(body.scanContext, [
      "foreground", "background", "foreground-find", "fixed-gateway", "dedicated-android-gateway",
    ] as const, "scanContext"),
    ...(body.osVersion === undefined ? {} : { osVersion: requiredString(body, "osVersion", 50) }),
  };
}

export function observerInput(value: unknown): TrackingObserverRegisterInput {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "propertyId", "type", "name", "trustLevel", "fixedPosition",
    "fixedPositionAccuracyMeters", "zoneId", "appInstallationId", "hardwareMetadata",
  ], "Observer input");
  const trustLevel = optionalNumber(body, "trustLevel");
  const accuracy = optionalNumber(body, "fixedPositionAccuracyMeters");
  const hardwareMetadata = metadata(body.hardwareMetadata, "hardwareMetadata");
  return {
    propertyId: requiredString(body, "propertyId"),
    type: enumValue(body.type, OBSERVER_TYPES, "type"),
    name: requiredString(body, "name"),
    ...(trustLevel === undefined ? {} : { trustLevel }),
    ...(body.fixedPosition === undefined ? {} : { fixedPosition: coordinate(body.fixedPosition, "fixedPosition") }),
    ...(accuracy === undefined ? {} : { fixedPositionAccuracyMeters: accuracy }),
    ...(body.zoneId === undefined ? {} : { zoneId: requiredString(body, "zoneId") }),
    ...(body.appInstallationId === undefined ? {} : { appInstallationId: requiredString(body, "appInstallationId") }),
    ...(hardwareMetadata ? { hardwareMetadata } : {}),
  };
}

export function observerPatch(value: unknown): TrackingObserverPatch {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "name", "trustLevel", "fixedPosition", "fixedPositionAccuracyMeters",
    "zoneId", "hardwareMetadata", "status",
  ], "Observer patch");
  if (Object.keys(body).length === 0) throw new TrackingError(400, "INVALID_FIELD", "Observer patch is empty");
  const trustLevel = optionalNumber(body, "trustLevel");
  const accuracy = body.fixedPositionAccuracyMeters === null
    ? null
    : optionalNumber(body, "fixedPositionAccuracyMeters");
  const hardwareMetadata = metadata(body.hardwareMetadata, "hardwareMetadata");
  return {
    ...(body.name === undefined ? {} : { name: requiredString(body, "name") }),
    ...(trustLevel === undefined ? {} : { trustLevel }),
    ...(body.fixedPosition === undefined
      ? {}
      : { fixedPosition: body.fixedPosition === null ? null : coordinate(body.fixedPosition, "fixedPosition") }),
    ...(accuracy === undefined ? {} : { fixedPositionAccuracyMeters: accuracy }),
    ...(body.zoneId === undefined ? {} : { zoneId: nullableString(body, "zoneId") ?? null }),
    ...(hardwareMetadata ? { hardwareMetadata } : {}),
    ...(body.status === undefined ? {} : { status: enumValue(body.status, OBSERVER_STATUSES, "status") }),
  };
}

export function settingsPatch(
  value: unknown,
): Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">> {
  const body = bodyObject(value);
  const fields = [
    "enabled", "propertyBoundary", "liveNearbySeconds", "recentlySeenSeconds", "staleSeconds",
    "unknownSeconds", "movementThresholdMeters", "movementMaximumIntervalSeconds",
    "minimumMovementConfidence", "exitAlertDebounceSeconds", "observationRetentionDays",
    "rollupRetentionDays", "estimateRetentionDays",
  ] as const;
  rejectUnknown(body, fields, "Tracking settings");
  if (Object.keys(body).length === 0) throw new TrackingError(400, "INVALID_FIELD", "Tracking settings patch is empty");
  const output: Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">> = {};
  if (body.enabled !== undefined) output.enabled = optionalBoolean(body, "enabled")!;
  if (body.propertyBoundary !== undefined) {
    if (!Array.isArray(body.propertyBoundary)) {
      throw new TrackingError(400, "INVALID_FIELD", "propertyBoundary must be an array");
    }
    output.propertyBoundary = body.propertyBoundary.map((point, index) => coordinate(point, `propertyBoundary[${index}]`));
  }
  for (const field of fields) {
    if (field === "enabled" || field === "propertyBoundary" || body[field] === undefined) continue;
    Object.assign(output, { [field]: optionalNumber(body, field)! });
  }
  return output;
}

export function manualLocationInput(value: unknown): EquipmentManualLocationInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["dataMode", "coordinate", "zoneId", "uncertaintyRadiusMeters", "observedAt"], "Manual location");
  return {
    dataMode: enumValue(body.dataMode, ["live", "demo"] as const, "dataMode"),
    ...(body.coordinate === undefined ? {} : { coordinate: coordinate(body.coordinate, "coordinate") }),
    ...(body.zoneId === undefined ? {} : { zoneId: requiredString(body, "zoneId") }),
    ...(body.uncertaintyRadiusMeters === undefined
      ? {}
      : { uncertaintyRadiusMeters: optionalNumber(body, "uncertaintyRadiusMeters")! }),
    observedAt: requiredString(body, "observedAt", 100),
  };
}

export function equipmentBorrowInput(value: unknown): EquipmentBorrowInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["expectedReturnAt", "note"], "Equipment borrowing");
  return {
    ...(body.expectedReturnAt === undefined
      ? {}
      : { expectedReturnAt: nullableString(body, "expectedReturnAt", 100) ?? null }),
    ...(body.note === undefined ? {} : { note: nullableString(body, "note", 1_000) ?? null }),
  };
}

export function equipmentReturnInput(value: unknown): EquipmentReturnInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["note"], "Equipment return");
  return { ...(body.note === undefined ? {} : { note: nullableString(body, "note", 1_000) ?? null }) };
}

export function memberLocationInput(value: unknown): PropertyMemberLocationInput {
  const body = bodyObject(value);
  rejectUnknown(body, [
    "coordinate", "horizontalAccuracyMeters", "reducedAccuracy", "capturedAt", "sharingUntil",
  ], "Member location");
  const accuracy = optionalNumber(body, "horizontalAccuracyMeters");
  if (accuracy === undefined) throw new TrackingError(400, "INVALID_FIELD", "horizontalAccuracyMeters is required");
  return {
    coordinate: coordinate(body.coordinate, "coordinate"),
    horizontalAccuracyMeters: accuracy,
    reducedAccuracy: optionalBoolean(body, "reducedAccuracy") ?? false,
    capturedAt: requiredString(body, "capturedAt", 100),
    sharingUntil: requiredString(body, "sharingUntil", 100),
  };
}

export function requireMember(options: TrackingRouteOptions, response: Response): TrackingRoutePrincipal {
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

export function requireProperty(options: TrackingRouteOptions, response: Response, propertyId: string): void {
  if (!options.authorizeProperty(response, propertyId) || !options.service.store.core.getProperty(propertyId)) {
    throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
  }
}

export function requireEquipment(options: TrackingRouteOptions, response: Response, equipmentId: string): void {
  if (!options.authorizeEquipment(response, equipmentId)
    || !options.service.store.core.getAreaEquipment(equipmentId)) {
    throw new TrackingError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found");
  }
}

export function requireEndpoint(options: TrackingRouteOptions, response: Response, endpointId: string) {
  const endpoint = options.service.store.getEndpoint(endpointId);
  if (!endpoint || !options.authorizeProperty(response, endpoint.propertyId)) {
    throw new TrackingError(404, "TRACKING_ENDPOINT_NOT_FOUND", "Tracking endpoint not found");
  }
  return endpoint;
}

export function machineIdentity(
  options: TrackingRouteOptions,
  response: Response,
  observerId: string,
): AuthenticatedTrackingObserver {
  const identity = options.machineObserver(response);
  if (!identity || identity.observer.id !== observerId) {
    throw new TrackingError(401, "UNAUTHORIZED", "A valid observer credential is required");
  }
  return identity;
}

export function ingestionActor(options: TrackingRouteOptions, response: Response): TrackingIngestionActor {
  const machineObserver = options.machineObserver(response);
  const principal = options.principal(response);
  return {
    machineObserver,
    userId: principal?.userId ?? null,
    administrator: principal?.role === "owner" || principal?.role === "admin",
    canWriteProperty: (propertyId) => Boolean(
      principal && principal.role !== "guest" && options.authorizeProperty(response, propertyId)
    ),
  };
}

export function numericLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TrackingError(400, "INVALID_FIELD", `limit must be an integer from 1 to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `limit must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}
