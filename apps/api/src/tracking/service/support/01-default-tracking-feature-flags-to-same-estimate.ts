import { createHash } from "node:crypto";
import type {
  AssetPositionEstimate,
  EquipmentBorrowInput,
  EquipmentLoan,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocation,
  PropertyMemberLocationInput,
  PropertyMemberLocationSignal,
  TrackedEquipmentState,
  TrackingAppState,
  TrackingCapabilities,
  TrackingEvent,
  TrackingFeatureFlags,
  TrackingMapSnapshot,
  TrackingObservation,
  TrackingObservationBatchError,
  TrackingObservationBatchResult,
  TrackingObservationInput,
  TrackingObservationQualityFlag,
  TrackingObserver,
  TrackingObserverPosition,
  TrackingScanMode,
  TrackingScanToken,
  TrackingTag,
} from "@climate-twin/contracts";
import { inferTrackedEquipmentPosition, trackingPointInPolygon } from "../../inference.js";
import {
  parseTrackingAdvertisement,
  rotatingTagId,
  trackingEpochCounter,
  TRACKING_FLAGS,
  TRACKING_PROTOCOL_VERSION,
  verifyTrackingAdvertisement,
  type TrackingAdvertisement,
} from "../../protocol.js";
import {
  TrackingError,
  TrackingStore,
  type AuthenticatedTrackingObserver,
} from "../../store.js";

export const DEFAULT_TRACKING_FEATURE_FLAGS: TrackingFeatureFlags = {
  "tracking.enabled": false,
  "tracking.mobileObserver.enabled": false,
  "tracking.mobileObserver.iosBackground.enabled": false,
  "tracking.mobileObserver.androidBackground.enabled": false,
  "tracking.androidGatewayMode.enabled": false,
  "tracking.liveMap.enabled": false,
  "tracking.movementTrails.enabled": false,
  "tracking.exitAlerts.enabled": false,
  "tracking.rotatingIdentifiers.enabled": true,
  "tracking.userLocationSharing.enabled": false,
  "tracking.experimentalCoordinateInference.enabled": false,
};

/** Private 128-bit GATT service carrying the Stugu v1 advertisement as service data. */
export const STUGA_TRACKING_BLE_SERVICE_UUID = "F8A57A01-9D58-4C66-8D2D-2026A11E0001";

export const MAXIMUM_BATCH_SIZE = 100;

export const TRACKING_MODES = new Set<TrackingScanMode>([
  "passive",
  "property",
  "active-property",
  "find-nearby",
  "gateway",
]);

export const APP_STATES = new Set<TrackingAppState>(["foreground", "background", "suspended"]);

export const LOCATION_SOURCES = new Set<TrackingObserverPosition["source"]>([
  "gps",
  "fused",
  "network",
  "fixed",
  "manual",
]);

export const INVALIDATING_FLAGS = new Set<TrackingObservationQualityFlag>([
  "CLOCK_UNRELIABLE",
  "UNRESOLVED_TAG",
  "INVALID_AUTHENTICATOR",
  "PROPERTY_SCOPE_MISMATCH",
  "OBSERVER_UNTRUSTED",
]);

export interface ResolvedAdvertisement {
  advertisement: TrackingAdvertisement;
  input: TrackingObservationInput;
}

export interface ResolutionCandidate {
  tag: TrackingTag;
  secret: Buffer;
}

export interface TrackingIngestionActor {
  machineObserver: AuthenticatedTrackingObserver | null;
  userId: string | null;
  administrator: boolean;
  canWriteProperty: (propertyId: string) => boolean;
}

export interface TrackingServiceOptions {
  flags: TrackingFeatureFlags;
  tenantId?: string;
  rawMobileCoordinateRetentionHours?: number;
  maximumObservationsPerMinute?: number;
}

export type TrackingEventListener = (event: TrackingEvent) => void;

