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

export const DEFAULT_TAG_CAPABILITIES: TrackingTagCapabilities = {
  motion: false,
  battery: false,
  buzzer: false,
  button: false,
  tamper: false,
  connectable: false,
};

export const DEFAULT_SETTINGS = {
  enabled: true,
  propertyBoundary: [] as GeoCoordinate[],
  liveNearbySeconds: 10,
  recentlySeenSeconds: 120,
  staleSeconds: 1_800,
  unknownSeconds: 7 * 24 * 3_600,
  movementThresholdMeters: 8,
  movementMaximumIntervalSeconds: 120,
  minimumMovementConfidence: 0.55,
  exitAlertDebounceSeconds: 120,
} as const;

export const TRACKED_EQUIPMENT_PAGE_SIZE = 500;

export const MAX_TRACKED_EQUIPMENT = 10_000;

export class TrackingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface TrackingTagRow {
  id: string;
  tenant_id: string;
  property_id: string;
  serial_number: string;
  hardware_model: string;
  firmware_version: string | null;
  protocol_version: number;
  rotation_window_minutes: number;
  secret_envelope: string;
  battery_type: string | null;
  battery_percent: number | null;
  capabilities_json: string;
  status: TrackingTag["status"];
  paired_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrackingAssignmentRow {
  id: string;
  equipment_id: string;
  tag_id: string;
  valid_from: string;
  valid_to: string | null;
  assigned_by: string;
}

export interface TrackingObserverRow {
  id: string;
  tenant_id: string;
  property_id: string;
  type: TrackingObserver["type"];
  name: string;
  trust_level: number;
  fixed_position_json: string | null;
  fixed_position_accuracy_meters: number | null;
  zone_id: string | null;
  app_installation_id: string | null;
  created_by_user_id: string | null;
  hardware_metadata_json: string;
  last_heartbeat_at: string | null;
  status: TrackingObserver["status"];
  credential_hash: string;
  created_at: string;
  updated_at: string;
}

export interface TrackingObservationRow {
  id: string;
  tenant_id: string;
  property_id: string;
  tag_id: string | null;
  observer_id: string;
  observer_type: TrackingObservation["observerType"];
  observed_at: string;
  received_at: string;
  rotating_tag_id: string;
  protocol_version: number;
  epoch_counter: number;
  event_counter: number;
  rssi: number;
  tx_power: number | null;
  motion: number;
  battery_percent: number | null;
  observer_position_json: string | null;
  scan_mode: TrackingObservation["scanMode"];
  app_state: TrackingObservation["appState"];
  device_time_offset_ms: number | null;
  quality_flags_json: string;
  accepted: number;
  metadata_json: string;
  raw_payload: string | null;
  dedup_key: string;
}

export interface PositionEstimateRow {
  id: string;
  equipment_id: string;
  property_id: string;
  calculated_at: string;
  effective_at: string;
  position_type: AssetPositionEstimate["positionType"];
  coordinate_json: string | null;
  accuracy_radius_meters: number | null;
  zone_id: string | null;
  confidence: number;
  confidence_level: AssetPositionEstimate["confidenceLevel"];
  movement_state: AssetPositionEstimate["movementState"];
  freshness_state: AssetPositionEstimate["freshnessState"];
  last_observed_at: string | null;
  observer_count: number;
  algorithm_version: string;
  evidence_observation_ids_json: string;
  explanation_json: string;
  version: number;
}

export interface TrackingEventRow {
  sequence: number;
  type: TrackingEventType;
  tenant_id: string;
  property_id: string;
  entity_id: string;
  event_at: string;
  state_version: number;
  evidence_observation_ids_json: string;
  state_json: string;
}

export interface EquipmentLoanRow {
  id: string;
  property_id: string;
  equipment_id: string;
  borrower_user_id: string;
  borrower_label: string;
  borrowed_at: string;
  expected_return_at: string | null;
  note: string | null;
  returned_at: string | null;
  returned_by_user_id: string | null;
  returned_by_label: string | null;
  return_note: string | null;
}

export interface PropertyMemberLocationRow {
  id: string;
  property_id: string;
  user_id: string;
  member_label: string;
  coordinate_json: string;
  horizontal_accuracy_meters: number;
  reduced_accuracy: number;
  captured_at: string;
  updated_at: string;
  sharing_until: string;
}

export function json<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function requiredText(value: string, field: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

export function optionalText(value: string | undefined, field: string, maximum = 200): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must contain at most ${maximum} characters`);
  }
  return normalized;
}

export function finiteCoordinate(value: GeoCoordinate, field: string): GeoCoordinate {
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
    || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    throw new TrackingError(422, "INVALID_COORDINATE", `${field} must be a finite WGS84 coordinate`);
  }
  return { latitude: value.latitude, longitude: value.longitude };
}

export function tagFromRow(row: TrackingTagRow): TrackingTag {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    serialNumber: row.serial_number,
    hardwareModel: row.hardware_model,
    firmwareVersion: row.firmware_version,
    protocolVersion: row.protocol_version,
    rotationWindowMinutes: row.rotation_window_minutes,
    batteryType: row.battery_type,
    batteryPercent: row.battery_percent,
    capabilities: {
      ...DEFAULT_TAG_CAPABILITIES,
      ...json<Partial<TrackingTagCapabilities>>(row.capabilities_json, {}),
    },
    status: row.status,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function assignmentFromRow(row: TrackingAssignmentRow): TrackingAssetTagAssignment {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    tagId: row.tag_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    assignedBy: row.assigned_by,
  };
}

export function equipmentLoanFromRow(row: EquipmentLoanRow): EquipmentLoan {
  return {
    id: row.id,
    propertyId: row.property_id,
    equipmentId: row.equipment_id,
    borrowerLabel: row.borrower_label,
    borrowedAt: row.borrowed_at,
    expectedReturnAt: row.expected_return_at,
    note: row.note,
    returnedAt: row.returned_at,
    returnedByLabel: row.returned_by_label,
    returnNote: row.return_note,
  };
}

export function memberLocationFromRow(row: PropertyMemberLocationRow): PropertyMemberLocation {
  return {
    id: row.id,
    propertyId: row.property_id,
    memberLabel: row.member_label,
    coordinate: json<GeoCoordinate>(row.coordinate_json, { latitude: 0, longitude: 0 }),
    horizontalAccuracyMeters: row.horizontal_accuracy_meters,
    reducedAccuracy: row.reduced_accuracy === 1,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
    sharingUntil: row.sharing_until,
  };
}

export function observerFromRow(row: TrackingObserverRow): TrackingObserver {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    type: row.type,
    name: row.name,
    trustLevel: row.trust_level,
    fixedPosition: row.fixed_position_json ? json<GeoCoordinate | null>(row.fixed_position_json, null) : null,
    fixedPositionAccuracyMeters: row.fixed_position_accuracy_meters,
    zoneId: row.zone_id,
    appInstallationId: row.app_installation_id,
    hardwareMetadata: json<TrackingObserver["hardwareMetadata"]>(row.hardware_metadata_json, {}),
    lastHeartbeatAt: row.last_heartbeat_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function observationFromRow(row: TrackingObservationRow): TrackingObservation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    tagId: row.tag_id,
    observerId: row.observer_id,
    observerType: row.observer_type,
    observedAt: row.observed_at,
    receivedAt: row.received_at,
    rotatingTagId: row.rotating_tag_id,
    protocolVersion: row.protocol_version,
    epochCounter: row.epoch_counter,
    eventCounter: row.event_counter,
    rssi: row.rssi,
    txPower: row.tx_power,
    motion: row.motion === 1,
    batteryPercent: row.battery_percent,
    observerPosition: row.observer_position_json
      ? json<TrackingObservation["observerPosition"]>(row.observer_position_json, null)
      : null,
    scanMode: row.scan_mode,
    appState: row.app_state,
    deviceTimeOffsetMs: row.device_time_offset_ms,
    qualityFlags: json<TrackingObservation["qualityFlags"]>(row.quality_flags_json, []),
    accepted: row.accepted === 1,
    metadata: json<TrackingObservation["metadata"]>(row.metadata_json, {}),
  };
}
