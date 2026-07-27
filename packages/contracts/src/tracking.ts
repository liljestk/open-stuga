import type { DataMode, TruthClass } from "./measurement-analytics.js";
import type { AreaEquipment, GeoCoordinate, PropertyArea } from "./property-inventory.js";
export const TRACKING_SCHEMA_VERSION = "2026-07-01" as const;
export const TRACKING_PROFILE_SCHEMA_VERSION = "2026-07-01" as const;
export type TrackingFeatureFlag =
  | "tracking.enabled"
  | "tracking.mobileObserver.enabled"
  | "tracking.mobileObserver.iosBackground.enabled"
  | "tracking.mobileObserver.androidBackground.enabled"
  | "tracking.androidGatewayMode.enabled"
  | "tracking.liveMap.enabled"
  | "tracking.movementTrails.enabled"
  | "tracking.exitAlerts.enabled"
  | "tracking.userLocationSharing.enabled";
export type TrackingFeatureFlags = Record<TrackingFeatureFlag, boolean>;
export type TrackabilityTier =
  | "DISCOVERED_ONLY"
  | "OBSERVER_LOCAL"
  | "PROPERTY_BEACON"
  | "VERIFIED_TRACKER"
  | "EXTERNAL_PROVIDER";
export type TrackingIdentityScope = "NONE" | "OBSERVER" | "PROPERTY" | "TENANT" | "GLOBAL";
export type TrackingIdentityStrength =
  | "HEURISTIC"
  | "STATIC_CLEAR"
  | "PAIRED_RESOLVABLE"
  | "CRYPTOGRAPHIC";
export type TrackingDiscoverability = "NONE" | "FOREGROUND" | "BACKGROUND_CONDITIONAL" | "BACKGROUND_RELIABLE";
export type TrackingBackgroundSupport = "NONE" | "FOREGROUND_ONLY" | "CONDITIONAL" | "RELIABLE";
export type TrackingMapCapability = "NONE" | "NEARBY" | "AREA" | "ZONE" | "COORDINATE";
export type TrackingPlatform = "ios" | "android" | "gateway" | "web";
export type TrackingScanContext =
  | "foreground"
  | "background"
  | "foreground-find"
  | "fixed-gateway"
  | "dedicated-android-gateway";
export interface TrackingPlatformCondition {
  platform: TrackingPlatform;
  scanContexts: TrackingScanContext[];
  minimumOsVersion?: string;
  maximumOsVersion?: string;
  requiresServiceFilter?: boolean;
  requiresLiveActivity?: boolean;
  requiresScreenAwake?: boolean;
  notes: string[];
}
export type TrackingAdvertisementSource =
  | "manufacturerData"
  | "serviceData"
  | "localName"
  | "peripheralIdentifier"
  | "address";
export interface TrackingProfileMatchRule {
  source: Extract<TrackingAdvertisementSource, "manufacturerData" | "serviceData" | "localName">;
  key?: string;
  offset?: number;
  value: string;
  mask?: string;
}
export type TrackingFieldEncoding =
  | "hex"
  | "utf8"
  | "uint8"
  | "uint16be"
  | "uint16le"
  | "int8"
  | "uuid";
