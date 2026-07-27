/**
 * Stuguby v2 federates independently administered Stugu installations.
 * Property changes may be collaborative, while shared Homes remain read-only
 * unless their authority explicitly enables editing. Integration bindings,
 * credentials, account identities and device control never cross this
 * boundary, including during authority transfer.
 */

export const STUGBY_PROTOCOL_VERSION = "2.0" as const;

export const STUGBY_MEDIA_TYPE = "application/vnd.stugby.v2+json" as const;

export const STUGBY_MAX_EVENT_BYTES = 1_048_576 as const;

export const STUGBY_MAX_EVENT_PAGE_BYTES = 4_194_304 as const;

export const STUGBY_MAX_BATCH_EVENTS = 250 as const;

export const STUGBY_MAX_BLOB_BYTES = 10_485_760 as const;

export const STUGBY_MAX_CLOCK_SKEW_SECONDS = 300 as const;

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export const STUGBY_DATASETS = [
  "home.directory.v1",
  "home.location.v1",
  "home.structure.v1",
  "home.floorplan.v1",
  "home.sensor-catalog.v1",
  "home.telemetry.v1",
  "home.notes.v1",
  "home.observations.v1",
  "home.recovery.v1",
] as const;

export type StugubyDataset = (typeof STUGBY_DATASETS)[number];

export type StugubyRole = "steward" | "property-manager" | "participant" | "viewer";

export type StugubyMemberState = "invited" | "active" | "suspended" | "left" | "revoked";

export type StugubyOperation = "upsert" | "tombstone";

export type StugubyEventKind =
  | "dataset.published"
  | "grant.upserted"
  | "grant.revoked"
  | "member.updated"
  | "shared-property.updated";

export interface StugubyNodeIdentity {
  nodeId: string;
  displayName: string;
  publicKey: string;
  keyFingerprint: string;
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
}

