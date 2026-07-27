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
import { MAX_TRACKED_EQUIPMENT, TRACKED_EQUIPMENT_PAGE_SIZE, TrackingError } from "../support/01-default-tag-capabilities-to-observation-from-row.js";
import { registerTrackingStoreMethods, trackingStoreState, type TrackingStoreInternals } from "../core.js";

registerTrackingStoreMethods({
  trackedEquipment(this: TrackingStoreInternals, propertyId: string): Array<{
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
    },
});
