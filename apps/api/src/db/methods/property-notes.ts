import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import type { PropertyNote, PropertyNoteInput, PropertyNotePatch, PropertyArea } from "@climate-twin/contracts";
import { boundedCollectionLimit, boundedCollectionOffset, PROPERTY_NOTE_KINDS } from "../support/domain-limits.js";
import { PropertyNoteRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { propertyNoteFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listPropertyNotes(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): PropertyNote[];
    getPropertyNote(id: string): PropertyNote | null;
    createPropertyNote(input: PropertyNoteInput): PropertyNote;
    updatePropertyNote(id: string, patch: PropertyNotePatch): PropertyNote | null;
    deletePropertyNote(id: string): boolean;
    validatePropertyNote(note: PropertyNote, retainedHiddenHouseId?: string | null): void;
  }

  interface ClimateDatabaseCore {
    listPropertyNotes(filters?: {
            propertyId?: string;
            houseId?: string;
            areaId?: string;
            equipmentId?: string;
            limit?: number;
            offset?: number;
        }): PropertyNote[];
    getPropertyNote(id: string): PropertyNote | null;
    createPropertyNote(input: PropertyNoteInput): PropertyNote;
    updatePropertyNote(id: string, patch: PropertyNotePatch): PropertyNote | null;
    deletePropertyNote(id: string): boolean;
  }
}

registerDatabaseMethods({
  listPropertyNotes(filters: {
      propertyId?: string;
      houseId?: string;
      areaId?: string;
      equipmentId?: string;
      limit?: number;
      offset?: number;
    } = {}): PropertyNote[] {
      const clauses: string[] = [];
      const values: string[] = [];
      for (const [column, value] of [
        ["property_id", filters.propertyId], ["house_id", filters.houseId], ["area_id", filters.areaId],
        ["equipment_id", filters.equipmentId],
      ] as const) {
        if (value) { clauses.push(`${column} = ?`); values.push(value); }
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db.prepare(`SELECT * FROM property_notes${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
        .all(...values, boundedCollectionLimit(filters.limit), boundedCollectionOffset(filters.offset)) as unknown as PropertyNoteRow[];
      return rows.map(propertyNoteFromRow);
    },
  getPropertyNote(id: string): PropertyNote | null {
      const row = this.db.prepare("SELECT * FROM property_notes WHERE id = ?").get(id) as unknown as PropertyNoteRow | undefined;
      return row ? propertyNoteFromRow(row) : null;
    },
  createPropertyNote(input: PropertyNoteInput): PropertyNote {
      return this.immediateTransaction(() => {
        const timestamp = new Date().toISOString();
        const note: PropertyNote = {
          id: input.id ?? randomUUID(),
          propertyId: input.propertyId,
          houseId: input.houseId ?? null,
          areaId: input.areaId ?? null,
          equipmentId: input.equipmentId ?? null,
          kind: input.kind,
          text: this.propertyRequiredText(input.text, "Property note", 5_000),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.validatePropertyNote(note);
        try {
          this.db.prepare(`INSERT INTO property_notes
            (id, property_id, house_id, area_id, equipment_id, kind, text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(note.id, note.propertyId, note.houseId, note.areaId, note.equipmentId, note.kind, note.text,
              note.createdAt, note.updatedAt);
        } catch (error) {
          if (isSqliteFailure(error, "unique", "property_notes.id")) {
            throw new ClimateDataValidationError(409, "PROPERTY_NOTE_ID_CONFLICT", `Property note ${note.id} already exists`);
          }
          throw error;
        }
        return note;
      });
    },
  updatePropertyNote(id: string, patch: PropertyNotePatch): PropertyNote | null {
      return this.immediateTransaction(() => {
        const current = this.getPropertyNote(id);
        if (!current) return null;
        const next: PropertyNote = {
          ...current,
          ...(patch.houseId !== undefined ? { houseId: patch.houseId } : {}),
          ...(patch.areaId !== undefined ? { areaId: patch.areaId } : {}),
          ...(patch.equipmentId !== undefined ? { equipmentId: patch.equipmentId } : {}),
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.text !== undefined ? { text: this.propertyRequiredText(patch.text, "Property note", 5_000) } : {}),
          updatedAt: this.nextUpdatedAt(current.updatedAt),
        };
        this.validatePropertyNote(next, next.houseId === current.houseId ? current.houseId : null);
        this.db.prepare(`UPDATE property_notes
          SET house_id = ?, area_id = ?, equipment_id = ?, kind = ?, text = ?, updated_at = ? WHERE id = ?`)
          .run(next.houseId, next.areaId, next.equipmentId, next.kind, next.text, next.updatedAt, id);
        return next;
      });
    },
  deletePropertyNote(id: string): boolean {
      return Number(this.db.prepare("DELETE FROM property_notes WHERE id = ?").run(id).changes) > 0;
    },
  validatePropertyNote(note: PropertyNote, retainedHiddenHouseId: string | null = null): void {
      if (!this.getProperty(note.propertyId)) {
        throw new ClimateDataValidationError(404, "NOTE_PROPERTY_NOT_FOUND", `Property ${note.propertyId} does not exist`);
      }
      if (!PROPERTY_NOTE_KINDS.has(note.kind)) {
        throw new ClimateDataValidationError(422, "INVALID_PROPERTY_NOTE_KIND", "Property note kind is not supported");
      }
      if ([note.houseId, note.areaId, note.equipmentId].filter((id) => id !== null).length > 1) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_PROPERTY_NOTE_TARGET",
          "A property note may target at most one house, area, or equipment item",
        );
      }
      if (note.houseId !== null) {
        const house = this.getHouse(note.houseId);
        const retainingHiddenHouse = !house && note.houseId === retainedHiddenHouseId;
        if (!house && !retainingHiddenHouse) {
          throw new ClimateDataValidationError(404, "NOTE_HOUSE_NOT_FOUND", `House ${note.houseId} does not exist`);
        }
        if (house && house.propertyId !== note.propertyId) {
          throw new ClimateDataValidationError(409, "PROPERTY_NOTE_SCOPE_MISMATCH", "Note house belongs to another property");
        }
      }
      let area: PropertyArea | null = null;
      if (note.areaId !== null) {
        area = this.getPropertyArea(note.areaId);
        if (!area) throw new ClimateDataValidationError(404, "NOTE_AREA_NOT_FOUND", `Area ${note.areaId} does not exist`);
        if (area.propertyId !== note.propertyId) {
          throw new ClimateDataValidationError(409, "PROPERTY_NOTE_SCOPE_MISMATCH", "Note area belongs to another property");
        }
      }
      if (note.equipmentId !== null) {
        const equipment = this.getAreaEquipment(note.equipmentId);
        if (!equipment) {
          throw new ClimateDataValidationError(404, "NOTE_EQUIPMENT_NOT_FOUND", `Equipment ${note.equipmentId} does not exist`);
        }
        if (equipment.propertyId !== note.propertyId || (area && equipment.areaId !== area.id)) {
          throw new ClimateDataValidationError(
            409,
            "PROPERTY_NOTE_SCOPE_MISMATCH",
            "Note equipment belongs to another property or area",
          );
        }
      }
    },
});
