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
import { TrackingService, type TrackingIngestionActor } from "./service.js";
import {
  TrackingError,
  type AuthenticatedTrackingObserver,
} from "./store.js";

const OBSERVER_TYPES = [
  "esp32-gateway",
  "linux-gateway",
  "android-gateway",
  "android-phone",
  "ios-phone",
] as const;
const OBSERVER_STATUSES = ["online", "offline", "degraded", "disabled"] as const;

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

function bodyObject(value: unknown, label = "Request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrackingError(400, "INVALID_BODY", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
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

function requiredString(body: Record<string, unknown>, field: string, maximum = 200): string {
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

function optionalString(
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

function nullableString(
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

function optionalNumber(body: Record<string, unknown>, field: string): number | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be a finite number`);
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be a boolean`);
  }
  return value;
}

function coordinate(value: unknown, field: string): GeoCoordinate {
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

function metadata(
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

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function tagCapabilities(value: unknown): Partial<TrackingTagCapabilities> | undefined {
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

function tagInput(value: unknown): TrackingTagCreateInput {
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

function observerInput(value: unknown): TrackingObserverRegisterInput {
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

function observerPatch(value: unknown): TrackingObserverPatch {
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

function settingsPatch(value: unknown): Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">> {
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

function equipmentBorrowInput(value: unknown): EquipmentBorrowInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["expectedReturnAt", "note"], "Equipment borrowing");
  return {
    ...(body.expectedReturnAt !== undefined
      ? { expectedReturnAt: nullableString(body, "expectedReturnAt", 100) ?? null }
      : {}),
    ...(body.note !== undefined ? { note: nullableString(body, "note", 1_000) ?? null } : {}),
  };
}

function equipmentReturnInput(value: unknown): EquipmentReturnInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["note"], "Equipment return");
  return {
    ...(body.note !== undefined ? { note: nullableString(body, "note", 1_000) ?? null } : {}),
  };
}

function memberLocationInput(value: unknown): PropertyMemberLocationInput {
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

function requireMember(
  options: TrackingRouteOptions,
  response: Response,
): TrackingRoutePrincipal {
  const principal = options.principal(response);
  if (!principal || principal.role === "guest" || principal.role === "service") {
    throw new TrackingError(403, "FORBIDDEN", "A Property member is required");
  }
  return principal;
}

function requireAdministrator(options: TrackingRouteOptions, response: Response): TrackingRoutePrincipal {
  const principal = options.principal(response);
  if (!principal || (principal.role !== "owner" && principal.role !== "admin")) {
    throw new TrackingError(403, "FORBIDDEN", "Tracking administration requires an Owner or Admin account");
  }
  return principal;
}

function requireProperty(
  options: TrackingRouteOptions,
  response: Response,
  propertyId: string,
): void {
  if (!options.authorizeProperty(response, propertyId)
    || !options.service.store.core.getProperty(propertyId)) {
    throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
  }
}

function requireEquipment(
  options: TrackingRouteOptions,
  response: Response,
  equipmentId: string,
): void {
  if (!options.authorizeEquipment(response, equipmentId)
    || !options.service.store.core.getAreaEquipment(equipmentId)) {
    throw new TrackingError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found");
  }
}

function requestTag(options: TrackingRouteOptions, response: Response, tagId: string) {
  const tag = options.service.store.getTag(tagId);
  if (!tag || !options.authorizeProperty(response, tag.propertyId)) {
    throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
  }
  return tag;
}

function machineIdentity(
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

function numericLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TrackingError(400, "INVALID_FIELD", `limit must be an integer from 1 to ${maximum}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `limit must be an integer from 1 to ${maximum}`);
  }
  return number;
}

function ingestionActor(options: TrackingRouteOptions, response: Response): TrackingIngestionActor {
  const machineObserver = options.machineObserver(response);
  const principal = options.principal(response);
  return {
    machineObserver,
    userId: principal?.userId ?? null,
    administrator: principal?.role === "owner" || principal?.role === "admin",
    canWriteProperty: (propertyId) => Boolean(
      principal
      && principal.role !== "guest"
      && options.authorizeProperty(response, propertyId),
    ),
  };
}

export function registerTrackingRoutes(app: Application, options: TrackingRouteOptions): void {
  const prefix = options.prefix ?? "/api/v1";
  const service = options.service;
  const store = service.store;

  app.get(`${prefix}/tracking/capabilities`, (_request, response) => {
    response.json(service.capabilities());
  });

  app.get(`${prefix}/properties/:propertyId/tracking-settings`, (request, response) => {
    service.requireEnabled();
    requireProperty(options, response, request.params.propertyId);
    response.json({ settings: store.propertySettings(request.params.propertyId) });
  });

  app.patch(`${prefix}/properties/:propertyId/tracking-settings`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requireProperty(options, response, request.params.propertyId);
    const settings = store.updatePropertySettings(
      request.params.propertyId,
      settingsPatch(request.body),
    );
    response.json({ settings });
  });

  app.get(`${prefix}/tracking/tags`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    const propertyId = typeof request.query.propertyId === "string"
      ? request.query.propertyId
      : null;
    if (!propertyId) throw new TrackingError(400, "INVALID_FIELD", "propertyId is required");
    requireProperty(options, response, propertyId);
    response.json({ tags: store.listTags(propertyId) });
  });

  app.post(`${prefix}/tracking/tags`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    const input = tagInput(request.body);
    requireProperty(options, response, input.propertyId);
    const provisioning = store.createTag(input, service.tenantId);
    service.invalidateTagResolution();
    response.setHeader("cache-control", "no-store");
    response.status(201).json(provisioning);
  });

  app.post(`${prefix}/tracking/tags/:tagId/claim`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    const tag = store.claimTag(request.params.tagId);
    service.invalidateTagResolution();
    response.json({ tag });
  });

  app.post(`${prefix}/tracking/tags/:tagId/assign`, (request, response) => {
    service.requireEnabled();
    const principal = requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["equipmentId"], "Tag assignment");
    const equipmentId = requiredString(body, "equipmentId");
    requireEquipment(options, response, equipmentId);
    const assignment = store.assignTag(request.params.tagId, equipmentId, principal.userId);
    service.recalculateTag(request.params.tagId);
    response.status(201).json({ assignment });
  });

  app.delete(`${prefix}/tracking/tags/:tagId/assignment`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    response.json({ assignment: store.unassignTag(request.params.tagId) });
  });

  app.post(`${prefix}/tracking/tags/:tagId/rotate-secret`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requestTag(options, response, request.params.tagId);
    const provisioning = store.rotateTagSecret(request.params.tagId);
    service.invalidateTagResolution();
    response.setHeader("cache-control", "no-store");
    response.json(provisioning);
  });

  app.get(`${prefix}/properties/:propertyId/tracking-observers`, (request, response) => {
    service.requireEnabled();
    requireAdministrator(options, response);
    requireProperty(options, response, request.params.propertyId);
    response.json({ observers: store.listObservers(request.params.propertyId) });
  });

  app.post(`${prefix}/tracking/observers/register`, (request, response) => {
    service.requireEnabled();
    const principal = options.principal(response);
    if (!principal || principal.role === "guest") {
      throw new TrackingError(403, "FORBIDDEN", "A Property member is required to register an observer");
    }
    const input = observerInput(request.body);
    requireProperty(options, response, input.propertyId);
    const mobile = input.type === "android-phone" || input.type === "ios-phone";
    const administrator = principal.role === "owner" || principal.role === "admin";
    if (mobile && !service.flags["tracking.mobileObserver.enabled"]) {
      throw new TrackingError(404, "MOBILE_OBSERVER_DISABLED", "Mobile observation is not enabled");
    }
    if (mobile && !administrator && (
      input.trustLevel !== undefined
      || input.fixedPosition !== undefined
      || input.fixedPositionAccuracyMeters !== undefined
      || input.zoneId !== undefined
    )) {
      throw new TrackingError(
        403,
        "FORBIDDEN",
        "Phone observers cannot assign their own trust, fixed position, or zone",
      );
    }
    if (!mobile) requireAdministrator(options, response);
    if (input.type === "android-gateway" && !service.flags["tracking.androidGatewayMode.enabled"]) {
      throw new TrackingError(404, "ANDROID_GATEWAY_MODE_DISABLED", "Android Gateway Mode is not enabled");
    }
    const registration = store.registerObserver(input, principal.userId, service.tenantId);
    response.setHeader("cache-control", "no-store");
    response.status(201).json(registration);
  });

  app.patch(`${prefix}/tracking/observers/:observerId`, (request, response) => {
    service.requireEnabled();
    const principal = options.principal(response);
    const identity = store.observerIdentity(request.params.observerId);
    if (!identity || !options.authorizeProperty(response, identity.observer.propertyId)) {
      throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    }
    const administrator = principal?.role === "owner" || principal?.role === "admin";
    if (!administrator && (
      !principal
      || identity.createdByUserId !== principal.userId
      || (identity.observer.type !== "android-phone" && identity.observer.type !== "ios-phone")
    )) {
      throw new TrackingError(403, "FORBIDDEN", "Only an administrator or the phone owner can update this observer");
    }
    const patch = observerPatch(request.body);
    if (!administrator && (
      patch.trustLevel !== undefined
      || patch.fixedPosition !== undefined
      || patch.fixedPositionAccuracyMeters !== undefined
      || patch.zoneId !== undefined
    )) {
      throw new TrackingError(403, "FORBIDDEN", "Phone owners may update only their observer name, status, and metadata");
    }
    response.json({ observer: store.updateObserver(identity.observer.id, patch) });
  });

  app.post(`${prefix}/tracking/observers/:observerId/heartbeat`, (request, response) => {
    const identity = machineIdentity(options, response, request.params.observerId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["status", "hardwareMetadata"], "Observer heartbeat");
    const status = body.status === undefined
      ? undefined
      : enumValue(body.status, ["online", "degraded", "disabled"] as const, "status");
    const hardwareMetadata = metadata(body.hardwareMetadata, "hardwareMetadata");
    response.json({
      observer: service.heartbeat(identity, {
        ...(status ? { status } : {}),
        ...(hardwareMetadata ? { hardwareMetadata } : {}),
      }),
    });
  });

  app.post(`${prefix}/tracking/observers/:observerId/position`, (request, response) => {
    service.requireEnabled();
    const principal = options.principal(response);
    const identity = store.observerIdentity(request.params.observerId);
    if (!identity) {
      throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    }
    const administrator = principal?.role === "owner" || principal?.role === "admin";
    if (!administrator) {
      throw new TrackingError(403, "FORBIDDEN", "Only an administrator can reposition a fixed gateway");
    }
    requireProperty(options, response, identity.observer.propertyId);
    const body = bodyObject(request.body);
    rejectUnknown(body, ["position", "accuracyMeters", "zoneId"], "Observer position");
    const accuracyMeters = body.accuracyMeters;
    if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters)) {
      throw new TrackingError(400, "INVALID_FIELD", "accuracyMeters must be a finite number");
    }
    response.json({
      observer: store.updateObserverPosition(
        identity.observer.id,
        coordinate(body.position, "position"),
        accuracyMeters,
        nullableString(body, "zoneId") ?? null,
      ),
    });
  });

  app.post(`${prefix}/tracking/observations\\:batch`, (request, response) => {
    response.json(service.ingest(request.body, ingestionActor(options, response)));
  });

  app.get(`${prefix}/properties/:propertyId/equipment-loans`, (request, response) => {
    const propertyId = request.params.propertyId;
    requireProperty(options, response, propertyId);
    const active = request.query.active;
    if (active !== undefined && active !== "true" && active !== "false") {
      throw new TrackingError(400, "INVALID_FIELD", "active must be true or false");
    }
    const equipmentId = request.query.equipmentId;
    if (equipmentId !== undefined && (typeof equipmentId !== "string" || !equipmentId.trim())) {
      throw new TrackingError(400, "INVALID_FIELD", "equipmentId must be a non-empty string");
    }
    response.json({
      loans: service.equipmentLoans(propertyId, {
        ...(typeof equipmentId === "string" ? { equipmentId: equipmentId.trim() } : {}),
        activeOnly: active === "true",
        limit: numericLimit(request.query.limit, 200, 500),
      }),
    });
  });

  app.post(`${prefix}/area-equipment/:equipmentId/borrow`, (request, response) => {
    const principal = requireMember(options, response);
    const equipmentId = request.params.equipmentId;
    requireEquipment(options, response, equipmentId);
    options.assertPropertyWriteAllowed(store.core.getAreaEquipment(equipmentId)!.propertyId);
    const loan = service.borrowEquipment(
      equipmentId,
      principal.userId,
      principal.label,
      equipmentBorrowInput(request.body),
    );
    response.status(201).json({ loan });
  });

  app.post(`${prefix}/equipment-loans/:loanId/return`, (request, response) => {
    const principal = requireMember(options, response);
    const loan = store.getEquipmentLoan(request.params.loanId);
    if (!loan || !options.authorizeProperty(response, loan.propertyId)) {
      throw new TrackingError(404, "EQUIPMENT_LOAN_NOT_FOUND", "Equipment loan not found");
    }
    options.assertPropertyWriteAllowed(loan.propertyId);
    response.json({
      loan: service.returnEquipment(
        loan.id,
        principal.userId,
        principal.label,
        equipmentReturnInput(request.body),
      ),
    });
  });

  app.get(`${prefix}/properties/:propertyId/member-locations`, (request, response) => {
    const propertyId = request.params.propertyId;
    requireProperty(options, response, propertyId);
    response.json({ locations: service.memberLocations(propertyId) });
  });

  app.put(`${prefix}/properties/:propertyId/member-location`, (request, response) => {
    const propertyId = request.params.propertyId;
    const principal = requireMember(options, response);
    requireProperty(options, response, propertyId);
    const location = service.shareMemberLocation(
      propertyId,
      principal.userId,
      principal.label,
      memberLocationInput(request.body),
    );
    response.json({ location });
  });

  app.delete(`${prefix}/properties/:propertyId/member-location`, (request, response) => {
    const propertyId = request.params.propertyId;
    const principal = requireMember(options, response);
    requireProperty(options, response, propertyId);
    service.stopMemberLocation(propertyId, principal.userId);
    response.status(204).end();
  });

  app.get(`${prefix}/properties/:propertyId/tracked-assets`, (request, response) => {
    service.requireEnabled();
    requireProperty(options, response, request.params.propertyId);
    service.refreshProperty(request.params.propertyId);
    response.json({
      assets: store.trackedEquipment(request.params.propertyId).filter((item) => item.assignment),
    });
  });

  app.get(`${prefix}/assets/:equipmentId/position`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    const equipment = store.core.getAreaEquipment(request.params.equipmentId)!;
    service.refreshProperty(equipment.propertyId);
    response.json({ position: store.currentPosition(request.params.equipmentId) });
  });

  app.get(`${prefix}/assets/:equipmentId/position-history`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    response.json({
      positions: store.positionHistory(
        request.params.equipmentId,
        numericLimit(request.query.limit, 100, 500),
      ),
    });
  });

  app.get(`${prefix}/assets/:equipmentId/observations`, (request, response) => {
    service.requireEnabled();
    requireEquipment(options, response, request.params.equipmentId);
    const principal = options.principal(response);
    const includeMobileCoordinates = principal?.role === "owner" || principal?.role === "admin";
    response.json({
      observations: service.equipmentObservations(
        request.params.equipmentId,
        numericLimit(request.query.limit, 100, 500),
        includeMobileCoordinates,
      ),
    });
  });

  app.get(`${prefix}/assets/:equipmentId/tracking-scan-token`, (request, response) => {
    service.requireEnabled();
    requireMember(options, response);
    requireEquipment(options, response, request.params.equipmentId);
    response.setHeader("cache-control", "private, no-store");
    response.json(service.scanToken(request.params.equipmentId));
  });

  app.get(`${prefix}/properties/:propertyId/tracking-map-snapshot`, (request, response) => {
    service.requireEnabled();
    requireProperty(options, response, request.params.propertyId);
    response.json(service.mapSnapshot(request.params.propertyId));
  });

  app.get(`${prefix}/properties/:propertyId/tracking-stream`, (request, response) => {
    service.requireFeature("tracking.liveMap.enabled", "The live equipment map is not enabled");
    requireProperty(options, response, request.params.propertyId);
    if (options.validateStream && !options.validateStream(request, response)) return;
    const acceptedFingerprint = options.streamAuthorizationFingerprint?.(request, response) ?? null;
    if (options.streamAuthorizationFingerprint && !acceptedFingerprint) {
      throw new TrackingError(401, "UNAUTHORIZED", "The authenticated session is no longer valid");
    }
    const acquired = options.acquireStream
      ? options.acquireStream(request, response)
      : () => undefined;
    if (!acquired) {
      response.setHeader("retry-after", "5");
      throw new TrackingError(429, "EVENT_STREAM_LIMIT", "Too many active event streams for this account");
    }
    const release = acquired;
    const headerSequence = request.header("last-event-id");
    const querySequence = request.query.sequence;
    const requestedSequence = headerSequence ?? (typeof querySequence === "string" ? querySequence : "0");
    if (!/^\d+$/u.test(requestedSequence)) {
      release();
      throw new TrackingError(400, "INVALID_SEQUENCE", "Last-Event-ID must be a non-negative integer");
    }
    let lastSent = Number(requestedSequence);
    if (!Number.isSafeInteger(lastSent)) {
      release();
      throw new TrackingError(400, "INVALID_SEQUENCE", "Last-Event-ID is too large");
    }
    response.status(200);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.flushHeaders();
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const authorizationValid = (): boolean => {
      if (options.streamAuthorizationFingerprint) {
        const current = options.streamAuthorizationFingerprint(request, response);
        if (!current || current !== acceptedFingerprint) return false;
      }
      return options.authorizeProperty(response, request.params.propertyId);
    };
    const writeEvent = (event: TrackingEvent): boolean => {
      if (closed || response.destroyed || response.writableEnded || event.sequence <= lastSent) return true;
      lastSent = event.sequence;
      return response.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    let unsubscribe = (): void => undefined;
    const close = (authorizationChanged = false): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      release();
      if (!response.writableEnded) {
        response.end(authorizationChanged
          ? `event: authorization\ndata: ${JSON.stringify({ status: "changed" })}\n\n`
          : undefined);
      }
    };
    unsubscribe = service.subscribe(request.params.propertyId, (event) => {
      if (!authorizationValid()) { close(true); return; }
      if (!writeEvent(event)) close();
    });
    const replay = store.eventsAfter(request.params.propertyId, lastSent, 501);
    if (replay.length > 500) {
      const sequence = store.latestSequence(request.params.propertyId);
      response.write(
        `event: snapshot-required\ndata: ${JSON.stringify({ propertyId: request.params.propertyId, sequence })}\n\n`,
      );
      lastSent = sequence;
    } else {
      for (const event of replay) {
        if (!writeEvent(event)) { close(); return; }
      }
    }
    response.write(`event: ready\ndata: ${JSON.stringify({
      propertyId: request.params.propertyId,
      sequence: lastSent,
    })}\n\n`);
    heartbeat = setInterval(() => {
      if (!authorizationValid()) { close(true); return; }
      if (!response.write(`event: heartbeat\ndata: ${JSON.stringify({
        timestamp: new Date().toISOString(),
        sequence: lastSent,
      })}\n\n`)) close();
    }, 15_000);
    heartbeat.unref();
    if (options.registerStream) {
      options.registerStream(
        request,
        response,
        () => {
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
        },
        release,
      );
    } else {
      request.once("aborted", () => close());
      response.once("close", () => close());
    }
  });
}
