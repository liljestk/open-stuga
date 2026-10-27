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
import { LocalMaintenanceTaskRevisionActor } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
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
    propertyRequiredText(value: string, field: string, maximumLength: number): string;
  }

  interface ClimateDatabaseCore {
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
