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
import { DEFAULT_SETTINGS, DEFAULT_TAG_CAPABILITIES, TrackingAssignmentRow, TrackingError, TrackingTagRow, assignmentFromRow, finiteCoordinate, json, optionalText, requiredText, tagFromRow } from "../support/01-default-tag-capabilities-to-observation-from-row.js";
import { registerTrackingStoreMethods, trackingStoreState, type TrackingStoreInternals } from "../core.js";

registerTrackingStoreMethods({
  verifyStoredSecrets(this: TrackingStoreInternals): void {
      const row = this.db.prepare("SELECT secret_envelope FROM tracking_tags LIMIT 1").get() as
        | { secret_envelope: string }
        | undefined;
      if (!row) return;
      try {
        this[trackingStoreState].secretBox.decrypt(row.secret_envelope);
      } catch {
        throw new Error("TRACKING_SECRET_KEY_INVALID");
      }
    },
  propertySettings(this: TrackingStoreInternals, propertyId: string): TrackingPropertySettings {
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
    },
  updatePropertySettings(this: TrackingStoreInternals,
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
    },
  createTag(this: TrackingStoreInternals, input: TrackingTagCreateInput, tenantId = "local"): TrackingTagProvisioningResult {
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
        secret_envelope: this[trackingStoreState].secretBox.encrypt(secret),
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
    },
  listTags(this: TrackingStoreInternals, propertyId?: string): TrackingTag[] {
      const rows = (propertyId
        ? this.db.prepare("SELECT * FROM tracking_tags WHERE property_id = ? ORDER BY created_at DESC").all(propertyId)
        : this.db.prepare("SELECT * FROM tracking_tags ORDER BY created_at DESC").all()) as unknown as TrackingTagRow[];
      return rows.map(tagFromRow);
    },
  getTag(this: TrackingStoreInternals, id: string): TrackingTag | null {
      const row = this.db.prepare("SELECT * FROM tracking_tags WHERE id = ?").get(id) as unknown as TrackingTagRow | undefined;
      return row ? tagFromRow(row) : null;
    },
  tagSecret(this: TrackingStoreInternals, id: string): Buffer {
      const row = this.db.prepare("SELECT secret_envelope FROM tracking_tags WHERE id = ?").get(id) as
        | { secret_envelope: string }
        | undefined;
      if (!row) throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
      return this[trackingStoreState].secretBox.decrypt(row.secret_envelope);
    },
  claimTag(this: TrackingStoreInternals, id: string): TrackingTag {
      const current = this.getTag(id);
      if (!current) throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
      if (current.status === "retired") throw new TrackingError(409, "TRACKING_TAG_RETIRED", "A retired tag cannot be claimed");
      const timestamp = new Date().toISOString();
      this.db.prepare(`UPDATE tracking_tags SET status='active', paired_at=COALESCE(paired_at, ?), updated_at=? WHERE id=?`)
        .run(timestamp, timestamp, id);
      return this.getTag(id)!;
    },
  rotateTagSecret(this: TrackingStoreInternals, id: string): TrackingTagProvisioningResult {
      const current = this.getTag(id);
      if (!current) throw new TrackingError(404, "TRACKING_TAG_NOT_FOUND", "Tracking tag not found");
      if (current.status === "retired") throw new TrackingError(409, "TRACKING_TAG_RETIRED", "A retired tag cannot rotate its secret");
      const secret = randomBytes(32);
      const timestamp = new Date().toISOString();
      this.db.prepare("UPDATE tracking_tags SET secret_envelope=?, status='provisioning', updated_at=? WHERE id=?")
        .run(this[trackingStoreState].secretBox.encrypt(secret), timestamp, id);
      return { tag: this.getTag(id)!, provisioningSecret: secret.toString("base64url") };
    },
  touchTag(this: TrackingStoreInternals, id: string, observedAt: string, batteryPercent: number | null): void {
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
    },
  assignTag(this: TrackingStoreInternals, tagId: string, equipmentId: string, assignedBy: string, at = new Date().toISOString()): TrackingAssetTagAssignment {
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
    },
  unassignTag(this: TrackingStoreInternals, tagId: string, at = new Date().toISOString()): TrackingAssetTagAssignment | null {
      const current = this.activeAssignmentForTag(tagId);
      if (!current) return null;
      this.db.prepare("UPDATE tracking_asset_tag_assignments SET valid_to=? WHERE id=?").run(at, current.id);
      return { ...current, validTo: at };
    },
  activeAssignmentForTag(this: TrackingStoreInternals, tagId: string): TrackingAssetTagAssignment | null {
      const row = this.db.prepare(`SELECT * FROM tracking_asset_tag_assignments
        WHERE tag_id=? AND valid_to IS NULL`).get(tagId) as unknown as TrackingAssignmentRow | undefined;
      return row ? assignmentFromRow(row) : null;
    },
  activeAssignmentForEquipment(this: TrackingStoreInternals, equipmentId: string): TrackingAssetTagAssignment | null {
      const row = this.db.prepare(`SELECT * FROM tracking_asset_tag_assignments
        WHERE equipment_id=? AND valid_to IS NULL`).get(equipmentId) as unknown as TrackingAssignmentRow | undefined;
      return row ? assignmentFromRow(row) : null;
    },
});
