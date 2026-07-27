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
import { STUGA_TRACKING_BLE_SERVICE_UUID } from "../support/01-default-tracking-feature-flags-to-same-estimate.js";
import { registerTrackingServiceMethods, trackingServiceState, type TrackingServiceInternals } from "../core.js";

registerTrackingServiceMethods({
  shareMemberLocation(this: TrackingServiceInternals,
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
      this.__appendEvent(
        "member.location.updated",
        this.__memberLocationSignal(location, true, location.updatedAt),
      );
      return location;
    },
  stopMemberLocation(this: TrackingServiceInternals,
      propertyId: string,
      userId: string,
      now = new Date(),
    ): PropertyMemberLocation | null {
      const location = this.store.stopMemberLocation(propertyId, userId);
      if (location) {
        this.__appendEvent(
          "member.location.stopped",
          this.__memberLocationSignal(location, false, now.toISOString()),
        );
      }
      return location;
    },
  __memberLocationSignal(this: TrackingServiceInternals,
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
    },
  equipmentObservations(this: TrackingServiceInternals,
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
    },
  scanToken(this: TrackingServiceInternals, equipmentId: string, now = new Date()): TrackingScanToken {
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
    },
  heartbeat(this: TrackingServiceInternals,
      identity: AuthenticatedTrackingObserver,
      input: { status?: TrackingObserver["status"]; hardwareMetadata?: TrackingObserver["hardwareMetadata"] },
    ): TrackingObserver {
      this.requireEnabled();
      const previous = this.store.getObserver(identity.observer.id);
      const observer = this.store.heartbeatObserver(identity.observer.id, input);
      if (previous?.status === "offline" && observer.status === "online") {
        this.__appendEvent("gateway.online", observer);
      }
      return observer;
    },
});
