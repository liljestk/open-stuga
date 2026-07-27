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
import type { ClimateDatabase } from "../../db.js";
import { TrackingSecretBox } from "../crypto.js";
import type { TrackingInferenceObservation, TrackingInferenceResult } from "../inference.js";
import { initializeTrackingSchema } from "../schema.js";

export const trackingStoreState = Symbol("TrackingStore.state");

export interface TrackingStoreState {
  secretBox: TrackingSecretBox;
}

export function createTrackingStoreState(): TrackingStoreState {
  return {
    secretBox: undefined as unknown as TrackingSecretBox,
  };
}

export interface TrackingStoreInternals {
  readonly [trackingStoreState]: TrackingStoreState;
  readonly db: DatabaseSync;
  readonly core: ClimateDatabase;
}

export type TrackingStoreMethodSet = Record<string, unknown> & ThisType<TrackingStoreInternals>;

export class TrackingStoreCore {
  readonly db: DatabaseSync;
  readonly [trackingStoreState] = createTrackingStoreState();
  constructor(
      readonly core: ClimateDatabase,
      secretBox: TrackingSecretBox,
    ) {
      const service = this as unknown as TrackingStoreInternals;
      this[trackingStoreState].secretBox = secretBox;
      this.db = core.db;
      initializeTrackingSchema(this.db);
      // A foreground sharing session cannot survive a server restart. Never
      // resurrect a member's last coordinate from a restored or restarted DB.
      this.db.prepare("DELETE FROM property_member_locations").run();
    }
}

export function registerTrackingStoreMethods(methods: TrackingStoreMethodSet): void {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(TrackingStoreCore.prototype, name, {
      value: method, configurable: true, writable: true, enumerable: false,
    });
  }
}
