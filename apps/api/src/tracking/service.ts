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
import { inferTrackedEquipmentPosition, trackingPointInPolygon } from "./inference.js";
import {
  parseTrackingAdvertisement,
  rotatingTagId,
  trackingEpochCounter,
  TRACKING_FLAGS,
  TRACKING_PROTOCOL_VERSION,
  verifyTrackingAdvertisement,
  type TrackingAdvertisement,
} from "./protocol.js";
import {
  TrackingError,
  TrackingStore,
  type AuthenticatedTrackingObserver,
} from "./store.js";

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

/** Private 128-bit GATT service carrying the Stuga v1 advertisement as service data. */
export const STUGA_TRACKING_BLE_SERVICE_UUID = "F8A57A01-9D58-4C66-8D2D-2026A11E0001";

const MAXIMUM_BATCH_SIZE = 100;
const TRACKING_MODES = new Set<TrackingScanMode>([
  "passive",
  "property",
  "active-property",
  "find-nearby",
  "gateway",
]);
const APP_STATES = new Set<TrackingAppState>(["foreground", "background", "suspended"]);
const LOCATION_SOURCES = new Set<TrackingObserverPosition["source"]>([
  "gps",
  "fused",
  "network",
  "fixed",
  "manual",
]);
const INVALIDATING_FLAGS = new Set<TrackingObservationQualityFlag>([
  "CLOCK_UNRELIABLE",
  "UNRESOLVED_TAG",
  "INVALID_AUTHENTICATOR",
  "PROPERTY_SCOPE_MISMATCH",
  "OBSERVER_UNTRUSTED",
]);

interface ResolvedAdvertisement {
  advertisement: TrackingAdvertisement;
  input: TrackingObservationInput;
}

