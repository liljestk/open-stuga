import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  AreaEquipment,
  Floor,
  House,
  MaintenanceTask,
  MeasurementSample,
  Property,
  PropertyArea,
  PropertyAreaKind,
  PropertyNote,
  Sensor,
  StugubyHouseLink,
  StugubyPropertyLink,
} from "@climate-twin/contracts";
import {
  STUGBY_MAX_BATCH_EVENTS,
  STUGBY_MAX_BLOB_BYTES,
  STUGBY_MAX_CLOCK_SKEW_SECONDS,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  STUGBY_MEDIA_TYPE,
  STUGBY_PROTOCOL_VERSION,
  assertSafeFederationPayload,
  canonicalJson,
  eventSigningValue,
  isStugubyDataset,
  isStugubyRole,
  requestSigningValue,
  validateDatasetPayload,
  validateHomeCommand,
  validateHomeCommandResult,
  validatePropertyCommand,
  validatePropertyCommandResult,
  validateShareGrant,
  validateSharedProperty,
  validateSignedEvent,
  type JsonObject,
  type JsonValue,
  type StugubyDataset,
  type StugubyDatasetGrant,
  type StugubyDeletionReceipt,
  type StugubyBlobMediaType,
  type StugubyBlobReference,
  type StugubyEventBatch,
  type StugubyEventPage,
  type StugubyGrantAudience,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyHomeCommandSnapshot,
  type StugubyHomeDirectoryPayload,
  type StugubyHomeFloorPlanPayload,
  type StugubyHomeLocationPayload,
  type StugubyHomeNotesPayload,
  type StugubyHomeObservationsPayload,
  type StugubyHomeRecoveryKind,
  type StugubyHomeRecoveryPayload,
  type StugubyHomeStructurePayload,
  type StugubyInvitation,
  type StugubyJoinRequest,
  type StugubyJoinResponse,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRole,
  type StugubySensorCatalogPayload,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
  type StugubyWireEvent,
} from "@climate-twin/stuguby-protocol";
import type { ClimateDatabase } from "../../../db.js";
import type { TelemetryBus } from "../../../events.js";
import type { StugubyNodeKeys } from "../../identity.js";
import { publicKeyFingerprint } from "../../identity.js";
import { durableAtomicWriteFileSync } from "../../durable-write.js";
import {
  StugubyStore,
  type StugubyAuthorityTransfer,
  type StugubyHomeProjection,
  type StugubyLocalInvitation,
  type StugubyLocalMember,
  type StugubyOutboxItem,
  type StugubyPropertyAdoption,
} from "../../store.js";

export class StugubyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "StugubyError";
  }
}

export interface StugubyServiceOptions {
  database: ClimateDatabase;
  store: StugubyStore;
  keys: StugubyNodeKeys;
  bus: TelemetryBus;
  assetDirectory: string;
  fetcher?: typeof fetch;
  syncIntervalMs?: number;
  publicOrigin?: string | null;
  suggestedPublicOrigin?: string | null;
  allowUiPublicOrigin?: boolean;
  localTelemetryHistoryComplete?: (from?: string) => boolean;
}

export interface MachineRequestProof {
  method: string;
  path: string;
  body: Uint8Array;
  nodeId: string | undefined;
  timestamp: string | undefined;
  requestId: string | undefined;
  signature: string | undefined;
}

export interface Notification {
  stugubyId: string;
  targetNodeId: string;
  cursor: number;
}

export type SharedPropertyInput = Pick<StugubySharedProperty,
  "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance"
> & Partial<Pick<StugubySharedProperty, "editPolicy" | "designatedSuccessorNodeId">>;

export const DATASET_SCHEMAS = new Set<string>([
  "home.directory.v1", "home.location.v1", "home.structure.v1", "home.floorplan.v1",
  "home.sensor-catalog.v1", "home.telemetry.v1", "home.notes.v1", "home.observations.v1",
  "home.recovery.v1",
]);

export const STUGBY_MAX_STAGED_BLOB_BYTES = 256 * 1024 * 1024;

export const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export const PROPERTY_AREA_KINDS = new Set<PropertyAreaKind>([
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road",
  "yard", "building", "other",
]);

export function recommendedHomeOverviewDatasets(): StugubyDatasetGrant[] {
  return [
    "home.directory.v1",
    "home.structure.v1",
    "home.sensor-catalog.v1",
  ].map((dataset) => ({
    dataset: dataset as StugubyDataset,
    enabled: true,
    includeLocalIds: false,
    allowReplicaCache: true,
    retentionDays: 30,
  }));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

export function recoveryAssetReferences(payload: StugubyHomeRecoveryPayload): StugubyBlobReference[] {
  if (payload.kind !== "assets") return [];
  return payload.records.map((record) => ({
    digest: String(record.digest),
    byteLength: Number(record.byteLength),
    mediaType: String(record.mimeType) as StugubyBlobMediaType,
  }));
}

export function eventBlobReferences(event: StugubySignedEvent): StugubyBlobReference[] {
  if (event.operation !== "upsert") return [];
  if (event.schema === "home.floorplan.v1") {
    return (event.payload as unknown as StugubyHomeFloorPlanPayload).assets.map((asset) => asset.image);
  }
  if (event.schema === "home.recovery.v1") {
    return recoveryAssetReferences(event.payload as unknown as StugubyHomeRecoveryPayload);
  }
  return [];
}

export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

export function normalizedBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new StugubyError(400, "INVALID_COORDINATOR_URL", "Coordinator URL must be an absolute URL"); }
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new StugubyError(400, "HTTPS_REQUIRED", "Stuguby federation requires HTTPS (HTTP is allowed only on loopback for development)");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new StugubyError(400, "INVALID_COORDINATOR_URL", "Coordinator URL must be an origin without credentials, a path, query parameters, or a fragment");
  }
  return url.origin;
}

