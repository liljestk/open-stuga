import { createHash } from "node:crypto";
import type {
  AssetPositionEstimate,
  EquipmentBorrowInput,
  EquipmentLoan,
  EquipmentReturnInput,
  GeoCoordinate,
  PropertyMemberLocation,
  PropertyMemberLocationInput,
  PropertyMemberLocationSignal,
  TrackedEquipmentState,
  TrackingAppState,
  TrackingCapabilities,
  TrackingEvent,
  TrackingFeatureFlags,
  TrackingMapSnapshot,
  TrackingObservation,
  TrackingObservationBatchError,
  TrackingObservationBatchResult,
  TrackingObservationInput,
  TrackingObservationQualityFlag,
  TrackingObserver,
  TrackingObserverPosition,
  TrackingScanMode,
  TrackingScanToken,
  TrackingTag,
} from "@climate-twin/contracts";
import { inferTrackedEquipmentPosition, trackingPointInPolygon } from "../inference.js";
import {
  parseTrackingAdvertisement,
  rotatingTagId,
  trackingEpochCounter,
  TRACKING_FLAGS,
  TRACKING_PROTOCOL_VERSION,
  verifyTrackingAdvertisement,
  type TrackingAdvertisement,
} from "../protocol.js";
import {
  TrackingError,
  TrackingStore,
  type AuthenticatedTrackingObserver,
} from "../store.js";
import { MAXIMUM_BATCH_SIZE, ResolutionCandidate, TrackingEventListener, TrackingServiceOptions } from "./support/01-default-tracking-feature-flags-to-same-estimate.js";

export const trackingServiceState = Symbol("TrackingService.state");

export interface TrackingServiceState {
  listeners: Map<string, Set<TrackingEventListener>>;
  resolutionCache: Map<string, Map<string, ResolutionCandidate[]>>;
  ingestionWindows: Map<string, { startedAt: number; observations: number }>;
  refreshTimer: NodeJS.Timeout | null;
}

export function createTrackingServiceState(): TrackingServiceState {
  return {
    listeners: new Map<string, Set<TrackingEventListener>>(),
    resolutionCache: new Map<string, Map<string, ResolutionCandidate[]>>(),
    ingestionWindows: new Map<string, { startedAt: number; observations: number }>(),
    refreshTimer: null,
  };
}

export interface TrackingServiceInternals {
  readonly [trackingServiceState]: TrackingServiceState;
  readonly flags: TrackingFeatureFlags;
  readonly tenantId: string;
  readonly rawMobileCoordinateRetentionHours: number;
  readonly maximumObservationsPerMinute: number;
  readonly store: TrackingStore;
  get enabled(): boolean;
}

export type TrackingServiceMethodSet = Record<string, unknown> & ThisType<TrackingServiceInternals>;

export class TrackingServiceCore {
  readonly flags: TrackingFeatureFlags;
  readonly tenantId: string;
  readonly rawMobileCoordinateRetentionHours: number;
  readonly maximumObservationsPerMinute: number;
  readonly [trackingServiceState] = createTrackingServiceState();
  constructor(readonly store: TrackingStore, options: TrackingServiceOptions) {
      const service = this as unknown as TrackingServiceInternals;

      this.flags = { ...options.flags };
      this.tenantId = options.tenantId ?? "local";
      this.rawMobileCoordinateRetentionHours = Math.max(
        1,
        Math.min(24 * 30, Math.round(options.rawMobileCoordinateRetentionHours ?? 24)),
      );
      this.maximumObservationsPerMinute = Math.max(
        MAXIMUM_BATCH_SIZE,
        Math.round(options.maximumObservationsPerMinute ?? 12_000),
      );
    }
  get enabled(): boolean {
      return this.flags["tracking.enabled"];
    }
}

export function registerTrackingServiceMethods(methods: TrackingServiceMethodSet): void {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(TrackingServiceCore.prototype, name, {
      value: method, configurable: true, writable: true, enumerable: false,
    });
  }
}
