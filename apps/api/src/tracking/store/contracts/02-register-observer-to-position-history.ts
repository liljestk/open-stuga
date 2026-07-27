import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AreaEquipment,
  AssetPositionEstimate,
  EquipmentBorrowInput,
  EquipmentLoan,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocation,
  PropertyMemberLocationInput,
  TrackingAssetTagAssignment,
  TrackingEvent,
  TrackingEventType,
  TrackingObservation,
  TrackingObserver,
  TrackingObserverPatch,
  TrackingObserverRegisterInput,
  TrackingPropertySettings,
  TrackingTag,
  TrackingTagCapabilities,
  TrackingTagCreateInput,
  TrackingTagProvisioningResult,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../../../db.js";
import { TrackingSecretBox } from "../../crypto.js";
import type { TrackingInferenceObservation, TrackingInferenceResult } from "../../inference.js";
import { initializeTrackingSchema } from "../../schema.js";
import { PositionEstimateRow, TrackingError, TrackingObservationRow, TrackingObserverRow, finiteCoordinate, observationFromRow, observerFromRow, requiredText } from "../support/01-default-tag-capabilities-to-observation-from-row.js";
import { AuthenticatedTrackingObserver, credentialMatches, estimateFromRow, sha256 } from "../support/02-estimate-from-row-to-authenticated-tracking-observer.js";
import "../core.js";

declare module "../core.js" {
  interface TrackingStoreInternals {
    registerObserver(input: TrackingObserverRegisterInput, createdByUserId: string | null, tenantId?: string): {
            observer: TrackingObserver;
            credential: string;
        };
    getObserver(id: string): TrackingObserver | null;
    observerIdentity(id: string): AuthenticatedTrackingObserver | null;
    listObservers(propertyId: string): TrackingObserver[];
    activePropertyIds(): string[];
    updateObserver(id: string, patch: TrackingObserverPatch): TrackingObserver;
    authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null;
    heartbeatObserver(id: string, input: {
            status?: TrackingObserver["status"];
            hardwareMetadata?: TrackingObserver["hardwareMetadata"];
        }, at?: string): TrackingObserver;
    updateObserverPosition(id: string, position: GeoCoordinate, accuracyMeters: number, zoneId: string | null): TrackingObserver;
    refreshGatewayHealth(now?: Date, timeoutSeconds?: number): TrackingObserver[];
    insertObservation(observation: TrackingObservation, rawPayload: string | null, dedupKey: string): "inserted" | "duplicate";
    recentAcceptedObservationsForTag(tagId: string, since: string, limit?: number): TrackingInferenceObservation[];
    equipmentObservations(equipmentId: string, limit?: number): TrackingObservation[];
    redactMobileObserverCoordinatesBefore(cutoff: string): number;
    currentPosition(equipmentId: string): AssetPositionEstimate | null;
    positionHistory(equipmentId: string, limit?: number): AssetPositionEstimate[];
  }

  interface TrackingStoreCore {
    registerObserver(input: TrackingObserverRegisterInput, createdByUserId: string | null, tenantId?: string): {
            observer: TrackingObserver;
            credential: string;
        };
    getObserver(id: string): TrackingObserver | null;
    observerIdentity(id: string): AuthenticatedTrackingObserver | null;
    listObservers(propertyId: string): TrackingObserver[];
    activePropertyIds(): string[];
    updateObserver(id: string, patch: TrackingObserverPatch): TrackingObserver;
    authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null;
    heartbeatObserver(id: string, input: {
            status?: TrackingObserver["status"];
            hardwareMetadata?: TrackingObserver["hardwareMetadata"];
        }, at?: string): TrackingObserver;
    updateObserverPosition(id: string, position: GeoCoordinate, accuracyMeters: number, zoneId: string | null): TrackingObserver;
    refreshGatewayHealth(now?: Date, timeoutSeconds?: number): TrackingObserver[];
    insertObservation(observation: TrackingObservation, rawPayload: string | null, dedupKey: string): "inserted" | "duplicate";
    recentAcceptedObservationsForTag(tagId: string, since: string, limit?: number): TrackingInferenceObservation[];
    equipmentObservations(equipmentId: string, limit?: number): TrackingObservation[];
    redactMobileObserverCoordinatesBefore(cutoff: string): number;
    currentPosition(equipmentId: string): AssetPositionEstimate | null;
    positionHistory(equipmentId: string, limit?: number): AssetPositionEstimate[];
  }
}
