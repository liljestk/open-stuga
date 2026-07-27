import {
  TRACKING_PROFILE_SCHEMA_VERSION,
  TRACKING_SCHEMA_VERSION,
  type EquipmentBorrowInput,
  type EquipmentLoan,
  type EquipmentLocationEstimate,
  type EquipmentManualLocationInput,
  type EquipmentReturnInput,
  type PropertyMemberLocation,
  type PropertyMemberLocationInput,
  type PropertyMemberLocationSignal,
  type TrackingCapabilities,
  type TrackingEvent,
  type TrackingFeatureFlags,
  type TrackingFindDescriptor,
  type TrackingGatewayRollupInput,
  type TrackingMapSnapshot,
  type TrackingObservation,
  type TrackingObservationBatchError,
  type TrackingObservationBatchInput,
  type TrackingObservationBatchResult,
  type TrackingObservationInput,
  type TrackingObserver,
  type TrackingResolutionManifest,
} from "@climate-twin/contracts";
import { inferTrackedEquipmentPosition, trackingPointInPolygon } from "./inference.js";
import { trackingProfile, trackingProfileManifest } from "./profiles.js";
import {
  observationQualityFlags,
  observationTemporalError,
  observationTrust,
  sameLocationEstimate,
  validRollupWindow,
} from "./service-evidence.js";
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
  "tracking.userLocationSharing.enabled": false,
};
const MAXIMUM_OBSERVATION_BATCH_SIZE = 100;
const MAXIMUM_ROLLUP_BATCH_SIZE = 100;
export interface TrackingIngestionActor {
  machineObserver: AuthenticatedTrackingObserver | null;
  userId: string | null;
  administrator: boolean;
  canWriteProperty: (propertyId: string) => boolean;
}
export interface TrackingServiceOptions {
  flags: TrackingFeatureFlags;
  tenantId?: string;
  maximumObservationsPerMinute?: number;
}
type EventListener = (event: TrackingEvent) => void;
interface AuthorizedEvidence {
  observer: TrackingObserver;
  bindingId: string;
  endpointProfileId: string;
  endpointProfileVersion: string;
}
export class TrackingService {
  readonly flags: TrackingFeatureFlags;
  readonly tenantId: string;
  private readonly maximumObservationsPerMinute: number;
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly ingestionWindows = new Map<string, { startedAt: number; evidence: number }>();
  private refreshTimer: NodeJS.Timeout | null = null;
  constructor(readonly store: TrackingStore, options: TrackingServiceOptions) {
    this.flags = { ...options.flags };
    this.tenantId = options.tenantId ?? "local";
    this.maximumObservationsPerMinute = Math.max(
      MAXIMUM_OBSERVATION_BATCH_SIZE,
      Math.round(options.maximumObservationsPerMinute ?? 12_000),
    );
  }
  get enabled(): boolean {
    return this.flags["tracking.enabled"];
  }
  start(refreshIntervalMilliseconds = 30_000): void {
    if (!this.enabled || this.refreshTimer) return;
    const refresh = () => {
      const now = new Date();
      for (const observer of this.store.refreshGatewayHealth(now)) {
        this.appendEvent(observer.status === "offline" ? "gateway.offline" : "gateway.online", observer);
      }
      for (const location of this.store.people.removeExpiredMemberLocations(now)) {
        this.appendEvent("member.location.stopped", this.memberLocationSignal(location, false, now.toISOString()));
      }
      for (const propertyId of this.store.activePropertyIds()) this.refreshProperty(propertyId, now);
    };
    this.refreshTimer = setInterval(refresh, Math.max(5_000, refreshIntervalMilliseconds));
    this.refreshTimer.unref();
  }
  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
  capabilities(): TrackingCapabilities {
    return {
      schemaVersion: TRACKING_SCHEMA_VERSION,
      profileSchemaVersion: TRACKING_PROFILE_SCHEMA_VERSION,
      flags: { ...this.flags },
      maximumObservationBatchSize: MAXIMUM_OBSERVATION_BATCH_SIZE,
      maximumRollupBatchSize: MAXIMUM_ROLLUP_BATCH_SIZE,
      observerTypes: [
        "esp32-gateway",
        "linux-gateway",
        "android-gateway",
        "android-phone",
        "ios-phone",
      ],
    };
  }

