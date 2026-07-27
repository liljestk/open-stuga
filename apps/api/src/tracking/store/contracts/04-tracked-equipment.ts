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
import "../core.js";

declare module "../core.js" {
  interface TrackingStoreInternals {
    trackedEquipment(propertyId: string): Array<{
            equipment: AreaEquipment;
            tag: TrackingTag | null;
            assignment: TrackingAssetTagAssignment | null;
            position: AssetPositionEstimate | null;
        }>;
  }

  interface TrackingStoreCore {
    trackedEquipment(propertyId: string): Array<{
            equipment: AreaEquipment;
            tag: TrackingTag | null;
            assignment: TrackingAssetTagAssignment | null;
            position: AssetPositionEstimate | null;
        }>;
  }
}
