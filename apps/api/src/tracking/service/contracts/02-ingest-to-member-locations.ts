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
import "../core.js";

declare module "../core.js" {
  interface TrackingServiceInternals {
    ingest(value: unknown, actor: TrackingIngestionActor, now?: Date): TrackingObservationBatchResult;
    recalculateTag(tagId: string, now?: Date): AssetPositionEstimate | null;
    refreshProperty(propertyId: string, now?: Date): void;
    redactExpiredMobileCoordinates(now?: Date): number;
    mapSnapshot(propertyId: string, now?: Date): TrackingMapSnapshot;
    equipmentLoans(propertyId: string, options?: {
            equipmentId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): EquipmentLoan[];
    borrowEquipment(equipmentId: string, userId: string, memberLabel: string, input: EquipmentBorrowInput, now?: Date): EquipmentLoan;
    returnEquipment(loanId: string, userId: string, memberLabel: string, input: EquipmentReturnInput, now?: Date): EquipmentLoan;
    memberLocations(propertyId: string, now?: Date): PropertyMemberLocation[];
  }

  interface TrackingServiceCore {
    ingest(value: unknown, actor: TrackingIngestionActor, now?: Date): TrackingObservationBatchResult;
    recalculateTag(tagId: string, now?: Date): AssetPositionEstimate | null;
    refreshProperty(propertyId: string, now?: Date): void;
    redactExpiredMobileCoordinates(now?: Date): number;
    mapSnapshot(propertyId: string, now?: Date): TrackingMapSnapshot;
    equipmentLoans(propertyId: string, options?: {
            equipmentId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): EquipmentLoan[];
    borrowEquipment(equipmentId: string, userId: string, memberLabel: string, input: EquipmentBorrowInput, now?: Date): EquipmentLoan;
    returnEquipment(loanId: string, userId: string, memberLabel: string, input: EquipmentReturnInput, now?: Date): EquipmentLoan;
    memberLocations(propertyId: string, now?: Date): PropertyMemberLocation[];
  }
}