interface ResolutionCandidate {
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

type TrackingEventListener = (event: TrackingEvent) => void;

function objectValue(value: unknown, field = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TrackingError(400, "INVALID_OBSERVATION", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, maximum = 200): string {
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

function integerValue(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TrackingError(
      400,
      "INVALID_OBSERVATION",
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined || value === null
    ? undefined
    : integerValue(value, field, minimum, maximum);
}

function dateValue(value: unknown, field: string): string {
  const source = stringValue(value, field, 100);
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) {
    throw new TrackingError(400, "INVALID_OBSERVATION", `${field} must be an ISO 8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function coordinateValue(value: unknown, field: string): GeoCoordinate {
  const source = objectValue(value, field);
  const latitude = source.latitude;
  const longitude = source.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new TrackingError(400, "INVALID_OBSERVATION", `${field} must contain a valid WGS84 coordinate`);
  }
  return { latitude, longitude };
}

function observerPositionValue(value: unknown): TrackingObserverPosition | undefined {
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

function metadataValue(value: unknown): Record<string, string | number | boolean | null> {
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

function parseInput(value: unknown): TrackingObservationInput {
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

function advertisementFromInput(input: TrackingObservationInput): ResolvedAdvertisement {
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

function observationDedupKey(input: TrackingObservationInput): string {
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

function adjacentEpoch(left: number, right: number): boolean {
  const forward = (left - right + 0x1_0000) & 0xffff;
  return forward === 0 || forward === 1 || forward === 0xffff;
}

function sameEstimate(left: AssetPositionEstimate | null, right: Omit<AssetPositionEstimate, "id" | "version">): boolean {
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

export class TrackingService {
  readonly flags: TrackingFeatureFlags;
  readonly tenantId: string;
  readonly rawMobileCoordinateRetentionHours: number;
  readonly maximumObservationsPerMinute: number;
  readonly #listeners = new Map<string, Set<TrackingEventListener>>();
  readonly #resolutionCache = new Map<string, Map<string, ResolutionCandidate[]>>();
  readonly #ingestionWindows = new Map<string, { startedAt: number; observations: number }>();
  #refreshTimer: NodeJS.Timeout | null = null;

  constructor(readonly store: TrackingStore, options: TrackingServiceOptions) {
    this.flags = { ...options.flags };
    this.tenantId = options.tenantId ?? "local";
    this.rawMobileCoordinateRetentionHours = Math.max(
      1,
      Math.min(24 * 30, Math.round(options.rawMobileCoordinateRetentionHours ?? 24)),
    );
    this.maximumObservationsPerMinute = Math.max(
      MAXIMUM_BATCH_SIZE,
      Math.round(options.maximumObservationsPerMinute ?? 12_000),
    );
  }

  get enabled(): boolean {
    return this.flags["tracking.enabled"];
  }

  start(refreshIntervalMilliseconds = 15_000): void {
    if (!this.enabled || this.#refreshTimer) return;
    const refresh = (): void => {
      for (const propertyId of this.store.activePropertyIds()) {
        try {
          this.refreshProperty(propertyId);
        } catch {
          console.error("[tracking] Scheduled Property refresh failed");
        }
      }
    };
    refresh();
    this.#refreshTimer = setInterval(
      refresh,
      Math.max(5_000, refreshIntervalMilliseconds),
    );
    this.#refreshTimer.unref();
  }

  stop(): void {
    if (!this.#refreshTimer) return;
    clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
  }

  capabilities(): TrackingCapabilities {
    return {
      flags: { ...this.flags },
      bleServiceUuid: STUGA_TRACKING_BLE_SERVICE_UUID,
      protocolVersions: [TRACKING_PROTOCOL_VERSION],
      maximumObservationBatchSize: MAXIMUM_BATCH_SIZE,
      observerModes: ["passive", "property", "active-property", "find-nearby", "gateway"],
    };
  }

  requireEnabled(): void {
    if (!this.enabled) {
      throw new TrackingError(404, "TRACKING_DISABLED", "Equipment tracking is not enabled");
    }
  }

  requireFeature(flag: keyof TrackingFeatureFlags, message: string): void {
    this.requireEnabled();
    if (!this.flags[flag]) throw new TrackingError(404, "TRACKING_FEATURE_DISABLED", message);
  }

  authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null {
    return this.enabled ? this.store.authenticateObserverCredential(credential) : null;
  }

  invalidateTagResolution(): void {
    this.#resolutionCache.clear();
  }

  subscribe(propertyId: string, listener: TrackingEventListener): () => void {
    const listeners = this.#listeners.get(propertyId) ?? new Set<TrackingEventListener>();
    listeners.add(listener);
    this.#listeners.set(propertyId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(propertyId);
    };
  }

  #publish(event: TrackingEvent): void {
    for (const listener of this.#listeners.get(event.propertyId) ?? []) listener(event);
  }

  #appendEvent(
    type: TrackingEvent["type"],
    state: TrackingEvent["state"],
    evidenceObservationIds: string[] = [],
  ): TrackingEvent {
    const event = this.store.appendEvent(type, this.tenantId, state, evidenceObservationIds);
    this.#publish(event);
    return event;
  }

  #epochResolution(
    propertyId: string,
    protocolVersion: number,
    epochCounter: number,
  ): Map<string, ResolutionCandidate[]> {
    const key = `${propertyId}:${protocolVersion}:${epochCounter}`;
    const cached = this.#resolutionCache.get(key);
    if (cached) return cached;
    const result = new Map<string, ResolutionCandidate[]>();
    for (const tag of this.store.listTags(propertyId).filter((candidate) => (
      candidate.tenantId === this.tenantId
      && candidate.status === "active"
      && candidate.protocolVersion === protocolVersion
    ))) {
      const secret = this.store.tagSecret(tag.id);
      const identifier = rotatingTagId(secret, protocolVersion, epochCounter);
      const candidates = result.get(identifier) ?? [];
      candidates.push({ tag, secret });
      result.set(identifier, candidates);
    }
    this.#resolutionCache.set(key, result);
    if (this.#resolutionCache.size > 64) {
      const first = this.#resolutionCache.keys().next().value as string | undefined;
      if (first) this.#resolutionCache.delete(first);
    }
    return result;
  }

  #resolve(
    propertyId: string,
    advertisement: TrackingAdvertisement,
  ): { candidate: ResolutionCandidate | null; flag: TrackingObservationQualityFlag | null } {
    if (advertisement.protocolVersion !== TRACKING_PROTOCOL_VERSION) {
      return { candidate: null, flag: "UNRESOLVED_TAG" };
    }
    const candidates = this.#epochResolution(
      propertyId,
      advertisement.protocolVersion,
      advertisement.epochCounter,
    ).get(advertisement.rotatingTagId) ?? [];
    if (candidates.length !== 1) return { candidate: null, flag: "UNRESOLVED_TAG" };
    const candidate = candidates[0]!;
    if (candidate.tag.tenantId !== this.tenantId || candidate.tag.propertyId !== propertyId) {
      return { candidate: null, flag: "PROPERTY_SCOPE_MISMATCH" };
    }
    if (!verifyTrackingAdvertisement(candidate.secret, advertisement)) {
      return { candidate, flag: "INVALID_AUTHENTICATOR" };
    }
    return { candidate, flag: null };
  }

  #consumeIngestionCapacity(
    actor: TrackingIngestionActor,
    observations: number,
    now: Date,
  ): void {
    const key = actor.machineObserver
      ? `observer:${actor.machineObserver.observer.id}`
      : `user:${actor.userId ?? "unknown"}`;
    const timestamp = now.getTime();
    const current = this.#ingestionWindows.get(key);
    const window = !current || timestamp - current.startedAt >= 60_000
      ? { startedAt: timestamp, observations: 0 }
      : current;
    if (window.observations + observations > this.maximumObservationsPerMinute) {
      throw new TrackingError(
        429,
        "OBSERVATION_RATE_LIMITED",
        "This observer is uploading detections too quickly; retry after the current minute",
      );
    }
    window.observations += observations;
    this.#ingestionWindows.set(key, window);
    if (this.#ingestionWindows.size > 10_000) {
      for (const [candidate, value] of this.#ingestionWindows) {
        if (timestamp - value.startedAt >= 60_000) this.#ingestionWindows.delete(candidate);
      }
    }
  }

  #authorizedObserver(
    actor: TrackingIngestionActor,
    observerId: string,
    propertyId: string,
  ): AuthenticatedTrackingObserver | null {
    const identity = this.store.observerIdentity(observerId);
    if (!identity || identity.observer.propertyId !== propertyId) return null;
    if (actor.machineObserver) {
      return actor.machineObserver.observer.id === observerId
        && actor.machineObserver.observer.propertyId === propertyId
        ? actor.machineObserver
        : null;
    }
    if (!actor.canWriteProperty(propertyId)) return null;
    return actor.administrator || (
      actor.userId !== null
      && identity.createdByUserId !== null
      && actor.userId === identity.createdByUserId
    ) ? identity : null;
  }

  #qualityFlags(
    input: TrackingObservationInput,
    advertisement: TrackingAdvertisement,
    observer: TrackingObserver,
    now: Date,
    maximumObservationAgeSeconds: number,
    rotationWindowMinutes: number | null,
  ): TrackingObservationQualityFlag[] {
    const flags: TrackingObservationQualityFlag[] = [];
    const observedAt = Date.parse(input.observedAt);
    if (Math.abs(input.deviceTimeOffsetMs ?? 0) > 5 * 60_000
      || observedAt > now.getTime() + 5 * 60_000
      || observedAt < now.getTime() - maximumObservationAgeSeconds * 1_000
      || (rotationWindowMinutes !== null
        && !adjacentEpoch(
          advertisement.epochCounter,
          trackingEpochCounter(new Date(observedAt), rotationWindowMinutes),
        ))) {
      flags.push("CLOCK_UNRELIABLE");
    }
    const mobile = observer.type === "ios-phone" || observer.type === "android-phone";
    if (mobile && !input.observerPosition) flags.push("LOCATION_UNAVAILABLE");
    if (input.observerPosition) {
      if (input.observerPosition.horizontalAccuracyMeters > 50 || input.observerPosition.reducedAccuracy) {
        flags.push("LOCATION_LOW_ACCURACY");
      }
      if (input.observerPosition.capturedAt
        && Math.abs(observedAt - Date.parse(input.observerPosition.capturedAt)) > 2 * 60_000) {
        flags.push("LOCATION_STALE");
      }
    }
    if (input.rssi > -10 || input.rssi < -110) flags.push("RSSI_OUTLIER");
    if (observer.status === "disabled" || observer.trustLevel <= 0) flags.push("OBSERVER_UNTRUSTED");
    if (input.motion !== undefined
      && input.motion !== Boolean(advertisement.flags & TRACKING_FLAGS.moving)) {
      flags.push("INVALID_AUTHENTICATOR");
    }
    return flags;
  }

  ingest(value: unknown, actor: TrackingIngestionActor, now = new Date()): TrackingObservationBatchResult {
    this.requireEnabled();
    const body = objectValue(value, "Observation batch");
    if (!Array.isArray(body.observations)) {
      throw new TrackingError(400, "INVALID_OBSERVATION_BATCH", "observations must be an array");
    }
    if (body.observations.length > MAXIMUM_BATCH_SIZE) {
      throw new TrackingError(
        413,
        "OBSERVATION_BATCH_TOO_LARGE",
        `A batch may contain at most ${MAXIMUM_BATCH_SIZE} observations`,
      );
    }
    this.#consumeIngestionCapacity(actor, body.observations.length, now);
    const result: TrackingObservationBatchResult = {
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      serverTime: now.toISOString(),
      errors: [],
    };
    const affectedTags = new Set<string>();
    for (const [index, raw] of body.observations.entries()) {
      let resolvedInput: ResolvedAdvertisement;
      try {
        resolvedInput = advertisementFromInput(parseInput(raw));
      } catch {
        result.rejected += 1;
        result.errors.push({ index, code: "INVALID_OBSERVATION" });
        continue;
      }
      const { input, advertisement } = resolvedInput;
      const identity = this.#authorizedObserver(actor, input.observerId, input.propertyId);
      if (!identity) {
        result.rejected += 1;
        result.errors.push({ index, code: "OBSERVER_SCOPE_MISMATCH" });
        continue;
      }
      const observerType = identity.observer.type;
      const mobile = observerType === "ios-phone" || observerType === "android-phone";
      const unavailableMode = (mobile && !this.flags["tracking.mobileObserver.enabled"])
        || (observerType === "ios-phone"
          && input.appState === "background"
          && !this.flags["tracking.mobileObserver.iosBackground.enabled"])
        || (observerType === "android-phone"
          && input.appState === "background"
          && !this.flags["tracking.mobileObserver.androidBackground.enabled"])
        || (observerType === "android-gateway"
          && !this.flags["tracking.androidGatewayMode.enabled"]);
      if (unavailableMode) {
        result.rejected += 1;
        result.errors.push({ index, code: "TRACKING_DISABLED" });
        continue;
      }
      const settings = this.store.propertySettings(input.propertyId);
      if (!settings.enabled) {
        result.rejected += 1;
        result.errors.push({ index, code: "TRACKING_DISABLED" });
        continue;
      }
      const resolution = this.#resolve(input.propertyId, advertisement);
      const qualityFlags = this.#qualityFlags(
        input,
        advertisement,
        identity.observer,
        now,
        settings.unknownSeconds,
        resolution.candidate?.tag.rotationWindowMinutes ?? null,
      );
      if (resolution.flag && !qualityFlags.includes(resolution.flag)) qualityFlags.push(resolution.flag);
      const accepted = !qualityFlags.some((flag) => INVALIDATING_FLAGS.has(flag));
      const observation: TrackingObservation = {
        id: input.observationId,
        tenantId: this.tenantId,
        propertyId: input.propertyId,
        tagId: resolution.candidate?.tag.id ?? null,
        observerId: identity.observer.id,
        observerType: identity.observer.type,
        observedAt: input.observedAt,
        receivedAt: now.toISOString(),
        rotatingTagId: input.rotatingTagId,
        protocolVersion: input.protocolVersion,
        epochCounter: input.epochCounter,
        eventCounter: input.eventCounter,
        rssi: input.rssi,
        txPower: input.txPower ?? null,
        motion: Boolean(advertisement.flags & TRACKING_FLAGS.moving),
        batteryPercent: advertisement.batteryPercent,
        observerPosition: input.observerPosition ?? null,
        scanMode: input.scanMode,
        appState: input.appState ?? null,
        deviceTimeOffsetMs: input.deviceTimeOffsetMs ?? null,
        qualityFlags,
        accepted,
        metadata: input.metadata ?? {},
      };
      const inserted = this.store.insertObservation(
        observation,
        input.rawPayload ?? null,
        observationDedupKey(input),
      );
      if (inserted === "duplicate") {
        result.duplicates += 1;
        continue;
      }
      if (!accepted) {
        result.rejected += 1;
        result.errors.push({
          index,
          code: resolution.flag ?? qualityFlags.find((flag) => INVALIDATING_FLAGS.has(flag))
            ?? "INVALID_OBSERVATION",
        });
        continue;
      }
      result.accepted += 1;
      const tag = resolution.candidate!.tag;
      const previousBattery = tag.batteryPercent;
      this.store.touchTag(tag.id, observation.observedAt, observation.batteryPercent);
      affectedTags.add(tag.id);
      const updatedTag = this.store.getTag(tag.id)!;
      if (updatedTag.lastSeenAt === observation.observedAt
        && updatedTag.batteryPercent !== null
        && updatedTag.batteryPercent <= 20
        && (previousBattery === null || previousBattery > 20)) {
        this.#appendEvent("tag.battery.low", updatedTag, [observation.id]);
      }
    }
    for (const tagId of affectedTags) this.recalculateTag(tagId, now);
    this.redactExpiredMobileCoordinates(now);
    return result;
  }

  recalculateTag(tagId: string, now = new Date()): AssetPositionEstimate | null {
    const assignment = this.store.activeAssignmentForTag(tagId);
    const tag = this.store.getTag(tagId);
    if (!assignment || !tag) return null;
    const equipment = this.store.core.getAreaEquipment(assignment.equipmentId);
    if (!equipment || equipment.propertyId !== tag.propertyId) return null;
    const settings = this.store.propertySettings(equipment.propertyId);
    const previous = this.store.currentPosition(equipment.id);
    const observations = this.store.recentAcceptedObservationsForTag(
      tagId,
      new Date(now.getTime() - settings.unknownSeconds * 1_000).toISOString(),
    );
    const inferenceObservations = this.flags["tracking.experimentalCoordinateInference.enabled"]
      ? observations
      : observations.map((entry) => ({
        observation: { ...entry.observation, observerPosition: null },
        observer: {
          ...entry.observer,
          fixedPosition: null,
          fixedPositionAccuracyMeters: null,
        },
      }));
    const inferred = inferTrackedEquipmentPosition({
      equipmentId: equipment.id,
      propertyId: equipment.propertyId,
      observations: inferenceObservations,
      previous,
      settings,
      zones: this.store.core.listPropertyAreas(equipment.propertyId, 500),
      now,
    });
    if (sameEstimate(previous, inferred)) return previous;
    const estimate = this.store.savePosition(inferred);
    this.#appendEvent("asset.position.updated", estimate, estimate.evidenceObservationIds);
    if (previous?.zoneId !== estimate.zoneId && estimate.zoneId) {
      this.#appendEvent("asset.zone.changed", estimate, estimate.evidenceObservationIds);
    }
    if (previous?.movementState !== estimate.movementState) {
      if (estimate.movementState === "moving") {
        this.#appendEvent("asset.movement.started", estimate, estimate.evidenceObservationIds);
      } else if (estimate.movementState === "stationary" && previous?.movementState === "moving") {
        this.#appendEvent("asset.movement.stopped", estimate, estimate.evidenceObservationIds);
      }
    }
    if (estimate.freshnessState === "stale"
      && previous?.freshnessState !== "stale"
      && previous?.freshnessState !== "unknown") {
      this.#appendEvent("tag.not_seen", tag, estimate.evidenceObservationIds);
    }
    if (this.flags["tracking.exitAlerts.enabled"]
      && settings.propertyBoundary.length >= 3
      && estimate.coordinate
      && estimate.confidence >= settings.minimumMovementConfidence) {
      const transition = this.store.evaluateBoundaryTransition(
        equipment.id,
        trackingPointInPolygon(estimate.coordinate, settings.propertyBoundary),
        settings.exitAlertDebounceSeconds,
        now,
      );
      if (transition === "entered") {
        this.#appendEvent("asset.property.entered", estimate, estimate.evidenceObservationIds);
      } else if (transition === "exited") {
        this.#appendEvent("asset.property.exited", estimate, estimate.evidenceObservationIds);
      }
    }
    return estimate;
  }

  refreshProperty(propertyId: string, now = new Date()): void {
    this.requireEnabled();
    const settings = this.store.propertySettings(propertyId);
    for (const item of this.store.trackedEquipment(propertyId)) {
      if (!item.assignment) continue;
      const position = item.position;
      if (!position?.lastObservedAt) {
        this.recalculateTag(item.assignment.tagId, now);
        continue;
      }
      const ageSeconds = Math.max(0, (now.getTime() - Date.parse(position.lastObservedAt)) / 1_000);
      const expectedFreshness = ageSeconds <= settings.liveNearbySeconds
        ? "live"
        : ageSeconds <= settings.recentlySeenSeconds
          ? "recent"
          : ageSeconds <= settings.staleSeconds
            ? "last-known"
            : ageSeconds <= settings.unknownSeconds
              ? "stale"
              : "unknown";
      if (position.freshnessState !== expectedFreshness) {
        this.recalculateTag(item.assignment.tagId, now);
      }
    }
    for (const observer of this.store.refreshGatewayHealth(now)) {
      this.#appendEvent(
        observer.status === "offline" ? "gateway.offline" : "gateway.online",
        observer,
      );
    }
    for (const location of this.store.removeExpiredMemberLocations(now)) {
      this.#appendEvent("member.location.stopped", this.#memberLocationSignal(
        location,
        false,
        now.toISOString(),
      ));
    }
    this.redactExpiredMobileCoordinates(now);
  }

  redactExpiredMobileCoordinates(now = new Date()): number {
    const cutoff = new Date(
      now.getTime() - this.rawMobileCoordinateRetentionHours * 60 * 60_000,
    ).toISOString();
    return this.store.redactMobileObserverCoordinatesBefore(cutoff);
  }

  mapSnapshot(propertyId: string, now = new Date()): TrackingMapSnapshot {
    this.requireFeature("tracking.liveMap.enabled", "The live equipment map is not enabled");
    this.refreshProperty(propertyId, now);
    const assets = this.store.trackedEquipment(propertyId)
      .filter((item): item is TrackedEquipmentState => Boolean(item.assignment));
    return {
      propertyId,
      generatedAt: now.toISOString(),
      sequence: this.store.latestSequence(propertyId),
      settings: this.store.propertySettings(propertyId),
      zones: this.store.core.listPropertyAreas(propertyId, 500),
      gateways: this.store.listObservers(propertyId).filter((observer) => (
        observer.type === "esp32-gateway"
        || observer.type === "linux-gateway"
        || observer.type === "android-gateway"
      )),
      assets,
      members: this.flags["tracking.userLocationSharing.enabled"]
        ? this.store.memberLocations(propertyId, now)
        : [],
    };
  }

  equipmentLoans(
    propertyId: string,
    options: { equipmentId?: string; activeOnly?: boolean; limit?: number } = {},
  ): EquipmentLoan[] {
    return this.store.listEquipmentLoans(propertyId, options);
  }

  borrowEquipment(
    equipmentId: string,
    userId: string,
    memberLabel: string,
    input: EquipmentBorrowInput,
    now = new Date(),
  ): EquipmentLoan {
    return this.store.borrowEquipment(equipmentId, userId, memberLabel, input, now);
  }

  returnEquipment(
    loanId: string,
    userId: string,
    memberLabel: string,
    input: EquipmentReturnInput,
    now = new Date(),
  ): EquipmentLoan {
    return this.store.returnEquipment(loanId, userId, memberLabel, input, now);
  }

  memberLocations(propertyId: string, now = new Date()): PropertyMemberLocation[] {
    for (const location of this.store.removeExpiredMemberLocations(now)) {
      this.#appendEvent("member.location.stopped", this.#memberLocationSignal(
        location,
        false,
        now.toISOString(),
      ));
    }
    this.requireFeature(
      "tracking.userLocationSharing.enabled",
      "Property member location sharing is not enabled",
    );
    return this.store.memberLocations(propertyId, now);
  }

  shareMemberLocation(
    propertyId: string,
    userId: string,
    memberLabel: string,
    input: PropertyMemberLocationInput,
    now = new Date(),
  ): PropertyMemberLocation {
    this.requireFeature(
      "tracking.userLocationSharing.enabled",
      "Property member location sharing is not enabled",
    );
    if (!Number.isFinite(input.horizontalAccuracyMeters)
      || input.horizontalAccuracyMeters < 0
      || input.horizontalAccuracyMeters > 10_000) {
      throw new TrackingError(
        400,
        "INVALID_FIELD",
        "horizontalAccuracyMeters must be from 0 to 10000",
      );
    }
    const capturedAt = Date.parse(input.capturedAt);
    if (!Number.isFinite(capturedAt)
      || capturedAt < now.getTime() - 2 * 60_000
      || capturedAt > now.getTime() + 60_000) {
      throw new TrackingError(
        422,
        "LOCATION_NOT_CURRENT",
        "Shared member location must have been captured recently",
      );
    }
    const sharingUntil = Date.parse(input.sharingUntil);
    if (!Number.isFinite(sharingUntil)
      || sharingUntil <= now.getTime()
      || sharingUntil > now.getTime() + 4 * 60 * 60_000) {
      throw new TrackingError(
        422,
        "INVALID_SHARING_WINDOW",
        "Location sharing must end within the next four hours",
      );
    }
    const location = this.store.upsertMemberLocation(
      propertyId,
      userId,
      memberLabel,
      input,
      now,
    );
    this.#appendEvent(
      "member.location.updated",
      this.#memberLocationSignal(location, true, location.updatedAt),
    );
    return location;
  }

  stopMemberLocation(
    propertyId: string,
    userId: string,
    now = new Date(),
  ): PropertyMemberLocation | null {
    const location = this.store.stopMemberLocation(propertyId, userId);
    if (location) {
      this.#appendEvent(
        "member.location.stopped",
        this.#memberLocationSignal(location, false, now.toISOString()),
      );
    }
    return location;
  }

  #memberLocationSignal(
    location: Pick<PropertyMemberLocation, "id" | "propertyId">,
    active: boolean,
    updatedAt: string,
  ): PropertyMemberLocationSignal {
    return {
      id: location.id,
      propertyId: location.propertyId,
      active,
      updatedAt,
      version: 1,
    };
  }

  equipmentObservations(
    equipmentId: string,
    limit: number,
    includeMobileCoordinates: boolean,
  ): TrackingObservation[] {
    return this.store.equipmentObservations(equipmentId, limit).map((observation) => (
      includeMobileCoordinates
        || (observation.observerType !== "ios-phone"
          && observation.observerType !== "android-phone")
        ? observation
        : { ...observation, observerPosition: null }
    ));
  }

  scanToken(equipmentId: string, now = new Date()): TrackingScanToken {
    this.requireFeature("tracking.mobileObserver.enabled", "Mobile observation is not enabled");
    const assignment = this.store.activeAssignmentForEquipment(equipmentId);
    if (!assignment) {
      throw new TrackingError(409, "EQUIPMENT_NOT_TRACKED", "This equipment does not have an active tracking tag");
    }
    const tag = this.store.getTag(assignment.tagId);
    if (!tag || tag.status !== "active") {
      throw new TrackingError(409, "TRACKING_TAG_NOT_ACTIVE", "This equipment's tracking tag is not active");
    }
    const secret = this.store.tagSecret(tag.id);
    const currentEpoch = trackingEpochCounter(now, tag.rotationWindowMinutes);
    const epochs = [
      (currentEpoch + 0xffff) & 0xffff,
      currentEpoch,
      (currentEpoch + 1) & 0xffff,
    ];
    const windowMilliseconds = tag.rotationWindowMinutes * 60_000;
    const nextBoundary = (Math.floor(now.getTime() / windowMilliseconds) + 1) * windowMilliseconds;
    return {
      equipmentId,
      bleServiceUuid: STUGA_TRACKING_BLE_SERVICE_UUID,
      protocolVersion: tag.protocolVersion,
      rotatingTagIds: epochs.map((epoch) => rotatingTagId(secret, tag.protocolVersion, epoch)),
      validUntil: new Date(nextBoundary).toISOString(),
    };
  }

  heartbeat(
    identity: AuthenticatedTrackingObserver,
    input: { status?: TrackingObserver["status"]; hardwareMetadata?: TrackingObserver["hardwareMetadata"] },
  ): TrackingObserver {
    this.requireEnabled();
    const previous = this.store.getObserver(identity.observer.id);
    const observer = this.store.heartbeatObserver(identity.observer.id, input);
    if (previous?.status === "offline" && observer.status === "online") {
      this.#appendEvent("gateway.online", observer);
    }
    return observer;
  }
}
