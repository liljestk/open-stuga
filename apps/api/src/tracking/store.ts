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
import type { ClimateDatabase } from "../db.js";
import { TrackingSecretBox } from "./crypto.js";
import type { TrackingInferenceObservation, TrackingInferenceResult } from "./inference.js";
import { initializeTrackingSchema } from "./schema.js";

const DEFAULT_TAG_CAPABILITIES: TrackingTagCapabilities = {
  motion: false,
  battery: false,
  buzzer: false,
  button: false,
  tamper: false,
  connectable: false,
};

const DEFAULT_SETTINGS = {
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

const TRACKED_EQUIPMENT_PAGE_SIZE = 500;
const MAX_TRACKED_EQUIPMENT = 10_000;

export class TrackingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

interface TrackingTagRow {
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

interface TrackingAssignmentRow {
  id: string;
  equipment_id: string;
  tag_id: string;
  valid_from: string;
  valid_to: string | null;
  assigned_by: string;
}

interface TrackingObserverRow {
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

interface TrackingObservationRow {
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

interface PositionEstimateRow {
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

interface TrackingEventRow {
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

interface EquipmentLoanRow {
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

interface PropertyMemberLocationRow {
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

function json<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function requiredText(value: string, field: string, maximum = 200): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

function optionalText(value: string | undefined, field: string, maximum = 200): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum) {
    throw new TrackingError(400, "INVALID_FIELD", `${field} must contain at most ${maximum} characters`);
  }
  return normalized;
}

function finiteCoordinate(value: GeoCoordinate, field: string): GeoCoordinate {
  if (!Number.isFinite(value.latitude) || value.latitude < -90 || value.latitude > 90
    || !Number.isFinite(value.longitude) || value.longitude < -180 || value.longitude > 180) {
    throw new TrackingError(422, "INVALID_COORDINATE", `${field} must be a finite WGS84 coordinate`);
  }
  return { latitude: value.latitude, longitude: value.longitude };
}

function tagFromRow(row: TrackingTagRow): TrackingTag {
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

function assignmentFromRow(row: TrackingAssignmentRow): TrackingAssetTagAssignment {
  return {
    id: row.id,
    equipmentId: row.equipment_id,
    tagId: row.tag_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    assignedBy: row.assigned_by,
  };
}

function equipmentLoanFromRow(row: EquipmentLoanRow): EquipmentLoan {
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

function memberLocationFromRow(row: PropertyMemberLocationRow): PropertyMemberLocation {
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

function observerFromRow(row: TrackingObserverRow): TrackingObserver {
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

function observationFromRow(row: TrackingObservationRow): TrackingObservation {
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

function estimateFromRow(row: PositionEstimateRow): AssetPositionEstimate {
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

function eventFromRow(row: TrackingEventRow): TrackingEvent {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function credentialMatches(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export interface AuthenticatedTrackingObserver {
  observer: TrackingObserver;
  createdByUserId: string | null;
}

export class TrackingStore {
  readonly db: DatabaseSync;

  constructor(
    readonly core: ClimateDatabase,
    private readonly secretBox: TrackingSecretBox,
  ) {
    this.db = core.db;
    initializeTrackingSchema(this.db);
    // A foreground sharing session cannot survive a server restart. Never
    // resurrect a member's last coordinate from a restored or restarted DB.
    this.db.prepare("DELETE FROM property_member_locations").run();
  }

  verifyStoredSecrets(): void {
    const row = this.db.prepare("SELECT secret_envelope FROM tracking_tags LIMIT 1").get() as
      | { secret_envelope: string }
      | undefined;
    if (!row) return;
    try {
      this.secretBox.decrypt(row.secret_envelope);
    } catch {
      throw new Error("TRACKING_SECRET_KEY_INVALID");
    }
  }

  propertySettings(propertyId: string): TrackingPropertySettings {
    if (!this.core.getProperty(propertyId)) throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    const row = this.db.prepare("SELECT * FROM tracking_property_settings WHERE property_id = ?").get(propertyId) as
      | {
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
        updated_at: string;
      }
      | undefined;
    if (!row) {
      return {
        propertyId,
        ...DEFAULT_SETTINGS,
        propertyBoundary: [],
        updatedAt: this.core.getProperty(propertyId)!.updatedAt,
      };
    }
    return {
      propertyId: row.property_id,
      enabled: row.enabled === 1,
      propertyBoundary: json<GeoCoordinate[]>(row.property_boundary_json, []),
      liveNearbySeconds: row.live_nearby_seconds,
      recentlySeenSeconds: row.recently_seen_seconds,
      staleSeconds: row.stale_seconds,
      unknownSeconds: row.unknown_seconds,
      movementThresholdMeters: row.movement_threshold_meters,
      movementMaximumIntervalSeconds: row.movement_maximum_interval_seconds,
      minimumMovementConfidence: row.minimum_movement_confidence,
      exitAlertDebounceSeconds: row.exit_alert_debounce_seconds,
      updatedAt: row.updated_at,
    };
  }

  updatePropertySettings(
    propertyId: string,
    patch: Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">>,
  ): TrackingPropertySettings {
    const current = this.propertySettings(propertyId);
    const next: TrackingPropertySettings = {
      ...current,
      ...patch,
      propertyBoundary: patch.propertyBoundary?.map((point) => finiteCoordinate(point, "Property boundary"))
        ?? current.propertyBoundary,
      updatedAt: new Date().toISOString(),
    };
    if (next.propertyBoundary.length !== 0 && next.propertyBoundary.length < 3) {
      throw new TrackingError(400, "INVALID_FIELD", "Property boundary must be empty or contain at least three coordinates");
    }
    if (next.propertyBoundary.length > 500) {
      throw new TrackingError(400, "INVALID_FIELD", "Property boundary may contain at most 500 coordinates");
    }
    const integerRanges: Array<[keyof TrackingPropertySettings, number, number]> = [
      ["liveNearbySeconds", 1, 300],
      ["recentlySeenSeconds", 10, 3_600],
      ["staleSeconds", 60, 86_400],
      ["unknownSeconds", 300, 2_592_000],
      ["movementMaximumIntervalSeconds", 5, 3_600],
      ["exitAlertDebounceSeconds", 5, 3_600],
    ];
    for (const [field, minimum, maximum] of integerRanges) {
      const value = next[field];
      if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new TrackingError(
          400,
          "INVALID_FIELD",
          `${field} must be an integer from ${minimum} to ${maximum}`,
        );
      }
    }
    if (!Number.isFinite(next.movementThresholdMeters)
      || next.movementThresholdMeters < 1
      || next.movementThresholdMeters > 1_000) {
      throw new TrackingError(400, "INVALID_FIELD", "movementThresholdMeters must be from 1 to 1000");
    }
    if (!Number.isFinite(next.minimumMovementConfidence)
      || next.minimumMovementConfidence < 0
      || next.minimumMovementConfidence > 1) {
      throw new TrackingError(400, "INVALID_FIELD", "minimumMovementConfidence must be from 0 to 1");
    }
    if (!(next.liveNearbySeconds < next.recentlySeenSeconds
      && next.recentlySeenSeconds < next.staleSeconds
      && next.staleSeconds < next.unknownSeconds)) {
      throw new TrackingError(
        422,
        "INVALID_TRACKING_WINDOWS",
        "Tracking freshness windows must increase from live through unknown",
      );
    }
    this.db.prepare(`INSERT INTO tracking_property_settings(
      property_id, enabled, property_boundary_json, live_nearby_seconds, recently_seen_seconds, stale_seconds,
      unknown_seconds, movement_threshold_meters, movement_maximum_interval_seconds, minimum_movement_confidence,
      exit_alert_debounce_seconds, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(property_id) DO UPDATE SET
      enabled=excluded.enabled, property_boundary_json=excluded.property_boundary_json,
      live_nearby_seconds=excluded.live_nearby_seconds, recently_seen_seconds=excluded.recently_seen_seconds,
      stale_seconds=excluded.stale_seconds, unknown_seconds=excluded.unknown_seconds,
      movement_threshold_meters=excluded.movement_threshold_meters,
      movement_maximum_interval_seconds=excluded.movement_maximum_interval_seconds,
      minimum_movement_confidence=excluded.minimum_movement_confidence,
      exit_alert_debounce_seconds=excluded.exit_alert_debounce_seconds, updated_at=excluded.updated_at`)
      .run(
        propertyId,
        next.enabled ? 1 : 0,
        JSON.stringify(next.propertyBoundary),
        next.liveNearbySeconds,
        next.recentlySeenSeconds,
        next.staleSeconds,
        next.unknownSeconds,
        next.movementThresholdMeters,
        next.movementMaximumIntervalSeconds,
        next.minimumMovementConfidence,
        next.exitAlertDebounceSeconds,
        next.updatedAt,
      );
    return next;
  }

  createTag(input: TrackingTagCreateInput, tenantId = "local"): TrackingTagProvisioningResult {
    if (!this.core.getProperty(input.propertyId)) throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    const protocolVersion = input.protocolVersion ?? 1;
    if (protocolVersion !== 1) throw new TrackingError(422, "UNSUPPORTED_TRACKING_PROTOCOL", "Only tracking protocol version 1 is supported");
    const rotationWindowMinutes = input.rotationWindowMinutes ?? 15;
    if (!Number.isInteger(rotationWindowMinutes) || rotationWindowMinutes < 5 || rotationWindowMinutes > 60) {
      throw new TrackingError(400, "INVALID_FIELD", "rotationWindowMinutes must be between 5 and 60");
    }
    const timestamp = new Date().toISOString();
    const secret = randomBytes(32);
    const row: TrackingTagRow = {
      id: randomUUID(),
      tenant_id: tenantId,
      property_id: input.propertyId,
      serial_number: requiredText(input.serialNumber, "Tag serial number"),
      hardware_model: requiredText(input.hardwareModel, "Tag hardware model"),
      firmware_version: optionalText(input.firmwareVersion, "Tag firmware version"),
      protocol_version: protocolVersion,
      rotation_window_minutes: rotationWindowMinutes,
      secret_envelope: this.secretBox.encrypt(secret),
      battery_type: optionalText(input.batteryType, "Tag battery type"),
      battery_percent: null,
      capabilities_json: JSON.stringify({ ...DEFAULT_TAG_CAPABILITIES, ...(input.capabilities ?? {}) }),
      status: "provisioning",
      paired_at: null,
      last_seen_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    try {
      this.db.prepare(`INSERT INTO tracking_tags(
        id, tenant_id, property_id, serial_number, hardware_model, firmware_version, protocol_version,
        rotation_window_minutes, secret_envelope, battery_type, battery_percent, capabilities_json, status, paired_at,
        last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id,
        row.tenant_id,
        row.property_id,
        row.serial_number,
        row.hardware_model,
        row.firmware_version,
        row.protocol_version,
        row.rotation_window_minutes,
        row.secret_envelope,
        row.battery_type,
        row.battery_percent,
        row.capabilities_json,
        row.status,
        row.paired_at,
        row.last_seen_at,
        row.created_at,
        row.updated_at,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new TrackingError(409, "TRACKING_TAG_CONFLICT", "A tag with this serial number already exists");
      }
      throw error;
    }
    return { tag: tagFromRow(row), provisioningSecret: secret.toString("base64url") };
  }

  listTags(propertyId?: string): TrackingTag[] {
    const rows = (propertyId
      ? this.db.prepare("SELECT * FROM tracking_tags WHERE property_id = ? ORDER BY created_at DESC").all(propertyId)
      : this.db.prepare("SELECT * FROM tracking_tags ORDER BY created_at DESC").all()) as unknown as TrackingTagRow[];
    return rows.map(tagFromRow);
  }

  getTag(id: string): TrackingTag | null {
    const row = this.db.prepare("SELECT * FROM tracking_tags WHERE id = ?").get(id) as unknown as TrackingTagRow | undefined;
    return row ? tagFromRow(row) : null;
  }

  tagSecret(id: string): Buffer {
    const row = this.db.prepare("SELECT secret_envelope FROM tracking_tags WHERE id = ?").get(id) as
      | { secret_envelope: string }
      | undefined;
    if (!row) throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
    return this.secretBox.decrypt(row.secret_envelope);
  }

  claimTag(id: string): TrackingTag {
    const current = this.getTag(id);
    if (!current) throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
    if (current.status === "retired") throw new TrackingError(409, "TRACKING_TAG_RETIRED", "A retired tag cannot be claimed");
    const timestamp = new Date().toISOString();
    this.db.prepare(`UPDATE tracking_tags SET status='active', paired_at=COALESCE(paired_at, ?), updated_at=? WHERE id=?`)
      .run(timestamp, timestamp, id);
    return this.getTag(id)!;
  }

  rotateTagSecret(id: string): TrackingTagProvisioningResult {
    const current = this.getTag(id);
    if (!current) throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
    if (current.status === "retired") throw new TrackingError(409, "TRACKING_TAG_RETIRED", "A retired tag cannot rotate its secret");
    const secret = randomBytes(32);
    const timestamp = new Date().toISOString();
    this.db.prepare("UPDATE tracking_tags SET secret_envelope=?, status='provisioning', updated_at=? WHERE id=?")
      .run(this.secretBox.encrypt(secret), timestamp, id);
    return { tag: this.getTag(id)!, provisioningSecret: secret.toString("base64url") };
  }

  touchTag(id: string, observedAt: string, batteryPercent: number | null): void {
    this.db.prepare(`UPDATE tracking_tags SET
      last_seen_at=CASE WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE last_seen_at END,
      battery_percent=CASE
        WHEN (last_seen_at IS NULL OR last_seen_at < ?) AND ? IS NOT NULL THEN ?
        ELSE battery_percent
      END,
      updated_at=CASE WHEN last_seen_at IS NULL OR last_seen_at < ? THEN ? ELSE updated_at END
      WHERE id=?`).run(
        observedAt,
        observedAt,
        observedAt,
        batteryPercent,
        batteryPercent,
        observedAt,
        observedAt,
        id,
      );
  }

  assignTag(tagId: string, equipmentId: string, assignedBy: string, at = new Date().toISOString()): TrackingAssetTagAssignment {
    const tag = this.getTag(tagId);
    const equipment = this.core.getAreaEquipment(equipmentId);
    if (!tag) throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
    if (!equipment) throw new TrackingError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found");
    if (tag.status !== "active") throw new TrackingError(409, "TRACKING_TAG_NOT_ACTIVE", "Claim the tag before assigning it");
    if (tag.propertyId !== equipment.propertyId) {
      throw new TrackingError(409, "TRACKING_ASSIGNMENT_SCOPE", "The tag and equipment must belong to the same Property");
    }
    const active = this.activeAssignmentForTag(tagId);
    if (active?.equipmentId === equipmentId) return active;
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE tracking_asset_tag_assignments SET valid_to=?
        WHERE valid_to IS NULL AND (tag_id=? OR equipment_id=?)`).run(at, tagId, equipmentId);
      this.db.prepare(`INSERT INTO tracking_asset_tag_assignments(
        id, equipment_id, tag_id, valid_from, valid_to, assigned_by
      ) VALUES (?, ?, ?, ?, NULL, ?)`).run(id, equipmentId, tagId, at, assignedBy);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof Error && error.message.includes("TRACKING_ASSIGNMENT_SCOPE")) {
        throw new TrackingError(409, "TRACKING_ASSIGNMENT_SCOPE", "The tag and equipment must belong to the same Property");
      }
      throw error;
    }
    return this.activeAssignmentForTag(tagId)!;
  }

  unassignTag(tagId: string, at = new Date().toISOString()): TrackingAssetTagAssignment | null {
    const current = this.activeAssignmentForTag(tagId);
    if (!current) return null;
    this.db.prepare("UPDATE tracking_asset_tag_assignments SET valid_to=? WHERE id=?").run(at, current.id);
    return { ...current, validTo: at };
  }

  activeAssignmentForTag(tagId: string): TrackingAssetTagAssignment | null {
    const row = this.db.prepare(`SELECT * FROM tracking_asset_tag_assignments
      WHERE tag_id=? AND valid_to IS NULL`).get(tagId) as unknown as TrackingAssignmentRow | undefined;
    return row ? assignmentFromRow(row) : null;
  }

  activeAssignmentForEquipment(equipmentId: string): TrackingAssetTagAssignment | null {
    const row = this.db.prepare(`SELECT * FROM tracking_asset_tag_assignments
      WHERE equipment_id=? AND valid_to IS NULL`).get(equipmentId) as unknown as TrackingAssignmentRow | undefined;
    return row ? assignmentFromRow(row) : null;
  }

  registerObserver(
    input: TrackingObserverRegisterInput,
    createdByUserId: string | null,
    tenantId = "local",
  ): { observer: TrackingObserver; credential: string } {
    if (!this.core.getProperty(input.propertyId)) throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    if (input.zoneId) {
      const area = this.core.getPropertyArea(input.zoneId);
      if (!area || area.propertyId !== input.propertyId) {
        throw new TrackingError(409, "OBSERVER_ZONE_SCOPE", "Observer zone must belong to the selected Property");
      }
    }
    const mobile = input.type === "ios-phone" || input.type === "android-phone";
    if (mobile && !input.appInstallationId?.trim()) {
      throw new TrackingError(400, "INVALID_FIELD", "Mobile observers require an appInstallationId");
    }
    if (!mobile && !input.fixedPosition && !input.zoneId) {
      throw new TrackingError(400, "INVALID_FIELD", "Fixed gateways require a map position or assigned zone");
    }
    const fixedPosition = input.fixedPosition ? finiteCoordinate(input.fixedPosition, "Observer position") : null;
    const accuracy = input.fixedPositionAccuracyMeters ?? (fixedPosition ? 5 : null);
    if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0.1 || accuracy > 10_000)) {
      throw new TrackingError(400, "INVALID_FIELD", "Fixed position accuracy must be between 0.1 and 10000 metres");
    }
    const trustLevel = input.trustLevel ?? (mobile ? 0.7 : 0.9);
    if (!Number.isFinite(trustLevel) || trustLevel < 0 || trustLevel > 1) {
      throw new TrackingError(400, "INVALID_FIELD", "trustLevel must be from 0 to 1");
    }
    const installationId = input.appInstallationId?.trim() || null;
    const previousInstallation = installationId
      ? this.db.prepare(`SELECT * FROM tracking_observers
        WHERE property_id=? AND app_installation_id=?`).get(
        input.propertyId,
        installationId,
      ) as unknown as TrackingObserverRow | undefined
      : undefined;
    if (previousInstallation) {
      if (!mobile
        || previousInstallation.status !== "disabled"
        || previousInstallation.type !== input.type
        || previousInstallation.created_by_user_id !== createdByUserId) {
        throw new TrackingError(
          409,
          "OBSERVER_INSTALLATION_CONFLICT",
          "This app installation is already registered",
        );
      }
      const credential = `stuga_observer_v1.${previousInstallation.id}.${randomBytes(32).toString("base64url")}`;
      const timestamp = new Date().toISOString();
      this.db.prepare(`UPDATE tracking_observers SET
        name=?, trust_level=?, hardware_metadata_json=?, status='offline',
        credential_hash=?, updated_at=? WHERE id=?`).run(
        requiredText(input.name, "Observer name"),
        trustLevel,
        JSON.stringify(input.hardwareMetadata ?? {}),
        sha256(credential),
        timestamp,
        previousInstallation.id,
      );
      return { observer: this.getObserver(previousInstallation.id)!, credential };
    }
    const id = randomUUID();
    const credential = `stuga_observer_v1.${id}.${randomBytes(32).toString("base64url")}`;
    const timestamp = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO tracking_observers(
        id, tenant_id, property_id, type, name, trust_level, fixed_position_json,
        fixed_position_accuracy_meters, zone_id, app_installation_id, created_by_user_id,
        hardware_metadata_json, last_heartbeat_at, status, credential_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'offline', ?, ?, ?)`).run(
        id,
        tenantId,
        input.propertyId,
        input.type,
        requiredText(input.name, "Observer name"),
        trustLevel,
        fixedPosition ? JSON.stringify(fixedPosition) : null,
        accuracy,
        input.zoneId?.trim() || null,
        installationId,
        createdByUserId,
        JSON.stringify(input.hardwareMetadata ?? {}),
        sha256(credential),
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new TrackingError(409, "OBSERVER_INSTALLATION_CONFLICT", "This app installation is already registered");
      }
      throw error;
    }
    return { observer: this.getObserver(id)!, credential };
  }

  getObserver(id: string): TrackingObserver | null {
    const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?").get(id) as unknown as TrackingObserverRow | undefined;
    return row ? observerFromRow(row) : null;
  }

  observerIdentity(id: string): AuthenticatedTrackingObserver | null {
    const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?").get(id) as
      | TrackingObserverRow
      | undefined;
    return row ? { observer: observerFromRow(row), createdByUserId: row.created_by_user_id } : null;
  }

  listObservers(propertyId: string): TrackingObserver[] {
    return (this.db.prepare("SELECT * FROM tracking_observers WHERE property_id=? ORDER BY name, id")
      .all(propertyId) as unknown as TrackingObserverRow[]).map(observerFromRow);
  }

  activePropertyIds(): string[] {
    return (this.db.prepare(`SELECT property_id FROM tracking_tags WHERE status='active'
      UNION
      SELECT property_id FROM tracking_observers WHERE status <> 'disabled'
      UNION
      SELECT property_id FROM property_member_locations
      ORDER BY property_id`).all() as Array<{ property_id: string }>)
      .map((row) => row.property_id);
  }

  updateObserver(id: string, patch: TrackingObserverPatch): TrackingObserver {
    const current = this.getObserver(id);
    if (!current) throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    const fixedPosition = patch.fixedPosition === undefined
      ? current.fixedPosition
      : patch.fixedPosition === null
        ? null
        : finiteCoordinate(patch.fixedPosition, "Observer position");
    const fixedPositionAccuracyMeters = patch.fixedPositionAccuracyMeters === undefined
      ? current.fixedPositionAccuracyMeters
      : patch.fixedPositionAccuracyMeters;
    if (fixedPositionAccuracyMeters !== null && (
      !Number.isFinite(fixedPositionAccuracyMeters)
      || fixedPositionAccuracyMeters < 0.1
      || fixedPositionAccuracyMeters > 10_000
    )) {
      throw new TrackingError(400, "INVALID_FIELD", "Observer accuracy must be between 0.1 and 10000 metres");
    }
    const zoneId = patch.zoneId === undefined ? current.zoneId : patch.zoneId?.trim() || null;
    if (zoneId) {
      const area = this.core.getPropertyArea(zoneId);
      if (!area || area.propertyId !== current.propertyId) {
        throw new TrackingError(409, "OBSERVER_ZONE_SCOPE", "Observer zone must belong to the selected Property");
      }
    }
    const fixedGateway = current.type === "esp32-gateway"
      || current.type === "linux-gateway"
      || current.type === "android-gateway";
    if (fixedGateway && !fixedPosition && !zoneId) {
      throw new TrackingError(400, "INVALID_FIELD", "Fixed gateways require a map position or assigned zone");
    }
    const trustLevel = patch.trustLevel ?? current.trustLevel;
    if (!Number.isFinite(trustLevel) || trustLevel < 0 || trustLevel > 1) {
      throw new TrackingError(400, "INVALID_FIELD", "trustLevel must be from 0 to 1");
    }
    const timestamp = new Date().toISOString();
    this.db.prepare(`UPDATE tracking_observers SET
      name=?, trust_level=?, fixed_position_json=?, fixed_position_accuracy_meters=?,
      zone_id=?, hardware_metadata_json=?, status=?, updated_at=? WHERE id=?`).run(
      patch.name === undefined ? current.name : requiredText(patch.name, "Observer name"),
      trustLevel,
      fixedPosition ? JSON.stringify(fixedPosition) : null,
      fixedPosition ? fixedPositionAccuracyMeters : null,
      zoneId,
      JSON.stringify(patch.hardwareMetadata ?? current.hardwareMetadata),
      patch.status ?? current.status,
      timestamp,
      id,
    );
    return this.getObserver(id)!;
  }

  authenticateObserverCredential(credential: string): AuthenticatedTrackingObserver | null {
    const match = credential.match(/^stuga_observer_v1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/iu);
    if (!match) return null;
    const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?").get(match[1]!) as
      | TrackingObserverRow
      | undefined;
    if (!row || row.status === "disabled" || !credentialMatches(sha256(credential), row.credential_hash)) return null;
    return { observer: observerFromRow(row), createdByUserId: row.created_by_user_id };
  }

  heartbeatObserver(
    id: string,
    input: { status?: TrackingObserver["status"]; hardwareMetadata?: TrackingObserver["hardwareMetadata"] },
    at = new Date().toISOString(),
  ): TrackingObserver {
    const current = this.getObserver(id);
    if (!current) throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    const status = input.status === "degraded" ? "degraded" : input.status === "disabled" ? "disabled" : "online";
    this.db.prepare(`UPDATE tracking_observers SET
      status=?, hardware_metadata_json=?, last_heartbeat_at=?, updated_at=? WHERE id=?`).run(
      status,
      JSON.stringify(input.hardwareMetadata ?? current.hardwareMetadata),
      at,
      at,
      id,
    );
    return this.getObserver(id)!;
  }

  updateObserverPosition(
    id: string,
    position: GeoCoordinate,
    accuracyMeters: number,
    zoneId: string | null,
  ): TrackingObserver {
    const current = this.getObserver(id);
    if (!current) throw new TrackingError(404, "TRACKING_OBSERVER_NOT_FOUND", "Tracking observer not found");
    const coordinate = finiteCoordinate(position, "Observer position");
    if (!Number.isFinite(accuracyMeters) || accuracyMeters < 0.1 || accuracyMeters > 10_000) {
      throw new TrackingError(400, "INVALID_FIELD", "Observer accuracy must be between 0.1 and 10000 metres");
    }
    if (zoneId) {
      const area = this.core.getPropertyArea(zoneId);
      if (!area || area.propertyId !== current.propertyId) {
        throw new TrackingError(409, "OBSERVER_ZONE_SCOPE", "Observer zone must belong to the selected Property");
      }
    }
    const timestamp = new Date().toISOString();
    this.db.prepare(`UPDATE tracking_observers SET fixed_position_json=?, fixed_position_accuracy_meters=?,
      zone_id=?, updated_at=? WHERE id=?`).run(JSON.stringify(coordinate), accuracyMeters, zoneId, timestamp, id);
    return this.getObserver(id)!;
  }

  refreshGatewayHealth(now = new Date(), timeoutSeconds = 90): TrackingObserver[] {
    const changed: TrackingObserver[] = [];
    for (const observer of (this.db.prepare(`SELECT * FROM tracking_observers
      WHERE type IN ('esp32-gateway','linux-gateway','android-gateway') AND status <> 'disabled'`)
      .all() as unknown as TrackingObserverRow[])) {
      const nextStatus: TrackingObserver["status"] = observer.last_heartbeat_at
        && now.getTime() - Date.parse(observer.last_heartbeat_at) <= timeoutSeconds * 1_000
        ? observer.status === "degraded" ? "degraded" : "online"
        : "offline";
      if (nextStatus === observer.status) continue;
      this.db.prepare("UPDATE tracking_observers SET status=?, updated_at=? WHERE id=?")
        .run(nextStatus, now.toISOString(), observer.id);
      changed.push(this.getObserver(observer.id)!);
    }
    return changed;
  }

  insertObservation(
    observation: TrackingObservation,
    rawPayload: string | null,
    dedupKey: string,
  ): "inserted" | "duplicate" {
    try {
      this.db.prepare(`INSERT INTO tracking_observations(
        id, tenant_id, property_id, tag_id, observer_id, observer_type, observed_at, received_at,
        rotating_tag_id, protocol_version, epoch_counter, event_counter, rssi, tx_power, motion,
        battery_percent, observer_position_json, scan_mode, app_state, device_time_offset_ms,
        quality_flags_json, accepted, metadata_json, raw_payload, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        observation.id,
        observation.tenantId,
        observation.propertyId,
        observation.tagId,
        observation.observerId,
        observation.observerType,
        observation.observedAt,
        observation.receivedAt,
        observation.rotatingTagId,
        observation.protocolVersion,
        observation.epochCounter,
        observation.eventCounter,
        observation.rssi,
        observation.txPower,
        observation.motion ? 1 : 0,
        observation.batteryPercent,
        observation.observerPosition ? JSON.stringify(observation.observerPosition) : null,
        observation.scanMode,
        observation.appState,
        observation.deviceTimeOffsetMs,
        JSON.stringify(observation.qualityFlags),
        observation.accepted ? 1 : 0,
        JSON.stringify(observation.metadata),
        rawPayload,
        dedupKey,
      );
      return "inserted";
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return "duplicate";
      throw error;
    }
  }

  recentAcceptedObservationsForTag(
    tagId: string,
    since: string,
    limit = 500,
  ): TrackingInferenceObservation[] {
    const rows = this.db.prepare(`SELECT * FROM tracking_observations
      WHERE tag_id=? AND accepted=1 AND observed_at>=?
      ORDER BY observed_at DESC, id DESC LIMIT ?`).all(tagId, since, limit) as unknown as TrackingObservationRow[];
    return rows.flatMap((row) => {
      const observer = this.getObserver(row.observer_id);
      return observer ? [{ observation: observationFromRow(row), observer }] : [];
    });
  }

  equipmentObservations(equipmentId: string, limit = 100): TrackingObservation[] {
    return (this.db.prepare(`SELECT observation.*
      FROM tracking_observations observation
      JOIN tracking_asset_tag_assignments assignment ON assignment.tag_id=observation.tag_id
      WHERE assignment.equipment_id=?
        AND observation.observed_at>=assignment.valid_from
        AND (assignment.valid_to IS NULL OR observation.observed_at<=assignment.valid_to)
      ORDER BY observation.observed_at DESC, observation.id DESC LIMIT ?`)
      .all(equipmentId, limit) as unknown as TrackingObservationRow[]).map(observationFromRow);
  }

  redactMobileObserverCoordinatesBefore(cutoff: string): number {
    return Number(this.db.prepare(`UPDATE tracking_observations
      SET observer_position_json=NULL
      WHERE observer_position_json IS NOT NULL
        AND observer_type IN ('ios-phone','android-phone')
        AND observed_at < ?`).run(cutoff).changes);
  }

  currentPosition(equipmentId: string): AssetPositionEstimate | null {
    const row = this.db.prepare(`SELECT estimate.* FROM asset_current_positions current
      JOIN asset_position_estimates estimate ON estimate.id=current.latest_estimate_id
      WHERE current.equipment_id=?`).get(equipmentId) as unknown as PositionEstimateRow | undefined;
    return row ? estimateFromRow(row) : null;
  }

  positionHistory(equipmentId: string, limit = 500): AssetPositionEstimate[] {
    return (this.db.prepare(`SELECT * FROM asset_position_estimates
      WHERE equipment_id=? ORDER BY effective_at DESC, version DESC LIMIT ?`)
      .all(equipmentId, limit) as unknown as PositionEstimateRow[]).map(estimateFromRow);
  }

  savePosition(result: TrackingInferenceResult): AssetPositionEstimate {
    const version = (this.currentPosition(result.equipmentId)?.version ?? 0) + 1;
    const estimate: AssetPositionEstimate = { ...result, id: randomUUID(), version };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO asset_position_estimates(
        id, equipment_id, property_id, calculated_at, effective_at, position_type, coordinate_json,
        accuracy_radius_meters, zone_id, confidence, confidence_level, movement_state, freshness_state,
        last_observed_at, observer_count, algorithm_version, evidence_observation_ids_json,
        explanation_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        estimate.id,
        estimate.equipmentId,
        estimate.propertyId,
        estimate.calculatedAt,
        estimate.effectiveAt,
        estimate.positionType,
        estimate.coordinate ? JSON.stringify(estimate.coordinate) : null,
        estimate.accuracyRadiusMeters,
        estimate.zoneId,
        estimate.confidence,
        estimate.confidenceLevel,
        estimate.movementState,
        estimate.freshnessState,
        estimate.lastObservedAt,
        estimate.observerCount,
        estimate.algorithmVersion,
        JSON.stringify(estimate.evidenceObservationIds),
        JSON.stringify(estimate.explanation),
        estimate.version,
      );
      this.db.prepare(`INSERT INTO asset_current_positions(
        equipment_id, latest_estimate_id, property_id, version, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(equipment_id) DO UPDATE SET latest_estimate_id=excluded.latest_estimate_id,
        property_id=excluded.property_id, version=excluded.version, updated_at=excluded.updated_at`)
        .run(estimate.equipmentId, estimate.id, estimate.propertyId, estimate.version, estimate.calculatedAt);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return estimate;
  }

  appendEvent(
    type: TrackingEventType,
    tenantId: string,
    state: TrackingEvent["state"],
    evidenceObservationIds: string[] = [],
  ): TrackingEvent {
    const propertyId = state.propertyId;
    const entityId = "equipmentId" in state ? state.equipmentId : state.id;
    const stateVersion = "version" in state ? state.version : 1;
    const eventAt = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO tracking_events(
      type, tenant_id, property_id, entity_id, event_at, state_version,
      evidence_observation_ids_json, state_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      type,
      tenantId,
      propertyId,
      entityId,
      eventAt,
      stateVersion,
      JSON.stringify(evidenceObservationIds),
      JSON.stringify(state),
    );
    const sequence = Number(result.lastInsertRowid);
    return {
      type,
      tenantId,
      propertyId,
      entityId,
      sequence,
      eventAt,
      stateVersion,
      evidenceObservationIds,
      state,
    };
  }

  eventsAfter(propertyId: string, sequence: number, limit = 500): TrackingEvent[] {
    return (this.db.prepare(`SELECT * FROM tracking_events
      WHERE property_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
      .all(propertyId, sequence, limit) as unknown as TrackingEventRow[]).map(eventFromRow);
  }

  latestSequence(propertyId: string): number {
    const row = this.db.prepare("SELECT MAX(sequence) AS sequence FROM tracking_events WHERE property_id=?")
      .get(propertyId) as { sequence: number | null };
    return Number(row.sequence ?? 0);
  }

  evaluateBoundaryTransition(
    equipmentId: string,
    inside: boolean,
    debounceSeconds: number,
    now = new Date(),
  ): "entered" | "exited" | null {
    const row = this.db.prepare(`SELECT confirmed_inside, candidate_inside, candidate_since
      FROM tracking_boundary_states WHERE equipment_id=?`).get(equipmentId) as
      | { confirmed_inside: number | null; candidate_inside: number | null; candidate_since: string | null }
      | undefined;
    const timestamp = now.toISOString();
    if (!row || row.confirmed_inside === null) {
      this.db.prepare(`INSERT INTO tracking_boundary_states(
        equipment_id, confirmed_inside, candidate_inside, candidate_since, updated_at
      ) VALUES (?, ?, NULL, NULL, ?)
      ON CONFLICT(equipment_id) DO UPDATE SET confirmed_inside=excluded.confirmed_inside,
        candidate_inside=NULL, candidate_since=NULL, updated_at=excluded.updated_at`)
        .run(equipmentId, inside ? 1 : 0, timestamp);
      return null;
    }
    const confirmed = row.confirmed_inside === 1;
    if (confirmed === inside) {
      if (row.candidate_inside !== null) {
        this.db.prepare(`UPDATE tracking_boundary_states SET candidate_inside=NULL,
          candidate_since=NULL, updated_at=? WHERE equipment_id=?`).run(timestamp, equipmentId);
      }
      return null;
    }
    if (row.candidate_inside === null || (row.candidate_inside === 1) !== inside || !row.candidate_since) {
      this.db.prepare(`UPDATE tracking_boundary_states SET candidate_inside=?,
        candidate_since=?, updated_at=? WHERE equipment_id=?`).run(inside ? 1 : 0, timestamp, timestamp, equipmentId);
      return null;
    }
    if (now.getTime() - Date.parse(row.candidate_since) < debounceSeconds * 1_000) return null;
    this.db.prepare(`UPDATE tracking_boundary_states SET confirmed_inside=?, candidate_inside=NULL,
      candidate_since=NULL, updated_at=? WHERE equipment_id=?`).run(inside ? 1 : 0, timestamp, equipmentId);
    return inside ? "entered" : "exited";
  }

  listEquipmentLoans(
    propertyId: string,
    options: { equipmentId?: string; activeOnly?: boolean; limit?: number } = {},
  ): EquipmentLoan[] {
    const conditions = ["property_id=?"];
    const parameters: Array<string | number> = [propertyId];
    if (options.equipmentId) {
      conditions.push("equipment_id=?");
      parameters.push(options.equipmentId);
    }
    if (options.activeOnly) conditions.push("returned_at IS NULL");
    parameters.push(Math.max(1, Math.min(500, options.limit ?? 200)));
    return (this.db.prepare(`SELECT * FROM equipment_loans
      WHERE ${conditions.join(" AND ")}
      ORDER BY borrowed_at DESC, id DESC LIMIT ?`)
      .all(...parameters) as unknown as EquipmentLoanRow[]).map(equipmentLoanFromRow);
  }

  getEquipmentLoan(id: string): EquipmentLoan | null {
    const row = this.db.prepare("SELECT * FROM equipment_loans WHERE id=?")
      .get(id) as unknown as EquipmentLoanRow | undefined;
    return row ? equipmentLoanFromRow(row) : null;
  }

  borrowEquipment(
    equipmentId: string,
    borrowerUserId: string,
    borrowerLabel: string,
    input: EquipmentBorrowInput,
    now = new Date(),
  ): EquipmentLoan {
    const equipment = this.core.getAreaEquipment(equipmentId);
    if (!equipment) throw new TrackingError(404, "EQUIPMENT_NOT_FOUND", "Equipment not found");
    const timestamp = now.toISOString();
    const expectedReturnAt = input.expectedReturnAt?.trim() || null;
    if (expectedReturnAt && (
      !Number.isFinite(Date.parse(expectedReturnAt))
      || Date.parse(expectedReturnAt) <= now.getTime()
    )) {
      throw new TrackingError(422, "INVALID_RETURN_TIME", "Expected return must be a future date and time");
    }
    const note = input.note?.trim() || null;
    if (note && note.length > 1_000) {
      throw new TrackingError(400, "INVALID_FIELD", "Borrowing note must contain at most 1000 characters");
    }
    const id = randomUUID();
    try {
      this.db.prepare(`INSERT INTO equipment_loans(
        id, property_id, equipment_id, borrower_user_id, borrower_label, borrowed_at,
        expected_return_at, note, returned_at, returned_by_user_id, returned_by_label, return_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`).run(
        id,
        equipment.propertyId,
        equipment.id,
        requiredText(borrowerUserId, "Borrower", 200),
        requiredText(borrowerLabel, "Borrower label", 320),
        timestamp,
        expectedReturnAt,
        note,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new TrackingError(409, "EQUIPMENT_ALREADY_BORROWED", "This equipment is already borrowed");
      }
      throw error;
    }
    return this.getEquipmentLoan(id)!;
  }

  returnEquipment(
    loanId: string,
    returnedByUserId: string,
    returnedByLabel: string,
    input: EquipmentReturnInput,
    now = new Date(),
  ): EquipmentLoan {
    const current = this.getEquipmentLoan(loanId);
    if (!current) throw new TrackingError(404, "EQUIPMENT_LOAN_NOT_FOUND", "Equipment loan not found");
    if (current.returnedAt) return current;
    const note = input.note?.trim() || null;
    if (note && note.length > 1_000) {
      throw new TrackingError(400, "INVALID_FIELD", "Return note must contain at most 1000 characters");
    }
    this.db.prepare(`UPDATE equipment_loans
      SET returned_at=?, returned_by_user_id=?, returned_by_label=?, return_note=?
      WHERE id=? AND returned_at IS NULL`).run(
      now.toISOString(),
      requiredText(returnedByUserId, "Returning member", 200),
      requiredText(returnedByLabel, "Returning member label", 320),
      note,
      loanId,
    );
    return this.getEquipmentLoan(loanId)!;
  }

  upsertMemberLocation(
    propertyId: string,
    userId: string,
    memberLabel: string,
    input: PropertyMemberLocationInput,
    now = new Date(),
  ): PropertyMemberLocation {
    if (!this.core.getProperty(propertyId)) {
      throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    }
    const position = finiteCoordinate(input.coordinate, "Member location");
    const current = this.db.prepare(`SELECT id FROM property_member_locations
      WHERE property_id=? AND user_id=?`).get(propertyId, userId) as { id: string } | undefined;
    const id = current?.id ?? randomUUID();
    const timestamp = now.toISOString();
    this.db.prepare(`INSERT INTO property_member_locations(
      id, property_id, user_id, member_label, coordinate_json,
      horizontal_accuracy_meters, reduced_accuracy, captured_at, updated_at, sharing_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(property_id, user_id) DO UPDATE SET
      member_label=excluded.member_label,
      coordinate_json=excluded.coordinate_json,
      horizontal_accuracy_meters=excluded.horizontal_accuracy_meters,
      reduced_accuracy=excluded.reduced_accuracy,
      captured_at=excluded.captured_at,
      updated_at=excluded.updated_at,
      sharing_until=excluded.sharing_until`).run(
      id,
      propertyId,
      requiredText(userId, "Member", 200),
      requiredText(memberLabel, "Member label", 320),
      JSON.stringify(position),
      input.horizontalAccuracyMeters,
      input.reducedAccuracy ? 1 : 0,
      input.capturedAt,
      timestamp,
      input.sharingUntil,
    );
    const row = this.db.prepare("SELECT * FROM property_member_locations WHERE id=?")
      .get(id) as unknown as PropertyMemberLocationRow;
    return memberLocationFromRow(row);
  }

  memberLocations(propertyId: string, now = new Date(), staleSeconds = 90): PropertyMemberLocation[] {
    const staleCutoff = new Date(now.getTime() - staleSeconds * 1_000).toISOString();
    return (this.db.prepare(`SELECT * FROM property_member_locations
      WHERE property_id=? AND sharing_until>? AND updated_at>?
      ORDER BY member_label, id`).all(
      propertyId,
      now.toISOString(),
      staleCutoff,
    ) as unknown as PropertyMemberLocationRow[]).map(memberLocationFromRow);
  }

  stopMemberLocation(propertyId: string, userId: string): PropertyMemberLocation | null {
    const row = this.db.prepare(`SELECT * FROM property_member_locations
      WHERE property_id=? AND user_id=?`).get(
      propertyId,
      userId,
    ) as unknown as PropertyMemberLocationRow | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM property_member_locations WHERE id=?").run(row.id);
    return memberLocationFromRow(row);
  }

  removeExpiredMemberLocations(now = new Date(), staleSeconds = 90): PropertyMemberLocation[] {
    const staleCutoff = new Date(now.getTime() - staleSeconds * 1_000).toISOString();
    const rows = this.db.prepare(`SELECT * FROM property_member_locations
      WHERE sharing_until<=? OR updated_at<=?`).all(
      now.toISOString(),
      staleCutoff,
    ) as unknown as PropertyMemberLocationRow[];
    if (rows.length === 0) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare("DELETE FROM property_member_locations WHERE id=?");
      for (const row of rows) remove.run(row.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.map(memberLocationFromRow);
  }

  trackedEquipment(propertyId: string): Array<{
    equipment: AreaEquipment;
    tag: TrackingTag | null;
    assignment: TrackingAssetTagAssignment | null;
    position: AssetPositionEstimate | null;
  }> {
    const equipmentRecords: AreaEquipment[] = [];
    for (let offset = 0; ; offset += TRACKED_EQUIPMENT_PAGE_SIZE) {
      const page = this.core.listAreaEquipment({
        propertyId,
        limit: TRACKED_EQUIPMENT_PAGE_SIZE,
        offset,
      });
      equipmentRecords.push(...page);
      if (equipmentRecords.length > MAX_TRACKED_EQUIPMENT) {
        throw new TrackingError(
          413,
          "COLLECTION_TOO_LARGE",
          `Tracking supports up to ${MAX_TRACKED_EQUIPMENT} equipment records per Property`,
        );
      }
      if (page.length < TRACKED_EQUIPMENT_PAGE_SIZE) break;
    }
    return equipmentRecords.map((equipment) => {
      const assignment = this.activeAssignmentForEquipment(equipment.id);
      return {
        equipment,
        assignment,
        tag: assignment ? this.getTag(assignment.tagId) : null,
        position: this.currentPosition(equipment.id),
      };
    });
  }
}
