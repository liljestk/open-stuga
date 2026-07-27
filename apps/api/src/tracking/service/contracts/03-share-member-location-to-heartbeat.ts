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
import "../core.js";

declare module "../core.js" {
  interface TrackingServiceInternals {
    shareMemberLocation(propertyId: string, userId: string, memberLabel: string, input: PropertyMemberLocationInput, now?: Date): PropertyMemberLocation;
    stopMemberLocation(propertyId: string, userId: string, now?: Date): PropertyMemberLocation | null;
    __memberLocationSignal(
        location: Pick<PropertyMemberLocation, "id" | "propertyId">,
        active: boolean,
        updatedAt: string,
      ): PropertyMemberLocationSignal;
    equipmentObservations(equipmentId: string, limit: number, includeMobileCoordinates: boolean): TrackingObservation[];
    scanToken(equipmentId: string, now?: Date): TrackingScanToken;
    heartbeat(identity: AuthenticatedTrackingObserver, input: {
            status?: TrackingObserver["status"];
            hardwareMetadata?: TrackingObserver["hardwareMetadata"];
        }): TrackingObserver;
  }

  interface TrackingServiceCore {
    shareMemberLocation(propertyId: string, userId: string, memberLabel: string, input: PropertyMemberLocationInput, now?: Date): PropertyMemberLocation;
    stopMemberLocation(propertyId: string, userId: string, now?: Date): PropertyMemberLocation | null;
    equipmentObservations(equipmentId: string, limit: number, includeMobileCoordinates: boolean): TrackingObservation[];
    scanToken(equipmentId: string, now?: Date): TrackingScanToken;
    heartbeat(identity: AuthenticatedTrackingObserver, input: {
            status?: TrackingObserver["status"];
            hardwareMetadata?: TrackingObserver["hardwareMetadata"];
        }): TrackingObserver;
  }
}
