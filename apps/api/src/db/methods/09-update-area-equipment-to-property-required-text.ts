import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import type {
  AreaEquipment,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
} from "@climate-twin/contracts";
import { boundedCollectionLimit, boundedCollectionOffset } from "../support/01-json-value-to-area-equipment-row.js";
import { EquipmentAttachmentDataRow, EquipmentAttachmentRow, EquipmentLinkRow, LocalMaintenanceTaskRevisionActor, PropertyNoteRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { equipmentAttachmentFromRow, equipmentLinkFromRow, propertyNoteFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  updateAreaEquipment(
      id: string,
      patch: AreaEquipmentPatch,
      actor: LocalMaintenanceTaskRevisionActor = "local-rest",
    ): AreaEquipment | null {
      return this.immediateTransaction(() => {
        const current = this.getAreaEquipment(id);
        if (!current) return null;
        let areaId = patch.areaId === undefined ? current.areaId : patch.areaId;
        let houseId = patch.houseId === undefined ? current.houseId ?? null : patch.houseId;
        if (patch.areaId && patch.houseId === undefined) houseId = null;
        if (patch.houseId && patch.areaId === undefined) areaId = null;
        if (areaId && houseId) {
          throw new ClimateDataValidationError(
            422,
            "INVALID_EQUIPMENT_LOCATION",
            "Equipment may have one expected Area or Home, not both",
          );
        }
        const targetArea = areaId ? this.getPropertyArea(areaId) : null;
        if (areaId && !targetArea) {
          throw new ClimateDataValidationError(404, "EQUIPMENT_AREA_NOT_FOUND", `Area ${areaId} does not exist`);
        }
        const targetHouse = houseId ? this.getHouse(houseId) : null;
        const retainedHiddenHouseId = houseId === (current.houseId ?? null)
          ? houseId
          : null;
        if (houseId && !targetHouse && houseId !== retainedHiddenHouseId) {
          throw new ClimateDataValidationError(404, "EQUIPMENT_HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
        }
        const targetPropertyId = targetArea?.propertyId ?? targetHouse?.propertyId ?? current.propertyId;
        if (targetPropertyId !== current.propertyId) {
          this.ensureScopeMoveCanDetachHouses("task.equipment_id = ?", [id], targetPropertyId);
        }
        const locationChanged = areaId !== current.areaId || houseId !== (current.houseId ?? null);
        const affectedTasks = locationChanged
          ? this.maintenanceTasksBeforeScopeMove("equipment_id = ?", [id])
          : [];
        const next: AreaEquipment = {
          ...current,
          propertyId: targetPropertyId,
          areaId,
          houseId,
          ...(patch.name !== undefined ? { name: this.propertyRequiredText(patch.name, "Equipment name", 200) } : {}),
          ...(patch.kind !== undefined ? { kind: this.propertyRequiredText(patch.kind, "Equipment kind", 200) } : {}),
          ...(patch.manufacturer !== undefined
            ? { manufacturer: this.propertyOptionalText(patch.manufacturer, "Equipment manufacturer", 200) }
            : {}),
          ...(patch.model !== undefined ? { model: this.propertyOptionalText(patch.model, "Equipment model", 200) } : {}),
          ...(patch.serialNumber !== undefined
            ? { serialNumber: this.propertyOptionalText(patch.serialNumber, "Equipment serial number", 200) }
            : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.notes !== undefined ? { notes: this.propertyOptionalText(patch.notes, "Equipment notes", 5_000) } : {}),
          updatedAt: this.nextUpdatedAt(current.updatedAt),
        };
        if (patch.location === null) delete next.location;
        else if (patch.location !== undefined) next.location = structuredClone(patch.location);
        this.validateAreaEquipment(next, retainedHiddenHouseId);
        try {
          this.db.prepare(`UPDATE area_equipment SET property_id = ?, area_id = ?, house_id = ?, location_json = ?,
            name = ?, kind = ?, manufacturer = ?, model = ?, serial_number = ?, status = ?, notes = ?, updated_at = ?
            WHERE id = ?`)
            .run(next.propertyId, next.areaId, next.houseId ?? null,
              next.location ? JSON.stringify(next.location) : null, next.name, next.kind, next.manufacturer, next.model,
              next.serialNumber, next.status, next.notes, next.updatedAt, id);
        } catch (error) {
          if (isSqliteFailure(error, "trigger", "MAINTENANCE_OBSERVATION_SCOPE_MISMATCH")) {
            throw new ClimateDataValidationError(
              409,
              "MAINTENANCE_OBSERVATION_SCOPE_MISMATCH",
              "Move or unlink maintenance observation evidence before assigning this equipment to another Home",
            );
          }
          if (isSqliteFailure(error, "trigger", "TRACKING_BINDING_PROPERTY_MOVE")) {
            throw new ClimateDataValidationError(
              409,
              "TRACKED_EQUIPMENT_PROPERTY_MOVE",
              "Remove the active tracking endpoint binding before moving this equipment to another Property",
            );
          }
          throw error;
        }
        this.recordScopeMoveMaintenanceRevisions(affectedTasks, actor);
        return next;
      });
    },
  deleteAreaEquipment(id: string): boolean {
      try {
        return Number(this.db.prepare("DELETE FROM area_equipment WHERE id = ?").run(id).changes) > 0;
      } catch (error) {
        if (isSqliteFailure(error, "foreign-key")) {
          throw new ClimateDataValidationError(
            409,
            "EQUIPMENT_IN_USE",
            `Equipment ${id} is referenced by notes or maintenance tasks`,
          );
        }
        throw error;
      }
    },
  listEquipmentAttachments(filters: {
      equipmentId?: string;
      propertyId?: string;
    } = {}): EquipmentAttachment[] {
      const clauses: string[] = [];
      const values: string[] = [];
      if (filters.equipmentId) {
        clauses.push("attachment.equipment_id = ?");
        values.push(filters.equipmentId);
      }
      if (filters.propertyId) {
        clauses.push("equipment.property_id = ?");
        values.push(filters.propertyId);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db.prepare(`SELECT attachment.id, attachment.equipment_id, attachment.kind,
          attachment.name, attachment.mime_type, attachment.size, attachment.created_at
        FROM equipment_attachments attachment
        JOIN area_equipment equipment ON equipment.id = attachment.equipment_id
        ${where}
        ORDER BY attachment.created_at DESC, attachment.id`)
        .all(...values) as unknown as EquipmentAttachmentRow[];
      return rows.map(equipmentAttachmentFromRow);
    },
  getEquipmentAttachment(id: string): (EquipmentAttachment & { data: Uint8Array }) | null {
      const row = this.db.prepare("SELECT * FROM equipment_attachments WHERE id = ?")
        .get(id) as unknown as EquipmentAttachmentDataRow | undefined;
      return row ? { ...equipmentAttachmentFromRow(row), data: row.data } : null;
    },
  createEquipmentAttachment(input: {
      equipmentId: string;
      kind: EquipmentAttachment["kind"];
      name: string;
      mimeType: string;
      data: Uint8Array;
    }): EquipmentAttachment {
      if (!this.getAreaEquipment(input.equipmentId)) {
        throw new ClimateDataValidationError(
          404,
          "EQUIPMENT_NOT_FOUND",
          `Equipment ${input.equipmentId} does not exist`,
        );
      }
      if (!["photo", "document"].includes(input.kind)) {
        throw new ClimateDataValidationError(422, "INVALID_ATTACHMENT_KIND", "Attachment kind must be photo or document");
      }
      if (input.data.byteLength < 1 || input.data.byteLength > 10 * 1024 * 1024) {
        throw new ClimateDataValidationError(422, "INVALID_ATTACHMENT_SIZE", "Attachment size must be from 1 byte to 10 MiB");
      }
      const attachment: EquipmentAttachment = {
        id: randomUUID(),
        equipmentId: input.equipmentId,
        kind: input.kind,
        name: this.propertyRequiredText(input.name, "Attachment name", 255),
        mimeType: this.propertyRequiredText(input.mimeType, "Attachment media type", 200).toLowerCase(),
        size: input.data.byteLength,
        createdAt: new Date().toISOString(),
      };
      this.db.prepare(`INSERT INTO equipment_attachments
        (id, equipment_id, kind, name, mime_type, data, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          attachment.id,
          attachment.equipmentId,
          attachment.kind,
          attachment.name,
          attachment.mimeType,
          input.data,
          attachment.size,
          attachment.createdAt,
        );
      return attachment;
    },
  deleteEquipmentAttachment(id: string): boolean {
      return Number(this.db.prepare("DELETE FROM equipment_attachments WHERE id = ?").run(id).changes) > 0;
    },
  listEquipmentLinks(filters: {
      equipmentId?: string;
      propertyId?: string;
    } = {}): EquipmentLink[] {
      const clauses: string[] = [];
      const values: string[] = [];
      if (filters.equipmentId) {
        clauses.push("link.equipment_id = ?");
        values.push(filters.equipmentId);
      }
      if (filters.propertyId) {
        clauses.push("equipment.property_id = ?");
        values.push(filters.propertyId);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db.prepare(`SELECT link.*
        FROM equipment_links link
        JOIN area_equipment equipment ON equipment.id = link.equipment_id
        ${where}
        ORDER BY link.label COLLATE NOCASE, link.id`)
        .all(...values) as unknown as EquipmentLinkRow[];
      return rows.map(equipmentLinkFromRow);
    },
  getEquipmentLink(id: string): EquipmentLink | null {
      const row = this.db.prepare("SELECT * FROM equipment_links WHERE id = ?")
        .get(id) as unknown as EquipmentLinkRow | undefined;
      return row ? equipmentLinkFromRow(row) : null;
    },
  createEquipmentLink(input: EquipmentLinkInput & { equipmentId: string }): EquipmentLink {
      if (!this.getAreaEquipment(input.equipmentId)) {
        throw new ClimateDataValidationError(
          404,
          "EQUIPMENT_NOT_FOUND",
          `Equipment ${input.equipmentId} does not exist`,
        );
      }
      const timestamp = new Date().toISOString();
      const link: EquipmentLink = {
        id: randomUUID(),
        equipmentId: input.equipmentId,
        label: this.propertyRequiredText(input.label, "Equipment link label", 200),
        url: this.equipmentLinkUrl(input.url),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.db.prepare(`INSERT INTO equipment_links
        (id, equipment_id, label, url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(link.id, link.equipmentId, link.label, link.url, link.createdAt, link.updatedAt);
      return link;
    },
  updateEquipmentLink(id: string, patch: EquipmentLinkPatch): EquipmentLink | null {
      const current = this.getEquipmentLink(id);
      if (!current) return null;
      const link: EquipmentLink = {
        ...current,
        ...(patch.label !== undefined
          ? { label: this.propertyRequiredText(patch.label, "Equipment link label", 200) }
          : {}),
        ...(patch.url !== undefined ? { url: this.equipmentLinkUrl(patch.url) } : {}),
        updatedAt: this.nextUpdatedAt(current.updatedAt),
      };
      this.db.prepare("UPDATE equipment_links SET label = ?, url = ?, updated_at = ? WHERE id = ?")
        .run(link.label, link.url, link.updatedAt, link.id);
      return link;
    },
  deleteEquipmentLink(id: string): boolean {
      return Number(this.db.prepare("DELETE FROM equipment_links WHERE id = ?").run(id).changes) > 0;
    },
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
  propertyRequiredText(value: string, field: string, maximumLength: number): string {
      if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > maximumLength) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_PROPERTY_FIELD",
          `${field} must be a non-empty string of at most ${maximumLength} characters`,
        );
      }
      return value.trim();
    },
});
