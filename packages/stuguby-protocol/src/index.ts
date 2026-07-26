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

const DATASET_SET = new Set<string>(STUGBY_DATASETS);
const ROLE_SET = new Set<string>(["steward", "property-manager", "participant", "viewer"]);
const EVENT_KIND_SET = new Set<string>(["dataset.published", "grant.upserted", "grant.revoked", "member.updated", "shared-property.updated"]);
const ENVELOPE_SCHEMA_SET = new Set<string>([...STUGBY_DATASETS, "stuguby.grant.v2", "stuguby.member.v2", "stuguby.shared-property.v2"]);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Exact and normalized key names forbidden in every dataset/shared-property
 * payload. Envelope admission material is validated separately and never
 * becomes a published resource.
 */
const FORBIDDEN_KEYS = new Set([
  "credential",
  "credentials",
  "password",
  "passwordhash",
  "secret",
  "secrets",
  "token",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "session",
  "sessionid",
  "cookie",
  "account",
  "accountid",
  "accountidentity",
  "userid",
  "username",
  "email",
  "integration",
  "integrations",
  "integrationid",
  "integrationendpoint",
  "endpointurl",
  "endpoint",
  "endpoints",
  "url",
  "uri",
  "host",
  "hostname",
  "baseurl",
  "connectionid",
  "entityid",
  "externalid",
  "statebinding",
  "provider",
  "authorization",
  "bearer",
  "oauth",
  "clientsecret",
  "command",
  "commands",
  "devicecommand",
  "remotecontrol",
  "control",
  "actuation",
  "automation",
  "script",
  "callback",
  "webhook",
]);

const FORBIDDEN_KEY_FRAGMENTS = [
  "credential", "password", "secret", "token", "privatekey", "session", "cookie",
  "accountidentity", "integration", "endpoint", "connectionid", "entityid", "externalid",
  "statebinding", "devicecommand", "remotecontrol", "actuation", "automation", "callback", "webhook",
] as const;

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function fail(message: string): never {
  throw new TypeError(`Invalid Stuguby payload: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} must be a non-empty string`);
  return value as string;
}

function requireIdentifier(object: Record<string, unknown>, key: string, maximum = 500): string {
  const value = requireString(object, key);
  if (value.length > maximum) fail(`${key} exceeds ${maximum} characters`);
  return value;
}

function requireFiniteNumber(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${key} must be a finite number`);
  return value as number;
}

function requireInteger(object: Record<string, unknown>, key: string, minimum = 0): number {
  const value = requireFiniteNumber(object, key);
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${key} must be a safe integer >= ${minimum}`);
  return value;
}

function requireBoolean(object: Record<string, unknown>, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") fail(`${key} must be boolean`);
  return value;
}

function requireNullableFiniteNumber(object: Record<string, unknown>, key: string): number | null {
  if (object[key] === null) return null;
  return requireFiniteNumber(object, key);
}

function requireEnumString(
  object: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string {
  const value = requireString(object, key);
  if (!allowed.includes(value)) fail(`${key} has an unsupported value`);
  return value;
}

function requireIsoDate(value: unknown, name: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO date-time${nullable ? " or null" : ""}`);
  return value as string;
}

function requireStringArray(value: unknown, name: string, maximum = 10_000): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 500)) {
    fail(`${name} must be an array of at most ${maximum} non-empty strings of at most 500 characters`);
  }
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value as string[];
}

function requireArray(value: unknown, name: string, maximum = 100_000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${name} must be an array of at most ${maximum} items`);
  return value;
}

function requireNullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(`${name} must be a string or null`);
  return value as string;
}

function optionalString(object: Record<string, unknown>, key: string): void {
  if (object[key] !== undefined && typeof object[key] !== "string") fail(`${key} must be a string when supplied`);
}

function onlyKeys(object: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(object).find((key) => !allowedSet.has(key));
  if (unknown) fail(`${name}.${unknown} is not part of the protocol schema`);
}

function point(value: unknown, name: string): void {
  if (!isObject(value)) fail(`${name} must be a point object`);
  onlyKeys(value, ["x", "y"], name);
  requireFiniteNumber(value, "x");
  requireFiniteNumber(value, "y");
}

function coordinate(value: unknown, name: string): void {
  if (!isObject(value)) fail(`${name} must be a coordinate object`);
  const latitude = requireFiniteNumber(value, "latitude");
  const longitude = requireFiniteNumber(value, "longitude");
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) fail(`${name} is outside WGS84 bounds`);
}

export function isStugubyDataset(value: unknown): value is StugubyDataset {
  return typeof value === "string" && DATASET_SET.has(value);
}

export function isStugubyRole(value: unknown): value is StugubyRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

