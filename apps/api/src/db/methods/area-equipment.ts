import { isSqliteFailure } from "../sqlite-failure.js";
import { randomUUID } from "node:crypto";
import type { AreaEquipment, AreaEquipmentInput, AreaEquipmentPatch, EquipmentAttachment, EquipmentLink, EquipmentLinkInput, EquipmentLinkPatch } from "@climate-twin/contracts";
import { AreaEquipmentRow } from "../support/row-types.js";
import { boundedCollectionLimit, boundedCollectionOffset, EQUIPMENT_STATUSES } from "../support/domain-limits.js";
import { LocalMaintenanceTaskRevisionActor } from "../support/record-types.js";
import { EquipmentAttachmentDataRow, EquipmentAttachmentRow, EquipmentLinkRow } from "../support/row-types.js";
import { ClimateDataValidationError } from "../support/validation-errors.js";
import { areaEquipmentFromRow, equipmentAttachmentFromRow, equipmentLinkFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listAreaEquipment(filters?: {
            propertyId?: string;
            areaId?: string;
            houseId?: string;
            limit?: number;
            offset?: number;
        }): AreaEquipment[];
    getAreaEquipment(id: string): AreaEquipment | null;
    createAreaEquipment(input: AreaEquipmentInput): AreaEquipment;
    updateAreaEquipment(id: string, patch: AreaEquipmentPatch, actor?: LocalMaintenanceTaskRevisionActor): AreaEquipment | null;
    deleteAreaEquipment(id: string): boolean;
    listEquipmentAttachments(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentAttachment[];
    getEquipmentAttachment(id: string): (EquipmentAttachment & {
            data: Uint8Array;
        }) | null;
    createEquipmentAttachment(input: {
            equipmentId: string;
            kind: EquipmentAttachment["kind"];
            name: string;
            mimeType: string;
            data: Uint8Array;
        }): EquipmentAttachment;
    deleteEquipmentAttachment(id: string): boolean;
    listEquipmentLinks(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentLink[];
    getEquipmentLink(id: string): EquipmentLink | null;
    createEquipmentLink(input: EquipmentLinkInput & {
            equipmentId: string;
        }): EquipmentLink;
    updateEquipmentLink(id: string, patch: EquipmentLinkPatch): EquipmentLink | null;
    deleteEquipmentLink(id: string): boolean;
    equipmentLinkUrl(value: string): string;
    validateAreaEquipment(equipment: AreaEquipment, retainedHiddenHouseId?: string | null): void;
  }

  interface ClimateDatabaseCore {
    listAreaEquipment(filters?: {
            propertyId?: string;
            areaId?: string;
            houseId?: string;
            limit?: number;
            offset?: number;
        }): AreaEquipment[];
    getAreaEquipment(id: string): AreaEquipment | null;
    createAreaEquipment(input: AreaEquipmentInput): AreaEquipment;
    updateAreaEquipment(id: string, patch: AreaEquipmentPatch, actor?: LocalMaintenanceTaskRevisionActor): AreaEquipment | null;
    deleteAreaEquipment(id: string): boolean;
    listEquipmentAttachments(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentAttachment[];
    getEquipmentAttachment(id: string): (EquipmentAttachment & {
            data: Uint8Array;
        }) | null;
    createEquipmentAttachment(input: {
            equipmentId: string;
            kind: EquipmentAttachment["kind"];
            name: string;
            mimeType: string;
            data: Uint8Array;
        }): EquipmentAttachment;
    deleteEquipmentAttachment(id: string): boolean;
    listEquipmentLinks(filters?: {
            equipmentId?: string;
            propertyId?: string;
        }): EquipmentLink[];
    getEquipmentLink(id: string): EquipmentLink | null;
    createEquipmentLink(input: EquipmentLinkInput & {
            equipmentId: string;
        }): EquipmentLink;
    updateEquipmentLink(id: string, patch: EquipmentLinkPatch): EquipmentLink | null;
    deleteEquipmentLink(id: string): boolean;
  }
}

registerDatabaseMethods({
  listAreaEquipment(filters: {
      propertyId?: string;
      areaId?: string;
      houseId?: string;
      limit?: number;
      offset?: number;
    } = {}): AreaEquipment[] {
      const clauses: string[] = [];
      const values: string[] = [];
      if (filters.propertyId) { clauses.push("property_id = ?"); values.push(filters.propertyId); }
      if (filters.areaId) { clauses.push("area_id = ?"); values.push(filters.areaId); }
      if (filters.houseId) { clauses.push("house_id = ?"); values.push(filters.houseId); }
      const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db.prepare(`SELECT * FROM area_equipment${where} ORDER BY name, id LIMIT ? OFFSET ?`)
        .all(...values, boundedCollectionLimit(filters.limit), boundedCollectionOffset(filters.offset)) as unknown as AreaEquipmentRow[];
      return rows.map(areaEquipmentFromRow);
    },
  getAreaEquipment(id: string): AreaEquipment | null {
      const row = this.db.prepare("SELECT * FROM area_equipment WHERE id = ?").get(id) as unknown as AreaEquipmentRow | undefined;
      return row ? areaEquipmentFromRow(row) : null;
    },
  createAreaEquipment(input: AreaEquipmentInput): AreaEquipment {
      return this.immediateTransaction(() => {
        const areaId = input.areaId ?? null;
        const houseId = input.houseId ?? null;
        if (areaId && houseId) {
          throw new ClimateDataValidationError(
            422,
            "INVALID_EQUIPMENT_LOCATION",
            "Equipment may have one expected Area or Home, not both",
          );
        }
        const area = areaId ? this.getPropertyArea(areaId) : null;
        if (areaId && !area) {
          throw new ClimateDataValidationError(404, "EQUIPMENT_AREA_NOT_FOUND", `Area ${areaId} does not exist`);
        }
        const house = houseId ? this.getHouse(houseId) : null;
        if (houseId && !house) {
          throw new ClimateDataValidationError(404, "EQUIPMENT_HOUSE_NOT_FOUND", `House ${houseId} does not exist`);
        }
        const propertyId = input.propertyId?.trim() || area?.propertyId || house?.propertyId;
        if (!propertyId) {
          throw new ClimateDataValidationError(
            422,
            "EQUIPMENT_PROPERTY_REQUIRED",
            "Unassigned equipment requires a Property",
          );
        }
        const timestamp = new Date().toISOString();
        const equipment: AreaEquipment = {
          id: input.id ?? randomUUID(),
          propertyId,
          areaId,
          houseId,
          ...(input.location ? { location: structuredClone(input.location) } : {}),
          name: this.propertyRequiredText(input.name, "Equipment name", 200),
          kind: this.propertyRequiredText(input.kind, "Equipment kind", 200),
          manufacturer: this.propertyOptionalText(input.manufacturer ?? null, "Equipment manufacturer", 200),
          model: this.propertyOptionalText(input.model ?? null, "Equipment model", 200),
          serialNumber: this.propertyOptionalText(input.serialNumber ?? null, "Equipment serial number", 200),
          status: input.status ?? "active",
          notes: this.propertyOptionalText(input.notes ?? null, "Equipment notes", 5_000),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        this.validateAreaEquipment(equipment);
        try {
          this.db.prepare(`INSERT INTO area_equipment
            (id, property_id, area_id, house_id, location_json, name, kind, manufacturer, model, serial_number,
             status, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(equipment.id, equipment.propertyId, equipment.areaId, equipment.houseId ?? null,
              equipment.location ? JSON.stringify(equipment.location) : null, equipment.name, equipment.kind,
              equipment.manufacturer, equipment.model, equipment.serialNumber, equipment.status, equipment.notes,
              equipment.createdAt, equipment.updatedAt);
        } catch (error) {
          if (isSqliteFailure(error, "unique", "area_equipment.id")) {
            throw new ClimateDataValidationError(409, "EQUIPMENT_ID_CONFLICT", `Equipment ${equipment.id} already exists`);
          }
          throw error;
        }
        return equipment;
      });
    },
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
  equipmentLinkUrl(value: string): string {
      const normalized = this.propertyRequiredText(value, "Equipment link URL", 2_048);
      try {
        const parsed = new URL(normalized);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        return parsed.href;
      } catch {
        throw new ClimateDataValidationError(
          422,
          "INVALID_EQUIPMENT_LINK",
          "Equipment link URL must be an HTTP or HTTPS address without embedded credentials",
        );
      }
    },
  validateAreaEquipment(equipment: AreaEquipment, retainedHiddenHouseId: string | null = null): void {
      if (!this.getProperty(equipment.propertyId)) {
        throw new ClimateDataValidationError(
          404,
          "EQUIPMENT_PROPERTY_NOT_FOUND",
          `Property ${equipment.propertyId} does not exist`,
        );
      }
      const houseId = equipment.houseId ?? null;
      if (equipment.areaId !== null && houseId !== null) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_EQUIPMENT_LOCATION",
          "Equipment may have one expected Area or Home, not both",
        );
      }
      if (equipment.areaId !== null) {
        const area = this.getPropertyArea(equipment.areaId);
        if (!area) {
          throw new ClimateDataValidationError(
            404,
            "EQUIPMENT_AREA_NOT_FOUND",
            `Area ${equipment.areaId} does not exist`,
          );
        }
        if (area.propertyId !== equipment.propertyId) {
          throw new ClimateDataValidationError(
            409,
            "EQUIPMENT_AREA_SCOPE_MISMATCH",
            `Area ${area.id} does not belong to property ${equipment.propertyId}`,
          );
        }
      }
      if (houseId !== null) {
        const house = this.getHouse(houseId);
        const retainingHiddenHouse = !house && houseId === retainedHiddenHouseId;
        if (!house && !retainingHiddenHouse) {
          throw new ClimateDataValidationError(
            404,
            "EQUIPMENT_HOUSE_NOT_FOUND",
            `House ${houseId} does not exist`,
          );
        }
        if (house && house.propertyId !== equipment.propertyId) {
          throw new ClimateDataValidationError(
            409,
            "EQUIPMENT_HOUSE_SCOPE_MISMATCH",
            `House ${house.id} does not belong to property ${equipment.propertyId}`,
          );
        }
      }
      if (equipment.location && (
        !Number.isFinite(equipment.location.latitude)
        || equipment.location.latitude < -90
        || equipment.location.latitude > 90
        || !Number.isFinite(equipment.location.longitude)
        || equipment.location.longitude < -180
        || equipment.location.longitude > 180
      )) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_EQUIPMENT_LOCATION",
          "Equipment location must be a finite WGS84 latitude/longitude coordinate",
        );
      }
      if (!EQUIPMENT_STATUSES.has(equipment.status)) {
        throw new ClimateDataValidationError(422, "INVALID_EQUIPMENT_STATUS", "Equipment status is not supported");
      }
    },
});
