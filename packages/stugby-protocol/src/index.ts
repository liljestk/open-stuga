/**
 * Stugby is a deliberately read-only federation protocol for independently
 * administered Stuga installations. Integration configuration, credentials,
 * account identities and device control are outside this protocol.
 */

export const STUGBY_PROTOCOL_VERSION = "1.0" as const;
export const STUGBY_MEDIA_TYPE = "application/vnd.stugby.v1+json" as const;
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
] as const;

export type StugbyDataset = (typeof STUGBY_DATASETS)[number];
export type StugbyRole = "steward" | "property-manager" | "participant" | "viewer";
export type StugbyMemberState = "invited" | "active" | "suspended" | "left" | "revoked";
export type StugbyOperation = "upsert" | "tombstone";
export type StugbyEventKind =
  | "dataset.published"
  | "grant.upserted"
  | "grant.revoked"
  | "member.updated"
  | "shared-property.updated";

export interface StugbyNodeIdentity {
  nodeId: string;
  displayName: string;
  publicKey: string;
  keyFingerprint: string;
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
}

export interface StugbySummary {
  id: string;
  name: string;
  description: string | null;
  coordinatorNodeId: string;
  coordinatorUrl: string;
  localRole: StugbyRole;
  localMemberState: StugbyMemberState;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

export interface StugbyMember {
  stugbyId: string;
  nodeId: string;
  displayName: string;
  role: StugbyRole;
  state: StugbyMemberState;
  publicKey: string;
  keyFingerprint: string;
  joinedAt: string | null;
  updatedAt: string;
}

export interface StugbyInvitation {
  id: string;
  stugbyId: string;
  role: Exclude<StugbyRole, "steward">;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  /** One-time admission secret. Returned only when the invitation is created. */
  joinSecret?: string;
  coordinatorUrl: string;
}

export interface StugbyJoinRequest {
  invitationId: string;
  joinSecret: string;
  identity: StugbyNodeIdentity;
  signature: string;
}

export interface StugbyJoinResponse {
  stugby: StugbySummary;
  member: StugbyMember;
  members: StugbyMember[];
  coordinatorIdentity: StugbyNodeIdentity;
  cursor: number;
}

export interface StugbyHomePublication {
  publicationId: string;
  stugbyId: string;
  authorityNodeId: string;
  localHouseId?: string;
  displayName: string;
  activeGrantCount: number;
  updatedAt: string;
}

export interface StugbyGrantAudience {
  kind: "all-members" | "members";
  nodeIds: string[];
}

export interface StugbyTelemetryPolicy {
  sensorPublicationIds: string[];
  metricIds: string[];
  historyFrom: string | null;
  live: boolean;
  maxSamplesPerHour: number;
}

export interface StugbyDatasetGrant {
  dataset: StugbyDataset;
  enabled: boolean;
  includeLocalIds: boolean;
  allowReplicaCache: boolean;
  retentionDays: number;
  telemetry?: StugbyTelemetryPolicy;
}

export interface StugbyShareGrant {
  id: string;
  stugbyId: string;
  authorityNodeId: string;
  publicationId: string;
  localHouseId?: string;
  audience: StugbyGrantAudience;
  datasets: StugbyDatasetGrant[];
  epoch: number;
  revision: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StugbyBlobReference extends JsonObject {
  digest: string;
  byteLength: number;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface StugbyHomeDirectoryPayload extends JsonObject {
  publicationId: string;
  name: string;
  timezone: string;
  localHouseId?: string;
}

export interface StugbyHomeLocationPayload extends JsonObject {
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

export interface StugbyPlanPoint extends JsonObject { x: number; y: number }
export interface StugbyWallPayload extends JsonObject {
  wallPublicationId: string;
  localWallId?: string;
  from: StugbyPlanPoint;
  to: StugbyPlanPoint;
}
export interface StugbyRoomPayload extends JsonObject {
  roomPublicationId: string;
  localRoomId?: string;
  name: string;
  points: StugbyPlanPoint[];
  kind?: string;
}
export interface StugbyPlanElementPayload extends JsonObject {
  planElementPublicationId: string;
  localPlanElementId?: string;
  kind: string;
  position: StugbyPlanPoint;
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

export interface StugbyRoofPayload extends JsonObject {
  style: string;
  pitchDegrees: number;
  ridgeAxis: string;
  overhang: number;
  eavesHeight: number;
}

export interface StugbyFloorPayload extends JsonObject {
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
  roof?: StugbyRoofPayload;
  walls: StugbyWallPayload[];
  rooms: StugbyRoomPayload[];
  /** Plan elements are stripped of bindings to local integrations. */
  planElements: StugbyPlanElementPayload[];
}

export interface StugbyHomeStructurePayload extends JsonObject {
  publicationId: string;
  floors: StugbyFloorPayload[];
}

export interface StugbyFloorPlanAsset extends JsonObject {
  floorPublicationId: string;
  image: StugbyBlobReference;
}

export interface StugbyHomeFloorPlanPayload extends JsonObject {
  publicationId: string;
  assets: StugbyFloorPlanAsset[];
}

export interface StugbySensorCatalogItem extends JsonObject {
  sensorPublicationId: string;
  localSensorId?: string;
  floorPublicationId: string;
  roomPublicationId?: string;
  name: string;
  x: number;
  y: number;
  z: number;
  metricIds: string[];
}

export interface StugbySensorCatalogPayload extends JsonObject {
  publicationId: string;
  sensors: StugbySensorCatalogItem[];
}

export interface StugbyTelemetrySample extends JsonObject {
  sensorPublicationId: string;
  metricId: string;
  timestamp: string;
  value: number;
  quality: "good" | "estimated" | "stale";
  correctionOf?: string;
}

export interface StugbyTelemetryPayload extends JsonObject {
  publicationId: string;
  chunkId: string;
  from: string;
  to: string;
  complete: boolean;
  samples: StugbyTelemetrySample[];
}

export interface StugbyHomeNote extends JsonObject {
  notePublicationId: string;
  localNoteId?: string;
  kind: "note" | "inspection" | "maintenance";
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface StugbyHomeNotesPayload extends JsonObject {
  publicationId: string;
  notes: StugbyHomeNote[];
}

export interface StugbyHomeObservation extends JsonObject {
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

export interface StugbyHomeObservationsPayload extends JsonObject {
  publicationId: string;
  observations: StugbyHomeObservation[];
}

export interface StugbyPropertyArea extends JsonObject {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  location?: { latitude: number; longitude: number };
  polygon: Array<{ latitude: number; longitude: number }>;
}

export interface StugbyPropertyEquipment extends JsonObject {
  id: string;
  areaId: string;
  name: string;
  kind: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: "active" | "out-of-service" | "retired";
  notes: string | null;
}

export interface StugbyPropertyNote extends JsonObject {
  id: string;
  areaId: string | null;
  equipmentId: string | null;
  kind: "note" | "inspection" | "maintenance";
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface StugbyMaintenanceItem extends JsonObject {
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

/** Coordinator-owned aggregate. It is not inserted into a participant's local Property tables. */
export interface StugbySharedProperty extends JsonObject {
  stugbyId: string;
  name: string;
  description: string | null;
  location: { latitude: number; longitude: number; label?: string } | null;
  areas: StugbyPropertyArea[];
  equipment: StugbyPropertyEquipment[];
  notes: StugbyPropertyNote[];
  maintenance: StugbyMaintenanceItem[];
  revision: number;
  updatedAt: string;
}

export type StugbyDatasetPayload =
  | StugbyHomeDirectoryPayload
  | StugbyHomeLocationPayload
  | StugbyHomeStructurePayload
  | StugbyHomeFloorPlanPayload
  | StugbySensorCatalogPayload
  | StugbyTelemetryPayload
  | StugbyHomeNotesPayload
  | StugbyHomeObservationsPayload;

export interface StugbyWireEvent {
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
  stugbyId: string;
  eventId: string;
  eventKind: StugbyEventKind;
  authorityNodeId: string;
  streamId: string;
  sequence: number;
  schema: StugbyDataset | "stugby.grant.v1" | "stugby.member.v1" | "stugby.shared-property.v1";
  resourceId: string;
  operation: StugbyOperation;
  revision: number;
  grantId: string | null;
  grantEpoch: number | null;
  occurredAt: string;
  payload: JsonValue | null;
  payloadHash: string;
}

export interface StugbySignedEvent extends StugbyWireEvent {
  keyFingerprint: string;
  signature: string;
}

export interface StugbyEventBatch {
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
  events: StugbySignedEvent[];
}

export interface StugbyEventPage {
  protocolVersion: typeof STUGBY_PROTOCOL_VERSION;
  events: StugbySignedEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface StugbyRemoteResource {
  stugbyId: string;
  authorityNodeId: string;
  schema: StugbyDataset;
  resourceId: string;
  publicationId: string;
  revision: number;
  payload: JsonValue;
  receivedAt: string;
  sourceOccurredAt: string;
  stale: boolean;
}

export interface StugbyDeletionReceipt {
  stugbyId: string;
  nodeId: string;
  grantId: string;
  grantEpoch: number;
  deletedAt: string;
}

const DATASET_SET = new Set<string>(STUGBY_DATASETS);
const ROLE_SET = new Set<string>(["steward", "property-manager", "participant", "viewer"]);
const EVENT_KIND_SET = new Set<string>(["dataset.published", "grant.upserted", "grant.revoked", "member.updated", "shared-property.updated"]);
const ENVELOPE_SCHEMA_SET = new Set<string>([...STUGBY_DATASETS, "stugby.grant.v1", "stugby.member.v1", "stugby.shared-property.v1"]);
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
  throw new TypeError(`Invalid Stugby payload: ${message}`);
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

export function isStugbyDataset(value: unknown): value is StugbyDataset {
  return typeof value === "string" && DATASET_SET.has(value);
}

export function isStugbyRole(value: unknown): value is StugbyRole {
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

export function validateShareGrant(value: unknown): StugbyShareGrant {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail("share grant must be an object");
  onlyKeys(value, ["id", "stugbyId", "authorityNodeId", "publicationId", "localHouseId", "audience", "datasets", "epoch", "revision", "expiresAt", "revokedAt", "createdAt", "updatedAt"], "grant");
  requireIdentifier(value, "id");
  requireIdentifier(value, "stugbyId");
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
    if (!isObject(item) || !isStugbyDataset(item.dataset)) fail("invalid dataset grant");
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
  return value as unknown as StugbyShareGrant;
}

export function validateSharedProperty(value: unknown): StugbySharedProperty {
  assertSafeFederationPayload(value);
  if (!isObject(value)) fail("shared property must be an object");
  onlyKeys(value, ["stugbyId", "name", "description", "location", "areas", "equipment", "notes", "maintenance", "revision", "updatedAt"], "shared property");
  requireString(value, "stugbyId");
  requireString(value, "name");
  requireInteger(value, "revision", 1);
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
    onlyKeys(equipment, ["id", "areaId", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes"], "equipment");
    const equipmentId = requireString(equipment, "id");
    const areaId = requireString(equipment, "areaId"); requireString(equipment, "name"); requireString(equipment, "kind");
    if (equipmentIds.has(equipmentId)) fail(`duplicate equipment id ${equipmentId}`);
    if (!areaIds.has(areaId)) fail(`equipment ${equipmentId} references an unknown area`);
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
  return value as unknown as StugbySharedProperty;
}

export function validateDatasetPayload(dataset: StugbyDataset, value: unknown): StugbyDatasetPayload {
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
        onlyKeys(sensor, ["sensorPublicationId", "localSensorId", "floorPublicationId", "roomPublicationId", "name", "x", "y", "z", "metricIds"], "sensor");
        const sensorId = requireIdentifier(sensor, "sensorPublicationId");
        if (sensorIds.has(sensorId)) fail(`duplicate sensor publication id ${sensorId}`);
        sensorIds.add(sensorId);
        requireIdentifier(sensor, "floorPublicationId");
        requireString(sensor, "name");
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
  }
  return value as unknown as StugbyDatasetPayload;
}

export function validateWireEvent(value: unknown): StugbyWireEvent {
  if (!isObject(value)) fail("event must be an object");
  onlyKeys(value, ["protocolVersion", "stugbyId", "eventId", "eventKind", "authorityNodeId", "streamId", "sequence", "schema", "resourceId", "operation", "revision", "grantId", "grantEpoch", "occurredAt", "payload", "payloadHash", "keyFingerprint", "signature"], "event");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > STUGBY_MAX_EVENT_BYTES) fail("event exceeds maximum encoded size");
  if (value.protocolVersion !== STUGBY_PROTOCOL_VERSION) fail("unsupported protocol version");
  requireIdentifier(value, "stugbyId");
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
  if (isStugbyDataset(value.schema)) {
    if (value.eventKind !== "dataset.published") fail("dataset schema requires dataset.published event kind");
    requireIdentifier(value, "grantId");
    requireInteger(value, "grantEpoch", 1);
    if (value.operation === "upsert") validateDatasetPayload(value.schema, value.payload);
  } else if (value.schema === "stugby.grant.v1") {
    if (value.eventKind !== (value.operation === "tombstone" ? "grant.revoked" : "grant.upserted")) fail("grant event kind does not match operation");
    requireIdentifier(value, "grantId");
    requireInteger(value, "grantEpoch", 1);
    if (value.operation === "upsert") {
      const grant = validateShareGrant(value.payload);
      if (grant.localHouseId !== undefined) fail("wire grants must not expose a local house id");
    }
  } else if (value.schema === "stugby.member.v1") {
    if (value.eventKind !== "member.updated" || value.operation !== "upsert" || !isObject(value.payload)) fail("invalid member event");
    if (value.grantId !== null || value.grantEpoch !== null) fail("member events cannot reference a grant");
    onlyKeys(value.payload, ["stugbyId", "nodeId", "displayName", "role", "state", "publicKey", "keyFingerprint", "joinedAt", "updatedAt"], "member");
    requireString(value.payload, "stugbyId");
    requireString(value.payload, "nodeId");
    requireString(value.payload, "displayName");
    if (!isStugbyRole(value.payload.role)) fail("invalid member role");
    if (!["invited", "active", "suspended", "left", "revoked"].includes(String(value.payload.state))) fail("invalid member state");
    requireString(value.payload, "publicKey");
    requireString(value.payload, "keyFingerprint");
    requireIsoDate(value.payload.joinedAt, "member.joinedAt", true);
    requireIsoDate(value.payload.updatedAt, "member.updatedAt");
  } else if (value.schema === "stugby.shared-property.v1") {
    if (value.eventKind !== "shared-property.updated" || value.operation !== "upsert") fail("invalid shared-property event");
    if (value.grantId !== null || value.grantEpoch !== null) fail("shared-property events cannot reference a grant");
    validateSharedProperty(value.payload);
  }
  return value as unknown as StugbyWireEvent;
}

export function validateSignedEvent(value: unknown): StugbySignedEvent {
  const event = validateWireEvent(value);
  if (!isObject(value)) fail("signed event must be an object");
  requireString(value, "keyFingerprint");
  if (!/^[a-f0-9]{64}$/.test(String(value.keyFingerprint))) fail("keyFingerprint must be lowercase SHA-256");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(requireString(value, "signature"))) fail("signature must be base64");
  return event as StugbySignedEvent;
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

export function eventSigningValue(event: StugbyWireEvent): string {
  const envelope: JsonObject = {
    protocolVersion: event.protocolVersion,
    stugbyId: event.stugbyId,
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
