import type { AreaEquipment, GeoCoordinate, PropertyArea } from "./property-inventory.js";

export type TrackingFeatureFlag =
  | "tracking.enabled"
  | "tracking.mobileObserver.enabled"
  | "tracking.mobileObserver.iosBackground.enabled"
  | "tracking.mobileObserver.androidBackground.enabled"
  | "tracking.androidGatewayMode.enabled"
  | "tracking.liveMap.enabled"
  | "tracking.movementTrails.enabled"
  | "tracking.exitAlerts.enabled"
  | "tracking.rotatingIdentifiers.enabled"
  | "tracking.userLocationSharing.enabled"
  | "tracking.experimentalCoordinateInference.enabled";

export type TrackingFeatureFlags = Record<TrackingFeatureFlag, boolean>;

export interface TrackingCapabilities {
  flags: TrackingFeatureFlags;
  /** 128-bit service UUID carrying the 18-byte v1 payload as BLE service data. */
  bleServiceUuid: string;
  protocolVersions: number[];
  maximumObservationBatchSize: number;
  observerModes: TrackingScanMode[];
}

export type TrackingTagStatus = "provisioning" | "active" | "disabled" | "retired";

export interface TrackingTagCapabilities {
  motion: boolean;
  battery: boolean;
  buzzer: boolean;
  button: boolean;
  tamper: boolean;
  connectable: boolean;
}

