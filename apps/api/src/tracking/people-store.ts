import { randomUUID } from "node:crypto";
import type {
  EquipmentBorrowInput,
  EquipmentLoan,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocation,
  PropertyMemberLocationInput,
} from "@climate-twin/contracts";
import type { ClimateDatabase } from "../db.js";
import { TrackingError } from "./errors.js";
import { finiteCoordinate, parseJson, requiredText } from "./store-support.js";

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

interface MemberLocationRow {
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

function loanFromRow(row: EquipmentLoanRow): EquipmentLoan {
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

function memberFromRow(row: MemberLocationRow): PropertyMemberLocation {
  return {
    id: row.id,
    propertyId: row.property_id,
    memberLabel: row.member_label,
    coordinate: parseJson<GeoCoordinate>(row.coordinate_json, "member location"),
    horizontalAccuracyMeters: row.horizontal_accuracy_meters,
    reducedAccuracy: row.reduced_accuracy === 1,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
    sharingUntil: row.sharing_until,
  };
}

export class TrackingPeopleStore {
  constructor(private readonly core: ClimateDatabase) {}

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
    return (this.core.db.prepare(`SELECT * FROM equipment_loans
      WHERE ${conditions.join(" AND ")} ORDER BY borrowed_at DESC, id DESC LIMIT ?`)
      .all(...parameters) as unknown as EquipmentLoanRow[]).map(loanFromRow);
  }

  getEquipmentLoan(id: string): EquipmentLoan | null {
    const row = this.core.db.prepare("SELECT * FROM equipment_loans WHERE id=?")
      .get(id) as unknown as EquipmentLoanRow | undefined;
    return row ? loanFromRow(row) : null;
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
      this.core.db.prepare(`INSERT INTO equipment_loans(
        id, property_id, equipment_id, borrower_user_id, borrower_label, borrowed_at,
        expected_return_at, note, returned_at, returned_by_user_id, returned_by_label, return_note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`).run(
        id, equipment.propertyId, equipment.id, requiredText(borrowerUserId, "Borrower"),
        requiredText(borrowerLabel, "Borrower label", 320), now.toISOString(), expectedReturnAt, note,
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
    this.core.db.prepare(`UPDATE equipment_loans SET returned_at=?, returned_by_user_id=?,
      returned_by_label=?, return_note=? WHERE id=? AND returned_at IS NULL`).run(
      now.toISOString(), requiredText(returnedByUserId, "Returning member"),
      requiredText(returnedByLabel, "Returning member label", 320), note, loanId,
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
    if (!this.core.getProperty(propertyId)) throw new TrackingError(404, "PROPERTY_NOT_FOUND", "Property not found");
    const coordinate = finiteCoordinate(input.coordinate, "Member location");
    if (!Number.isFinite(input.horizontalAccuracyMeters)
      || input.horizontalAccuracyMeters < 0
      || input.horizontalAccuracyMeters > 10_000) {
      throw new TrackingError(422, "INVALID_COORDINATE_ACCURACY", "Location accuracy must be from 0 to 10000 metres");
    }
    const capturedAt = Date.parse(input.capturedAt);
    const sharingUntil = Date.parse(input.sharingUntil);
    if (!Number.isFinite(capturedAt) || !Number.isFinite(sharingUntil)
      || sharingUntil <= now.getTime() || sharingUntil > now.getTime() + 24 * 60 * 60 * 1_000) {
      throw new TrackingError(422, "INVALID_SHARING_WINDOW", "Location sharing must end within the next 24 hours");
    }
    const current = this.core.db.prepare(
      "SELECT id FROM property_member_locations WHERE property_id=? AND user_id=?",
    ).get(propertyId, userId) as { id: string } | undefined;
    const id = current?.id ?? randomUUID();
    const timestamp = now.toISOString();
    this.core.db.prepare(`INSERT INTO property_member_locations(
      id, property_id, user_id, member_label, coordinate_json, horizontal_accuracy_meters,
      reduced_accuracy, captured_at, updated_at, sharing_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(property_id, user_id) DO UPDATE SET
      member_label=excluded.member_label, coordinate_json=excluded.coordinate_json,
      horizontal_accuracy_meters=excluded.horizontal_accuracy_meters,
      reduced_accuracy=excluded.reduced_accuracy, captured_at=excluded.captured_at,
      updated_at=excluded.updated_at, sharing_until=excluded.sharing_until`).run(
      id, propertyId, requiredText(userId, "Member"), requiredText(memberLabel, "Member label", 320),
      JSON.stringify(coordinate), input.horizontalAccuracyMeters, input.reducedAccuracy ? 1 : 0,
      new Date(capturedAt).toISOString(), timestamp, new Date(sharingUntil).toISOString(),
    );
    return memberFromRow(this.core.db.prepare("SELECT * FROM property_member_locations WHERE id=?")
      .get(id) as unknown as MemberLocationRow);
  }

  memberLocations(propertyId: string, now = new Date(), staleSeconds = 90): PropertyMemberLocation[] {
    const staleCutoff = new Date(now.getTime() - staleSeconds * 1_000).toISOString();
    return (this.core.db.prepare(`SELECT * FROM property_member_locations
      WHERE property_id=? AND sharing_until>? AND updated_at>? ORDER BY member_label, id`)
      .all(propertyId, now.toISOString(), staleCutoff) as unknown as MemberLocationRow[]).map(memberFromRow);
  }

  stopMemberLocation(propertyId: string, userId: string): PropertyMemberLocation | null {
    const row = this.core.db.prepare(
      "SELECT * FROM property_member_locations WHERE property_id=? AND user_id=?",
    ).get(propertyId, userId) as unknown as MemberLocationRow | undefined;
    if (!row) return null;
    this.core.db.prepare("DELETE FROM property_member_locations WHERE id=?").run(row.id);
    return memberFromRow(row);
  }

  removeExpiredMemberLocations(now = new Date(), staleSeconds = 90): PropertyMemberLocation[] {
    const rows = this.core.db.prepare(`SELECT * FROM property_member_locations
      WHERE sharing_until<=? OR updated_at<=?`).all(
      now.toISOString(),
      new Date(now.getTime() - staleSeconds * 1_000).toISOString(),
    ) as unknown as MemberLocationRow[];
    const remove = this.core.db.prepare("DELETE FROM property_member_locations WHERE id=?");
    for (const row of rows) remove.run(row.id);
    return rows.map(memberFromRow);
  }
}
