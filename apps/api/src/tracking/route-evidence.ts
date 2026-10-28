import {
  TRACKING_SCHEMA_VERSION,
  type TrackingGatewayRollupInput,
  type TrackingObservationBatchInput,
  type TrackingObservationInput,
  type TrackingObserverPosition,
} from "@climate-twin/contracts";
import { TrackingError } from "./errors.js";
import {
  bodyObject,
  coordinate,
  enumValue,
  metadata,
  optionalBoolean,
  rejectUnknown,
  requiredString,
} from "./route-support.js";

function integer(
  body: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  optional = false,
): number | undefined {
  const value = body[field];
  if (optional && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TrackingError(400, "INVALID_EVIDENCE", `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function boundedNumberField(
  body: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
  optional = false,
): number | undefined {
  const value = body[field];
  if (optional && value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TrackingError(400, "INVALID_EVIDENCE", `${field} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function observerPosition(value: unknown): TrackingObserverPosition | undefined {
  if (value === undefined) return undefined;
  const body = bodyObject(value, "observerPosition");
  rejectUnknown(body, [
    "latitude", "longitude", "horizontalAccuracyMeters", "source", "capturedAt", "reducedAccuracy",
  ], "observerPosition");
  const point = coordinate(
    { latitude: body.latitude, longitude: body.longitude },
    "observerPosition",
  );
  return {
    ...point,
    horizontalAccuracyMeters: boundedNumberField(body, "horizontalAccuracyMeters", 0, 10_000)!,
    source: enumValue(body.source, ["gps", "fused", "network", "fixed", "manual"] as const, "source"),
    capturedAt: requiredString(body, "capturedAt", 100),
    ...(body.reducedAccuracy === undefined ? {} : { reducedAccuracy: optionalBoolean(body, "reducedAccuracy")! }),
  };
}

function observation(value: unknown): TrackingObservationInput {
  const body = bodyObject(value, "observation");
  rejectUnknown(body, [
    "schemaVersion", "dataMode", "observationId", "idempotencyKey", "propertyId",
    "endpointId", "equipmentId", "observerId", "observedAt", "profileId", "profileVersion",
    "rssi", "txPower", "batteryPercent", "motion", "counter", "observerPosition",
    "scanContext", "telemetry",
  ], "observation");
  if (body.schemaVersion !== TRACKING_SCHEMA_VERSION) {
    throw new TrackingError(400, "INVALID_EVIDENCE", `schemaVersion must be ${TRACKING_SCHEMA_VERSION}`);
  }
  const txPower = integer(body, "txPower", -127, 20, true);
  const batteryPercent = integer(body, "batteryPercent", 0, 100, true);
  const counter = integer(body, "counter", 0, Number.MAX_SAFE_INTEGER, true);
  const position = observerPosition(body.observerPosition);
  const telemetry = metadata(body.telemetry, "telemetry");
  return {
    schemaVersion: TRACKING_SCHEMA_VERSION,
    dataMode: enumValue(body.dataMode, ["live", "demo"] as const, "dataMode"),
    observationId: requiredString(body, "observationId"),
    idempotencyKey: requiredString(body, "idempotencyKey"),
    propertyId: requiredString(body, "propertyId"),
    endpointId: requiredString(body, "endpointId"),
    equipmentId: requiredString(body, "equipmentId"),
    observerId: requiredString(body, "observerId"),
    observedAt: requiredString(body, "observedAt", 100),
    profileId: requiredString(body, "profileId"),
    profileVersion: requiredString(body, "profileVersion"),
    rssi: integer(body, "rssi", -127, 20)!,
    ...(txPower === undefined ? {} : { txPower }),
    ...(batteryPercent === undefined ? {} : { batteryPercent }),
    ...(body.motion === undefined ? {} : { motion: optionalBoolean(body, "motion")! }),
    ...(counter === undefined ? {} : { counter }),
    ...(position ? { observerPosition: position } : {}),
    scanContext: enumValue(body.scanContext, [
      "foreground", "background", "foreground-find", "fixed-gateway", "dedicated-android-gateway",
    ] as const, "scanContext"),
    ...(telemetry ? { telemetry } : {}),
  };
}

function rollup(value: unknown): TrackingGatewayRollupInput {
  const body = bodyObject(value, "rollup");
  rejectUnknown(body, [
    "schemaVersion", "dataMode", "rollupId", "idempotencyKey", "propertyId", "endpointId",
    "equipmentId", "observerId", "profileId", "profileVersion", "windowStartedAt",
    "windowEndedAt", "packetCount", "rssiMinimum", "rssiMaximum", "rssiMean",
    "rssiVariance", "lastBatteryPercent", "motionObserved", "firstCounter", "lastCounter",
    "telemetry",
  ], "rollup");
  if (body.schemaVersion !== TRACKING_SCHEMA_VERSION) {
    throw new TrackingError(400, "INVALID_EVIDENCE", `schemaVersion must be ${TRACKING_SCHEMA_VERSION}`);
  }
  const packetCount = integer(body, "packetCount", 1, 1_000_000)!;
  const rssiMinimum = integer(body, "rssiMinimum", -127, 20)!;
  const rssiMaximum = integer(body, "rssiMaximum", -127, 20)!;
  const rssiMean = boundedNumberField(body, "rssiMean", -127, 20)!;
  const rssiVariance = boundedNumberField(body, "rssiVariance", 0, 20_000)!;
  if (rssiMinimum > rssiMean || rssiMean > rssiMaximum) {
    throw new TrackingError(400, "INVALID_EVIDENCE", "Rollup RSSI statistics are inconsistent");
  }
  const lastBatteryPercent = integer(body, "lastBatteryPercent", 0, 100, true);
  const firstCounter = integer(body, "firstCounter", 0, Number.MAX_SAFE_INTEGER, true);
  const lastCounter = integer(body, "lastCounter", 0, Number.MAX_SAFE_INTEGER, true);
  const telemetry = metadata(body.telemetry, "telemetry");
  return {
    schemaVersion: TRACKING_SCHEMA_VERSION,
    dataMode: enumValue(body.dataMode, ["live", "demo"] as const, "dataMode"),
    rollupId: requiredString(body, "rollupId"),
    idempotencyKey: requiredString(body, "idempotencyKey"),
    propertyId: requiredString(body, "propertyId"),
    endpointId: requiredString(body, "endpointId"),
    equipmentId: requiredString(body, "equipmentId"),
    observerId: requiredString(body, "observerId"),
    profileId: requiredString(body, "profileId"),
    profileVersion: requiredString(body, "profileVersion"),
    windowStartedAt: requiredString(body, "windowStartedAt", 100),
    windowEndedAt: requiredString(body, "windowEndedAt", 100),
    packetCount,
    rssiMinimum,
    rssiMaximum,
    rssiMean,
    rssiVariance,
    ...(lastBatteryPercent === undefined ? {} : { lastBatteryPercent }),
    ...(body.motionObserved === undefined ? {} : { motionObserved: optionalBoolean(body, "motionObserved")! }),
    ...(firstCounter === undefined ? {} : { firstCounter }),
    ...(lastCounter === undefined ? {} : { lastCounter }),
    ...(telemetry ? { telemetry } : {}),
  };
}

export function trackingEvidenceBatch(value: unknown): TrackingObservationBatchInput {
  const body = bodyObject(value);
  rejectUnknown(body, ["observations", "rollups"], "Tracking evidence batch");
  if (!Array.isArray(body.observations)) {
    throw new TrackingError(400, "INVALID_EVIDENCE", "observations must be an array");
  }
  if (body.rollups !== undefined && !Array.isArray(body.rollups)) {
    throw new TrackingError(400, "INVALID_EVIDENCE", "rollups must be an array");
  }
  return {
    observations: body.observations.map(observation),
    ...(Array.isArray(body.rollups) ? { rollups: body.rollups.map(rollup) } : {}),
  };
}