/** Public tag metadata. The per-tag secret is never included. */
export interface TrackingTag {
  id: string;
  tenantId: string;
  propertyId: string;
  serialNumber: string;
  hardwareModel: string;
  firmwareVersion: string | null;
  protocolVersion: number;
  rotationWindowMinutes: number;
  batteryType: string | null;
  batteryPercent: number | null;
  capabilities: TrackingTagCapabilities;
  status: TrackingTagStatus;
  pairedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackingTagCreateInput {
  propertyId: string;
  serialNumber: string;
  hardwareModel: string;
  firmwareVersion?: string;
  protocolVersion?: number;
  rotationWindowMinutes?: number;
  batteryType?: string;
  capabilities?: Partial<TrackingTagCapabilities>;
}

/** One-time material for a trusted provisioning flow. */
export interface TrackingTagProvisioningResult {
  tag: TrackingTag;
  provisioningSecret: string;
}

export interface TrackingAssetTagAssignment {
  id: string;
  equipmentId: string;
  tagId: string;
  validFrom: string;
  validTo: string | null;
  assignedBy: string;
}

export type TrackingObserverType =
  | "esp32-gateway"
  | "linux-gateway"
  | "android-gateway"
  | "android-phone"
  | "ios-phone";

export type TrackingObserverStatus = "online" | "offline" | "degraded" | "disabled";

export interface TrackingObserver {
  id: string;
  tenantId: string;
  propertyId: string;
  type: TrackingObserverType;
  name: string;
  trustLevel: number;
  fixedPosition: GeoCoordinate | null;
  fixedPositionAccuracyMeters: number | null;
  zoneId: string | null;
  appInstallationId: string | null;
  hardwareMetadata: Record<string, string | number | boolean | null>;
  lastHeartbeatAt: string | null;
  status: TrackingObserverStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TrackingObserverRegisterInput {
  propertyId: string;
  type: TrackingObserverType;
  name: string;
  trustLevel?: number;
  fixedPosition?: GeoCoordinate;
  fixedPositionAccuracyMeters?: number;
  zoneId?: string;
  appInstallationId?: string;
  hardwareMetadata?: Record<string, string | number | boolean | null>;
}

export type TrackingObserverPatch = Partial<Pick<TrackingObserver,
  "name" | "trustLevel" | "fixedPositionAccuracyMeters" | "zoneId" | "hardwareMetadata" | "status"
>> & {
  fixedPosition?: GeoCoordinate | null;
};

/** The credential is shown once and should be stored in Keychain/Keystore. */
export interface TrackingObserverRegistration {
  observer: TrackingObserver;
  credential: string;
}

export type TrackingLocationSource = "gps" | "fused" | "network" | "fixed" | "manual";

export interface TrackingObserverPosition extends GeoCoordinate {
  horizontalAccuracyMeters: number;
  source: TrackingLocationSource;
  capturedAt?: string;
  reducedAccuracy?: boolean;
}

export type TrackingScanMode =
  | "passive"
  | "property"
  | "active-property"
  | "find-nearby"
  | "gateway";

export type TrackingAppState = "foreground" | "background" | "suspended";

export type TrackingObservationQualityFlag =
  | "CLOCK_UNRELIABLE"
  | "LOCATION_UNAVAILABLE"
  | "LOCATION_STALE"
  | "LOCATION_LOW_ACCURACY"
  | "RSSI_OUTLIER"
  | "DUPLICATE"
  | "UNRESOLVED_TAG"
  | "INVALID_AUTHENTICATOR"
  | "PROPERTY_SCOPE_MISMATCH"
  | "OBSERVER_UNTRUSTED";

export interface TrackingObservationInput {
  observationId: string;
  propertyId: string;
  observerId: string;
  observedAt: string;
  rotatingTagId: string;
  authenticator: string;
  protocolVersion: number;
  /** Exact six-bit tag flags when rawPayload is unavailable. */
  advertisementFlags?: number;
  epochCounter: number;
  eventCounter: number;
  rssi: number;
  txPower?: number;
  motion?: boolean;
  batteryPercent?: number;
  observerPosition?: TrackingObserverPosition;
  fixedGatewayPositionId?: string;
  scanMode: TrackingScanMode;
  appState?: TrackingAppState;
  deviceTimeOffsetMs?: number;
  rawPayload?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/** Immutable normalized evidence. A nullable tagId preserves rejected evidence for diagnostics. */
export interface TrackingObservation {
  id: string;
  tenantId: string;
  propertyId: string;
  tagId: string | null;
  observerId: string;
  observerType: TrackingObserverType;
  observedAt: string;
  receivedAt: string;
  rotatingTagId: string;
  protocolVersion: number;
  epochCounter: number;
  eventCounter: number;
  rssi: number;
  txPower: number | null;
  motion: boolean;
  batteryPercent: number | null;
  observerPosition: TrackingObserverPosition | null;
  scanMode: TrackingScanMode;
  appState: TrackingAppState | null;
  deviceTimeOffsetMs: number | null;
  qualityFlags: TrackingObservationQualityFlag[];
  accepted: boolean;
  metadata: Record<string, string | number | boolean | null>;
}

export interface TrackingObservationBatchInput {
  observations: TrackingObservationInput[];
}

export interface TrackingObservationBatchError {
  index: number;
  code:
    | TrackingObservationQualityFlag
    | "INVALID_OBSERVATION"
    | "OBSERVER_SCOPE_MISMATCH"
    | "TRACKING_DISABLED";
}

export interface TrackingObservationBatchResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  serverTime: string;
  errors: TrackingObservationBatchError[];
}

export type TrackingPositionType =
  | "confirmed-zone"
  | "estimated-coordinate"
  | "nearby-live"
  | "last-known"
  | "unknown";

export type TrackingFreshnessState = "live" | "recent" | "last-known" | "stale" | "unknown";

export type TrackingMovementState = "moving" | "stationary" | "unknown";

export type TrackingConfidenceLevel = "high" | "medium" | "low";

export interface TrackingInferenceExplanation {
  method:
    | "FIND_NEARBY"
    | "MULTI_OBSERVER_WEIGHTED_MEDIAN"
    | "SINGLE_MOBILE_OBSERVER"
    | "MULTIPLE_FIXED_GATEWAYS"
    | "FIXED_GATEWAY_ZONE"
    | "LAST_KNOWN"
    | "NO_RELIABLE_EVIDENCE";
  inputObservationCount: number;
  acceptedObservationCount: number;
  rejectedObservationCount: number;
  primaryFactors: string[];
}

export interface AssetPositionEstimate {
  id: string;
  equipmentId: string;
  propertyId: string;
  calculatedAt: string;
  effectiveAt: string;
  positionType: TrackingPositionType;
  coordinate: GeoCoordinate | null;
  accuracyRadiusMeters: number | null;
  zoneId: string | null;
  confidence: number;
  confidenceLevel: TrackingConfidenceLevel;
  movementState: TrackingMovementState;
  freshnessState: TrackingFreshnessState;
  lastObservedAt: string | null;
  observerCount: number;
  algorithmVersion: string;
  evidenceObservationIds: string[];
  explanation: TrackingInferenceExplanation;
  version: number;
}

export interface TrackedEquipmentState {
  equipment: AreaEquipment;
  tag: TrackingTag | null;
  assignment: TrackingAssetTagAssignment | null;
  position: AssetPositionEstimate | null;
}

/** Property-owned checkout history for equipment. One item can have at most one active loan. */
export interface EquipmentLoan {
  id: string;
  propertyId: string;
  equipmentId: string;
  borrowerLabel: string;
  borrowedAt: string;
  expectedReturnAt: string | null;
  note: string | null;
  returnedAt: string | null;
  returnedByLabel: string | null;
  returnNote: string | null;
}

export interface EquipmentBorrowInput {
  expectedReturnAt?: string | null;
  note?: string | null;
}

export interface EquipmentReturnInput {
  note?: string | null;
}

/**
 * An explicitly shared, short-lived current position. The backend keeps no
 * member-location trail and removes this state when sharing stops or expires.
 */
export interface PropertyMemberLocation {
  id: string;
  propertyId: string;
  memberLabel: string;
  coordinate: GeoCoordinate;
  horizontalAccuracyMeters: number;
  reducedAccuracy: boolean;
  capturedAt: string;
  updatedAt: string;
  sharingUntil: string;
}

export interface PropertyMemberLocationInput {
  coordinate: GeoCoordinate;
  horizontalAccuracyMeters: number;
  reducedAccuracy?: boolean;
  capturedAt: string;
  sharingUntil: string;
}

/** Coordinate-free signal used only to tell authorized map clients to refresh. */
export interface PropertyMemberLocationSignal {
  id: string;
  propertyId: string;
  active: boolean;
  updatedAt: string;
  version: 1;
}

export interface TrackingPropertySettings {
  propertyId: string;
  enabled: boolean;
  propertyBoundary: GeoCoordinate[];
  liveNearbySeconds: number;
  recentlySeenSeconds: number;
  staleSeconds: number;
  unknownSeconds: number;
  movementThresholdMeters: number;
  movementMaximumIntervalSeconds: number;
  minimumMovementConfidence: number;
  exitAlertDebounceSeconds: number;
  updatedAt: string;
}

export interface TrackingMapSnapshot {
  propertyId: string;
  generatedAt: string;
  sequence: number;
  settings: TrackingPropertySettings;
  zones: PropertyArea[];
  gateways: TrackingObserver[];
  assets: TrackedEquipmentState[];
  members: PropertyMemberLocation[];
}

/** Short-lived identifiers used by an authorized foreground Find session. */
export interface TrackingScanToken {
  equipmentId: string;
  bleServiceUuid: string;
  protocolVersion: number;
  rotatingTagIds: string[];
  validUntil: string;
}

export type TrackingEventType =
  | "asset.position.updated"
  | "asset.zone.changed"
  | "asset.movement.started"
  | "asset.movement.stopped"
  | "asset.property.exited"
  | "asset.property.entered"
  | "tag.battery.low"
  | "tag.not_seen"
  | "gateway.online"
  | "gateway.offline"
  | "member.location.updated"
  | "member.location.stopped";

export interface TrackingEvent {
  type: TrackingEventType;
  tenantId: string;
  propertyId: string;
  entityId: string;
  sequence: number;
  eventAt: string;
  stateVersion: number;
  evidenceObservationIds: string[];
  state: AssetPositionEstimate | TrackingObserver | TrackingTag | PropertyMemberLocationSignal;
}
