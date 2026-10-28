import { bodyObject, enumValue, nullableString, optionalBoolean, optionalNumber, optionalString, rejectUnknownFields, requiredString } from "../request-fields.js";
import { roleIsWorkspacePerson, roleCanManageWorkspace, roleCanAccessNonGuestConfiguration, type TenantMemberRole } from "@climate-twin/contracts";
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
  role: TenantMemberRole;
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

export function coordinate(value: unknown, field: string): GeoCoordinate {
  const body = bodyObject(value, field);
  rejectUnknownFields(body, ["latitude", "longitude"], field);
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
  rejectUnknownFields(body, [
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
  rejectUnknownFields(proof, ["kind", "challengeId", "response", "attestation"], "Endpoint proof");
  const kind = enumValue(proof.kind, [
    "PHYSICAL_ACCESS", "GATT_CHALLENGE", "VENDOR_ATTESTATION",
    "CRYPTOGRAPHIC_CHALLENGE", "EXTERNAL_ACCOUNT",
  ] as const, "proof.kind");
  return {
    propertyId: requiredString(body, "propertyId", 200),
    profileId: requiredString(body, "profileId", 200),
    profileVersion: requiredString(body, "profileVersion", 200),
    identityFields,
    ...(body.observerScopeId === undefined ? {} : { observerScopeId: requiredString(body, "observerScopeId", 200) }),
    displayName: requiredString(body, "displayName", 200),
    ...(body.manufacturer === undefined ? {} : { manufacturer: optionalString(body, "manufacturer", 200)! }),
    ...(body.model === undefined ? {} : { model: optionalString(body, "model", 200)! }),
    ...(body.firmwareVersion === undefined ? {} : { firmwareVersion: optionalString(body, "firmwareVersion", 200)! }),
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
  rejectUnknownFields(body, ["profileId", "profileVersion", "platform", "scanContext", "osVersion"], "Assessment");
  return {
    profileId: requiredString(body, "profileId", 200),
    profileVersion: requiredString(body, "profileVersion", 200),
    platform: enumValue(body.platform, ["ios", "android", "gateway", "web"] as const, "platform"),
    scanContext: enumValue(body.scanContext, [
      "foreground", "background", "foreground-find", "fixed-gateway", "dedicated-android-gateway",
    ] as const, "scanContext"),
    ...(body.osVersion === undefined ? {} : { osVersion: requiredString(body, "osVersion", 50) }),
  };
}

export function observerInput(value: unknown): TrackingObserverRegisterInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, [
    "propertyId", "type", "name", "trustLevel", "fixedPosition",
    "fixedPositionAccuracyMeters", "zoneId", "appInstallationId", "hardwareMetadata",
  ], "Observer input");
  const trustLevel = optionalNumber(body, "trustLevel");
  const accuracy = optionalNumber(body, "fixedPositionAccuracyMeters");
  const hardwareMetadata = metadata(body.hardwareMetadata, "hardwareMetadata");
  return {
    propertyId: requiredString(body, "propertyId", 200),
    type: enumValue(body.type, OBSERVER_TYPES, "type"),
    name: requiredString(body, "name", 200),
    ...(trustLevel === undefined ? {} : { trustLevel }),
    ...(body.fixedPosition === undefined ? {} : { fixedPosition: coordinate(body.fixedPosition, "fixedPosition") }),
    ...(accuracy === undefined ? {} : { fixedPositionAccuracyMeters: accuracy }),
    ...(body.zoneId === undefined ? {} : { zoneId: requiredString(body, "zoneId", 200) }),
    ...(body.appInstallationId === undefined ? {} : { appInstallationId: requiredString(body, "appInstallationId", 200) }),
    ...(hardwareMetadata ? { hardwareMetadata } : {}),
  };
}

export function observerPatch(value: unknown): TrackingObserverPatch {
  const body = bodyObject(value);
  rejectUnknownFields(body, [
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
    ...(body.name === undefined ? {} : { name: requiredString(body, "name", 200) }),
    ...(trustLevel === undefined ? {} : { trustLevel }),
    ...(body.fixedPosition === undefined
      ? {}
      : { fixedPosition: body.fixedPosition === null ? null : coordinate(body.fixedPosition, "fixedPosition") }),
    ...(accuracy === undefined ? {} : { fixedPositionAccuracyMeters: accuracy }),
    ...(body.zoneId === undefined ? {} : { zoneId: nullableString(body, "zoneId", 200) ?? null }),
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
  rejectUnknownFields(body, fields, "Tracking settings");
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
  rejectUnknownFields(body, ["dataMode", "coordinate", "zoneId", "uncertaintyRadiusMeters", "observedAt"], "Manual location");
  return {
    dataMode: enumValue(body.dataMode, ["live", "demo"] as const, "dataMode"),
    ...(body.coordinate === undefined ? {} : { coordinate: coordinate(body.coordinate, "coordinate") }),
    ...(body.zoneId === undefined ? {} : { zoneId: requiredString(body, "zoneId", 200) }),
    ...(body.uncertaintyRadiusMeters === undefined
      ? {}
      : { uncertaintyRadiusMeters: optionalNumber(body, "uncertaintyRadiusMeters")! }),
    observedAt: requiredString(body, "observedAt", 100),
  };
}

export function equipmentBorrowInput(value: unknown): EquipmentBorrowInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, ["expectedReturnAt", "note"], "Equipment borrowing");
  return {
    ...(body.expectedReturnAt === undefined
      ? {}
      : { expectedReturnAt: nullableString(body, "expectedReturnAt", 100) ?? null }),
    ...(body.note === undefined ? {} : { note: nullableString(body, "note", 1_000) ?? null }),
  };
}

export function equipmentReturnInput(value: unknown): EquipmentReturnInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, ["note"], "Equipment return");
  return { ...(body.note === undefined ? {} : { note: nullableString(body, "note", 1_000) ?? null }) };
}

export function memberLocationInput(value: unknown): PropertyMemberLocationInput {
  const body = bodyObject(value);
  rejectUnknownFields(body, [
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
  if (!principal || !roleIsWorkspacePerson(principal.role)) {
    throw new TrackingError(403, "FORBIDDEN", "A Property member is required");
  }
  return principal;
}

export function requireAdministrator(options: TrackingRouteOptions, response: Response): TrackingRoutePrincipal {
  const principal = options.principal(response);
  if (!principal || !roleCanManageWorkspace(principal.role)) {
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
    administrator: principal !== null && roleCanManageWorkspace(principal.role),
    canWriteProperty: (propertyId) => Boolean(
      principal && roleCanAccessNonGuestConfiguration(principal.role) && options.authorizeProperty(response, propertyId)
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
