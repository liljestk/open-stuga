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
import "../core.js";

declare module "../core.js" {
  interface TrackingStoreInternals {
    verifyStoredSecrets(): void;
    propertySettings(propertyId: string): TrackingPropertySettings;
    updatePropertySettings(propertyId: string, patch: Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">>): TrackingPropertySettings;
    createTag(input: TrackingTagCreateInput, tenantId?: string): TrackingTagProvisioningResult;
    listTags(propertyId?: string): TrackingTag[];
    getTag(id: string): TrackingTag | null;
    tagSecret(id: string): Buffer;
    claimTag(id: string): TrackingTag;
    rotateTagSecret(id: string): TrackingTagProvisioningResult;
    touchTag(id: string, observedAt: string, batteryPercent: number | null): void;
    assignTag(tagId: string, equipmentId: string, assignedBy: string, at?: string): TrackingAssetTagAssignment;
    unassignTag(tagId: string, at?: string): TrackingAssetTagAssignment | null;
    activeAssignmentForTag(tagId: string): TrackingAssetTagAssignment | null;
    activeAssignmentForEquipment(equipmentId: string): TrackingAssetTagAssignment | null;
  }

  interface TrackingStoreCore {
    verifyStoredSecrets(): void;
    propertySettings(propertyId: string): TrackingPropertySettings;
    updatePropertySettings(propertyId: string, patch: Partial<Omit<TrackingPropertySettings, "propertyId" | "updatedAt">>): TrackingPropertySettings;
    createTag(input: TrackingTagCreateInput, tenantId?: string): TrackingTagProvisioningResult;
    listTags(propertyId?: string): TrackingTag[];
    getTag(id: string): TrackingTag | null;
    tagSecret(id: string): Buffer;
    claimTag(id: string): TrackingTag;
    rotateTagSecret(id: string): TrackingTagProvisioningResult;
    touchTag(id: string, observedAt: string, batteryPercent: number | null): void;
    assignTag(tagId: string, equipmentId: string, assignedBy: string, at?: string): TrackingAssetTagAssignment;
    unassignTag(tagId: string, at?: string): TrackingAssetTagAssignment | null;
    activeAssignmentForTag(tagId: string): TrackingAssetTagAssignment | null;
    activeAssignmentForEquipment(equipmentId: string): TrackingAssetTagAssignment | null;
  }
}
