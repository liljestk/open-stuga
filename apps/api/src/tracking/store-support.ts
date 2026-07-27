import { createHash, timingSafeEqual } from "node:crypto";
import type {
  EquipmentTrackingBinding,
  GeoCoordinate,
  TrackingEndpoint,
  TrackingObserver,
  TrackingPropertySettings,
} from "@climate-twin/contracts";
import { TrackingError } from "./errors.js";

export const DEFAULT_TRACKING_SETTINGS = {
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
  observationRetentionDays: 14,
  rollupRetentionDays: 180,
  estimateRetentionDays: 730,
} as const;

export const TRACKED_EQUIPMENT_PAGE_SIZE = 500;
export const MAX_TRACKED_EQUIPMENT = 10_000;

export interface TrackingSettingsRow {
  property_id: string;
  enabled: number;
  property_boundary_json: string;
  live_nearby_seconds: number;
  recently_seen_seconds: number;
  stale_seconds: number;
  unknown_seconds: number;
  movement_threshold_meters: number;
  movement_maximum_interval_seconds: number;
  minimum_movement_confidence: number;
  exit_alert_debounce_seconds: number;
  observation_retention_days: number;
  rollup_retention_days: number;
  estimate_retention_days: number;
  updated_at: string;
}

export interface TrackingEndpointRow {
  id: string;
  tenant_id: string;
  property_id: string;
  profile_id: string;
  profile_version: string;
  identity_namespace_version: number;
  identity_hash: string;
  identity_envelope: string;
  identity_reference: string;
  identity_scope: TrackingEndpoint["identityScope"];
  identity_strength: TrackingEndpoint["identityStrength"];
  observer_scope_id: string | null;
  observer_scope_key: string;
  trackability_tier: TrackingEndpoint["trackabilityTier"];
  display_name: string;
  manufacturer: string | null;
  model: string | null;
  firmware_version: string | null;
  claim_status: TrackingEndpoint["claimStatus"];
  proof_kind: TrackingEndpoint["proofKind"];
  proof_verified_at: string | null;
  last_seen_at: string | null;
  telemetry_json: string;
  created_at: string;
  updated_at: string;
}

export interface TrackingBindingRow {
  id: string;
  property_id: string;
  equipment_id: string;
  endpoint_id: string;
  observer_id: string | null;
  valid_from: string;
  valid_to: string | null;
  bound_by: string;
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

export function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Stored tracking ${field} is invalid JSON`);
  }
}

export function requiredText(value: string, field: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

export function optionalText(value: string | undefined, field: string, maximum = 200): string | null {
  if (value === undefined || !value.trim()) return null;
  const normalized = value.trim();
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

export function settingsFromRow(row: TrackingSettingsRow): TrackingPropertySettings {
  return {
    propertyId: row.property_id,
    enabled: row.enabled === 1,
    propertyBoundary: parseJson<GeoCoordinate[]>(row.property_boundary_json, "property boundary"),
    liveNearbySeconds: row.live_nearby_seconds,
    recentlySeenSeconds: row.recently_seen_seconds,
    staleSeconds: row.stale_seconds,
    unknownSeconds: row.unknown_seconds,
    movementThresholdMeters: row.movement_threshold_meters,
    movementMaximumIntervalSeconds: row.movement_maximum_interval_seconds,
    minimumMovementConfidence: row.minimum_movement_confidence,
    exitAlertDebounceSeconds: row.exit_alert_debounce_seconds,
    observationRetentionDays: row.observation_retention_days,
    rollupRetentionDays: row.rollup_retention_days,
    estimateRetentionDays: row.estimate_retention_days,
    updatedAt: row.updated_at,
  };
}

export function endpointFromRow(row: TrackingEndpointRow): TrackingEndpoint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    propertyId: row.property_id,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    identityNamespaceVersion: row.identity_namespace_version,
    identityReference: row.identity_reference,
    identityScope: row.identity_scope,
    identityStrength: row.identity_strength,
    observerScopeId: row.observer_scope_id,
    trackabilityTier: row.trackability_tier,
    displayName: row.display_name,
    manufacturer: row.manufacturer,
    model: row.model,
    firmwareVersion: row.firmware_version,
    claimStatus: row.claim_status,
    proofKind: row.proof_kind,
    proofVerifiedAt: row.proof_verified_at,
    lastSeenAt: row.last_seen_at,
    telemetry: parseJson<TrackingEndpoint["telemetry"]>(row.telemetry_json, "endpoint telemetry"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function bindingFromRow(row: TrackingBindingRow): EquipmentTrackingBinding {
  return {
    id: row.id,
    propertyId: row.property_id,
    equipmentId: row.equipment_id,
    endpointId: row.endpoint_id,
    observerId: row.observer_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    boundBy: row.bound_by,
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
    fixedPosition: row.fixed_position_json
      ? parseJson<GeoCoordinate>(row.fixed_position_json, "observer position")
      : null,
    fixedPositionAccuracyMeters: row.fixed_position_accuracy_meters,
    zoneId: row.zone_id,
    appInstallationId: row.app_installation_id,
    hardwareMetadata: parseJson<TrackingObserver["hardwareMetadata"]>(
      row.hardware_metadata_json,
      "observer metadata",
    ),
    lastHeartbeatAt: row.last_heartbeat_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