export function assertSafeFederationPayload(value: unknown, path = "$", depth = 0): asserts value is JsonValue {
  if (depth > 64) fail(`${path} exceeds maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100_000) fail(`${path} contains too many items`);
    value.forEach((item, index) => assertSafeFederationPayload(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isObject(value)) fail(`${path} contains an unsupported value`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 10_000) fail(`${path} contains too many fields`);
  for (const [key, item] of entries) {
    const normalized = normalizedKey(key);
    if (FORBIDDEN_KEYS.has(normalized) || FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
      || normalized.endsWith("url") || normalized.endsWith("uri")) {
      fail(`${path}.${key} is outside the federation data plane`);
    }
    assertSafeFederationPayload(item, `${path}.${key}`, depth + 1);
  }
}

export function validateShareGrant(value: unknown): StugubyShareGrant {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail("share grant must be an object");
  onlyKeys(value, ["id", "stugubyId", "authorityNodeId", "publicationId", "localHouseId", "audience", "datasets", "housePolicy", "epoch", "revision", "expiresAt", "revokedAt", "createdAt", "updatedAt"], "grant");
  requireIdentifier(value, "id");
  requireIdentifier(value, "stugubyId");
  requireIdentifier(value, "authorityNodeId");
  requireIdentifier(value, "publicationId");
  requireInteger(value, "epoch", 1);
  requireInteger(value, "revision", 1);
  if (!isObject(value.audience)) fail("audience must be an object");
  onlyKeys(value.audience, ["kind", "nodeIds"], "audience");
  if (value.audience.kind !== "all-members" && value.audience.kind !== "members") fail("invalid audience kind");
  const audienceNodeIds = requireStringArray(value.audience.nodeIds, "audience.nodeIds", 1_000);
  if (value.audience.kind === "all-members" && audienceNodeIds.length !== 0) fail("all-members audience must not list node ids");
  if (value.audience.kind === "members" && audienceNodeIds.length === 0) fail("members audience requires at least one node id");
  if (!isObject(value.housePolicy)) fail("housePolicy must be an object");
  onlyKeys(value.housePolicy, ["editPolicy", "recoveryMode", "designatedSuccessorNodeId"], "housePolicy");
  if (!["read-only", "editable"].includes(String(value.housePolicy.editPolicy))) fail("invalid Home edit policy");
  if (!["none", "full"].includes(String(value.housePolicy.recoveryMode))) fail("invalid Home recovery mode");
  const successorNodeId = requireNullableString(value.housePolicy.designatedSuccessorNodeId, "housePolicy.designatedSuccessorNodeId");
  if (value.housePolicy.recoveryMode === "full") {
    if (!successorNodeId) fail("full Home recovery requires one designated successor");
    if (value.audience.kind !== "members" || audienceNodeIds.length !== 1 || audienceNodeIds[0] !== successorNodeId) {
      fail("full Home recovery must be shared only with its one designated successor");
    }
  } else if (successorNodeId) {
    fail("a designated successor is only valid for full Home recovery");
  }
  if (!Array.isArray(value.datasets) || value.datasets.length === 0 || value.datasets.length > STUGBY_DATASETS.length) fail("at least one unique supported dataset is required");
  requireIsoDate(value.expiresAt, "expiresAt", true);
  requireIsoDate(value.revokedAt, "revokedAt", true);
  requireIsoDate(value.createdAt, "createdAt");
  requireIsoDate(value.updatedAt, "updatedAt");
  if (Date.parse(String(value.updatedAt)) < Date.parse(String(value.createdAt))) fail("updatedAt precedes createdAt");
  if (value.expiresAt && Date.parse(String(value.expiresAt)) <= Date.parse(String(value.createdAt))) fail("expiresAt must follow createdAt");
  if (value.revokedAt && Date.parse(String(value.revokedAt)) < Date.parse(String(value.createdAt))) fail("revokedAt precedes createdAt");
  const seen = new Set<string>();
  let enabledCount = 0;
  for (const item of value.datasets) {
    if (!isObject(item) || !isStugubyDataset(item.dataset)) fail("invalid dataset grant");
    onlyKeys(item, ["dataset", "enabled", "includeLocalIds", "allowReplicaCache", "retentionDays", "telemetry"], "dataset grant");
    if (seen.has(item.dataset)) fail(`duplicate dataset ${item.dataset}`);
    seen.add(item.dataset);
    if (typeof item.enabled !== "boolean" || typeof item.includeLocalIds !== "boolean" || typeof item.allowReplicaCache !== "boolean") {
      fail(`invalid flags for ${item.dataset}`);
    }
    if (item.enabled) enabledCount += 1;
    const retentionDays = requireInteger(item, "retentionDays", 0);
    if (retentionDays > 3_650) fail("retentionDays exceeds 3650");
    if (item.dataset === "home.telemetry.v1" && item.enabled) {
      if (!isObject(item.telemetry)) fail("enabled telemetry requires a policy");
      onlyKeys(item.telemetry, ["sensorPublicationIds", "metricIds", "historyFrom", "live", "maxSamplesPerHour"], "telemetry policy");
      requireStringArray(item.telemetry.sensorPublicationIds, "telemetry.sensorPublicationIds", 10_000);
      requireStringArray(item.telemetry.metricIds, "telemetry.metricIds", 1_000);
      requireIsoDate(item.telemetry.historyFrom, "telemetry.historyFrom", true);
      const maximum = requireInteger(item.telemetry, "maxSamplesPerHour", 1);
      if (maximum > 1_000_000) fail("telemetry sample limit is too high");
      if (typeof item.telemetry.live !== "boolean") fail("telemetry.live must be boolean");
    } else if (item.telemetry !== undefined) {
      fail("telemetry policy is only valid for an enabled telemetry dataset");
    }
  }
  if (enabledCount === 0) fail("at least one dataset must be enabled");
  const recoveryDataset = (value.datasets as unknown as StugubyDatasetGrant[])
    .find((item) => item.dataset === "home.recovery.v1" && item.enabled);
  if (recoveryDataset && value.housePolicy.recoveryMode !== "full") {
    fail("the Home recovery dataset is only valid for a full recovery successor");
  }
  if (value.housePolicy.recoveryMode === "full") {
    const enabled = new Map((value.datasets as unknown as StugubyDatasetGrant[])
      .filter((item) => item.enabled).map((item) => [item.dataset, item]));
    for (const dataset of STUGBY_DATASETS) {
      const policy = enabled.get(dataset);
      if (!policy || !policy.allowReplicaCache || policy.retentionDays < 1) {
        fail("full Home recovery requires every dataset with durable replica retention");
      }
    }
    const telemetry = enabled.get("home.telemetry.v1")?.telemetry;
    if (!telemetry?.historyFrom) fail("full Home recovery requires a telemetry history start");
    if (telemetry.sensorPublicationIds.length > 0 || telemetry.metricIds.length > 0) {
      fail("full Home recovery must include every sensor and metric");
    }
  }
  return value as unknown as StugubyShareGrant;
}

export function validateSharedProperty(value: unknown): StugubySharedProperty {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail("shared property must be an object");
  onlyKeys(value, ["stugubyId", "name", "description", "location", "areas", "equipment", "notes", "maintenance", "editPolicy", "authorityEpoch", "designatedSuccessorNodeId", "revision", "updatedAt"], "shared property");
  requireString(value, "stugubyId");
  requireString(value, "name");
  requireInteger(value, "revision", 1);
  requireInteger(value, "authorityEpoch", 1);
  if (!["collaborative", "read-only"].includes(String(value.editPolicy))) fail("invalid shared Property edit policy");
  requireNullableString(value.designatedSuccessorNodeId, "designatedSuccessorNodeId");
  requireIsoDate(value.updatedAt, "updatedAt");
  if (value.description !== null && typeof value.description !== "string") fail("description must be a string or null");
  if (value.location !== null) {
    coordinate(value.location, "location");
    onlyKeys(value.location as Record<string, unknown>, ["latitude", "longitude", "label"], "location");
    optionalString(value.location as Record<string, unknown>, "label");
  }
  for (const key of ["areas", "equipment", "notes", "maintenance"] as const) {
    requireArray(value[key], key, 10_000);
  }
  const areaIds = new Set<string>();
  for (const area of value.areas as unknown[]) {
    if (!isObject(area)) fail("each area must be an object");
    onlyKeys(area, ["id", "name", "kind", "description", "location", "polygon"], "area");
    const areaId = requireString(area, "id"); requireString(area, "name"); requireString(area, "kind");
    if (areaIds.has(areaId)) fail(`duplicate area id ${areaId}`);
    areaIds.add(areaId);
    requireNullableString(area.description, "area.description");
    if (area.location !== undefined) coordinate(area.location, "area.location");
    for (const point of requireArray(area.polygon, "area.polygon", 100_000)) coordinate(point, "area polygon point");
  }
  const equipmentIds = new Set<string>();
  for (const equipment of value.equipment as unknown[]) {
    if (!isObject(equipment)) fail("each equipment item must be an object");
    onlyKeys(equipment, ["id", "areaId", "home", "location", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes"], "equipment");
    const equipmentId = requireString(equipment, "id");
    const areaId = requireNullableString(equipment.areaId, "equipment.areaId");
    requireString(equipment, "name"); requireString(equipment, "kind");
    if (equipmentIds.has(equipmentId)) fail(`duplicate equipment id ${equipmentId}`);
    if (areaId && !areaIds.has(areaId)) fail(`equipment ${equipmentId} references an unknown area`);
    if (equipment.home !== undefined && equipment.home !== null) {
      if (!isObject(equipment.home)) fail(`equipment ${equipmentId} home must be an object or null`);
      onlyKeys(equipment.home, ["authorityNodeId", "publicationId"], "equipment home reference");
      requireString(equipment.home, "authorityNodeId");
      requireString(equipment.home, "publicationId");
      if (areaId) fail(`equipment ${equipmentId} cannot reference both an area and a Home`);
    }
    if (equipment.location !== undefined) coordinate(equipment.location, "equipment.location");
    equipmentIds.add(equipmentId);
    requireNullableString(equipment.manufacturer, "equipment.manufacturer");
    requireNullableString(equipment.model, "equipment.model");
    requireNullableString(equipment.serialNumber, "equipment.serialNumber");
    requireNullableString(equipment.notes, "equipment.notes");
    if (!["active", "out-of-service", "retired"].includes(String(equipment.status))) fail("invalid equipment status");
  }
  const noteIds = new Set<string>();
  for (const note of value.notes as unknown[]) {
    if (!isObject(note)) fail("each property note must be an object");
    onlyKeys(note, ["id", "areaId", "equipmentId", "kind", "text", "createdAt", "updatedAt"], "property note");
    const noteId = requireString(note, "id"); requireString(note, "text");
    if (noteIds.has(noteId)) fail(`duplicate property note id ${noteId}`);
    noteIds.add(noteId);
    const areaId = requireNullableString(note.areaId, "note.areaId");
    const equipmentId = requireNullableString(note.equipmentId, "note.equipmentId");
    if (areaId && !areaIds.has(areaId)) fail(`property note ${noteId} references an unknown area`);
    if (equipmentId && !equipmentIds.has(equipmentId)) fail(`property note ${noteId} references unknown equipment`);
    if (!["note", "inspection", "maintenance"].includes(String(note.kind))) fail("invalid property note kind");
    requireIsoDate(note.createdAt, "note.createdAt"); requireIsoDate(note.updatedAt, "note.updatedAt");
    if (Date.parse(String(note.updatedAt)) < Date.parse(String(note.createdAt))) fail(`property note ${noteId} updatedAt precedes createdAt`);
  }
  const maintenanceIds = new Set<string>();
  for (const item of value.maintenance as unknown[]) {
    if (!isObject(item)) fail("each maintenance item must be an object");
    onlyKeys(item, ["id", "title", "description", "areaId", "equipmentId", "state", "dueAt", "completedAt", "createdAt", "updatedAt"], "maintenance item");
    const itemId = requireString(item, "id"); requireString(item, "title");
    if (maintenanceIds.has(itemId)) fail(`duplicate maintenance item id ${itemId}`);
    maintenanceIds.add(itemId);
    requireNullableString(item.description, "maintenance.description");
    const areaId = requireNullableString(item.areaId, "maintenance.areaId");
    const equipmentId = requireNullableString(item.equipmentId, "maintenance.equipmentId");
    if (areaId && !areaIds.has(areaId)) fail(`maintenance item ${itemId} references an unknown area`);
    if (equipmentId && !equipmentIds.has(equipmentId)) fail(`maintenance item ${itemId} references unknown equipment`);
    if (!["planned", "in-progress", "done", "cancelled"].includes(String(item.state))) fail("invalid maintenance state");
    requireIsoDate(item.dueAt, "maintenance.dueAt", true); requireIsoDate(item.completedAt, "maintenance.completedAt", true);
    requireIsoDate(item.createdAt, "maintenance.createdAt"); requireIsoDate(item.updatedAt, "maintenance.updatedAt");
    if (Date.parse(String(item.updatedAt)) < Date.parse(String(item.createdAt))) fail(`maintenance item ${itemId} updatedAt precedes createdAt`);
  }
  return value as unknown as StugubySharedProperty;
}

export function validatePropertyCommand(value: unknown): StugubyPropertyCommand {
  if (!isObject(value)) fail("property command must be an object");
  onlyKeys(value, ["id", "stugubyId", "actorNodeId", "baseRevision", "entityKind", "entityId", "operation", "changedFields", "value", "createdAt"], "property command");
  requireIdentifier(value, "id");
  requireIdentifier(value, "stugubyId");
  requireIdentifier(value, "actorNodeId");
  requireInteger(value, "baseRevision", 1);
  if (!["property", "area", "equipment", "note", "maintenance"].includes(String(value.entityKind))) {
    fail("invalid property command entity kind");
  }
  requireString(value, "entityId");
  if (!["upsert", "delete"].includes(String(value.operation))) fail("invalid property command operation");
  const changedFields = requireStringArray(value.changedFields, "changedFields", 100);
  if (new Set(changedFields).size !== changedFields.length) fail("changedFields must be unique");
  if (value.operation === "upsert") {
    if (!isObject(value.value)) fail("upsert property commands require an object value");
    assertSafeFederationPayload(value.value, "$.value");
  } else {
    if (value.value !== null) fail("delete property commands require a null value");
    if (changedFields.length !== 0) fail("delete property commands cannot list changed fields");
  }
  requireIsoDate(value.createdAt, "createdAt");
  return value as unknown as StugubyPropertyCommand;
}

export function validatePropertyCommandResult(value: unknown): StugubyPropertyCommandResult {
  if (!isObject(value)) fail("property command result must be an object");
  onlyKeys(value, ["commandId", "status", "appliedFields", "conflict", "property"], "property command result");
  requireIdentifier(value, "commandId");
  if (!["applied", "conflict"].includes(String(value.status))) fail("invalid property command result status");
  requireStringArray(value.appliedFields, "appliedFields", 100);
  validateSharedProperty(value.property);
  if (value.conflict !== null) {
    if (!isObject(value.conflict)) fail("property command conflict must be an object or null");
    onlyKeys(value.conflict, ["commandId", "entityKind", "entityId", "fields", "message", "serverValue", "clientValue", "detectedAt", "resolvedAt"], "property command conflict");
    if (value.conflict.commandId !== value.commandId) fail("property command conflict id does not match");
    if (!["property", "area", "equipment", "note", "maintenance"].includes(String(value.conflict.entityKind))) {
      fail("invalid property command conflict entity kind");
    }
    requireString(value.conflict, "entityId");
    requireStringArray(value.conflict.fields, "conflict.fields", 100);
    requireString(value.conflict, "message");
    if (value.conflict.serverValue !== null && !isObject(value.conflict.serverValue)) fail("conflict.serverValue must be an object or null");
    if (value.conflict.clientValue !== null && !isObject(value.conflict.clientValue)) fail("conflict.clientValue must be an object or null");
    if (value.conflict.serverValue !== null) assertSafeFederationPayload(value.conflict.serverValue, "$.conflict.serverValue");
    if (value.conflict.clientValue !== null) assertSafeFederationPayload(value.conflict.clientValue, "$.conflict.clientValue");
    requireIsoDate(value.conflict.detectedAt, "conflict.detectedAt");
    requireIsoDate(value.conflict.resolvedAt, "conflict.resolvedAt", true);
  }
  if (value.status === "conflict" && value.conflict === null) fail("conflict result requires conflict details");
  if (value.status === "applied" && value.conflict !== null) fail("applied result cannot include conflict details");
  return value as unknown as StugubyPropertyCommandResult;
}

export function validateHomeCommand(value: unknown): StugubyHomeCommand {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail("Home command must be an object");
  onlyKeys(value, [
    "id", "stugubyId", "actorNodeId", "authorityNodeId", "publicationId", "grantId", "grantEpoch",
    "authorityEpoch", "baseRevision", "snapshot", "createdAt",
  ], "Home command");
  for (const key of ["id", "stugubyId", "actorNodeId", "authorityNodeId", "publicationId", "grantId"] as const) {
    requireString(value, key);
  }
  requireInteger(value, "grantEpoch", 1);
  requireInteger(value, "authorityEpoch", 1);
  requireInteger(value, "baseRevision", 1);
  requireIsoDate(value.createdAt, "createdAt");
  if (!isObject(value.snapshot)) fail("Home command snapshot must be an object");
  onlyKeys(value.snapshot, ["directory", "location", "structure", "sensorCatalog", "notes", "observations"], "Home command snapshot");
  validateDatasetPayload("home.directory.v1", value.snapshot.directory);
  if (value.snapshot.location !== null) validateDatasetPayload("home.location.v1", value.snapshot.location);
  validateDatasetPayload("home.structure.v1", value.snapshot.structure);
  validateDatasetPayload("home.sensor-catalog.v1", value.snapshot.sensorCatalog);
  validateDatasetPayload("home.notes.v1", value.snapshot.notes);
  validateDatasetPayload("home.observations.v1", value.snapshot.observations);
  const publicationId = String(value.publicationId);
  for (const payload of [
    value.snapshot.directory,
    value.snapshot.location,
    value.snapshot.structure,
    value.snapshot.sensorCatalog,
    value.snapshot.notes,
    value.snapshot.observations,
  ]) {
    if (payload !== null && isObject(payload) && payload.publicationId !== publicationId) {
      fail("Home command snapshot publication ids must match");
    }
  }
  return value as unknown as StugubyHomeCommand;
}

export function validateHomeCommandResult(value: unknown): StugubyHomeCommandResult {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail("Home command result must be an object");
  onlyKeys(value, ["commandId", "status", "authorityRevision", "message"], "Home command result");
  requireString(value, "commandId");
  if (!["applied", "conflict"].includes(String(value.status))) fail("invalid Home command result status");
  requireInteger(value, "authorityRevision", 1);
  requireString(value, "message");
  return value as unknown as StugubyHomeCommandResult;
}

export function validateDatasetPayload(dataset: StugubyDataset, value: unknown): StugubyDatasetPayload {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail(`${dataset} must be an object`);
  requireIdentifier(value, "publicationId");
  switch (dataset) {
    case "home.directory.v1":
      onlyKeys(value, ["publicationId", "name", "timezone", "localHouseId"], dataset);
      requireString(value, "name");
      requireString(value, "timezone");
      optionalString(value, "localHouseId");
      break;
    case "home.location.v1":
      onlyKeys(value, ["publicationId", "latitude", "longitude", "label", "countryCode", "mapPlacement", "orientationDegrees"], dataset);
      if (requireFiniteNumber(value, "latitude") < -90 || Number(value.latitude) > 90) fail("latitude is outside WGS84 bounds");
      if (requireFiniteNumber(value, "longitude") < -180 || Number(value.longitude) > 180) fail("longitude is outside WGS84 bounds");
      optionalString(value, "label"); optionalString(value, "countryCode");
      if (value.orientationDegrees !== undefined) requireFiniteNumber(value, "orientationDegrees");
      if (value.mapPlacement !== undefined) {
        if (!isObject(value.mapPlacement)) fail("mapPlacement must be an object");
        onlyKeys(value.mapPlacement, ["latitude", "longitude", "metersPerPlanUnit", "footprintFloorPublicationId"], "mapPlacement");
        coordinate(value.mapPlacement, "mapPlacement");
        if (requireFiniteNumber(value.mapPlacement, "metersPerPlanUnit") <= 0) fail("metersPerPlanUnit must be positive");
        optionalString(value.mapPlacement, "footprintFloorPublicationId");
      }
      break;
    case "home.structure.v1":
      onlyKeys(value, ["publicationId", "floors"], dataset);
      {
      const floorIds = new Set<string>();
      for (const floor of requireArray(value.floors, "floors", 1_000)) {
        if (!isObject(floor)) fail("each floor must be an object");
        onlyKeys(floor, ["floorPublicationId", "localFloorId", "name", "type", "width", "height", "metersPerPlanUnit", "elevation", "ceilingHeight", "wallHeight", "roof", "walls", "rooms", "planElements"], "floor");
        const floorId = requireIdentifier(floor, "floorPublicationId"); requireString(floor, "name");
        if (floorIds.has(floorId)) fail(`duplicate floor publication id ${floorId}`);
        floorIds.add(floorId);
        optionalString(floor, "localFloorId"); optionalString(floor, "type");
        if (requireFiniteNumber(floor, "width") <= 0 || requireFiniteNumber(floor, "height") <= 0) fail("floor dimensions must be positive");
        requireFiniteNumber(floor, "elevation");
        for (const key of ["metersPerPlanUnit", "ceilingHeight", "wallHeight"] as const) {
          if (floor[key] !== undefined && requireFiniteNumber(floor, key) <= 0) fail(`${key} must be positive`);
        }
        if (floor.roof !== undefined) {
          if (!isObject(floor.roof)) fail("floor.roof must be an object");
          onlyKeys(floor.roof, ["style", "pitchDegrees", "ridgeAxis", "overhang", "eavesHeight"], "floor.roof");
          requireString(floor.roof, "style"); requireString(floor.roof, "ridgeAxis");
          requireFiniteNumber(floor.roof, "pitchDegrees"); requireFiniteNumber(floor.roof, "overhang"); requireFiniteNumber(floor.roof, "eavesHeight");
        }
        const wallIds = new Set<string>();
        for (const wall of requireArray(floor.walls, "floor.walls", 100_000)) {
          if (!isObject(wall)) fail("each wall must be an object");
          onlyKeys(wall, ["wallPublicationId", "localWallId", "from", "to"], "wall");
          const wallId = requireIdentifier(wall, "wallPublicationId"); optionalString(wall, "localWallId");
          if (wallIds.has(wallId)) fail(`duplicate wall publication id ${wallId}`);
          wallIds.add(wallId);
          point(wall.from, "wall.from"); point(wall.to, "wall.to");
        }
        const roomIds = new Set<string>();
        for (const room of requireArray(floor.rooms, "floor.rooms", 100_000)) {
          if (!isObject(room)) fail("each room must be an object");
          onlyKeys(room, ["roomPublicationId", "localRoomId", "name", "points", "kind"], "room");
          const roomId = requireIdentifier(room, "roomPublicationId"); optionalString(room, "localRoomId");
          if (roomIds.has(roomId)) fail(`duplicate room publication id ${roomId}`);
          roomIds.add(roomId);
          requireString(room, "name"); optionalString(room, "kind");
          for (const roomPoint of requireArray(room.points, "room.points", 100_000)) point(roomPoint, "room point");
        }
        const elementIds = new Set<string>();
        for (const element of requireArray(floor.planElements, "floor.planElements", 100_000)) {
          if (!isObject(element)) fail("each plan element must be an object");
          onlyKeys(element, ["planElementPublicationId", "localPlanElementId", "kind", "position", "rotationDegrees", "width", "height", "label", "state", "openFraction", "bottomOffsetM", "wallPublicationId", "variant", "nominalFlowM3h", "verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"], "plan element");
          const elementId = requireIdentifier(element, "planElementPublicationId"); optionalString(element, "localPlanElementId");
          if (elementIds.has(elementId)) fail(`duplicate plan element publication id ${elementId}`);
          elementIds.add(elementId);
          requireString(element, "kind"); point(element.position, "plan element position");
          requireFiniteNumber(element, "rotationDegrees");
          for (const key of ["width", "height", "openFraction", "bottomOffsetM", "nominalFlowM3h", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"] as const) {
            if (element[key] !== undefined) requireFiniteNumber(element, key);
          }
          for (const key of ["label", "state", "wallPublicationId", "variant", "verticalExtent"] as const) optionalString(element, key);
          if (typeof element.wallPublicationId === "string" && !wallIds.has(element.wallPublicationId)) fail(`plan element ${elementId} references an unknown wall`);
        }
      }
      }
      break;
    case "home.floorplan.v1":
      onlyKeys(value, ["publicationId", "assets"], dataset);
      {
      const assetFloors = new Set<string>();
      for (const asset of requireArray(value.assets, "assets", 1_000)) {
        if (!isObject(asset) || !isObject(asset.image)) fail("each floor-plan asset requires an image reference");
        onlyKeys(asset, ["floorPublicationId", "image"], "floor-plan asset");
        onlyKeys(asset.image, ["digest", "byteLength", "mediaType"], "floor-plan image");
        const floorId = requireIdentifier(asset, "floorPublicationId");
        if (assetFloors.has(floorId)) fail(`duplicate floor-plan asset for floor ${floorId}`);
        assetFloors.add(floorId);
        const digest = requireString(asset.image, "digest");
        if (!/^[a-f0-9]{64}$/.test(digest)) fail("floor-plan digest must be lowercase SHA-256");
        const byteLength = requireInteger(asset.image, "byteLength", 1);
        if (byteLength > STUGBY_MAX_BLOB_BYTES) fail("floor-plan asset exceeds maximum size");
        if (!["image/png", "image/jpeg", "image/webp"].includes(String(asset.image.mediaType))) fail("unsupported floor-plan media type");
      }
      }
      break;
    case "home.sensor-catalog.v1":
      onlyKeys(value, ["publicationId", "sensors"], dataset);
      {
      const sensorIds = new Set<string>();
      for (const sensor of requireArray(value.sensors, "sensors", 100_000)) {
        if (!isObject(sensor)) fail("each sensor must be an object");
        onlyKeys(sensor, ["sensorPublicationId", "localSensorId", "floorPublicationId", "roomPublicationId", "name", "model", "tags", "enabled", "x", "y", "z", "metricIds"], "sensor");
        const sensorId = requireIdentifier(sensor, "sensorPublicationId");
        if (sensorIds.has(sensorId)) fail(`duplicate sensor publication id ${sensorId}`);
        sensorIds.add(sensorId);
        requireIdentifier(sensor, "floorPublicationId");
        requireString(sensor, "name");
        requireString(sensor, "model");
        requireStringArray(sensor.tags, "sensor.tags", 100);
        requireBoolean(sensor, "enabled");
        optionalString(sensor, "localSensorId"); optionalString(sensor, "roomPublicationId");
        requireFiniteNumber(sensor, "x");
        requireFiniteNumber(sensor, "y");
        requireFiniteNumber(sensor, "z");
        requireStringArray(sensor.metricIds, "sensor.metricIds", 1_000);
      }
      }
      break;
    case "home.telemetry.v1":
      onlyKeys(value, ["publicationId", "chunkId", "from", "to", "complete", "samples"], dataset);
      requireString(value, "chunkId");
      requireIsoDate(value.from, "from");
      requireIsoDate(value.to, "to");
      if (Date.parse(String(value.from)) > Date.parse(String(value.to))) fail("telemetry from must not follow to");
      if (typeof value.complete !== "boolean") fail("complete must be boolean");
      for (const sample of requireArray(value.samples, "samples", 100_000)) {
        if (!isObject(sample)) fail("each telemetry sample must be an object");
        onlyKeys(sample, ["sensorPublicationId", "metricId", "timestamp", "value", "quality", "correctionOf"], "telemetry sample");
        requireIdentifier(sample, "sensorPublicationId");
        requireIdentifier(sample, "metricId");
        requireIsoDate(sample.timestamp, "sample.timestamp");
        if (Date.parse(String(sample.timestamp)) < Date.parse(String(value.from)) || Date.parse(String(sample.timestamp)) > Date.parse(String(value.to))) fail("telemetry sample is outside chunk bounds");
        requireFiniteNumber(sample, "value");
        if (!["good", "estimated", "stale"].includes(String(sample.quality))) fail("invalid telemetry quality");
        optionalString(sample, "correctionOf");
      }
      break;
    case "home.notes.v1":
      onlyKeys(value, ["publicationId", "notes"], dataset);
      {
      const noteIds = new Set<string>();
      for (const note of requireArray(value.notes, "notes", 100_000)) {
        if (!isObject(note)) fail("each Home note must be an object");
        onlyKeys(note, ["notePublicationId", "localNoteId", "kind", "text", "createdAt", "updatedAt"], "Home note");
        const noteId = requireIdentifier(note, "notePublicationId"); requireString(note, "text"); optionalString(note, "localNoteId");
        if (noteIds.has(noteId)) fail(`duplicate Home note publication id ${noteId}`);
        noteIds.add(noteId);
        if (!["note", "inspection", "maintenance"].includes(String(note.kind))) fail("invalid Home note kind");
        requireIsoDate(note.createdAt, "note.createdAt"); requireIsoDate(note.updatedAt, "note.updatedAt");
        if (Date.parse(String(note.updatedAt)) < Date.parse(String(note.createdAt))) fail(`Home note ${noteId} updatedAt precedes createdAt`);
      }
      }
      break;
    case "home.observations.v1":
      onlyKeys(value, ["publicationId", "observations"], dataset);
      {
      const observationIds = new Set<string>();
      for (const observation of requireArray(value.observations, "observations", 100_000)) {
        if (!isObject(observation)) fail("each observation must be an object");
        onlyKeys(observation, ["observationPublicationId", "localObservationId", "floorPublicationId", "sensorPublicationId", "kind", "severity", "note", "x", "y", "occurredAt", "timePrecision", "validFrom", "validTo", "confidence", "status", "resolutionNote", "resolvedAt", "updatedAt"], "observation");
        const observationId = requireIdentifier(observation, "observationPublicationId"); requireIdentifier(observation, "floorPublicationId");
        if (observationIds.has(observationId)) fail(`duplicate observation publication id ${observationId}`);
        observationIds.add(observationId);
        requireString(observation, "kind"); requireString(observation, "severity"); requireString(observation, "note");
        optionalString(observation, "localObservationId"); optionalString(observation, "sensorPublicationId");
        for (const axis of ["x", "y"] as const) if (observation[axis] !== null) requireFiniteNumber(observation, axis);
        requireIsoDate(observation.occurredAt, "observation.occurredAt"); requireIsoDate(observation.updatedAt, "observation.updatedAt");
        for (const key of ["validFrom", "validTo", "resolvedAt"] as const) if (observation[key] !== undefined) requireIsoDate(observation[key], `observation.${key}`, true);
        for (const key of ["timePrecision", "confidence", "status"] as const) optionalString(observation, key);
        if (observation.resolutionNote !== undefined) requireNullableString(observation.resolutionNote, "observation.resolutionNote");
      }
      }
      break;
    case "home.recovery.v1": {
      onlyKeys(value, ["publicationId", "chunkId", "generation", "kind", "complete", "records"], dataset);
      requireString(value, "chunkId");
      requireInteger(value, "generation", 1);
      if (!["manifest", "measurement-definitions", "alert-rules", "alert-events", "static-parameters", "opening-states",
        "weather-history", "electricity-history", "assets"].includes(String(value.kind))) fail("invalid Home recovery kind");
      if (typeof value.complete !== "boolean") fail("recovery complete must be boolean");
      const records = requireArray(value.records, "records", 25_000);
      const allowed: Record<StugubyHomeRecoveryKind, readonly string[]> = {
        manifest: ["telemetrySamples", "generatedAt"],
        "measurement-definitions": ["id", "labels", "unit", "dimension", "allowedUnits", "kind", "defaultAggregation", "precision", "validMin", "validMax", "displayMin", "displayMax", "interpolationDelta", "colorScale", "enabled", "spatialInterpolation", "forecastSupported"],
        "alert-rules": ["ruleKey", "name", "sensorPublicationId", "metric", "operator", "threshold", "durationSeconds", "severity", "enabled", "retiredAt"],
        "alert-events": ["eventKey", "ruleKey", "sensorPublicationId", "metric", "value", "threshold", "severity", "startedAt", "acknowledgedAt", "resolvedAt"],
        "static-parameters": ["parameterKey", "scopeType", "scopePublicationId", "key", "value", "unit", "label"],
        "opening-states": ["openingKey", "floorPublicationId", "planElementPublicationId", "state", "openFraction", "observedAt", "validUntil"],
        "weather-history": ["weatherKey", "locationKey", "timestamp", "temperatureC", "source", "fetchedAt", "stationId", "stationName", "conditions"],
        "electricity-history": ["priceKey", "startAt", "endAt", "rawPriceCentsPerKwh", "marginCentsPerKwh", "fetchedAt"],
        assets: ["assetKey", "name", "mimeType", "kind", "digest", "byteLength", "createdAt"],
      };
      for (const record of records) {
        if (!isObject(record)) fail("each Home recovery record must be an object");
        onlyKeys(record, allowed[value.kind as StugubyHomeRecoveryKind], `${String(value.kind)} recovery record`);
      }
      const kind = value.kind as StugubyHomeRecoveryKind;
      const typedRecords = records as Array<Record<string, unknown>>;
      const uniqueRecordKey: Partial<Record<StugubyHomeRecoveryKind, string>> = {
        "measurement-definitions": "id",
        "alert-rules": "ruleKey",
        "alert-events": "eventKey",
        "static-parameters": "parameterKey",
        "opening-states": "openingKey",
        "weather-history": "weatherKey",
        "electricity-history": "priceKey",
        assets: "assetKey",
      };
      const recordKey = uniqueRecordKey[kind];
      if (recordKey) {
        const seen = new Set<string>();
        for (const record of typedRecords) {
          const key = requireIdentifier(record, recordKey);
          if (seen.has(key)) fail(`${kind} recovery records contain duplicate ${recordKey}`);
          seen.add(key);
        }
      }
      if (kind === "manifest") {
        if (typedRecords.length !== 1) fail("Home recovery manifest requires exactly one record");
        const record = typedRecords[0]!;
        requireInteger(record, "telemetrySamples", 0);
        requireIsoDate(record.generatedAt, "manifest.generatedAt");
      } else if (kind === "measurement-definitions") {
        for (const record of typedRecords) {
          requireString(record, "unit");
          if (!isObject(record.labels) || Object.keys(record.labels).length === 0
            || Object.keys(record.labels).length > 100
            || Object.values(record.labels).some((label) => typeof label !== "string" || label.length === 0 || label.length > 500)) {
            fail("measurement definition labels must be a non-empty string map");
          }
          optionalString(record, "dimension");
          if (record.allowedUnits !== undefined) requireStringArray(record.allowedUnits, "measurement definition allowedUnits", 100);
          if (record.kind !== undefined) {
            requireEnumString(record, "kind", ["gauge", "rate", "increment", "cumulative_counter", "binary_state", "categorical_state"]);
          }
          if (record.defaultAggregation !== undefined) {
            requireEnumString(record, "defaultAggregation", ["mean", "sum", "delta", "last", "time_weighted_mean", "duration", "custom"]);
          }
          requireInteger(record, "precision", 0);
          const validMin = requireNullableFiniteNumber(record, "validMin");
          const validMax = requireNullableFiniteNumber(record, "validMax");
          const displayMin = requireNullableFiniteNumber(record, "displayMin");
          const displayMax = requireNullableFiniteNumber(record, "displayMax");
          if (validMin !== null && validMax !== null && validMin > validMax) fail("measurement definition validMin exceeds validMax");
          if (displayMin !== null && displayMax !== null && displayMin > displayMax) fail("measurement definition displayMin exceeds displayMax");
          if (requireFiniteNumber(record, "interpolationDelta") < 0) fail("measurement definition interpolationDelta must not be negative");
          requireEnumString(record, "colorScale", ["thermal", "humidity", "air-quality", "sequential"]);
          requireBoolean(record, "enabled");
          requireBoolean(record, "spatialInterpolation");
          requireBoolean(record, "forecastSupported");
        }
      } else if (kind === "alert-rules") {
        for (const record of typedRecords) {
          requireString(record, "name");
          requireIdentifier(record, "sensorPublicationId");
          requireIdentifier(record, "metric");
          requireEnumString(record, "operator", ["gt", "gte", "lt", "lte"]);
          requireFiniteNumber(record, "threshold");
          requireInteger(record, "durationSeconds", 0);
          requireEnumString(record, "severity", ["info", "warning", "critical"]);
          requireBoolean(record, "enabled");
          requireIsoDate(record.retiredAt, "alert rule retiredAt", true);
        }
      } else if (kind === "alert-events") {
        for (const record of typedRecords) {
          requireIdentifier(record, "ruleKey");
          requireIdentifier(record, "sensorPublicationId");
          requireIdentifier(record, "metric");
          requireFiniteNumber(record, "value");
          requireFiniteNumber(record, "threshold");
          requireEnumString(record, "severity", ["info", "warning", "critical"]);
          const startedAt = requireIsoDate(record.startedAt, "alert event startedAt")!;
          const acknowledgedAt = requireIsoDate(record.acknowledgedAt, "alert event acknowledgedAt", true);
          const resolvedAt = requireIsoDate(record.resolvedAt, "alert event resolvedAt", true);
          if (acknowledgedAt && Date.parse(acknowledgedAt) < Date.parse(startedAt)) fail("alert event acknowledgedAt precedes startedAt");
          if (resolvedAt && Date.parse(resolvedAt) < Date.parse(startedAt)) fail("alert event resolvedAt precedes startedAt");
        }
      } else if (kind === "static-parameters") {
        for (const record of typedRecords) {
          requireEnumString(record, "scopeType", ["house", "floor", "room", "sensor"]);
          requireIdentifier(record, "scopePublicationId");
          requireString(record, "key");
          if (!["string", "number", "boolean"].includes(typeof record.value)
            || (typeof record.value === "number" && !Number.isFinite(record.value))) {
            fail("static parameter value must be a finite scalar");
          }
          requireNullableString(record.unit, "static parameter unit");
          requireString(record, "label");
        }
      } else if (kind === "opening-states") {
        for (const record of typedRecords) {
          requireIdentifier(record, "floorPublicationId");
          requireIdentifier(record, "planElementPublicationId");
          const state = requireEnumString(record, "state", ["open", "closed", "unknown"]);
          const openFraction = requireNullableFiniteNumber(record, "openFraction");
          if (openFraction !== null && (openFraction < 0 || openFraction > 1
            || (state !== "open" && openFraction !== 0))) {
            fail("opening-state openFraction is invalid");
          }
          const observedAt = requireIsoDate(record.observedAt, "opening-state observedAt")!;
          const validUntil = requireIsoDate(record.validUntil, "opening-state validUntil", true);
          if (validUntil && Date.parse(validUntil) <= Date.parse(observedAt)) fail("opening-state validUntil must follow observedAt");
        }
      } else if (kind === "weather-history") {
        for (const record of typedRecords) {
          requireString(record, "locationKey");
          requireIsoDate(record.timestamp, "weather timestamp");
          requireFiniteNumber(record, "temperatureC");
          requireEnumString(record, "source", [
            "fmi-observation", "open-meteo-current", "fmi-backfill", "open-meteo-backfill", "mock", "api",
          ]);
          requireIsoDate(record.fetchedAt, "weather fetchedAt");
          requireNullableString(record.stationId, "weather stationId");
          requireNullableString(record.stationName, "weather stationName");
          if (record.conditions !== null && !isObject(record.conditions)) fail("weather conditions must be an object or null");
        }
      } else if (kind === "electricity-history") {
        for (const record of typedRecords) {
          const startAt = requireIsoDate(record.startAt, "electricity startAt")!;
          const endAt = requireIsoDate(record.endAt, "electricity endAt")!;
          if (Date.parse(endAt) <= Date.parse(startAt)) fail("electricity endAt must follow startAt");
          requireFiniteNumber(record, "rawPriceCentsPerKwh");
          requireFiniteNumber(record, "marginCentsPerKwh");
          requireIsoDate(record.fetchedAt, "electricity fetchedAt");
        }
      } else {
        for (const record of typedRecords) {
          requireString(record, "name");
          if (!["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"].includes(String(record.mimeType))) {
            fail("unsupported Home recovery asset media type");
          }
          if (!["floor-plan", "model-3d", "other"].includes(String(record.kind))) fail("invalid Home recovery asset kind");
          if (!/^[a-f0-9]{64}$/.test(requireString(record, "digest"))) fail("Home recovery asset digest must be lowercase SHA-256");
          const byteLength = requireInteger(record, "byteLength", 1);
          if (byteLength > STUGBY_MAX_BLOB_BYTES) fail("Home recovery asset exceeds maximum size");
          requireIsoDate(record.createdAt, "asset.createdAt");
        }
      }
      break;
    }
  }
  return value as unknown as StugubyDatasetPayload;
}

export function validateWireEvent(value: unknown): StugubyWireEvent {
  if (!isObject(value)) fail("event must be an object");
  onlyKeys(value, ["protocolVersion", "stugubyId", "eventId", "eventKind", "authorityNodeId", "streamId", "sequence", "schema", "resourceId", "operation", "revision", "grantId", "grantEpoch", "occurredAt", "payload", "payloadHash", "keyFingerprint", "signature"], "event");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > STUGBY_MAX_EVENT_BYTES) fail("event exceeds maximum encoded size");
  if (value.protocolVersion !== STUGBY_PROTOCOL_VERSION) fail("unsupported protocol version");
  requireIdentifier(value, "stugubyId");
  requireIdentifier(value, "eventId");
  if (!EVENT_KIND_SET.has(String(value.eventKind))) fail("invalid event kind");
  requireIdentifier(value, "authorityNodeId");
  requireIdentifier(value, "streamId");
  requireInteger(value, "sequence", 1);
  requireIdentifier(value, "resourceId");
  requireInteger(value, "revision", 1);
  requireIsoDate(value.occurredAt, "occurredAt");
  if (!ENVELOPE_SCHEMA_SET.has(String(value.schema))) fail("unsupported event schema");
  if (!/^[a-f0-9]{64}$/.test(requireString(value, "payloadHash"))) fail("payloadHash must be lowercase SHA-256");
  if (value.operation !== "upsert" && value.operation !== "tombstone") fail("invalid operation");
  if (value.operation === "tombstone" && value.payload !== null) fail("tombstone payload must be null");
  if (value.operation === "upsert" && value.payload === null) fail("upsert payload is required");
  if (isStugubyDataset(value.schema)) {
    if (value.eventKind !== "dataset.published") fail("dataset schema requires dataset.published event kind");
    requireIdentifier(value, "grantId");
    requireInteger(value, "grantEpoch", 1);
    if (value.operation === "upsert") validateDatasetPayload(value.schema, value.payload);
  } else if (value.schema === "stuguby.grant.v2") {
    if (value.eventKind !== (value.operation === "tombstone" ? "grant.revoked" : "grant.upserted")) fail("grant event kind does not match operation");
    requireIdentifier(value, "grantId");
    requireInteger(value, "grantEpoch", 1);
    if (value.operation === "upsert") {
      const grant = validateShareGrant(value.payload);
      if (grant.localHouseId !== undefined) fail("wire grants must not expose a local house id");
    }
  } else if (value.schema === "stuguby.member.v2") {
    if (value.eventKind !== "member.updated" || value.operation !== "upsert" || !isObject(value.payload)) fail("invalid member event");
    if (value.grantId !== null || value.grantEpoch !== null) fail("member events cannot reference a grant");
    onlyKeys(value.payload, ["stugubyId", "nodeId", "displayName", "role", "state", "publicKey", "keyFingerprint", "joinedAt", "updatedAt"], "member");
    requireString(value.payload, "stugubyId");
    requireString(value.payload, "nodeId");
    requireString(value.payload, "displayName");
    if (!isStugubyRole(value.payload.role)) fail("invalid member role");
    if (!["invited", "active", "suspended", "left", "revoked"].includes(String(value.payload.state))) fail("invalid member state");
    requireString(value.payload, "publicKey");
    requireString(value.payload, "keyFingerprint");
    requireIsoDate(value.payload.joinedAt, "member.joinedAt", true);
    requireIsoDate(value.payload.updatedAt, "member.updatedAt");
  } else if (value.schema === "stuguby.shared-property.v2") {
    if (value.eventKind !== "shared-property.updated" || value.operation !== "upsert") fail("invalid shared-property event");
    if (value.grantId !== null || value.grantEpoch !== null) fail("shared-property events cannot reference a grant");
    validateSharedProperty(value.payload);
  }
  return value as unknown as StugubyWireEvent;
}

export function validateSignedEvent(value: unknown): StugubySignedEvent {
  const event = validateWireEvent(value);
  if (!isObject(value)) fail("signed event must be an object");
  requireString(value, "keyFingerprint");
  if (!/^[a-f0-9]{64}$/.test(String(value.keyFingerprint))) fail("keyFingerprint must be lowercase SHA-256");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(requireString(value, "signature"))) fail("signature must be base64");
  return event as StugubySignedEvent;
}

/** Stable JSON used for event hashing and signatures. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

export function eventSigningValue(event: StugubyWireEvent): string {
  const envelope: JsonObject = {
    protocolVersion: event.protocolVersion,
    stugubyId: event.stugubyId,
    eventId: event.eventId,
    eventKind: event.eventKind,
    authorityNodeId: event.authorityNodeId,
    streamId: event.streamId,
    sequence: event.sequence,
    schema: event.schema,
    resourceId: event.resourceId,
    operation: event.operation,
    revision: event.revision,
    grantId: event.grantId,
    grantEpoch: event.grantEpoch,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
  return `${canonicalJson(envelope)}\n${event.payloadHash}`;
}

export function requestSigningValue(input: {
  method: string;
  path: string;
  bodyHash: string;
  timestamp: string;
  requestId: string;
  nodeId: string;
}): string {
  return [input.method.toUpperCase(), input.path, input.bodyHash, input.timestamp, input.requestId, input.nodeId, STUGBY_PROTOCOL_VERSION].join("\n");
}