export interface TrackingProfileField {
  name: string;
  source: TrackingAdvertisementSource;
  key?: string;
  offset?: number;
  length?: number;
  encoding: TrackingFieldEncoding;
  optional?: boolean;
  scale?: number;
}
export interface TrackingProfileIdentity {
  namespace: string;
  namespaceVersion: number;
  scope: TrackingIdentityScope;
  strength: TrackingIdentityStrength;
  fields: string[];
  separator?: string;
}
export interface TrackingProfileCapabilities {
  trackabilityTier: TrackabilityTier;
  discoverability: TrackingDiscoverability;
  backgroundSupport: TrackingBackgroundSupport;
  mapCapability: TrackingMapCapability;
  connectable: boolean;
  reportsBattery: boolean;
  reportsMotion: boolean;
  reportsCounter: boolean;
}
export interface TrackingProfile {
  schemaVersion: typeof TRACKING_PROFILE_SCHEMA_VERSION;
  id: string;
  version: string;
  displayName: string;
  description: string;
  serviceUuids: string[];
  match: TrackingProfileMatchRule[];
  fields: TrackingProfileField[];
  identity: TrackingProfileIdentity;
  capabilities: TrackingProfileCapabilities;
  platformSupport: TrackingPlatformCondition[];
  maximumFrameBytes: number;
  deprecatedAt: string | null;
}
/** Profile integrity is detached so the signed bytes never contain their own signature. */
export interface TrackingProfileIntegrity {
  digestAlgorithm: "SHA-256";
  digest: string;
  signatureAlgorithm: "ED25519" | null;
  keyId: string | null;
  signature: string | null;
}
export interface TrackingProfileEnvelope {
  profile: TrackingProfile;
  integrity: TrackingProfileIntegrity;
  source: "BUILTIN" | "SIGNED_REGISTRY";
}
export interface TrackingProfileManifest {
  schemaVersion: typeof TRACKING_PROFILE_SCHEMA_VERSION;
  registryVersion: string;
  generatedAt: string;
  profiles: TrackingProfileEnvelope[];
}
/** A platform-local BLE frame. It is deliberately absent from every ingestion contract. */
export interface TrackingLocalAdvertisementFrame {
  serviceUuids: string[];
  manufacturerData: Record<string, string>;
  serviceData: Record<string, string>;
  localName: string | null;
  peripheralIdentifier: string | null;
  address: string | null;
  connectable: boolean | null;
  rssi: number;
  observedAt: string;
}
export interface TrackingProfileMatch {
  profileId: string;
  profileVersion: string;
  identityFields: Record<string, string>;
  canonicalIdentity: string | null;
  telemetry: Record<string, string | number | boolean | null>;
}
export type TrackingCompatibilityStatus =
  | "SUPPORTED"
  | "CONDITIONAL"
  | "OBSERVER_LOCAL_ONLY"
  | "DISCOVERED_ONLY"
  | "UNSUPPORTED";
export interface TrackingCompatibilityAssessmentInput {
  profileId: string;
  profileVersion: string;
  platform: TrackingPlatform;
  scanContext: TrackingScanContext;
  osVersion?: string;
}
export interface TrackingCompatibilityAssessment {
  profileId: string;
  profileVersion: string;
  status: TrackingCompatibilityStatus;
  trackabilityTier: TrackabilityTier;
  identityScope: TrackingIdentityScope;
  identityStrength: TrackingIdentityStrength;
  backgroundSupport: TrackingBackgroundSupport;
  mapCapability: TrackingMapCapability;
  conditions: string[];
  assessedAt: string;
}
export interface TrackingCapabilities {
  schemaVersion: typeof TRACKING_SCHEMA_VERSION;
  profileSchemaVersion: typeof TRACKING_PROFILE_SCHEMA_VERSION;
  flags: TrackingFeatureFlags;
  maximumObservationBatchSize: number;
  maximumRollupBatchSize: number;
  observerTypes: TrackingObserverType[];
}
export type TrackingEndpointClaimStatus =
  | "PENDING"
  | "CLAIMED"
  | "DEGRADED"
  | "REVOKED"
  | "RETIRED";
export type TrackingProofKind =
  | "PHYSICAL_ACCESS"
  | "GATT_CHALLENGE"
  | "VENDOR_ATTESTATION"
  | "CRYPTOGRAPHIC_CHALLENGE"
  | "EXTERNAL_ACCOUNT";
export interface TrackingEndpoint {
  id: string;
  tenantId: string;
  propertyId: string;
  profileId: string;
  profileVersion: string;
  identityNamespaceVersion: number;
  identityReference: string;
  identityScope: TrackingIdentityScope;
  identityStrength: TrackingIdentityStrength;
  observerScopeId: string | null;
  trackabilityTier: TrackabilityTier;
  displayName: string;
  manufacturer: string | null;
  model: string | null;
  firmwareVersion: string | null;
  claimStatus: TrackingEndpointClaimStatus;
  proofKind: TrackingProofKind | null;
  proofVerifiedAt: string | null;
  lastSeenAt: string | null;
  telemetry: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
}

