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
import { INVALIDATING_FLAGS, MAXIMUM_BATCH_SIZE, ResolvedAdvertisement, TrackingIngestionActor, advertisementFromInput, objectValue, observationDedupKey, parseInput, sameEstimate } from "../support/01-default-tracking-feature-flags-to-same-estimate.js";
import { registerTrackingServiceMethods, trackingServiceState, type TrackingServiceInternals } from "../core.js";

registerTrackingServiceMethods({
  ingest(this: TrackingServiceInternals, value: unknown, actor: TrackingIngestionActor, now = new Date()): TrackingObservationBatchResult {
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
      this.__consumeIngestionCapacity(actor, body.observations.length, now);
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
        const identity = this.__authorizedObserver(actor, input.observerId, input.propertyId);
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
        const resolution = this.__resolve(input.propertyId, advertisement);
        const qualityFlags = this.__qualityFlags(
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
          this.__appendEvent("tag.battery.low", updatedTag, [observation.id]);
        }
      }
      for (const tagId of affectedTags) this.recalculateTag(tagId, now);
      this.redactExpiredMobileCoordinates(now);
      return result;
    },
  recalculateTag(this: TrackingServiceInternals, tagId: string, now = new Date()): AssetPositionEstimate | null {
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
      this.__appendEvent("asset.position.updated", estimate, estimate.evidenceObservationIds);
      if (previous?.zoneId !== estimate.zoneId && estimate.zoneId) {
        this.__appendEvent("asset.zone.changed", estimate, estimate.evidenceObservationIds);
      }
      if (previous?.movementState !== estimate.movementState) {
        if (estimate.movementState === "moving") {
          this.__appendEvent("asset.movement.started", estimate, estimate.evidenceObservationIds);
        } else if (estimate.movementState === "stationary" && previous?.movementState === "moving") {
          this.__appendEvent("asset.movement.stopped", estimate, estimate.evidenceObservationIds);
        }
      }
      if (estimate.freshnessState === "stale"
        && previous?.freshnessState !== "stale"
        && previous?.freshnessState !== "unknown") {
        this.__appendEvent("tag.not_seen", tag, estimate.evidenceObservationIds);
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
          this.__appendEvent("asset.property.entered", estimate, estimate.evidenceObservationIds);
        } else if (transition === "exited") {
          this.__appendEvent("asset.property.exited", estimate, estimate.evidenceObservationIds);
        }
      }
      return estimate;
    },
  refreshProperty(this: TrackingServiceInternals, propertyId: string, now = new Date()): void {
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
        this.__appendEvent(
          observer.status === "offline" ? "gateway.offline" : "gateway.online",
          observer,
        );
      }
      for (const location of this.store.removeExpiredMemberLocations(now)) {
        this.__appendEvent("member.location.stopped", this.__memberLocationSignal(
          location,
          false,
          now.toISOString(),
        ));
      }
      this.redactExpiredMobileCoordinates(now);
    },
  redactExpiredMobileCoordinates(this: TrackingServiceInternals, now = new Date()): number {
      const cutoff = new Date(
        now.getTime() - this.rawMobileCoordinateRetentionHours * 60 * 60_000,
      ).toISOString();
      return this.store.redactMobileObserverCoordinatesBefore(cutoff);
    },
  mapSnapshot(this: TrackingServiceInternals, propertyId: string, now = new Date()): TrackingMapSnapshot {
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
    },
  equipmentLoans(this: TrackingServiceInternals,
      propertyId: string,
      options: { equipmentId?: string; activeOnly?: boolean; limit?: number } = {},
    ): EquipmentLoan[] {
      return this.store.listEquipmentLoans(propertyId, options);
    },
  borrowEquipment(this: TrackingServiceInternals,
      equipmentId: string,
      userId: string,
      memberLabel: string,
      input: EquipmentBorrowInput,
      now = new Date(),
    ): EquipmentLoan {
      return this.store.borrowEquipment(equipmentId, userId, memberLabel, input, now);
    },
  returnEquipment(this: TrackingServiceInternals,
      loanId: string,
      userId: string,
      memberLabel: string,
      input: EquipmentReturnInput,
      now = new Date(),
    ): EquipmentLoan {
      return this.store.returnEquipment(loanId, userId, memberLabel, input, now);
    },
  memberLocations(this: TrackingServiceInternals, propertyId: string, now = new Date()): PropertyMemberLocation[] {
      for (const location of this.store.removeExpiredMemberLocations(now)) {
        this.__appendEvent("member.location.stopped", this.__memberLocationSignal(
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
    },
});
