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
import "../core.js";

declare module "../core.js" {
  interface TrackingServiceInternals {
    start(refreshIntervalMilliseconds?: number): void;
    stop(): void;
    capabilities(): TrackingCapabilities;
    requireEnabled(): void;
    requireFeature(flag: keyof TrackingFeatureFlags, message: string): void;
    authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null;
    invalidateTagResolution(): void;
    subscribe(propertyId: string, listener: TrackingEventListener): () => void;
    __publish(event: TrackingEvent): void;
    __appendEvent(
        type: TrackingEvent["type"],
        state: TrackingEvent["state"],
        evidenceObservationIds?: string[] ,
      ): TrackingEvent;
    __epochResolution(
        propertyId: string,
        protocolVersion: number,
        epochCounter: number,
      ): Map<string, ResolutionCandidate[]>;
    __resolve(
        propertyId: string,
        advertisement: TrackingAdvertisement,
      ): { candidate: ResolutionCandidate | null; flag: TrackingObservationQualityFlag | null };
    __consumeIngestionCapacity(
        actor: TrackingIngestionActor,
        observations: number,
        now: Date,
      ): void;
    __authorizedObserver(
        actor: TrackingIngestionActor,
        observerId: string,
        propertyId: string,
      ): AuthenticatedTrackingObserver | null;
    __qualityFlags(
        input: TrackingObservationInput,
        advertisement: TrackingAdvertisement,
        observer: TrackingObserver,
        now: Date,
        maximumObservationAgeSeconds: number,
        rotationWindowMinutes: number | null,
      ): TrackingObservationQualityFlag[];
  }

  interface TrackingServiceCore {
    start(refreshIntervalMilliseconds?: number): void;
    stop(): void;
    capabilities(): TrackingCapabilities;
    requireEnabled(): void;
    requireFeature(flag: keyof TrackingFeatureFlags, message: string): void;
    authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null;
    invalidateTagResolution(): void;
    subscribe(propertyId: string, listener: TrackingEventListener): () => void;
  }
}