export interface TrackingEndpointEnrollmentInput {
  propertyId: string;
  profileId: string;
  profileVersion: string;
  identityFields: Record<string, string>;
  observerScopeId?: string;
  displayName: string;
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  proof: {
    kind: TrackingProofKind;
    challengeId?: string;
    response?: string;
    attestation?: string;
  };
}

export interface EquipmentTrackingBinding {
  id: string;
  propertyId: string;
  equipmentId: string;
  endpointId: string;
  observerId: string | null;
  validFrom: string;
  validTo: string | null;
  boundBy: string;
}

export interface EquipmentTrackingBindingInput {
  endpointId: string;
  observerId?: string;
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
>> & { fixedPosition?: GeoCoordinate | null };

export interface TrackingObserverRegistration {
  observer: TrackingObserver;
  credential: string;
}

export type TrackingLocationSource = "gps" | "fused" | "network" | "fixed" | "manual";
export interface TrackingObserverPosition extends GeoCoordinate {
  horizontalAccuracyMeters: number;
  source: TrackingLocationSource;
  capturedAt: string;
  reducedAccuracy?: boolean;
}

export type TrackingObservationQualityFlag =
  | "LOCATION_UNAVAILABLE"
  | "LOCATION_STALE"
  | "LOCATION_LOW_ACCURACY"
  | "RSSI_OUTLIER"
  | "CLOCK_SKEW"
  | "OUT_OF_ORDER"
  | "LOW_TRUST"
  | "PROFILE_VERSION_MISMATCH";

export interface TrackingObservationInput {
  schemaVersion: typeof TRACKING_SCHEMA_VERSION;
  dataMode: DataMode;
  observationId: string;
  idempotencyKey: string;
  propertyId: string;
  endpointId: string;
  equipmentId: string;
  observerId: string;
  observedAt: string;
  profileId: string;
  profileVersion: string;
  rssi: number;
  txPower?: number;
  batteryPercent?: number;
  motion?: boolean;
  counter?: number;
  observerPosition?: TrackingObserverPosition;
  scanContext: TrackingScanContext;
  telemetry?: Record<string, string | number | boolean | null>;
}

/** Immutable, normalized, claimed-only evidence. Raw BLE payloads are never persisted. */
export interface TrackingObservation extends Omit<
  TrackingObservationInput,
  "schemaVersion" | "txPower" | "batteryPercent" | "motion" | "counter" | "observerPosition" | "telemetry"
> {
  id: string;
  tenantId: string;
  observerType: TrackingObserverType;
  receivedAt: string;
  txPower: number | null;
  batteryPercent: number | null;
  motion: boolean | null;
  counter: number | null;
  observerPosition: TrackingObserverPosition | null;
  qualityFlags: TrackingObservationQualityFlag[];
  trust: number;
  telemetry: Record<string, string | number | boolean | null>;
}

export interface TrackingGatewayRollupInput {
  schemaVersion: typeof TRACKING_SCHEMA_VERSION;
  dataMode: DataMode;
  rollupId: string;
  idempotencyKey: string;
  propertyId: string;
  endpointId: string;
  equipmentId: string;
  observerId: string;
  profileId: string;
  profileVersion: string;
  windowStartedAt: string;
  windowEndedAt: string;
  packetCount: number;
  rssiMinimum: number;
  rssiMaximum: number;
  rssiMean: number;
  rssiVariance: number;
  lastBatteryPercent?: number;
  motionObserved?: boolean;
  firstCounter?: number;
  lastCounter?: number;
  telemetry?: Record<string, string | number | boolean | null>;
}

export interface TrackingObservationBatchInput {
  observations: TrackingObservationInput[];
  rollups?: TrackingGatewayRollupInput[];
}

export interface TrackingObservationBatchError {
  kind: "observation" | "rollup";
  index: number;
  id: string | null;
  code:
    | "INVALID_EVIDENCE"
    | "NOT_CLAIMED"
    | "NO_ACTIVE_BINDING"
    | "OBSERVER_SCOPE_MISMATCH"
    | "PROPERTY_SCOPE_MISMATCH"
    | "DATA_MODE_MISMATCH"
    | "PROFILE_VERSION_MISMATCH"
    | "TRACKING_DISABLED";
}

export interface TrackingObservationBatchResult {
  accepted: number;
  duplicates: number;
  rejected: number;
  serverTime: string;
  errors: TrackingObservationBatchError[];
}

export type TrackingEstimateKind = "coordinate" | "zone" | "area" | "nearby" | "unknown";
export type TrackingFreshness = "live" | "recent" | "aging" | "stale" | "unknown";
export type TrackingMovementState = "moving" | "stationary" | "unknown";
export type TrackingEstimateSource =
  | "fixed-gateway"
  | "mobile-observer"
  | "multi-observer"
  | "manual"
  | "external-provider"
  | "none";

export interface TrackingEstimateProvenance {
  algorithm: string;
  observationIds: string[];
  rollupIds: string[];
  observerIds: string[];
  profileVersions: string[];
  factors: string[];
}

export interface EquipmentLocationEstimate {
  id: string;
  dataMode: DataMode;
  equipmentId: string;
  propertyId: string;
  endpointId: string;
  calculatedAt: string;
  effectiveAt: string;
  kind: TrackingEstimateKind;
  coordinate: GeoCoordinate | null;
  uncertaintyRadiusMeters: number | null;
  zoneId: string | null;
  confidence: number;
  truthClass: TruthClass;
  source: TrackingEstimateSource;
  freshness: TrackingFreshness;
  movementState: TrackingMovementState;
  lastObservedAt: string | null;
  observerCount: number;
  provenance: TrackingEstimateProvenance;
  version: number;
}

export interface EquipmentManualLocationInput {
  dataMode: DataMode;
  coordinate?: GeoCoordinate;
  zoneId?: string;
  uncertaintyRadiusMeters?: number;
  observedAt: string;
}

export interface TrackedEquipmentState {
  equipment: AreaEquipment;
  endpoint: TrackingEndpoint;
  binding: EquipmentTrackingBinding;
  position: EquipmentLocationEstimate | null;
}

export interface TrackingFindDescriptor {
  equipmentId: string;
  endpointId: string;
  profile: TrackingProfileEnvelope;
  identityFields: Record<string, string>;
  validUntil: string;
}

export interface TrackingResolutionEntry {
  equipmentId: string;
  endpointId: string;
  profileId: string;
  profileVersion: string;
  identityFields: Record<string, string>;
}

/** Short-lived, observer-scoped cache used to resolve raw frames locally. */
export interface TrackingResolutionManifest {
  propertyId: string;
  observerId: string;
  dataMode: DataMode;
  generatedAt: string;
  validUntil: string;
  entries: TrackingResolutionEntry[];
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
export interface EquipmentReturnInput { note?: string | null }

/** Short-lived sharing state. No member location trail is retained. */
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
  observationRetentionDays: number;
  rollupRetentionDays: number;
  estimateRetentionDays: number;
  updatedAt: string;
}

export interface TrackingMapSnapshot {
  propertyId: string;
  dataMode: DataMode;
  generatedAt: string;
  sequence: number;
  settings: TrackingPropertySettings;
  zones: PropertyArea[];
  gateways: TrackingObserver[];
  equipment: TrackedEquipmentState[];
  members: PropertyMemberLocation[];
}

export type TrackingEventType =
  | "equipment.position.updated"
  | "equipment.zone.changed"
  | "equipment.movement.started"
  | "equipment.movement.stopped"
  | "equipment.property.exited"
  | "equipment.property.entered"
  | "endpoint.battery.low"
  | "endpoint.not_seen"
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
  state: EquipmentLocationEstimate | TrackingObserver | TrackingEndpoint | PropertyMemberLocationSignal;
}
