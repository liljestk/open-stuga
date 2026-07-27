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
import { registerTrackingStoreMethods, trackingStoreState, type TrackingStoreInternals } from "../core.js";

registerTrackingStoreMethods({
  savePosition(this: TrackingStoreInternals, result: TrackingInferenceResult): AssetPositionEstimate {
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
    },
  appendEvent(this: TrackingStoreInternals,
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
    },
  eventsAfter(this: TrackingStoreInternals, propertyId: string, sequence: number, limit = 500): TrackingEvent[] {
      return (this.db.prepare(`SELECT * FROM tracking_events
        WHERE property_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
        .all(propertyId, sequence, limit) as unknown as TrackingEventRow[]).map(eventFromRow);
    },
  latestSequence(this: TrackingStoreInternals, propertyId: string): number {
      const row = this.db.prepare("SELECT MAX(sequence) AS sequence FROM tracking_events WHERE property_id=?")
        .get(propertyId) as { sequence: number | null };
      return Number(row.sequence ?? 0);
    },
  evaluateBoundaryTransition(this: TrackingStoreInternals,
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
    },
  listEquipmentLoans(this: TrackingStoreInternals,
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
    },
  getEquipmentLoan(this: TrackingStoreInternals, id: string): EquipmentLoan | null {
      const row = this.db.prepare("SELECT * FROM equipment_loans WHERE id=?")
        .get(id) as unknown as EquipmentLoanRow | undefined;
      return row ? equipmentLoanFromRow(row) : null;
    },
  borrowEquipment(this: TrackingStoreInternals,
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
    },
  returnEquipment(this: TrackingStoreInternals,
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
    },
  upsertMemberLocation(this: TrackingStoreInternals,
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
    },
  memberLocations(this: TrackingStoreInternals, propertyId: string, now = new Date(), staleSeconds = 90): PropertyMemberLocation[] {
      const staleCutoff = new Date(now.getTime() - staleSeconds * 1_000).toISOString();
      return (this.db.prepare(`SELECT * FROM property_member_locations
        WHERE property_id=? AND sharing_until>? AND updated_at>?
        ORDER BY member_label, id`).all(
        propertyId,
        now.toISOString(),
        staleCutoff,
      ) as unknown as PropertyMemberLocationRow[]).map(memberLocationFromRow);
    },
  stopMemberLocation(this: TrackingStoreInternals, propertyId: string, userId: string): PropertyMemberLocation | null {
      const row = this.db.prepare(`SELECT * FROM property_member_locations
        WHERE property_id=? AND user_id=?`).get(
        propertyId,
        userId,
      ) as unknown as PropertyMemberLocationRow | undefined;
      if (!row) return null;
      this.db.prepare("DELETE FROM property_member_locations WHERE id=?").run(row.id);
      return memberLocationFromRow(row);
    },
  removeExpiredMemberLocations(this: TrackingStoreInternals, now = new Date(), staleSeconds = 90): PropertyMemberLocation[] {
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
    },
});