export function objectValue(value: unknown, field = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrackingError(400, "INVALID_OBSERVATION", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown, field: string, maximum = 200): string {
  if (typeof value !== "string") {
    throw new TrackingError(400, "INVALID_OBSERVATION", `${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TrackingError(
      400,
      "INVALID_OBSERVATION",
      `${field} must contain between 1 and ${maximum} characters`,
    );
  }
  return normalized;
}

export function integerValue(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TrackingError(
      400,
      "INVALID_OBSERVATION",
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

export function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined || value === null
    ? undefined
    : integerValue(value, field, minimum, maximum);
}

export function dateValue(value: unknown, field: string): string {
  const source = stringValue(value, field, 100);
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) {
    throw new TrackingError(400, "INVALID_OBSERVATION", `${field} must be an ISO 8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

export function coordinateValue(value: unknown, field: string): GeoCoordinate {
  const source = objectValue(value, field);
  const latitude = source.latitude;
  const longitude = source.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new TrackingError(400, "INVALID_OBSERVATION", `${field} must contain a valid WGS84 coordinate`);
  }
  return { latitude, longitude };
}

export function observerPositionValue(value: unknown): TrackingObserverPosition | undefined {
  if (value === undefined || value === null) return undefined;
  const source = objectValue(value, "observerPosition");
  const coordinate = coordinateValue(source, "observerPosition");
  const accuracy = source.horizontalAccuracyMeters;
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10_000) {
    throw new TrackingError(
      400,
      "INVALID_OBSERVATION",
      "observerPosition.horizontalAccuracyMeters must be from 0 to 10000",
    );
  }
  if (typeof source.source !== "string"
    || !LOCATION_SOURCES.has(source.source as TrackingObserverPosition["source"])) {
    throw new TrackingError(400, "INVALID_OBSERVATION", "observerPosition.source is unsupported");
  }
  const capturedAt = source.capturedAt === undefined
    ? undefined
    : dateValue(source.capturedAt, "observerPosition.capturedAt");
  if (source.reducedAccuracy !== undefined && typeof source.reducedAccuracy !== "boolean") {
    throw new TrackingError(
      400,
      "INVALID_OBSERVATION",
      "observerPosition.reducedAccuracy must be a boolean",
    );
  }
  return {
    ...coordinate,
    horizontalAccuracyMeters: accuracy,
    source: source.source as TrackingObserverPosition["source"],
    ...(capturedAt ? { capturedAt } : {}),
    ...(source.reducedAccuracy !== undefined ? { reducedAccuracy: source.reducedAccuracy } : {}),
  };
}

export function metadataValue(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined || value === null) return {};
  const source = objectValue(value, "metadata");
  if (Object.keys(source).length > 50) {
    throw new TrackingError(400, "INVALID_OBSERVATION", "metadata may contain at most 50 fields");
  }
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key.length > 100
      || (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")
      || (typeof item === "number" && !Number.isFinite(item))
      || (typeof item === "string" && item.length > 1_000)) {
      throw new TrackingError(400, "INVALID_OBSERVATION", "metadata contains an invalid field");
    }
    output[key] = item as string | number | boolean | null;
  }
  return output;
}

export function parseInput(value: unknown): TrackingObservationInput {
  const source = objectValue(value, "observation");
  const scanMode = stringValue(source.scanMode, "scanMode", 40);
  if (!TRACKING_MODES.has(scanMode as TrackingScanMode)) {
    throw new TrackingError(400, "INVALID_OBSERVATION", "scanMode is unsupported");
  }
  const appState = source.appState === undefined || source.appState === null
    ? undefined
    : stringValue(source.appState, "appState", 40);
  if (appState && !APP_STATES.has(appState as TrackingAppState)) {
    throw new TrackingError(400, "INVALID_OBSERVATION", "appState is unsupported");
  }
  const observerPosition = observerPositionValue(source.observerPosition);
  const rawPayload = source.rawPayload === undefined || source.rawPayload === null
    ? undefined
    : stringValue(source.rawPayload, "rawPayload", 100);
  const advertisementFlags = optionalInteger(source.advertisementFlags, "advertisementFlags", 0, 0x3f);
  if (!rawPayload && advertisementFlags === undefined) {
    throw new TrackingError(
      400,
      "INVALID_OBSERVATION",
      "advertisementFlags is required when rawPayload is unavailable",
    );
  }
  const motion = source.motion === undefined ? undefined : source.motion;
  if (motion !== undefined && typeof motion !== "boolean") {
    throw new TrackingError(400, "INVALID_OBSERVATION", "motion must be a boolean");
  }
  return {
    observationId: stringValue(source.observationId, "observationId", 100),
    propertyId: stringValue(source.propertyId, "propertyId", 200),
    observerId: stringValue(source.observerId, "observerId", 200),
    observedAt: dateValue(source.observedAt, "observedAt"),
    rotatingTagId: stringValue(source.rotatingTagId, "rotatingTagId", 32),
    authenticator: stringValue(source.authenticator, "authenticator", 16),
    protocolVersion: integerValue(source.protocolVersion, "protocolVersion", 0, 3),
    ...(advertisementFlags !== undefined ? { advertisementFlags } : {}),
    epochCounter: integerValue(source.epochCounter, "epochCounter", 0, 0xffff),
    eventCounter: integerValue(source.eventCounter, "eventCounter", 0, 0xffff),
    rssi: integerValue(source.rssi, "rssi", -127, 20),
    ...(source.txPower !== undefined && source.txPower !== null
      ? { txPower: integerValue(source.txPower, "txPower", -127, 127) }
      : {}),
    ...(motion !== undefined ? { motion } : {}),
    ...(source.batteryPercent !== undefined && source.batteryPercent !== null
      ? { batteryPercent: integerValue(source.batteryPercent, "batteryPercent", 0, 100) }
      : {}),
    ...(observerPosition ? { observerPosition } : {}),
    scanMode: scanMode as TrackingScanMode,
    ...(appState ? { appState: appState as TrackingAppState } : {}),
    ...(source.deviceTimeOffsetMs !== undefined && source.deviceTimeOffsetMs !== null
      ? { deviceTimeOffsetMs: integerValue(
        source.deviceTimeOffsetMs,
        "deviceTimeOffsetMs",
        -86_400_000,
        86_400_000,
      ) }
      : {}),
    ...(rawPayload ? { rawPayload } : {}),
    metadata: metadataValue(source.metadata),
  };
}

