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
import { PositionEstimateRow, TrackingEventRow, json } from "./01-default-tag-capabilities-to-observation-from-row.js";

export function estimateFromRow(row: PositionEstimateRow): AssetPositionEstimate {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    propertyId: row.property_id,
    calculatedAt: row.calculated_at,
    effectiveAt: row.effective_at,
    positionType: row.position_type,
    coordinate: row.coordinate_json ? json<GeoCoordinate | null>(row.coordinate_json, null) : null,
    accuracyRadiusMeters: row.accuracy_radius_meters,
    zoneId: row.zone_id,
    confidence: row.confidence,
    confidenceLevel: row.confidence_level,
    movementState: row.movement_state,
    freshnessState: row.freshness_state,
    lastObservedAt: row.last_observed_at,
    observerCount: row.observer_count,
    algorithmVersion: row.algorithm_version,
    evidenceObservationIds: json<string[]>(row.evidence_observation_ids_json, []),
    explanation: json<AssetPositionEstimate["explanation"]>(row.explanation_json, {
      method: "NO_RELIABLE_EVIDENCE",
      inputObservationCount: 0,
      acceptedObservationCount: 0,
      rejectedObservationCount: 0,
      primaryFactors: [],
    }),
    version: row.version,
  };
}

export function eventFromRow(row: TrackingEventRow): TrackingEvent {
  return {
    type: row.type,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    entityId: row.entity_id,
    sequence: Number(row.sequence),
    eventAt: row.event_at,
    stateVersion: row.state_version,
    evidenceObservationIds: json<string[]>(row.evidence_observation_ids_json, []),
    state: json<TrackingEvent["state"]>(row.state_json, {} as TrackingEvent["state"]),
  };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function credentialMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface AuthenticatedTrackingObserver {
  observer: TrackingObserver;
  createdByUserId: string | null;
}