  profileManifest() {
    return trackingProfileManifest();
  }

  requireEnabled(): void {
    if (!this.enabled) throw new TrackingError(404, "TRACKING_DISABLED", "Equipment tracking is not enabled");
  }

  requireFeature(flag: keyof TrackingFeatureFlags, message: string): void {
    this.requireEnabled();
    if (!this.flags[flag]) throw new TrackingError(404, "TRACKING_FEATURE_DISABLED", message);
  }

  authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null {
    return this.store.authenticateObserverCredential(credential);
  }

  subscribe(propertyId: string, listener: EventListener): () => void {
    const propertyListeners = this.listeners.get(propertyId) ?? new Set<EventListener>();
    propertyListeners.add(listener);
    this.listeners.set(propertyId, propertyListeners);
    return () => {
      propertyListeners.delete(listener);
      if (propertyListeners.size === 0) this.listeners.delete(propertyId);
    };
  }

  ingest(
    batch: TrackingObservationBatchInput,
    actor: TrackingIngestionActor,
    now = new Date(),
  ): TrackingObservationBatchResult {
    this.requireEnabled();
    const observations = batch.observations;
    const rollups = batch.rollups ?? [];
    if (observations.length > MAXIMUM_OBSERVATION_BATCH_SIZE || rollups.length > MAXIMUM_ROLLUP_BATCH_SIZE) {
      throw new TrackingError(413, "BATCH_TOO_LARGE", "Tracking evidence batch exceeds the supported size");
    }
    this.consumeCapacity(actor, observations.length + rollups.length, now);
    const errors: TrackingObservationBatchError[] = [];
    const affectedEquipment = new Set<string>();
    let accepted = 0;
    let duplicates = 0;
    observations.forEach((input, index) => {
      const authorization = this.authorizeEvidence(input, actor);
      if (typeof authorization === "string") {
        errors.push({ kind: "observation", index, id: input.observationId || null, code: authorization });
        return;
      }
      const temporalError = observationTemporalError(input, now);
      if (temporalError) {
        errors.push({ kind: "observation", index, id: input.observationId, code: temporalError });
        return;
      }
      const flags = observationQualityFlags(input, authorization.observer, now);
      const stored = this.store.evidence.insertObservation({
        input,
        tenantId: this.tenantId,
        bindingId: authorization.bindingId,
        observerType: authorization.observer.type,
        receivedAt: now.toISOString(),
        qualityFlags: flags,
        trust: observationTrust(authorization.observer, flags),
      });
      if (stored.duplicate) {
        duplicates += 1;
        return;
      }
      accepted += 1;
      affectedEquipment.add(input.equipmentId);
      this.store.touchEndpoint(input.endpointId, input.observedAt, {
        ...(input.batteryPercent === undefined ? {} : { batteryPercent: input.batteryPercent }),
        ...(input.motion === undefined ? {} : { motion: input.motion }),
        ...(input.counter === undefined ? {} : { counter: input.counter }),
        ...(input.telemetry ?? {}),
      });
    });
    rollups.forEach((input, index) => {
      const authorization = this.authorizeEvidence(input, actor);
      if (typeof authorization === "string") {
        errors.push({ kind: "rollup", index, id: input.rollupId || null, code: authorization });
        return;
      }
      if (!["esp32-gateway", "linux-gateway", "android-gateway"].includes(authorization.observer.type)
        || !authorization.observer.fixedPosition && !authorization.observer.zoneId
        || !validRollupWindow(input, now)) {
        errors.push({ kind: "rollup", index, id: input.rollupId, code: "INVALID_EVIDENCE" });
        return;
      }
      const stored = this.store.evidence.insertRollup({
        input,
        tenantId: this.tenantId,
        bindingId: authorization.bindingId,
        receivedAt: now.toISOString(),
      });
      if (stored.duplicate) {
        duplicates += 1;
        return;
      }
      accepted += 1;
      affectedEquipment.add(input.equipmentId);
      this.store.touchEndpoint(input.endpointId, input.windowEndedAt, {
        ...(input.lastBatteryPercent === undefined ? {} : { batteryPercent: input.lastBatteryPercent }),
        ...(input.motionObserved === undefined ? {} : { motion: input.motionObserved }),
        ...(input.lastCounter === undefined ? {} : { counter: input.lastCounter }),
        ...(input.telemetry ?? {}),
      });
    });
    for (const equipmentId of affectedEquipment) this.recalculateEquipment(equipmentId, now);
    return {
      accepted,
      duplicates,
      rejected: errors.length,
      serverTime: now.toISOString(),
      errors,
    };
  }