export function advertisementFromInput(input: TrackingObservationInput): ResolvedAdvertisement {
  if (input.rawPayload) {
    let parsed: TrackingAdvertisement;
    try {
      parsed = parseTrackingAdvertisement(input.rawPayload);
    } catch (error) {
      throw new TrackingError(
        400,
        "INVALID_OBSERVATION",
        error instanceof Error ? error.message : "rawPayload is invalid",
      );
    }
    const mismatch = parsed.protocolVersion !== input.protocolVersion
      || parsed.rotatingTagId !== input.rotatingTagId
      || parsed.epochCounter !== input.epochCounter
      || parsed.eventCounter !== input.eventCounter
      || parsed.authenticator !== input.authenticator
      || (input.advertisementFlags !== undefined && parsed.flags !== input.advertisementFlags)
      || (input.batteryPercent !== undefined && parsed.batteryPercent !== input.batteryPercent)
      || (input.motion !== undefined && Boolean(parsed.flags & TRACKING_FLAGS.moving) !== input.motion);
    if (mismatch) {
      throw new TrackingError(
        400,
        "INVALID_OBSERVATION",
        "Parsed advertisement fields do not match rawPayload",
      );
    }
    return { advertisement: parsed, input };
  }
  return {
    advertisement: {
      protocolVersion: input.protocolVersion,
      flags: input.advertisementFlags!,
      rotatingTagId: input.rotatingTagId,
      epochCounter: input.epochCounter,
      eventCounter: input.eventCounter,
      batteryPercent: input.batteryPercent ?? null,
      authenticator: input.authenticator,
      rawPayload: "",
    },
    input,
  };
}

export function observationDedupKey(input: TrackingObservationInput): string {
  const bucket = Math.floor(Date.parse(input.observedAt) / 10_000);
  return createHash("sha256")
    .update([
      input.observerId,
      input.rotatingTagId,
      input.epochCounter,
      input.eventCounter,
      bucket,
    ].join("\u001f"))
    .digest("hex");
}

export function adjacentEpoch(left: number, right: number): boolean {
  const forward = (left - right + 0x1_0000) & 0xffff;
  return forward === 0 || forward === 1 || forward === 0xffff;
}

export function sameEstimate(left: AssetPositionEstimate | null, right: Omit<AssetPositionEstimate, "id" | "version">): boolean {
  if (!left) return false;
  return left.positionType === right.positionType
    && JSON.stringify(left.coordinate) === JSON.stringify(right.coordinate)
    && left.accuracyRadiusMeters === right.accuracyRadiusMeters
    && left.zoneId === right.zoneId
    && left.confidence === right.confidence
    && left.movementState === right.movementState
    && left.freshnessState === right.freshnessState
    && left.lastObservedAt === right.lastObservedAt
    && JSON.stringify(left.evidenceObservationIds) === JSON.stringify(right.evidenceObservationIds);
}
