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
import { MAXIMUM_BATCH_SIZE, ResolutionCandidate, STUGA_TRACKING_BLE_SERVICE_UUID, TrackingEventListener, TrackingIngestionActor, adjacentEpoch } from "../support/01-default-tracking-feature-flags-to-same-estimate.js";
import { registerTrackingServiceMethods, trackingServiceState, type TrackingServiceInternals } from "../core.js";

registerTrackingServiceMethods({
  start(this: TrackingServiceInternals, refreshIntervalMilliseconds = 15_000): void {
      if (!this.enabled || this[trackingServiceState].refreshTimer) return;
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
      this[trackingServiceState].refreshTimer = setInterval(
        refresh,
        Math.max(5_000, refreshIntervalMilliseconds),
      );
      this[trackingServiceState].refreshTimer.unref();
    },
  stop(this: TrackingServiceInternals): void {
      if (!this[trackingServiceState].refreshTimer) return;
      clearInterval(this[trackingServiceState].refreshTimer);
      this[trackingServiceState].refreshTimer = null;
    },
  capabilities(this: TrackingServiceInternals): TrackingCapabilities {
      return {
        flags: { ...this.flags },
        bleServiceUuid: STUGA_TRACKING_BLE_SERVICE_UUID,
        protocolVersions: [TRACKING_PROTOCOL_VERSION],
        maximumObservationBatchSize: MAXIMUM_BATCH_SIZE,
        observerModes: ["passive", "property", "active-property", "find-nearby", "gateway"],
      };
    },
  requireEnabled(this: TrackingServiceInternals): void {
      if (!this.enabled) {
        throw new TrackingError(404, "TRACKING_DISABLED", "Equipment tracking is not enabled");
      }
    },
  requireFeature(this: TrackingServiceInternals, flag: keyof TrackingFeatureFlags, message: string): void {
      this.requireEnabled();
      if (!this.flags[flag]) throw new TrackingError(404, "TRACKING_FEATURE_DISABLED", message);
    },
  authenticateObserverCredential(this: TrackingServiceInternals, credential: string): AuthenticatedTrackingObserver | null {
      return this.enabled ? this.store.authenticateObserverCredential(credential) : null;
    },
  invalidateTagResolution(this: TrackingServiceInternals): void {
      this[trackingServiceState].resolutionCache.clear();
    },
  subscribe(this: TrackingServiceInternals, propertyId: string, listener: TrackingEventListener): () => void {
      const listeners = this[trackingServiceState].listeners.get(propertyId) ?? new Set<TrackingEventListener>();
      listeners.add(listener);
      this[trackingServiceState].listeners.set(propertyId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) this[trackingServiceState].listeners.delete(propertyId);
      };
    },
  __publish(this: TrackingServiceInternals, event: TrackingEvent): void {
      for (const listener of this[trackingServiceState].listeners.get(event.propertyId) ?? []) listener(event);
    },
  __appendEvent(this: TrackingServiceInternals,
      type: TrackingEvent["type"],
      state: TrackingEvent["state"],
      evidenceObservationIds: string[] = [],
    ): TrackingEvent {
      const event = this.store.appendEvent(type, this.tenantId, state, evidenceObservationIds);
      this.__publish(event);
      return event;
    },
  __epochResolution(this: TrackingServiceInternals,
      propertyId: string,
      protocolVersion: number,
      epochCounter: number,
    ): Map<string, ResolutionCandidate[]> {
      const key = `${propertyId}:${protocolVersion}:${epochCounter}`;
      const cached = this[trackingServiceState].resolutionCache.get(key);
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
      this[trackingServiceState].resolutionCache.set(key, result);
      if (this[trackingServiceState].resolutionCache.size > 64) {
        const first = this[trackingServiceState].resolutionCache.keys().next().value as string | undefined;
        if (first) this[trackingServiceState].resolutionCache.delete(first);
      }
      return result;
    },
  __resolve(this: TrackingServiceInternals,
      propertyId: string,
      advertisement: TrackingAdvertisement,
    ): { candidate: ResolutionCandidate | null; flag: TrackingObservationQualityFlag | null } {
      if (advertisement.protocolVersion !== TRACKING_PROTOCOL_VERSION) {
        return { candidate: null, flag: "UNRESOLVED_TAG" };
      }
      const candidates = this.__epochResolution(
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
    },
  __consumeIngestionCapacity(this: TrackingServiceInternals,
      actor: TrackingIngestionActor,
      observations: number,
      now: Date,
    ): void {
      const key = actor.machineObserver
        ? `observer:${actor.machineObserver.observer.id}`
        : `user:${actor.userId ?? "unknown"}`;
      const timestamp = now.getTime();
      const current = this[trackingServiceState].ingestionWindows.get(key);
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
      this[trackingServiceState].ingestionWindows.set(key, window);
      if (this[trackingServiceState].ingestionWindows.size > 10_000) {
        for (const [candidate, value] of this[trackingServiceState].ingestionWindows) {
          if (timestamp - value.startedAt >= 60_000) this[trackingServiceState].ingestionWindows.delete(candidate);
        }
      }
    },
  __authorizedObserver(this: TrackingServiceInternals,
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
    },
  __qualityFlags(this: TrackingServiceInternals,
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
    },
});
