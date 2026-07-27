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
import { EquipmentLoanRow, PropertyMemberLocationRow, TrackingError, TrackingEventRow, equipmentLoanFromRow, finiteCoordinate, memberLocationFromRow, requiredText } from "../support/01-default-tag-capabilities-to-observation-from-row.js";
import { eventFromRow } from "../support/02-estimate-from-row-to-authenticated-tracking-observer.js";
import "../core.js";

declare module "../core.js" {
  interface TrackingStoreInternals {
    savePosition(result: TrackingInferenceResult): AssetPositionEstimate;
    appendEvent(type: TrackingEventType, tenantId: string, state: TrackingEvent["state"], evidenceObservationIds?: string[]): TrackingEvent;
    eventsAfter(propertyId: string, sequence: number, limit?: number): TrackingEvent[];
    latestSequence(propertyId: string): number;
    evaluateBoundaryTransition(equipmentId: string, inside: boolean, debounceSeconds: number, now?: Date): "entered" | "exited" | null;
    listEquipmentLoans(propertyId: string, options?: {
            equipmentId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): EquipmentLoan[];
    getEquipmentLoan(id: string): EquipmentLoan | null;
    borrowEquipment(equipmentId: string, borrowerUserId: string, borrowerLabel: string, input: EquipmentBorrowInput, now?: Date): EquipmentLoan;
    returnEquipment(loanId: string, returnedByUserId: string, returnedByLabel: string, input: EquipmentReturnInput, now?: Date): EquipmentLoan;
    upsertMemberLocation(propertyId: string, userId: string, memberLabel: string, input: PropertyMemberLocationInput, now?: Date): PropertyMemberLocation;
    memberLocations(propertyId: string, now?: Date, staleSeconds?: number): PropertyMemberLocation[];
    stopMemberLocation(propertyId: string, userId: string): PropertyMemberLocation | null;
    removeExpiredMemberLocations(now?: Date, staleSeconds?: number): PropertyMemberLocation[];
  }

  interface TrackingStoreCore {
    savePosition(result: TrackingInferenceResult): AssetPositionEstimate;
    appendEvent(type: TrackingEventType, tenantId: string, state: TrackingEvent["state"], evidenceObservationIds?: string[]): TrackingEvent;
    eventsAfter(propertyId: string, sequence: number, limit?: number): TrackingEvent[];
    latestSequence(propertyId: string): number;
    evaluateBoundaryTransition(equipmentId: string, inside: boolean, debounceSeconds: number, now?: Date): "entered" | "exited" | null;
    listEquipmentLoans(propertyId: string, options?: {
            equipmentId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): EquipmentLoan[];
    getEquipmentLoan(id: string): EquipmentLoan | null;
    borrowEquipment(equipmentId: string, borrowerUserId: string, borrowerLabel: string, input: EquipmentBorrowInput, now?: Date): EquipmentLoan;
    returnEquipment(loanId: string, returnedByUserId: string, returnedByLabel: string, input: EquipmentReturnInput, now?: Date): EquipmentLoan;
    upsertMemberLocation(propertyId: string, userId: string, memberLabel: string, input: PropertyMemberLocationInput, now?: Date): PropertyMemberLocation;
    memberLocations(propertyId: string, now?: Date, staleSeconds?: number): PropertyMemberLocation[];
    stopMemberLocation(propertyId: string, userId: string): PropertyMemberLocation | null;
    removeExpiredMemberLocations(now?: Date, staleSeconds?: number): PropertyMemberLocation[];
  }
}