  recalculateEquipment(equipmentId: string, now = new Date()): EquipmentLocationEstimate | null {
    const binding = this.store.activeBindingForEquipment(equipmentId);
    if (!binding) return null;
    const endpoint = this.store.getEndpoint(binding.endpointId);
    const profile = endpoint ? trackingProfile(endpoint.profileId, endpoint.profileVersion)?.profile : null;
    if (!endpoint || !profile) return null;
    const settings = this.store.propertySettings(binding.propertyId);
    const dataMode = this.store.dataMode();
    const recent = this.store.evidence.recentEvidence(
      equipmentId,
      dataMode,
      new Date(now.getTime() - Math.max(settings.staleSeconds, 300) * 1_000).toISOString(),
    );
    const observations = recent.observations.flatMap((observation) => {
      const observer = this.store.getObserver(observation.observerId);
      return observer ? [{ observation, observer }] : [];
    });
    const rollups = recent.rollups.flatMap((rollup) => {
      const observer = this.store.getObserver(rollup.observerId);
      return observer ? [{ rollup, observer }] : [];
    });
    const previous = this.store.evidence.currentPosition(equipmentId, dataMode);
    const draft = inferTrackedEquipmentPosition({
      dataMode,
      equipmentId,
      propertyId: binding.propertyId,
      endpointId: endpoint.id,
      mapCapability: profile.capabilities.mapCapability,
      observations,
      rollups,
      previous,
      settings,
      now,
    });
    if (previous && sameLocationEstimate(previous, draft)) return previous;
    const estimate = this.store.evidence.savePosition(draft);
    this.appendEvent("equipment.position.updated", estimate, estimate.provenance.observationIds);
    if (previous?.zoneId !== estimate.zoneId && (previous?.zoneId || estimate.zoneId)) {
      this.appendEvent("equipment.zone.changed", estimate, estimate.provenance.observationIds);
    }
    if (previous?.movementState !== estimate.movementState) {
      if (estimate.movementState === "moving") {
        this.appendEvent("equipment.movement.started", estimate, estimate.provenance.observationIds);
      } else if (previous?.movementState === "moving") {
        this.appendEvent("equipment.movement.stopped", estimate, estimate.provenance.observationIds);
      }
    }
    const hasCurrentEvidence = estimate.provenance.observationIds.length + estimate.provenance.rollupIds.length > 0;
    if (this.flags["tracking.exitAlerts.enabled"] && hasCurrentEvidence
      && estimate.coordinate && estimate.confidence >= 0.65
      && (estimate.freshness === "live" || estimate.freshness === "recent")
      && settings.propertyBoundary.length >= 3) {
      const transition = this.store.evidence.evaluateBoundaryTransition(
        equipmentId,
        dataMode,
        trackingPointInPolygon(estimate.coordinate, settings.propertyBoundary),
        settings.exitAlertDebounceSeconds,
        now,
      );
      if (transition) {
        this.appendEvent(
          transition === "entered" ? "equipment.property.entered" : "equipment.property.exited",
          estimate,
          estimate.provenance.observationIds,
        );
      }
    }
    return estimate;
  }

