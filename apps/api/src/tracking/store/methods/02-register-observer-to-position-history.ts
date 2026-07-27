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
import { registerTrackingStoreMethods, trackingStoreState, type TrackingStoreInternals } from "../core.js";

registerTrackingStoreMethods({
  registerObserver(this: TrackingStoreInternals,
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
    },
  getObserver(this: TrackingStoreInternals, id: string): TrackingObserver | null {
      const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?").get(id) as unknown as TrackingObserverRow | undefined;
      return row ? observerFromRow(row) : null;
    },
  observerIdentity(this: TrackingStoreInternals, id: string): AuthenticatedTrackingObserver | null {
      const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?").get(id) as
        | TrackingObserverRow
        | undefined;
      return row ? { observer: observerFromRow(row), createdByUserId: row.created_by_user_id } : null;
    },
  listObservers(this: TrackingStoreInternals, propertyId: string): TrackingObserver[] {
      return (this.db.prepare("SELECT * FROM tracking_observers WHERE property_id=? ORDER BY name, id")
        .all(propertyId) as unknown as TrackingObserverRow[]).map(observerFromRow);
    },
  activePropertyIds(this: TrackingStoreInternals): string[] {
      return (this.db.prepare(`SELECT property_id FROM tracking_tags WHERE status='active'
        UNION
        SELECT property_id FROM tracking_observers WHERE status <> 'disabled'
        UNION
        SELECT property_id FROM property_member_locations
        ORDER BY property_id`).all() as Array<{ property_id: string }>)
        .map((row) => row.property_id);
    },
  updateObserver(this: TrackingStoreInternals, id: string, patch: TrackingObserverPatch): TrackingObserver {
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
    },
  authenticateObserverCredential(this: TrackingStoreInternals, credential: string): AuthenticatedTrackingObserver | null {
      const match = credential.match(/^stuga_observer_v1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/iu);
      if (!match) return null;
      const row = this.db.prepare("SELECT * FROM tracking_observers WHERE id=?").get(match[1]!) as
        | TrackingObserverRow
        | undefined;
      if (!row || row.status === "disabled" || !credentialMatches(sha256(credential), row.credential_hash)) return null;
      return { observer: observerFromRow(row), createdByUserId: row.created_by_user_id };
    },
  heartbeatObserver(this: TrackingStoreInternals,
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
    },
  updateObserverPosition(this: TrackingStoreInternals,
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
    },
  refreshGatewayHealth(this: TrackingStoreInternals, now = new Date(), timeoutSeconds = 90): TrackingObserver[] {
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
    },
  insertObservation(this: TrackingStoreInternals,
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
    },
  recentAcceptedObservationsForTag(this: TrackingStoreInternals,
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
    },
  equipmentObservations(this: TrackingStoreInternals, equipmentId: string, limit = 100): TrackingObservation[] {
      return (this.db.prepare(`SELECT observation.*
        FROM tracking_observations observation
        JOIN tracking_asset_tag_assignments assignment ON assignment.tag_id=observation.tag_id
        WHERE assignment.equipment_id=?
          AND observation.observed_at>=assignment.valid_from
          AND (assignment.valid_to IS NULL OR observation.observed_at<=assignment.valid_to)
        ORDER BY observation.observed_at DESC, observation.id DESC LIMIT ?`)
        .all(equipmentId, limit) as unknown as TrackingObservationRow[]).map(observationFromRow);
    },
  redactMobileObserverCoordinatesBefore(this: TrackingStoreInternals, cutoff: string): number {
      return Number(this.db.prepare(`UPDATE tracking_observations
        SET observer_position_json=NULL
        WHERE observer_position_json IS NOT NULL
          AND observer_type IN ('ios-phone','android-phone')
          AND observed_at < ?`).run(cutoff).changes);
    },
  currentPosition(this: TrackingStoreInternals, equipmentId: string): AssetPositionEstimate | null {
      const row = this.db.prepare(`SELECT estimate.* FROM asset_current_positions current
        JOIN asset_position_estimates estimate ON estimate.id=current.latest_estimate_id
        WHERE current.equipment_id=?`).get(equipmentId) as unknown as PositionEstimateRow | undefined;
      return row ? estimateFromRow(row) : null;
    },
  positionHistory(this: TrackingStoreInternals, equipmentId: string, limit = 500): AssetPositionEstimate[] {
      return (this.db.prepare(`SELECT * FROM asset_position_estimates
        WHERE equipment_id=? ORDER BY effective_at DESC, version DESC LIMIT ?`)
        .all(equipmentId, limit) as unknown as PositionEstimateRow[]).map(estimateFromRow);
    },
});