export function parseIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!ISO_DATE_TIME.test(value) || !Number.isFinite(time)) throw new StugubyError(400, "INVALID_TIMESTAMP", `${label} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

export function requiredText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new StugubyError(400, "INVALID_INPUT", `${label} must contain 1 to ${maximum} characters`);
  }
  return value.trim();
}

export function localLabel(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  return requiredText(value, "Private member label");
}

export function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StugubyError(400, "INVALID_INPUT", `${label} must be an object`);
  return value as Record<string, unknown>;
}

export function validatedNodeIdentity(value: unknown): StugubyNodeIdentity {
  const identity = recordValue(value, "Node identity");
  const nodeId = requiredText(identity.nodeId, "Node id", 100);
  if (!UUID.test(nodeId)) {
    throw new StugubyError(400, "INVALID_NODE_ID", "Node id must be a UUID");
  }
  const publicKey = requiredText(identity.publicKey, "Node public key", 512);
  const keyFingerprint = requiredText(identity.keyFingerprint, "Node key fingerprint", 64);
  if (!/^[a-f0-9]{64}$/.test(keyFingerprint) || publicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw new StugubyError(400, "INVALID_NODE_KEY", "Node key fingerprint does not match");
  }
  if (identity.protocolVersion !== STUGBY_PROTOCOL_VERSION) throw new StugubyError(400, "INVALID_JOIN", "Unsupported Stuguby protocol version");
  return {
    nodeId,
    displayName: requiredText(identity.displayName, "Node display name"),
    publicKey,
    keyFingerprint,
    protocolVersion: STUGBY_PROTOCOL_VERSION,
  };
}

export function validatedMember(value: unknown, stugubyId: string): StugubyMember {
  const member = recordValue(value, "Stuguby member");
  const identity = validatedNodeIdentity({
    nodeId: member.nodeId,
    displayName: member.displayName,
    publicKey: member.publicKey,
    keyFingerprint: member.keyFingerprint,
    protocolVersion: STUGBY_PROTOCOL_VERSION,
  });
  if (member.stugubyId !== stugubyId || !isStugubyRole(member.role)
    || !["invited", "active", "suspended", "left", "revoked"].includes(String(member.state))) {
    throw new StugubyError(400, "INVALID_MEMBER", "Stuguby member identity, role, or state is invalid");
  }
  const joinedAt = member.joinedAt === null ? null : parseIso(requiredText(member.joinedAt, "joinedAt", 100), "joinedAt");
  return {
    stugubyId,
    nodeId: identity.nodeId,
    displayName: identity.displayName,
    publicKey: identity.publicKey,
    keyFingerprint: identity.keyFingerprint,
    role: member.role as StugubyRole,
    state: member.state as StugubyMemberState,
    joinedAt,
    updatedAt: parseIso(requiredText(member.updatedAt, "updatedAt", 100), "updatedAt"),
  };
}

export function grantAudienceIncludes(grant: StugubyShareGrant, nodeId: string): boolean {
  return grant.audience.kind === "all-members" || grant.audience.nodeIds.includes(nodeId);
}

export function enabledDataset(grant: StugubyShareGrant, dataset: StugubyDataset): StugubyDatasetGrant | null {
  return grant.datasets.find((item) => item.dataset === dataset && item.enabled) ?? null;
}

export function grantExpired(grant: Pick<StugubyShareGrant, "expiresAt">, now = Date.now()): boolean {
  return Boolean(grant.expiresAt && Date.parse(grant.expiresAt) <= now);
}

export function validateGrantTransition(existing: StugubyShareGrant | null, next: StugubyShareGrant, status: number): void {
  if (!existing) return;
  if (existing.stugubyId !== next.stugubyId || existing.authorityNodeId !== next.authorityNodeId
    || existing.publicationId !== next.publicationId) {
    throw new StugubyError(status, "GRANT_IDENTITY_CHANGED", "A grant cannot change its Stuguby, authority, or Home publication");
  }
  if (next.epoch === existing.epoch && next.revision === existing.revision) {
    if (canonicalJson(asJson(withoutLocalGrantIdentity(next))) !== canonicalJson(asJson(withoutLocalGrantIdentity(existing)))) {
      throw new StugubyError(status, "GRANT_VERSION_CONFLICT", "The same grant version contains different policy data");
    }
    return;
  }
  if (next.epoch <= existing.epoch || next.revision <= existing.revision) {
    throw new StugubyError(status, "STALE_GRANT_VERSION", "Grant epoch and revision must increase monotonically");
  }
}

export function joinSigningValue(request: Pick<StugubyJoinRequest, "invitationId" | "joinSecret" | "identity">): string {
  return `${request.invitationId}\n${sha256(request.joinSecret)}\n${canonicalJson(asJson(request.identity))}`;
}

export function withoutLocalGrantIdentity(grant: StugubyShareGrant): StugubyShareGrant {
  const wireGrant = { ...grant };
  delete wireGrant.localHouseId;
  return wireGrant;
}
