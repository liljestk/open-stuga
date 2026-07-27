import { STUGBY_DATASETS } from "./protocol-contracts.js";
import type { JsonValue, StugubyDataset, StugubyDatasetGrant, StugubyHomeCommand, StugubyHomeCommandResult, StugubyPropertyCommand, StugubyPropertyCommandResult, StugubyRole, StugubyShareGrant, StugubySharedProperty } from "./protocol-contracts.js";

import { validateDatasetPayload } from "./wire-validation.js";

export const DATASET_SET = new Set<string>(STUGBY_DATASETS);

export const ROLE_SET = new Set<string>(["steward", "property-manager", "participant", "viewer"]);

export const EVENT_KIND_SET = new Set<string>(["dataset.published", "grant.upserted", "grant.revoked", "member.updated", "shared-property.updated"]);

export const ENVELOPE_SCHEMA_SET = new Set<string>([...STUGBY_DATASETS, "stuguby.grant.v2", "stuguby.member.v2", "stuguby.shared-property.v2"]);

export const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export /**
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

export const FORBIDDEN_KEY_FRAGMENTS = [
  "credential", "password", "secret", "token", "privatekey", "session", "cookie",
  "accountidentity", "integration", "endpoint", "connectionid", "entityid", "externalid",
  "statebinding", "devicecommand", "remotecontrol", "actuation", "automation", "callback", "webhook",
] as const;

export function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function fail(message: string): never {
  throw new TypeError(`Invalid Stuguby payload: ${message}`);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} must be a non-empty string`);
  return value as string;
}

export function requireIdentifier(object: Record<string, unknown>, key: string, maximum = 500): string {
  const value = requireString(object, key);
  if (value.length > maximum) fail(`${key} exceeds ${maximum} characters`);
  return value;
}

export function requireFiniteNumber(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${key} must be a finite number`);
  return value as number;
}

export function requireInteger(object: Record<string, unknown>, key: string, minimum = 0): number {
  const value = requireFiniteNumber(object, key);
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${key} must be a safe integer >= ${minimum}`);
  return value;
}

export function requireBoolean(object: Record<string, unknown>, key: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") fail(`${key} must be boolean`);
  return value;
}

export function requireNullableFiniteNumber(object: Record<string, unknown>, key: string): number | null {
  if (object[key] === null) return null;
  return requireFiniteNumber(object, key);
}

export function requireEnumString(
  object: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string {
  const value = requireString(object, key);
  if (!allowed.includes(value)) fail(`${key} has an unsupported value`);
  return value;
}

export function requireIsoDate(value: unknown, name: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO date-time${nullable ? " or null" : ""}`);
  return value as string;
}

export function requireStringArray(value: unknown, name: string, maximum = 10_000): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 500)) {
    fail(`${name} must be an array of at most ${maximum} non-empty strings of at most 500 characters`);
  }
  if (new Set(value).size !== value.length) fail(`${name} must not contain duplicates`);
  return value as string[];
}

export function requireArray(value: unknown, name: string, maximum = 100_000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${name} must be an array of at most ${maximum} items`);
  return value;
}

export function requireNullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail(`${name} must be a string or null`);
  return value as string;
}

export function optionalString(object: Record<string, unknown>, key: string): void {
  if (object[key] !== undefined && typeof object[key] !== "string") fail(`${key} must be a string when supplied`);
}

export function onlyKeys(object: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(object).find((key) => !allowedSet.has(key));
  if (unknown) fail(`${name}.${unknown} is not part of the protocol schema`);
}

export function point(value: unknown, name: string): void {
  if (!isObject(value)) fail(`${name} must be a point object`);
  onlyKeys(value, ["x", "y"], name);
  requireFiniteNumber(value, "x");
  requireFiniteNumber(value, "y");
}

export function coordinate(value: unknown, name: string): void {
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