  setManualLocation(
    equipmentId: string,
    input: EquipmentManualLocationInput,
    now = new Date(),
  ): EquipmentLocationEstimate {
    this.requireEnabled();
    if (input.dataMode !== this.store.dataMode()) {
      throw new TrackingError(409, "DATA_MODE_MISMATCH", "Manual location must use the active data mode");
    }
    const binding = this.store.activeBindingForEquipment(equipmentId);
    const equipment = this.store.core.getAreaEquipment(equipmentId);
    if (!binding || !equipment) throw new TrackingError(409, "EQUIPMENT_NOT_TRACKED", "Equipment has no active tracking binding");
    if ((input.coordinate ? 1 : 0) + (input.zoneId ? 1 : 0) !== 1) {
      throw new TrackingError(422, "INVALID_MANUAL_LOCATION", "Provide exactly one coordinate or zone");
    }
    if (input.zoneId) {
      const zone = this.store.core.getPropertyArea(input.zoneId);
      if (!zone || zone.propertyId !== equipment.propertyId) {
        throw new TrackingError(409, "ZONE_SCOPE_MISMATCH", "Zone does not belong to the equipment Property");
      }
    }
    const observedAt = new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > now.getTime() + 60_000) {
      throw new TrackingError(422, "INVALID_OBSERVED_AT", "Manual location time is invalid");
    }
    const previous = this.store.evidence.currentPosition(equipmentId, input.dataMode);
    const estimate = this.store.evidence.savePosition({
      dataMode: input.dataMode,
      equipmentId,
      propertyId: equipment.propertyId,
      endpointId: binding.endpointId,
      calculatedAt: now.toISOString(),
      effectiveAt: observedAt.toISOString(),
      kind: input.coordinate ? "coordinate" : "zone",
      coordinate: input.coordinate ?? null,
      uncertaintyRadiusMeters: input.coordinate ? input.uncertaintyRadiusMeters ?? 5 : null,
      zoneId: input.zoneId ?? null,
      confidence: 1,
      truthClass: "observed",
      source: "manual",
      freshness: "recent",
      movementState: "unknown",
      lastObservedAt: observedAt.toISOString(),
      observerCount: 0,
      provenance: {
        algorithm: "manual",
        observationIds: [],
        rollupIds: [],
        observerIds: [],
        profileVersions: [],
        factors: ["An authorized Property member set this location explicitly."],
      },
    });
    this.appendEvent("equipment.position.updated", estimate);
    if (previous?.zoneId !== estimate.zoneId) this.appendEvent("equipment.zone.changed", estimate);
    return estimate;
  }

  refreshProperty(propertyId: string, now = new Date()): void {
    const settings = this.store.propertySettings(propertyId);
    for (const binding of this.store.listBindings(propertyId)) this.recalculateEquipment(binding.equipmentId, now);
    this.store.evidence.purge(propertyId, settings, now);
  }

  mapSnapshot(propertyId: string, now = new Date()): TrackingMapSnapshot {
    this.requireEnabled();
    this.refreshProperty(propertyId, now);
    return {
      propertyId,
      dataMode: this.store.dataMode(),
      generatedAt: now.toISOString(),
      sequence: this.store.evidence.latestSequence(propertyId, this.store.dataMode()),
      settings: this.store.propertySettings(propertyId),
      zones: this.store.core.listPropertyAreas(propertyId),
      gateways: this.store.listObservers(propertyId).filter((observer) => (
        observer.type === "esp32-gateway"
        || observer.type === "linux-gateway"
        || observer.type === "android-gateway"
      )),
      equipment: this.store.trackedEquipment(propertyId),
      members: this.flags["tracking.userLocationSharing.enabled"]
        ? this.store.people.memberLocations(propertyId, now)
        : [],
    };
  }

  findDescriptor(equipmentId: string, now = new Date()): TrackingFindDescriptor {
    this.requireFeature("tracking.mobileObserver.enabled", "Mobile observation is not enabled");
    const binding = this.store.activeBindingForEquipment(equipmentId);
    const endpoint = binding ? this.store.getEndpoint(binding.endpointId) : null;
    const profile = endpoint ? trackingProfile(endpoint.profileId, endpoint.profileVersion) : null;
    if (!binding || !endpoint || !profile) {
      throw new TrackingError(409, "EQUIPMENT_NOT_TRACKED", "Equipment has no supported active tracking binding");
    }
    return {
      equipmentId,
      endpointId: endpoint.id,
      profile,
      identityFields: this.store.endpointIdentityFields(endpoint.id),
      validUntil: new Date(now.getTime() + 10 * 60_000).toISOString(),
    };
  }

  resolutionManifest(
    observerIdentity: AuthenticatedTrackingObserver,
    now = new Date(),
  ): TrackingResolutionManifest {
    this.requireEnabled();
    const observer = observerIdentity.observer;
    const entries = this.store.listBindings(observer.propertyId).flatMap((binding) => {
      if (binding.observerId && binding.observerId !== observer.id) return [];
      const endpoint = this.store.getEndpoint(binding.endpointId);
      if (!endpoint
        || (endpoint.claimStatus !== "CLAIMED" && endpoint.claimStatus !== "DEGRADED")) return [];
      return [{
        equipmentId: binding.equipmentId,
        endpointId: endpoint.id,
        profileId: endpoint.profileId,
        profileVersion: endpoint.profileVersion,
        identityFields: this.store.endpointIdentityFields(endpoint.id),
      }];
    });
    return {
      propertyId: observer.propertyId,
      observerId: observer.id,
      dataMode: this.store.dataMode(),
      generatedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 15 * 60_000).toISOString(),
      entries,
    };
  }

  equipmentObservations(
    equipmentId: string,
    limit: number,
    includeMobileCoordinates: boolean,
  ): TrackingObservation[] {
    return this.store.evidence.equipmentObservations(equipmentId, this.store.dataMode(), limit)
      .map((observation) => includeMobileCoordinates
        || (observation.observerType !== "ios-phone" && observation.observerType !== "android-phone")
        ? observation
        : { ...observation, observerPosition: null });
  }

  equipmentLoans(
    propertyId: string,
    options: { equipmentId?: string; activeOnly?: boolean; limit?: number },
  ): EquipmentLoan[] {
    return this.store.people.listEquipmentLoans(propertyId, options);
  }

  borrowEquipment(
    equipmentId: string,
    userId: string,
    label: string,
    input: EquipmentBorrowInput,
  ): EquipmentLoan {
    return this.store.people.borrowEquipment(equipmentId, userId, label, input);
  }

  returnEquipment(
    loanId: string,
    userId: string,
    label: string,
    input: EquipmentReturnInput,
  ): EquipmentLoan {
    return this.store.people.returnEquipment(loanId, userId, label, input);
  }

  shareMemberLocation(
    propertyId: string,
    userId: string,
    label: string,
    input: PropertyMemberLocationInput,
    now = new Date(),
  ): PropertyMemberLocation {
    this.requireFeature("tracking.userLocationSharing.enabled", "Property member location sharing is not enabled");
    const location = this.store.people.upsertMemberLocation(propertyId, userId, label, input, now);
    this.appendEvent("member.location.updated", this.memberLocationSignal(location, true, location.updatedAt));
    return location;
  }

  stopMemberLocation(
    propertyId: string,
    userId: string,
    now = new Date(),
  ): PropertyMemberLocation | null {
    const location = this.store.people.stopMemberLocation(propertyId, userId);
    if (location) this.appendEvent(
      "member.location.stopped",
      this.memberLocationSignal(location, false, now.toISOString()),
    );
    return location;
  }

  memberLocations(propertyId: string): PropertyMemberLocation[] {
    return this.flags["tracking.userLocationSharing.enabled"]
      ? this.store.people.memberLocations(propertyId)
      : [];
  }

  heartbeat(
    identity: AuthenticatedTrackingObserver,
    input: { status?: TrackingObserver["status"]; hardwareMetadata?: TrackingObserver["hardwareMetadata"] },
  ): TrackingObserver {
    this.requireEnabled();
    const previous = this.store.getObserver(identity.observer.id);
    const observer = this.store.heartbeatObserver(identity.observer.id, input);
    if (previous?.status === "offline" && observer.status === "online") {
      this.appendEvent("gateway.online", observer);
    }
    return observer;
  }

  private authorizeEvidence(
    input: Pick<TrackingObservationInput, "dataMode" | "propertyId" | "endpointId" | "equipmentId" | "observerId" | "profileId" | "profileVersion">,
    actor: TrackingIngestionActor,
  ): AuthorizedEvidence | TrackingObservationBatchError["code"] {
    if (input.dataMode !== this.store.dataMode()) return "DATA_MODE_MISMATCH";
    const observerIdentity = this.store.observerIdentity(input.observerId);
    if (!observerIdentity || observerIdentity.observer.propertyId !== input.propertyId) {
      return "OBSERVER_SCOPE_MISMATCH";
    }
    if (actor.machineObserver) {
      if (actor.machineObserver.observer.id !== input.observerId) return "OBSERVER_SCOPE_MISMATCH";
    } else if (!actor.userId || !actor.canWriteProperty(input.propertyId)
      || (!actor.administrator && observerIdentity.createdByUserId !== actor.userId)) {
      return "OBSERVER_SCOPE_MISMATCH";
    }
    const endpoint = this.store.getEndpoint(input.endpointId);
    if (!endpoint || endpoint.propertyId !== input.propertyId) return "PROPERTY_SCOPE_MISMATCH";
    if (endpoint.claimStatus !== "CLAIMED" && endpoint.claimStatus !== "DEGRADED") return "NOT_CLAIMED";
    if (endpoint.profileId !== input.profileId || endpoint.profileVersion !== input.profileVersion) {
      return "PROFILE_VERSION_MISMATCH";
    }
    const binding = this.store.activeBindingForEndpoint(endpoint.id);
    if (!binding || binding.equipmentId !== input.equipmentId || binding.propertyId !== input.propertyId) {
      return "NO_ACTIVE_BINDING";
    }
    if (binding.observerId && binding.observerId !== input.observerId) return "OBSERVER_SCOPE_MISMATCH";
    return {
      observer: observerIdentity.observer,
      bindingId: binding.id,
      endpointProfileId: endpoint.profileId,
      endpointProfileVersion: endpoint.profileVersion,
    };
  }

  private consumeCapacity(actor: TrackingIngestionActor, count: number, now: Date): void {
    const key = actor.machineObserver?.observer.id ?? actor.userId ?? "anonymous";
    const current = this.ingestionWindows.get(key);
    if (!current || now.getTime() - current.startedAt >= 60_000) {
      this.ingestionWindows.set(key, { startedAt: now.getTime(), evidence: count });
      return;
    }
    if (current.evidence + count > this.maximumObservationsPerMinute) {
      throw new TrackingError(429, "TRACKING_RATE_LIMITED", "Tracking evidence rate limit exceeded");
    }
    current.evidence += count;
  }

  private appendEvent(
    type: TrackingEvent["type"],
    state: TrackingEvent["state"],
    evidenceObservationIds: string[] = [],
  ): TrackingEvent {
    const event = this.store.evidence.appendEvent(
      type,
      this.tenantId,
      this.store.dataMode(),
      state,
      evidenceObservationIds,
    );
    for (const listener of this.listeners.get(event.propertyId) ?? []) listener(event);
    return event;
  }

  private memberLocationSignal(
    location: Pick<PropertyMemberLocation, "id" | "propertyId">,
    active: boolean,
    updatedAt: string,
  ): PropertyMemberLocationSignal {
    return { id: location.id, propertyId: location.propertyId, active, updatedAt, version: 1 };
  }

}