export interface StugubySummary {
  id: string;
  name: string;
  description: string | null;
  coordinatorNodeId: string;
  coordinatorUrl: string;
  localRole: StugubyRole;
  localMemberState: StugubyMemberState;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export interface StugubyMember {
  stugubyId: string;
  nodeId: string;
  displayName: string;
  role: StugubyRole;
  state: StugubyMemberState;
  publicKey: string;
  keyFingerprint: string;
  joinedAt: string | null;
  updatedAt: string;
}

export interface StugubyInvitation {
  id: string;
  stugubyId: string;
  role: Exclude<StugubyRole, "steward">;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  /** One-time admission secret. Returned only when the invitation is created. */
  joinSecret?: string;
  coordinatorUrl: string;
}

export interface StugubyJoinRequest {
  invitationId: string;
  joinSecret: string;
  identity: StugubyNodeIdentity;
  signature: string;
}

export interface StugubyJoinResponse {
  stuguby: StugubySummary;
  member: StugubyMember;
  members: StugubyMember[];
  coordinatorIdentity: StugubyNodeIdentity;
  cursor: number;
}

export interface StugubyHomePublication {
  publicationId: string;
  stugubyId: string;
  authorityNodeId: string;
  localHouseId?: string;
  displayName: string;
  activeGrantCount: number;
  updatedAt: string;
}

export interface StugubyGrantAudience {
  kind: "all-members" | "members";
  nodeIds: string[];
}

export interface StugubyTelemetryPolicy {
  sensorPublicationIds: string[];
  metricIds: string[];
  historyFrom: string | null;
  live: boolean;
  maxSamplesPerHour: number;
}

export interface StugubyDatasetGrant {
  dataset: StugubyDataset;
  enabled: boolean;
  includeLocalIds: boolean;
  allowReplicaCache: boolean;
  retentionDays: number;
  telemetry?: StugubyTelemetryPolicy;
}

export interface StugubyHousePolicy extends JsonObject {
  /** Shared Homes are read-only unless the authority explicitly opts in. */
  editPolicy: "read-only" | "editable";
  /**
   * A full recovery replica is durable ownership-transfer material, not a
   * revocable viewer cache. Exactly one active member may be designated.
   */
  recoveryMode: "none" | "full";
  designatedSuccessorNodeId: string | null;
}

export interface StugubyShareGrant {
  id: string;
  stugubyId: string;
  authorityNodeId: string;
  publicationId: string;
  localHouseId?: string;
  audience: StugubyGrantAudience;
  datasets: StugubyDatasetGrant[];
  housePolicy: StugubyHousePolicy;
  epoch: number;
  revision: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StugubyBlobMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "model/gltf+json"
  | "model/gltf-binary";

export interface StugubyBlobReference extends JsonObject {
  digest: string;
  byteLength: number;
  mediaType: StugubyBlobMediaType;
}

export interface StugubyHomeDirectoryPayload extends JsonObject {
  publicationId: string;
  name: string;
  timezone: string;
  localHouseId?: string;
}

export interface StugubyHomeLocationPayload extends JsonObject {
  publicationId: string;
  latitude: number;
  longitude: number;
  label?: string;
  countryCode?: string;
  mapPlacement?: {
    latitude: number;
    longitude: number;
    metersPerPlanUnit: number;
    footprintFloorPublicationId?: string;
  };
  orientationDegrees?: number;
}

export interface StugubyPlanPoint extends JsonObject { x: number; y: number }

export interface StugubyWallPayload extends JsonObject {
  wallPublicationId: string;
  localWallId?: string;
  from: StugubyPlanPoint;
  to: StugubyPlanPoint;
}

export interface StugubyRoomPayload extends JsonObject {
  roomPublicationId: string;
  localRoomId?: string;
  name: string;
  points: StugubyPlanPoint[];
  kind?: string;
}

export interface StugubyPlanElementPayload extends JsonObject {
  planElementPublicationId: string;
  localPlanElementId?: string;
  kind: string;
  position: StugubyPlanPoint;
  rotationDegrees: number;
  width?: number;
  height?: number;
  label?: string;
  state?: string;
  openFraction?: number;
  bottomOffsetM?: number;
  wallPublicationId?: string;
  variant?: string;
  nominalFlowM3h?: number;
  verticalExtent?: string;
  chimneyHeightAboveRoof?: number;
  chimneyWidth?: number;
  chimneyDepth?: number;
  projection?: number;
}

export interface StugubyRoofPayload extends JsonObject {
  style: string;
  pitchDegrees: number;
  ridgeAxis: string;
  overhang: number;
  eavesHeight: number;
}

export interface StugubyFloorPayload extends JsonObject {
  floorPublicationId: string;
  localFloorId?: string;
  name: string;
  type?: string;
  width: number;
  height: number;
  metersPerPlanUnit?: number;
  elevation: number;
  ceilingHeight?: number;
  wallHeight?: number;
  roof?: StugubyRoofPayload;
  walls: StugubyWallPayload[];
  rooms: StugubyRoomPayload[];
  /** Plan elements are stripped of bindings to local integrations. */
  planElements: StugubyPlanElementPayload[];
}

export interface StugubyHomeStructurePayload extends JsonObject {
  publicationId: string;
  floors: StugubyFloorPayload[];
}

export interface StugubyFloorPlanAsset extends JsonObject {
  floorPublicationId: string;
  image: StugubyBlobReference;
}

export interface StugubyHomeFloorPlanPayload extends JsonObject {
  publicationId: string;
  assets: StugubyFloorPlanAsset[];
}

export interface StugubySensorCatalogItem extends JsonObject {
  sensorPublicationId: string;
  localSensorId?: string;
  floorPublicationId: string;
  roomPublicationId?: string;
  name: string;
  model: string;
  tags: string[];
  enabled: boolean;
  x: number;
  y: number;
  z: number;
  metricIds: string[];
}

export interface StugubySensorCatalogPayload extends JsonObject {
  publicationId: string;
  sensors: StugubySensorCatalogItem[];
}

export interface StugubyTelemetrySample extends JsonObject {
  sensorPublicationId: string;
  metricId: string;
  timestamp: string;
  value: number;
  quality: "good" | "estimated" | "stale";
  correctionOf?: string;
}

export interface StugubyTelemetryPayload extends JsonObject {
  publicationId: string;
  chunkId: string;
  from: string;
  to: string;
  complete: boolean;
  samples: StugubyTelemetrySample[];
}

export interface StugubyHomeNote extends JsonObject {
  notePublicationId: string;
  localNoteId?: string;
  kind: "note" | "inspection" | "maintenance";
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface StugubyHomeNotesPayload extends JsonObject {
  publicationId: string;
  notes: StugubyHomeNote[];
}

export interface StugubyHomeObservation extends JsonObject {
  observationPublicationId: string;
  localObservationId?: string;
  floorPublicationId: string;
  sensorPublicationId?: string;
  kind: string;
  severity: string;
  note: string;
  x: number | null;
  y: number | null;
  occurredAt: string;
  timePrecision?: string;
  validFrom?: string | null;
  validTo?: string | null;
  confidence?: string;
  status?: string;
  resolutionNote?: string | null;
  resolvedAt?: string | null;
  updatedAt: string;
}

export interface StugubyHomeObservationsPayload extends JsonObject {
  publicationId: string;
  observations: StugubyHomeObservation[];
}

export type StugubyHomeRecoveryKind =
  | "manifest"
  | "measurement-definitions"
  | "alert-rules"
  | "alert-events"
  | "static-parameters"
  | "opening-states"
  | "weather-history"
  | "electricity-history"
  | "assets";

/** Chunked, sanitized material used only by a designated full-recovery successor. */
export interface StugubyHomeRecoveryPayload extends JsonObject {
  publicationId: string;
  chunkId: string;
  generation: number;
  kind: StugubyHomeRecoveryKind;
  complete: boolean;
  records: JsonObject[];
}

/** Sanitized editable Home state. It deliberately excludes every integration binding and secret. */
export interface StugubyHomeCommandSnapshot extends JsonObject {
  directory: StugubyHomeDirectoryPayload;
  location: StugubyHomeLocationPayload | null;
  structure: StugubyHomeStructurePayload;
  sensorCatalog: StugubySensorCatalogPayload;
  notes: StugubyHomeNotesPayload;
  observations: StugubyHomeObservationsPayload;
}

/** Durable client intent. The authoritative Home accepts the snapshot or keeps its newer state. */
export interface StugubyHomeCommand extends JsonObject {
  id: string;
  stugubyId: string;
  actorNodeId: string;
  authorityNodeId: string;
  publicationId: string;
  grantId: string;
  grantEpoch: number;
  authorityEpoch: number;
  baseRevision: number;
  snapshot: StugubyHomeCommandSnapshot;
  createdAt: string;
}

export interface StugubyHomeCommandResult extends JsonObject {
  commandId: string;
  status: "applied" | "conflict";
  authorityRevision: number;
  message: string;
}

export interface StugubyPropertyArea extends JsonObject {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  location?: { latitude: number; longitude: number };
  polygon: Array<{ latitude: number; longitude: number }>;
}

export interface StugubyPropertyEquipment extends JsonObject {
  id: string;
  areaId: string | null;
  home?: {
    authorityNodeId: string;
    publicationId: string;
  } | null;
  location?: { latitude: number; longitude: number };
  name: string;
  kind: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: "active" | "out-of-service" | "retired";
  notes: string | null;
}

export interface StugubyPropertyNote extends JsonObject {
  id: string;
  areaId: string | null;
  equipmentId: string | null;
  kind: "note" | "inspection" | "maintenance";
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface StugubyMaintenanceItem extends JsonObject {
  id: string;
  title: string;
  description: string | null;
  areaId: string | null;
  equipmentId: string | null;
  state: "planned" | "in-progress" | "done" | "cancelled";
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Coordinator-owned aggregate materialized into an explicitly adopted local Property. */
export interface StugubySharedProperty extends JsonObject {
  stugubyId: string;
  name: string;
  description: string | null;
  location: { latitude: number; longitude: number; label?: string } | null;
  areas: StugubyPropertyArea[];
  equipment: StugubyPropertyEquipment[];
  notes: StugubyPropertyNote[];
  maintenance: StugubyMaintenanceItem[];
  editPolicy: "collaborative" | "read-only";
  authorityEpoch: number;
  designatedSuccessorNodeId: string | null;
  revision: number;
  updatedAt: string;
}

export type StugubyPropertyEntityKind = "property" | "area" | "equipment" | "note" | "maintenance";

export type StugubyPropertyCommandOperation = "upsert" | "delete";

export type StugubyPropertyCommandStatus = "pending" | "applied" | "conflict" | "cancelled";

/** Durable client intent sent to the coordinator for field-aware sequencing. */
export interface StugubyPropertyCommand extends JsonObject {
  id: string;
  stugubyId: string;
  actorNodeId: string;
  baseRevision: number;
  entityKind: StugubyPropertyEntityKind;
  entityId: string;
  operation: StugubyPropertyCommandOperation;
  changedFields: string[];
  value: JsonObject | null;
  createdAt: string;
}

export interface StugubyPropertyConflict extends JsonObject {
  commandId: string;
  entityKind: StugubyPropertyEntityKind;
  entityId: string;
  fields: string[];
  message: string;
  serverValue: JsonObject | null;
  clientValue: JsonObject | null;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface StugubyPropertyCommandResult extends JsonObject {
  commandId: string;
  status: "applied" | "conflict";
  appliedFields: string[];
  conflict: StugubyPropertyConflict | null;
  property: StugubySharedProperty;
}

export type StugubyDatasetPayload =
  | StugubyHomeDirectoryPayload
  | StugubyHomeLocationPayload
  | StugubyHomeStructurePayload
  | StugubyHomeFloorPlanPayload
  | StugubySensorCatalogPayload
  | StugubyTelemetryPayload
  | StugubyHomeNotesPayload
  | StugubyHomeObservationsPayload
  | StugubyHomeRecoveryPayload;

export interface StugubyWireEvent {
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
  stugubyId: string;
  eventId: string;
  eventKind: StugubyEventKind;
  authorityNodeId: string;
  streamId: string;
  sequence: number;
  schema: StugubyDataset | "stuguby.grant.v2" | "stuguby.member.v2" | "stuguby.shared-property.v2";
  resourceId: string;
  operation: StugubyOperation;
  revision: number;
  grantId: string | null;
  grantEpoch: number | null;
  occurredAt: string;
  payload: JsonValue | null;
  payloadHash: string;
}

export interface StugubySignedEvent extends StugubyWireEvent {
  keyFingerprint: string;
  signature: string;
}

export interface StugubyEventBatch {
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
  events: StugubySignedEvent[];
}

export interface StugubyEventPage {
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
  events: StugubySignedEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface StugubyRemoteResource {
  stugubyId: string;
  authorityNodeId: string;
  schema: StugubyDataset;
  resourceId: string;
  publicationId: string;
  revision: number;
  payload: JsonValue;
  receivedAt: string;
  sourceOccurredAt: string;
  stale: boolean;
}

export interface StugubyDeletionReceipt {
  stugubyId: string;
  nodeId: string;
  grantId: string;
  grantEpoch: number;
  deletedAt: string;
}
