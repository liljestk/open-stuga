import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Floor, House, MeasurementSample, Sensor } from "@climate-twin/contracts";
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
  isStugbyDataset,
  isStugbyRole,
  requestSigningValue,
  validateDatasetPayload,
  validateShareGrant,
  validateSharedProperty,
  validateSignedEvent,
  type JsonObject,
  type JsonValue,
  type StugbyDataset,
  type StugbyDatasetGrant,
  type StugbyDeletionReceipt,
  type StugbyEventBatch,
  type StugbyEventPage,
  type StugbyGrantAudience,
  type StugbyHomeDirectoryPayload,
  type StugbyHomeFloorPlanPayload,
  type StugbyHomeLocationPayload,
  type StugbyHomeNotesPayload,
  type StugbyHomeObservationsPayload,
  type StugbyHomeStructurePayload,
  type StugbyInvitation,
  type StugbyJoinRequest,
  type StugbyJoinResponse,
  type StugbyMember,
  type StugbyMemberState,
  type StugbyNodeIdentity,
  type StugbyRole,
  type StugbySensorCatalogPayload,
  type StugbyShareGrant,
  type StugbySharedProperty,
  type StugbySignedEvent,
  type StugbySummary,
  type StugbyTelemetryPayload,
  type StugbyWireEvent,
} from "@climate-twin/stugby-protocol";
import type { ClimateDatabase } from "../db.js";
import type { TelemetryBus } from "../events.js";
import type { StugbyNodeKeys } from "./identity.js";
import { publicKeyFingerprint } from "./identity.js";
import { durableAtomicWriteFileSync } from "./durable-write.js";
import { StugbyStore, type StugbyOutboxItem } from "./store.js";

export class StugbyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "StugbyError";
  }
}

export interface StugbyServiceOptions {
  database: ClimateDatabase;
  store: StugbyStore;
  keys: StugbyNodeKeys;
  bus: TelemetryBus;
  assetDirectory: string;
  fetcher?: typeof fetch;
  syncIntervalMs?: number;
  publicOrigin?: string | null;
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

interface Notification {
  stugbyId: string;
  targetNodeId: string;
  cursor: number;
}

type SharedPropertyInput = Pick<StugbySharedProperty,
  "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance"
>;

const DATASET_SCHEMAS = new Set<string>([
  "home.directory.v1", "home.location.v1", "home.structure.v1", "home.floorplan.v1",
  "home.sensor-catalog.v1", "home.telemetry.v1", "home.notes.v1", "home.observations.v1",
]);
const STUGBY_MAX_STAGED_BLOB_BYTES = 256 * 1024 * 1024;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new StugbyError(400, "INVALID_COORDINATOR_URL", "Coordinator URL must be an absolute URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new StugbyError(400, "HTTPS_REQUIRED", "Stugby federation requires HTTPS (HTTP is allowed only on loopback for development)");
  }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new StugbyError(400, "INVALID_COORDINATOR_URL", "Coordinator URL must be an origin without credentials, a path, query parameters, or a fragment");
  }
  return url.origin;
}

function parseIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!ISO_DATE_TIME.test(value) || !Number.isFinite(time)) throw new StugbyError(400, "INVALID_TIMESTAMP", `${label} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

function requiredText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new StugbyError(400, "INVALID_INPUT", `${label} must contain 1 to ${maximum} characters`);
  }
  return value.trim();
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StugbyError(400, "INVALID_INPUT", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function validatedNodeIdentity(value: unknown): StugbyNodeIdentity {
  const identity = recordValue(value, "Node identity");
  const nodeId = requiredText(identity.nodeId, "Node id", 100);
  if (!UUID.test(nodeId)) {
    throw new StugbyError(400, "INVALID_NODE_ID", "Node id must be a UUID");
  }
  const publicKey = requiredText(identity.publicKey, "Node public key", 512);
  const keyFingerprint = requiredText(identity.keyFingerprint, "Node key fingerprint", 64);
  if (!/^[a-f0-9]{64}$/.test(keyFingerprint) || publicKeyFingerprint(publicKey) !== keyFingerprint) {
    throw new StugbyError(400, "INVALID_NODE_KEY", "Node key fingerprint does not match");
  }
  if (identity.protocolVersion !== STUGBY_PROTOCOL_VERSION) throw new StugbyError(400, "INVALID_JOIN", "Unsupported Stugby protocol version");
  return {
    nodeId,
    displayName: requiredText(identity.displayName, "Node display name"),
    publicKey,
    keyFingerprint,
    protocolVersion: STUGBY_PROTOCOL_VERSION,
  };
}

function validatedMember(value: unknown, stugbyId: string): StugbyMember {
  const member = recordValue(value, "Stugby member");
  const identity = validatedNodeIdentity({
    nodeId: member.nodeId,
    displayName: member.displayName,
    publicKey: member.publicKey,
    keyFingerprint: member.keyFingerprint,
    protocolVersion: STUGBY_PROTOCOL_VERSION,
  });
  if (member.stugbyId !== stugbyId || !isStugbyRole(member.role)
    || !["invited", "active", "suspended", "left", "revoked"].includes(String(member.state))) {
    throw new StugbyError(400, "INVALID_MEMBER", "Stugby member identity, role, or state is invalid");
  }
  const joinedAt = member.joinedAt === null ? null : parseIso(requiredText(member.joinedAt, "joinedAt", 100), "joinedAt");
  return {
    stugbyId,
    nodeId: identity.nodeId,
    displayName: identity.displayName,
    publicKey: identity.publicKey,
    keyFingerprint: identity.keyFingerprint,
    role: member.role as StugbyRole,
    state: member.state as StugbyMemberState,
    joinedAt,
    updatedAt: parseIso(requiredText(member.updatedAt, "updatedAt", 100), "updatedAt"),
  };
}

function grantAudienceIncludes(grant: StugbyShareGrant, nodeId: string): boolean {
  return grant.audience.kind === "all-members" || grant.audience.nodeIds.includes(nodeId);
}

function enabledDataset(grant: StugbyShareGrant, dataset: StugbyDataset): StugbyDatasetGrant | null {
  return grant.datasets.find((item) => item.dataset === dataset && item.enabled) ?? null;
}

function grantExpired(grant: Pick<StugbyShareGrant, "expiresAt">, now = Date.now()): boolean {
  return Boolean(grant.expiresAt && Date.parse(grant.expiresAt) <= now);
}

function validateGrantTransition(existing: StugbyShareGrant | null, next: StugbyShareGrant, status: number): void {
  if (!existing) return;
  if (existing.stugbyId !== next.stugbyId || existing.authorityNodeId !== next.authorityNodeId
    || existing.publicationId !== next.publicationId) {
    throw new StugbyError(status, "GRANT_IDENTITY_CHANGED", "A grant cannot change its Stugby, authority, or Home publication");
  }
  if (next.epoch === existing.epoch && next.revision === existing.revision) {
    if (canonicalJson(asJson(withoutLocalGrantIdentity(next))) !== canonicalJson(asJson(withoutLocalGrantIdentity(existing)))) {
      throw new StugbyError(status, "GRANT_VERSION_CONFLICT", "The same grant version contains different policy data");
    }
    return;
  }
  if (next.epoch <= existing.epoch || next.revision <= existing.revision) {
    throw new StugbyError(status, "STALE_GRANT_VERSION", "Grant epoch and revision must increase monotonically");
  }
}

function joinSigningValue(request: Pick<StugbyJoinRequest, "invitationId" | "joinSecret" | "identity">): string {
  return `${request.invitationId}\n${sha256(request.joinSecret)}\n${canonicalJson(asJson(request.identity))}`;
}

function withoutLocalGrantIdentity(grant: StugbyShareGrant): StugbyShareGrant {
  const wireGrant = { ...grant };
  delete wireGrant.localHouseId;
  return wireGrant;
}

export class StugbyService {
  readonly database: ClimateDatabase;
  readonly store: StugbyStore;
  readonly keys: StugbyNodeKeys;
  readonly publicOrigin: string | null;
  readonly #bus: TelemetryBus;
  readonly #assetDirectory: string;
  readonly #fetcher: typeof fetch;
  readonly #notifications = new EventEmitter();
  readonly #syncIntervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #syncing: Promise<void> | null = null;
  #lifecycleController = new AbortController();
  readonly #activeSyncs = new Set<Promise<unknown>>();
  #removeMeasurementListener: (() => void) | null = null;
  #streamControllers = new Map<string, AbortController>();
  #streamTasks = new Map<string, Promise<void>>();
  #incomingNotificationStreams = new Map<string, () => void>();
  #deferredNotifications: Notification[] | null = null;
  #started = false;

  constructor(options: StugbyServiceOptions) {
    this.database = options.database;
    this.store = options.store;
    this.keys = options.keys;
    this.#bus = options.bus;
    this.#assetDirectory = join(options.assetDirectory, "stugby");
    this.#fetcher = options.fetcher ?? fetch;
    this.#syncIntervalMs = Math.max(2_000, options.syncIntervalMs ?? 15_000);
    this.publicOrigin = options.publicOrigin ? normalizedBaseUrl(options.publicOrigin) : null;
  }

  get identity(): StugbyNodeIdentity {
    return this.keys.identity;
  }

  start(): void {
    if (this.#lifecycleController.signal.aborted) this.#lifecycleController = new AbortController();
    this.#started = true;
    if (!this.#removeMeasurementListener) {
      this.#removeMeasurementListener = this.#bus.subscribeMeasurements((sample) => this.publishLiveTelemetry(sample));
    }
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.syncAll().catch(() => undefined); }, this.#syncIntervalMs);
      this.#timer.unref();
    }
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    this.ensureNotificationStreams();
    void this.syncAll().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#removeMeasurementListener?.();
    this.#removeMeasurementListener = null;
    this.#lifecycleController.abort(new Error("Stugby service is stopping"));
    for (const controller of this.#streamControllers.values()) controller.abort();
    this.#streamControllers.clear();
    for (const close of this.#incomingNotificationStreams.values()) close();
    this.#incomingNotificationStreams.clear();
    await Promise.allSettled([...this.#streamTasks.values()]);
    await Promise.allSettled([...this.#activeSyncs]);
  }

  private trackSync<T>(operation: Promise<T>): Promise<T> {
    this.#activeSyncs.add(operation);
    void operation.then(
      () => { this.#activeSyncs.delete(operation); },
      () => { this.#activeSyncs.delete(operation); },
    );
    return operation;
  }

  listStugbys(): StugbySummary[] { return this.store.listStugbys(); }
  getStugby(id: string): StugbySummary { return this.requireStugby(id); }

  createStugby(input: { name: string; description?: string | null; coordinatorUrl: string }): StugbySummary {
    const summary = this.store.createCoordinatedStugby({
      name: requiredText(input.name, "Name"),
      description: typeof input.description === "string" ? input.description.trim().slice(0, 2_000) || null : null,
      coordinatorUrl: normalizedBaseUrl(input.coordinatorUrl),
    }, this.identity);
    return summary;
  }

  createInvitation(stugbyId: string, input: { role: Exclude<StugbyRole, "steward">; expiresAt?: string }): StugbyInvitation & { joinSecret: string; joinUrl: string } {
    const stugby = this.requireCoordinator(stugbyId);
    if (!["property-manager", "participant", "viewer"].includes(input.role)) {
      throw new StugbyError(400, "INVALID_ROLE", "Invitation role must be property-manager, participant, or viewer");
    }
    const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : new Date(Date.now() + 7 * 86_400_000).toISOString();
    if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 30 * 86_400_000) {
      throw new StugbyError(400, "INVALID_EXPIRY", "Invitation expiry must be within the next 30 days");
    }
    const joinSecret = randomBytes(32).toString("base64url");
    const invitation = this.store.createInvitation({
      stugbyId,
      role: input.role,
      secretHash: sha256(joinSecret),
      expiresAt,
      coordinatorUrl: stugby.coordinatorUrl,
    });
    const joinUrl = `${stugby.coordinatorUrl}/invite-bootstrap#${encodeURIComponent(invitation.id)}.${joinSecret}`;
    return { ...invitation, joinSecret, joinUrl };
  }

  revokeInvitation(stugbyId: string, invitationId: string): void {
    this.requireCoordinator(stugbyId);
    const invitation = this.store.listInvitations(stugbyId).find((candidate) => candidate.id === invitationId);
    if (!invitation) throw new StugbyError(404, "INVITATION_NOT_FOUND", "Stugby invitation was not found");
    if (invitation.usedAt || invitation.revokedAt) throw new StugbyError(409, "INVITATION_INACTIVE", "Only an unused active invitation can be revoked");
    this.store.revokeInvitation(stugbyId, invitationId);
  }

  assertGrantScope(stugbyId: string, grantId: string): void {
    const grant = this.store.getGrant(grantId);
    if (!grant || grant.stugbyId !== stugbyId) throw new StugbyError(404, "GRANT_NOT_FOUND", "Share grant was not found in this Stugby");
  }

  async joinStugby(input: { coordinatorUrl: string; invitationId: string; joinSecret: string }): Promise<StugbySummary> {
    const coordinatorUrl = normalizedBaseUrl(input.coordinatorUrl);
    const unsigned: Omit<StugbyJoinRequest, "signature"> = {
      invitationId: requiredText(input.invitationId, "Invitation id", 200),
      joinSecret: requiredText(input.joinSecret, "Join secret", 500),
      identity: this.identity,
    };
    const request: StugbyJoinRequest = { ...unsigned, signature: this.keys.sign(joinSigningValue(unsigned)) };
    const response = await this.#fetcher(`${coordinatorUrl}/api/v1/stugby-protocol/join`, {
      method: "POST",
      headers: { "content-type": STUGBY_MEDIA_TYPE, "accept": STUGBY_MEDIA_TYPE },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.any([this.#lifecycleController.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw await this.remoteError(response, "Stugby join failed");
    let joined: StugbyJoinResponse;
    try {
      const raw = recordValue(await this.readJsonResponse(response, 2 * 1024 * 1024, "Join response"), "Join response");
      const rawSummary = recordValue(raw.stugby, "Joined Stugby");
      const stugbyId = requiredText(rawSummary.id, "Stugby id", 100);
      const coordinatorIdentity = validatedNodeIdentity(raw.coordinatorIdentity);
      const rawMembers = Array.isArray(raw.members) ? raw.members : [];
      if (!rawMembers.length || rawMembers.length > 1_000) throw new Error("Invalid member list");
      const members = rawMembers.map((member) => validatedMember(member, stugbyId));
      if (new Set(members.map((member) => member.nodeId)).size !== members.length) throw new Error("Duplicate member identity");
      const coordinatorNodeId = requiredText(rawSummary.coordinatorNodeId, "Coordinator node id", 100);
      const coordinatorMember = members.find((member) => member.nodeId === coordinatorNodeId);
      if (coordinatorIdentity.nodeId !== coordinatorNodeId || !coordinatorMember
        || coordinatorMember.role !== "steward" || coordinatorMember.state !== "active"
        || coordinatorMember.publicKey !== coordinatorIdentity.publicKey) throw new Error("Invalid coordinator identity");
      const local = members.find((member) => member.nodeId === this.identity.nodeId);
      if (!local || local.state !== "active" || local.publicKey !== this.identity.publicKey) throw new Error("Local membership missing");
      const createdAt = parseIso(requiredText(rawSummary.createdAt, "createdAt", 100), "createdAt");
      const updatedAt = parseIso(requiredText(rawSummary.updatedAt, "updatedAt", 100), "updatedAt");
      joined = {
        stugby: {
          id: stugbyId,
          name: requiredText(rawSummary.name, "Stugby name"),
          description: rawSummary.description === null ? null : requiredText(rawSummary.description, "Stugby description", 2_000),
          coordinatorNodeId,
          coordinatorUrl,
          localRole: local.role,
          localMemberState: local.state,
          memberCount: members.filter((member) => member.state === "active").length,
          createdAt,
          updatedAt,
          lastSyncAt: null,
          lastSyncError: null,
        },
        member: local,
        members,
        coordinatorIdentity,
        cursor: 0,
      };
    } catch (error) {
      throw new StugbyError(502, "INVALID_JOIN_RESPONSE", error instanceof Error ? `Coordinator returned an invalid join response: ${error.message}` : "Coordinator returned an invalid join response");
    }
    const existingStugby = this.store.getStugby(joined.stugby.id);
    if (existingStugby) {
      const existingMember = this.store.getMember(joined.stugby.id, this.identity.nodeId);
      if (existingStugby.coordinatorUrl === coordinatorUrl
        && existingStugby.coordinatorNodeId === joined.stugby.coordinatorNodeId
        && existingMember?.publicKey === this.identity.publicKey
        && existingMember?.state === "active") {
        return existingStugby;
      }
      throw new StugbyError(409, "STUGBY_ALREADY_EXISTS", "This Stuga has already joined a different Stugby record with that id");
    }
    const local = joined.member;
    const saved = this.store.saveJoinedStugby(joined.stugby, joined.members, local);
    if (this.#started) this.ensureNotificationStreams();
    return saved;
  }

  acceptJoin(request: StugbyJoinRequest): StugbyJoinResponse {
    const raw = recordValue(request, "Join request");
    const normalized: StugbyJoinRequest = {
      invitationId: requiredText(raw.invitationId, "Invitation id", 200),
      joinSecret: requiredText(raw.joinSecret, "Join secret", 500),
      identity: validatedNodeIdentity(raw.identity),
      signature: requiredText(raw.signature, "Join signature", 512),
    };
    if (!this.keys.verify(joinSigningValue(normalized), normalized.signature, normalized.identity.publicKey)) {
      throw new StugbyError(401, "INVALID_JOIN_PROOF", "Join request proof is invalid");
    }
    const secretHash = sha256(normalized.joinSecret);
    const admission = this.store.admitInvitation(normalized.invitationId, secretHash, normalized.identity);
    if (admission.status === "invalid") {
      throw new StugbyError(401, "INVALID_INVITATION", "Invitation is invalid, expired, revoked, used by another node, or otherwise inactive");
    }
    if (admission.status === "node-conflict") {
      throw new StugbyError(409, "NODE_ALREADY_MEMBER", "That node identity is already registered in this Stugby");
    }
    const stugby = this.requireCoordinator(admission.invitation.stugbyId);
    const member = admission.member;
    if (!admission.provisioned) {
      this.publishMember(member);
      for (const existing of this.store.listMembers(stugby.id)) this.sendMemberSnapshot(existing, member.nodeId);
      const property = this.store.getSharedProperty(stugby.id);
      if (property) this.sendSharedPropertySnapshot(property, member.nodeId);
      for (const grant of this.store.listGrants(stugby.id, this.identity.nodeId)) {
        if (grant.audience.kind !== "all-members" || grant.revokedAt || grantExpired(grant)) continue;
        const house = this.database.getHouse(grant.localHouseId ?? "");
        if (house) {
          this.publishGrant(grant, "grant.upserted");
          this.publishGrantSnapshots(grant, house);
        }
      }
      this.store.markInvitationProvisioned(admission.invitation.id, member.nodeId);
    }
    const participantSummary: StugbySummary = {
      ...this.store.getStugby(stugby.id)!,
      localRole: member.role,
      localMemberState: member.state,
    };
    return {
      stugby: participantSummary,
      member,
      members: this.store.listMembers(stugby.id),
      coordinatorIdentity: this.identity,
      cursor: 0,
    };
  }

  updateMember(stugbyId: string, nodeId: string, role: StugbyRole, state: StugbyMemberState): StugbyMember {
    const stugby = this.requireCoordinator(stugbyId);
    if (!(["steward", "property-manager", "participant", "viewer"] as string[]).includes(role)
      || !(["active", "suspended", "left", "revoked"] as string[]).includes(state)) {
      throw new StugbyError(400, "INVALID_MEMBERSHIP", "Invalid Stugby role or membership state");
    }
    const existingMember = this.store.getMember(stugbyId, nodeId);
    if (!existingMember) throw new StugbyError(404, "MEMBER_NOT_FOUND", "Stugby member was not found");
    if (role === "steward" && nodeId !== stugby.coordinatorNodeId) throw new StugbyError(400, "INVALID_STEWARD", "Only the coordinator node can hold the steward role");
    if (nodeId === stugby.coordinatorNodeId && (role !== "steward" || state !== "active")) {
      throw new StugbyError(409, "COORDINATOR_REQUIRED", "The coordinator steward cannot be demoted or deactivated");
    }
    // Expiry stops new reads immediately, but an unretired expired grant still
    // needs its tombstone/deletion handshake before either endpoint can leave.
    const activeGrants = this.store.listGrants(stugbyId).filter((grant) => !grant.revokedAt
        && (grant.authorityNodeId === nodeId || grantAudienceIncludes(grant, nodeId)));
    if (state !== "active") {
      if (activeGrants.length > 0) {
        throw new StugbyError(409, "MEMBER_DATA_STILL_SHARED", "Revoke or narrow every grant involving this node before deactivating its membership");
      }
      if (this.store.pendingDeletions(stugbyId, nodeId) > 0) {
        throw new StugbyError(409, "DELETION_ACK_PENDING", "Wait for this node to synchronize and acknowledge deletion before deactivating it");
      }
    }
    if (role === "viewer" && activeGrants.some((grant) => grant.authorityNodeId === nodeId)) {
      throw new StugbyError(409, "PUBLISHER_GRANT_ACTIVE", "Revoke this node's active Home grants before changing it to the read-only viewer role");
    }
    return this.atomicPublication(() => {
      const updated = this.store.updateMember(stugbyId, nodeId, role, state);
      this.publishMember(updated);
      if (updated.state === "active" && existingMember.state !== "active" && updated.nodeId !== this.identity.nodeId) {
        const property = this.store.getSharedProperty(stugbyId);
        if (property) this.sendSharedPropertySnapshot(property, updated.nodeId);
        for (const grant of this.store.listGrants(stugbyId, this.identity.nodeId)) {
          if (grant.audience.kind !== "all-members" || grant.revokedAt || grantExpired(grant)) continue;
          const house = this.database.getHouse(grant.localHouseId ?? "");
          if (!house) throw new StugbyError(409, "GRANT_HOUSE_MISSING", "An active all-member grant references a missing local Home");
          this.publishGrant(grant, "grant.upserted");
          this.publishGrantSnapshots(grant, house);
        }
      }
      return updated;
    });
  }

  async updateSharedProperty(stugbyId: string, baseRevision: number, input: SharedPropertyInput): Promise<StugbySharedProperty> {
    const stugby = this.requireStugby(stugbyId);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new StugbyError(400, "INVALID_REVISION", "baseRevision must be a positive integer");
    if (!this.store.isCoordinator(stugbyId)) {
      if (stugby.localRole !== "property-manager") throw new StugbyError(403, "PROPERTY_WRITE_FORBIDDEN", "Only a Stugby steward or property manager may edit shared property data");
      const response = await this.signedFetch(stugby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugbyId)}/property`, {
        method: "PUT",
        body: JSON.stringify({ baseRevision, property: input }),
      });
      if (!response.ok) throw await this.remoteError(response, "Shared property update failed");
      const property = validateSharedProperty(await this.readJsonResponse(response, 2 * 1024 * 1024, "Shared property response"));
      this.store.saveSharedProperty(property);
      return property;
    }
    return this.updateSharedPropertyAs(this.identity.nodeId, stugbyId, baseRevision, input);
  }

  updateSharedPropertyAs(actorNodeId: string, stugbyId: string, baseRevision: number, input: SharedPropertyInput): StugbySharedProperty {
    this.requireCoordinator(stugbyId);
    const actor = this.store.getMember(stugbyId, actorNodeId);
    if (!actor || actor.state !== "active" || !["steward", "property-manager"].includes(actor.role)) {
      throw new StugbyError(403, "PROPERTY_WRITE_FORBIDDEN", "Only an active Stugby steward or property manager may edit shared property data");
    }
    assertSafeFederationPayload(input);
    const now = new Date().toISOString();
    const property: StugbySharedProperty = {
      ...input,
      stugbyId,
      name: requiredText(input.name, "Property name"),
      revision: baseRevision + 1,
      updatedAt: now,
    };
    validateSharedProperty(property);
    return this.atomicPublication(() => {
      try { this.store.saveSharedProperty(property, baseRevision); } catch (error) {
        throw new StugbyError(409, "REVISION_CONFLICT", error instanceof Error ? error.message : "Shared property revision conflict");
      }
      this.store.audit(stugbyId, "shared-property.updated", actorNodeId, stugbyId, { revision: property.revision }, now);
      const event = this.createEvent({
        stugbyId,
        eventKind: "shared-property.updated",
        streamId: "shared-property",
        schema: "stugby.shared-property.v1",
        resourceId: stugbyId,
        operation: "upsert",
        revision: property.revision,
        grantId: null,
        grantEpoch: null,
        payload: property,
      });
      this.distribute(event);
      return property;
    });
  }

  createGrant(stugbyId: string, input: {
    localHouseId: string;
    audience: StugbyGrantAudience;
    datasets: StugbyDatasetGrant[];
    expiresAt?: string | null;
  }): StugbyShareGrant {
    this.requireLocalPublisher(stugbyId);
    const house = this.database.getHouse(requiredText(input.localHouseId, "House id"));
    if (!house) throw new StugbyError(404, "HOUSE_NOT_FOUND", "Local house was not found");
    const publicationId = this.store.publicationId(stugbyId, "home", house.id);
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : null;
    if (expiresAt && expiresAt <= now) throw new StugbyError(400, "INVALID_EXPIRY", "Grant expiry must be in the future");
    const grant: StugbyShareGrant = {
      id: randomUUID(),
      stugbyId,
      authorityNodeId: this.identity.nodeId,
      publicationId,
      localHouseId: house.id,
      audience: input.audience,
      datasets: input.datasets,
      epoch: 1,
      revision: 1,
      expiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.validateGrantAgainstMembership(grant);
    validateShareGrant(grant);
    this.atomicPublication(() => {
      this.store.upsertGrant(grant);
      this.store.audit(stugbyId, "grant.created", this.identity.nodeId, grant.id, {
        revision: grant.revision, epoch: grant.epoch, audience: grant.audience.kind,
        enabledDatasets: grant.datasets.filter((dataset) => dataset.enabled).length,
      });
      this.publishGrant(grant, "grant.upserted");
      this.publishGrantSnapshots(grant, house);
    });
    return grant;
  }

  localPublicationCatalog(stugbyId: string, localHouseId: string): {
    house: { localHouseId: string; publicationId: string; name: string };
    sensors: Array<{ localSensorId: string; sensorPublicationId: string; name: string; metricIds: string[] }>;
  } {
    this.requireLocalPublisher(stugbyId);
    const house = this.database.getHouse(requiredText(localHouseId, "House id"));
    if (!house) throw new StugbyError(404, "HOUSE_NOT_FOUND", "Local house was not found");
    return {
      house: {
        localHouseId: house.id,
        publicationId: this.store.publicationId(stugbyId, "home", house.id),
        name: house.name,
      },
      sensors: this.database.listSensors(house.id).map((sensor) => ({
        localSensorId: sensor.id,
        sensorPublicationId: this.store.publicationId(stugbyId, "sensor", sensor.id),
        name: sensor.name,
        metricIds: this.sensorMetrics(sensor.id),
      })),
    };
  }

  updateGrant(grantId: string, baseRevision: number, input: Pick<StugbyShareGrant, "audience" | "datasets" | "expiresAt">): StugbyShareGrant {
    const existing = this.store.getGrant(grantId);
    if (!existing) throw new StugbyError(404, "GRANT_NOT_FOUND", "Share grant was not found");
    if (existing.authorityNodeId !== this.identity.nodeId) throw new StugbyError(403, "GRANT_AUTHORITY_REQUIRED", "Only the authoritative local Stuga may edit this grant");
    if (existing.revokedAt) throw new StugbyError(409, "GRANT_REVOKED", "A revoked grant cannot be edited");
    this.requireLocalPublisher(existing.stugbyId);
    if (existing.revision !== baseRevision) throw new StugbyError(409, "REVISION_CONFLICT", `Current grant revision is ${existing.revision}`);
    const retiredAt = new Date().toISOString();
    const retired: StugbyShareGrant = {
      ...existing,
      epoch: existing.epoch + 1,
      revision: existing.revision + 1,
      revokedAt: retiredAt,
      updatedAt: retiredAt,
    };
    const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : null;
    if (expiresAt && expiresAt <= retiredAt) throw new StugbyError(400, "INVALID_EXPIRY", "Grant expiry must be in the future");
    const grant: StugbyShareGrant = {
      ...existing,
      audience: input.audience,
      datasets: input.datasets,
      expiresAt,
      epoch: existing.epoch + 2,
      revision: existing.revision + 2,
      revokedAt: null,
      updatedAt: new Date().toISOString(),
    };
    this.validateGrantAgainstMembership(grant);
    validateShareGrant(grant);
    const house = this.database.getHouse(existing.localHouseId ?? "");
    if (!house) throw new StugbyError(404, "HOUSE_NOT_FOUND", "Grant house was not found");
    // Every former recipient first receives a tombstone and must acknowledge
    // deletion. Continuing recipients then receive a fresh epoch and snapshot.
    this.atomicPublication(() => {
      this.store.discardOutboxGrantEpoch(existing.stugbyId, existing.id, existing.epoch);
      this.publishGrant(retired, "grant.revoked");
      this.store.upsertGrant(grant);
      this.store.audit(grant.stugbyId, "grant.updated", this.identity.nodeId, grant.id, {
        revision: grant.revision, epoch: grant.epoch, audience: grant.audience.kind,
        enabledDatasets: grant.datasets.filter((dataset) => dataset.enabled).length,
      });
      this.publishGrant(grant, "grant.upserted");
      this.publishGrantSnapshots(grant, house);
      this.store.retireLocalBlobReferences(grant.stugbyId, grant.id, existing.epoch);
    });
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    return grant;
  }

  revokeGrant(grantId: string): StugbyShareGrant {
    const previous = this.store.getGrant(grantId);
    if (!previous) throw new StugbyError(404, "GRANT_NOT_FOUND", "Share grant was not found");
    if (previous.authorityNodeId !== this.identity.nodeId) throw new StugbyError(403, "GRANT_AUTHORITY_REQUIRED", "Only the authoritative local Stuga may revoke this grant");
    if (previous.revokedAt) throw new StugbyError(409, "GRANT_REVOKED", "Share grant is already revoked");
    this.requireLocalPublisher(previous.stugbyId);
    const revoked = this.atomicPublication(() => {
      const retired = this.store.revokeGrant(grantId);
      // Keep the old audience on the revocation so every former recipient purges its replica.
      this.store.discardOutboxGrantEpoch(previous.stugbyId, previous.id, previous.epoch);
      this.publishGrant({ ...retired, audience: previous.audience }, "grant.revoked");
      this.store.audit(retired.stugbyId, "grant.revoked", this.identity.nodeId, retired.id, { epoch: retired.epoch });
      this.store.retireLocalBlobReferences(retired.stugbyId, retired.id, previous.epoch);
      return retired;
    });
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    return revoked;
  }

  republishGrant(grantId: string): void {
    const grant = this.store.getGrant(grantId);
    if (!grant || grant.authorityNodeId !== this.identity.nodeId || grant.revokedAt || grantExpired(grant)) throw new StugbyError(404, "GRANT_NOT_FOUND", "Active local share grant was not found");
    this.requireLocalPublisher(grant.stugbyId);
    const house = this.database.getHouse(grant.localHouseId ?? "");
    if (!house) throw new StugbyError(404, "HOUSE_NOT_FOUND", "Grant house was not found");
    this.publishGrant(grant, "grant.upserted");
    this.publishGrantSnapshots(grant, house);
    this.store.audit(grant.stugbyId, "grant.republished", this.identity.nodeId, grant.id, { revision: grant.revision, epoch: grant.epoch });
  }

  private validateGrantAgainstMembership(grant: StugbyShareGrant, authorityNodeId = this.identity.nodeId): void {
    if (grant.audience.kind === "members" && grant.audience.nodeIds.length === 0) {
      throw new StugbyError(400, "EMPTY_AUDIENCE", "A member-specific grant requires at least one participant");
    }
    const active = new Set(this.store.listMembers(grant.stugbyId).filter((member) => member.state === "active").map((member) => member.nodeId));
    for (const nodeId of grant.audience.nodeIds) {
      if (!active.has(nodeId) || nodeId === authorityNodeId) throw new StugbyError(400, "INVALID_AUDIENCE", `Node ${nodeId} is not an eligible active participant`);
    }
  }

  private publishGrant(grant: StugbyShareGrant, eventKind: "grant.upserted" | "grant.revoked"): void {
    const wireGrant = withoutLocalGrantIdentity(grant);
    const event = this.createEvent({
      stugbyId: grant.stugbyId,
      eventKind,
      streamId: `grant:${grant.id}`,
      schema: "stugby.grant.v1",
      resourceId: grant.id,
      operation: eventKind === "grant.revoked" ? "tombstone" : "upsert",
      revision: grant.revision,
      grantId: grant.id,
      grantEpoch: grant.epoch,
      payload: asJson(wireGrant),
    });
    this.distribute(event, grant);
  }

  private atomicPublication<T>(operation: () => T): T {
    if (this.#deferredNotifications) throw new Error("Nested Stugby grant transactions are not supported");
    const notifications: Notification[] = [];
    this.#deferredNotifications = notifications;
    try {
      const result = this.store.transaction(operation);
      for (const notification of notifications) this.#notifications.emit("event", notification);
      return result;
    } finally {
      this.#deferredNotifications = null;
    }
  }

  private publishGrantSnapshots(grant: StugbyShareGrant, house: House): void {
    for (const dataset of grant.datasets) {
      if (!dataset.enabled) continue;
      if (dataset.dataset === "home.telemetry.v1") {
        this.publishHistoricalTelemetry(grant, house, dataset);
        continue;
      }
      const projected = this.projectDataset(grant, house, dataset);
      if (!projected) continue;
      const revision = Math.max(1, Date.parse(house.updatedAt));
      this.publishDataset(grant, dataset.dataset, projected, `${grant.publicationId}:${dataset.dataset}`, revision);
    }
  }

  private projectDataset(grant: StugbyShareGrant, house: House, dataset: StugbyDatasetGrant): JsonValue | null {
    const local = dataset.includeLocalIds;
    const publicationId = grant.publicationId;
    switch (dataset.dataset) {
      case "home.directory.v1": {
        const payload: StugbyHomeDirectoryPayload = {
          publicationId,
          name: house.name,
          timezone: house.timezone,
          ...(local ? { localHouseId: house.id } : {}),
        };
        return payload;
      }
      case "home.location.v1": {
        if (!house.location) return null;
        const payload: StugbyHomeLocationPayload = {
          publicationId,
          latitude: house.location.latitude,
          longitude: house.location.longitude,
          ...(house.location.label ? { label: house.location.label } : {}),
          ...(house.location.countryCode ? { countryCode: house.location.countryCode } : {}),
          ...(house.mapPlacement ? { mapPlacement: {
            latitude: house.mapPlacement.latitude,
            longitude: house.mapPlacement.longitude,
            metersPerPlanUnit: house.mapPlacement.metersPerPlanUnit,
            ...(house.mapPlacement.footprintFloorId ? {
              footprintFloorPublicationId: this.store.publicationId(grant.stugbyId, "floor", house.mapPlacement.footprintFloorId),
            } : {}),
          } } : {}),
          ...(house.orientationDegrees !== undefined ? { orientationDegrees: house.orientationDegrees } : {}),
        };
        return payload;
      }
      case "home.structure.v1":
        return this.projectStructure(grant, house, local);
      case "home.floorplan.v1":
        return this.projectFloorPlans(grant, house);
      case "home.sensor-catalog.v1":
        return this.projectSensors(grant, house, local);
      case "home.notes.v1": {
        const notes = this.database.listPropertyNotes({ houseId: house.id, limit: 10_000 }).map((note) => ({
          notePublicationId: this.store.publicationId(grant.stugbyId, "note", note.id),
          ...(local ? { localNoteId: note.id } : {}),
          kind: note.kind,
          text: note.text,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }));
        return { publicationId, notes } satisfies StugbyHomeNotesPayload;
      }
      case "home.observations.v1": {
        const observations = this.database.listObservations(house.id).map((observation) => ({
          observationPublicationId: this.store.publicationId(grant.stugbyId, "observation", observation.id),
          ...(local ? { localObservationId: observation.id } : {}),
          floorPublicationId: this.store.publicationId(grant.stugbyId, "floor", observation.floorId),
          ...(observation.sensorId ? { sensorPublicationId: this.store.publicationId(grant.stugbyId, "sensor", observation.sensorId) } : {}),
          kind: observation.kind,
          severity: observation.severity,
          note: observation.note,
          x: observation.x,
          y: observation.y,
          occurredAt: observation.occurredAt,
          ...(observation.timePrecision ? { timePrecision: observation.timePrecision } : {}),
          ...(observation.validFrom !== undefined ? { validFrom: observation.validFrom } : {}),
          ...(observation.validTo !== undefined ? { validTo: observation.validTo } : {}),
          ...(observation.confidence ? { confidence: observation.confidence } : {}),
          ...(observation.status ? { status: observation.status } : {}),
          ...(observation.resolutionNote !== undefined ? { resolutionNote: observation.resolutionNote } : {}),
          ...(observation.resolvedAt !== undefined ? { resolvedAt: observation.resolvedAt } : {}),
          updatedAt: observation.updatedAt ?? observation.createdAt,
        }));
        return { publicationId, observations } satisfies StugbyHomeObservationsPayload;
      }
      case "home.telemetry.v1":
        return null;
    }
  }

  private projectStructure(grant: StugbyShareGrant, house: House, local: boolean): StugbyHomeStructurePayload {
    const floors = house.floors.map((floor) => {
      const walls = floor.walls.map((wall) => ({
        wallPublicationId: this.store.publicationId(grant.stugbyId, "wall", wall.id),
        ...(local ? { localWallId: wall.id } : {}),
        from: { x: wall.from.x, y: wall.from.y },
        to: { x: wall.to.x, y: wall.to.y },
      }));
      const rooms = floor.rooms.map((room) => ({
        roomPublicationId: this.store.publicationId(grant.stugbyId, "room", room.id),
        ...(local ? { localRoomId: room.id } : {}),
        name: room.name,
        points: room.points.map((point) => ({ x: point.x, y: point.y })),
        ...(room.kind ? { kind: room.kind } : {}),
      }));
      const planElements = (floor.planElements ?? []).map((element) => {
        const projected: Record<string, JsonValue> = {
          planElementPublicationId: this.store.publicationId(grant.stugbyId, "plan-element", element.id),
          ...(local ? { localPlanElementId: element.id } : {}),
          kind: element.kind,
          position: { x: element.position.x, y: element.position.y },
          rotationDegrees: element.rotationDegrees,
        };
        for (const key of ["width", "height", "label", "state", "openFraction", "bottomOffsetM", "variant",
          "nominalFlowM3h", "verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"] as const) {
          const value = element[key as keyof typeof element];
          if (value !== undefined) projected[key] = value as JsonValue;
        }
        if ("wallId" in element && typeof element.wallId === "string") {
          projected.wallPublicationId = this.store.publicationId(grant.stugbyId, "wall", element.wallId);
        }
        return projected;
      });
      const result: Record<string, JsonValue> = {
        floorPublicationId: this.store.publicationId(grant.stugbyId, "floor", floor.id),
        ...(local ? { localFloorId: floor.id } : {}),
        name: floor.name,
        width: floor.width,
        height: floor.height,
        elevation: floor.elevation,
        walls: asJson(walls),
        rooms: asJson(rooms),
        planElements,
      };
      for (const [key, value] of [
        ["type", floor.type], ["metersPerPlanUnit", floor.metersPerPlanUnit], ["ceilingHeight", floor.ceilingHeight],
        ["wallHeight", floor.wallHeight], ["roof", floor.roof ? {
          style: floor.roof.style,
          pitchDegrees: floor.roof.pitchDegrees,
          ridgeAxis: floor.roof.ridgeAxis,
          overhang: floor.roof.overhang,
          eavesHeight: floor.roof.eavesHeight,
        } : undefined],
      ] as const) if (value !== undefined) result[key] = value as JsonValue;
      return result;
    });
    const payload = { publicationId: grant.publicationId, floors } as unknown as StugbyHomeStructurePayload;
    assertSafeFederationPayload(payload);
    return payload;
  }

  private projectFloorPlans(grant: StugbyShareGrant, house: House): StugbyHomeFloorPlanPayload {
    const assets = house.floors.flatMap((floor) => {
      if (!floor.backgroundImage) return [];
      const image = this.storeDataUrl(floor.backgroundImage);
      this.store.registerBlobReference(grant.stugbyId, image.digest, grant.id, grant.epoch, "local");
      return [{ floorPublicationId: this.store.publicationId(grant.stugbyId, "floor", floor.id), image }];
    });
    return { publicationId: grant.publicationId, assets };
  }

  private projectSensors(grant: StugbyShareGrant, house: House, local: boolean): StugbySensorCatalogPayload {
    const sensors = this.database.listSensors(house.id).map((sensor) => ({
      sensorPublicationId: this.store.publicationId(grant.stugbyId, "sensor", sensor.id),
      ...(local ? { localSensorId: sensor.id } : {}),
      floorPublicationId: this.store.publicationId(grant.stugbyId, "floor", sensor.floorId),
      ...(sensor.roomId ? { roomPublicationId: this.store.publicationId(grant.stugbyId, "room", sensor.roomId) } : {}),
      name: sensor.name,
      x: sensor.x,
      y: sensor.y,
      z: sensor.z,
      metricIds: this.sensorMetrics(sensor.id),
    }));
    return { publicationId: grant.publicationId, sensors };
  }

  private sensorMetrics(sensorId: string): string[] {
    return (this.database.db.prepare("SELECT DISTINCT metric FROM measurement_samples WHERE sensor_id=? ORDER BY metric")
      .all(sensorId) as Array<{ metric: string }>).map((row) => row.metric);
  }

  private publishHistoricalTelemetry(grant: StugbyShareGrant, house: House, dataset: StugbyDatasetGrant): void {
    const policy = dataset.telemetry;
    if (!policy || !policy.historyFrom) return;
    const from = parseIso(policy.historyFrom, "Telemetry history start");
    const now = Date.now();
    // When live publication is enabled, the current UTC hour belongs solely
    // to the durable live bucket. This prevents the initial history snapshot
    // and live stream from each consuming a full allowance for that hour.
    const to = new Date(policy.live ? Math.floor(now / 3_600_000) * 3_600_000 - 1 : now).toISOString();
    if (Date.parse(from) > Date.parse(to)) return;
    const sensors = this.selectedSensors(grant, house, policy.sensorPublicationIds);
    if (sensors.length === 0) return;
    const sensorIds = sensors.map((sensor) => sensor.id);
    const sensorPlaceholders = sensorIds.map(() => "?").join(",");
    const metricPlaceholders = policy.metricIds.map(() => "?").join(",");
    const metricClause = metricPlaceholders ? `AND metric IN (${metricPlaceholders})` : "";
    const rows = this.database.db.prepare(`WITH candidates AS (
        SELECT id,sensor_id,metric,timestamp,value,quality,
          strftime('%Y-%m-%dT%H',timestamp) AS utc_hour
        FROM measurement_samples
        WHERE timestamp>=? AND timestamp<=? AND sensor_id IN (${sensorPlaceholders}) ${metricClause}
      ), bucketed AS (
        SELECT *,ntile(?) OVER (
          PARTITION BY utc_hour ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id
        ) AS sample_bucket
        FROM candidates WHERE utc_hour IS NOT NULL
      ), sampled AS (
        SELECT *,row_number() OVER (
          PARTITION BY utc_hour,sample_bucket ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id
        ) AS selected_rank
        FROM bucketed
      )
      SELECT sensor_id,metric,timestamp,value,quality
      FROM sampled WHERE selected_rank=1
      ORDER BY julianday(timestamp),timestamp,sensor_id,metric,id LIMIT ?`)
      .all(from, to, ...sensorIds, ...policy.metricIds, policy.maxSamplesPerHour, 100_000) as unknown as Array<{
        sensor_id: string;
        metric: string;
        timestamp: string;
        value: number;
        quality: "good" | "estimated" | "stale";
      }>;
    const publications = new Map(sensors.map((sensor) => [
      sensor.id,
      this.store.publicationId(grant.stugbyId, "sensor", sensor.id),
    ]));
    const samples: StugbyTelemetryPayload["samples"] = rows.map((sample) => ({
      sensorPublicationId: publications.get(sample.sensor_id)!,
      metricId: sample.metric,
      timestamp: sample.timestamp,
      value: sample.value,
      quality: sample.quality,
    }));
    const byHour = new Map<string, StugbyTelemetryPayload["samples"]>();
    for (const sample of samples) {
      const hour = new Date(Date.parse(sample.timestamp)).toISOString().slice(0, 13);
      const bucket = byHour.get(hour) ?? [];
      bucket.push(sample);
      byHour.set(hour, bucket);
    }
    const hours = [...byHour.entries()].sort(([left], [right]) => left.localeCompare(right));
    const chunkSize = 2_000;
    for (const [hourIndex, [hour, hourlySamples]] of hours.entries()) {
      for (let offset = 0; offset < hourlySamples.length; offset += chunkSize) {
        const selected = hourlySamples.slice(offset, offset + chunkSize);
        const chunkIndex = Math.floor(offset / chunkSize);
        const chunkId = sha256(`${grant.id}\n${grant.epoch}\n${hour}\n${chunkIndex}`);
        const payload: StugbyTelemetryPayload = {
          publicationId: grant.publicationId,
          chunkId,
          from: selected[0]!.timestamp,
          to: selected.at(-1)!.timestamp,
          complete: hourIndex === hours.length - 1 && offset + chunkSize >= hourlySamples.length,
          samples: selected,
        };
        this.publishDataset(grant, "home.telemetry.v1", payload, `${grant.publicationId}:telemetry:${chunkId}`, 1);
      }
    }
  }

  private selectedSensors(grant: StugbyShareGrant, house: House, publications: string[]): Sensor[] {
    const sensors = this.database.listSensors(house.id);
    if (!publications.length) return sensors;
    const selected = new Set(publications);
    return sensors.filter((sensor) => selected.has(this.store.publicationId(grant.stugbyId, "sensor", sensor.id)));
  }

  private publishLiveTelemetry(sample: MeasurementSample): void {
    const sensor = this.database.db.prepare("SELECT house_id FROM sensors WHERE id=?")
      .get(sample.sensorId) as { house_id: string } | undefined;
    if (!sensor) return;
    for (const stugby of this.store.listStugbys()) {
      if (stugby.localMemberState !== "active" || stugby.localRole === "viewer") continue;
      for (const grant of this.store.listGrants(stugby.id, this.identity.nodeId)) {
        if (grant.revokedAt || grantExpired(grant) || grant.localHouseId !== sensor.house_id) continue;
        const dataset = enabledDataset(grant, "home.telemetry.v1");
        const policy = dataset?.telemetry;
        if (!dataset || !policy?.live) continue;
        const sensorPublicationId = this.store.publicationId(grant.stugbyId, "sensor", sample.sensorId);
        if (policy.sensorPublicationIds.length && !policy.sensorPublicationIds.includes(sensorPublicationId)) continue;
        if (policy.metricIds.length && !policy.metricIds.includes(sample.metric)) continue;
        const utcHour = new Date(Date.parse(sample.timestamp)).toISOString().slice(0, 13);
        this.atomicPublication(() => {
          if (!this.store.reserveLiveTelemetrySample(grant.stugbyId, grant.id, utcHour, policy.maxSamplesPerHour)) return;
          const chunkId = randomUUID();
          const payload: StugbyTelemetryPayload = {
            publicationId: grant.publicationId,
            chunkId,
            from: sample.timestamp,
            to: sample.timestamp,
            complete: true,
            samples: [{ sensorPublicationId, metricId: sample.metric, timestamp: sample.timestamp, value: sample.value, quality: sample.quality }],
          };
          this.publishDataset(grant, "home.telemetry.v1", payload, `${grant.publicationId}:telemetry:${chunkId}`, 1);
        });
      }
    }
  }

  private publishDataset(grant: StugbyShareGrant, dataset: StugbyDataset, payload: JsonValue, resourceId: string, revision: number): void {
    validateDatasetPayload(dataset, payload);
    const event = this.createEvent({
      stugbyId: grant.stugbyId,
      eventKind: "dataset.published",
      streamId: `dataset:${grant.id}:${dataset}`,
      schema: dataset,
      resourceId,
      operation: "upsert",
      revision: Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, revision)),
      grantId: grant.id,
      grantEpoch: grant.epoch,
      payload,
    });
    this.distribute(event, grant);
  }

  private createEvent(input: Omit<StugbyWireEvent, "protocolVersion" | "eventId" | "authorityNodeId" | "sequence" | "occurredAt" | "payloadHash">): StugbySignedEvent {
    const payload = input.operation === "tombstone" ? null : input.payload;
    const wire: StugbyWireEvent = {
      protocolVersion: STUGBY_PROTOCOL_VERSION,
      stugbyId: input.stugbyId,
      eventId: randomUUID(),
      eventKind: input.eventKind,
      authorityNodeId: this.identity.nodeId,
      streamId: input.streamId,
      sequence: this.store.nextSequence(input.stugbyId, input.streamId),
      schema: input.schema,
      resourceId: input.resourceId,
      operation: input.operation,
      revision: input.revision,
      grantId: input.grantId,
      grantEpoch: input.grantEpoch,
      occurredAt: new Date().toISOString(),
      payload,
      payloadHash: sha256(canonicalJson(payload)),
    };
    return { ...wire, keyFingerprint: this.identity.keyFingerprint, signature: this.keys.sign(eventSigningValue(wire)) };
  }

  private distribute(event: StugbySignedEvent, explicitGrant?: StugbyShareGrant): void {
    const stugby = this.requireStugby(event.stugbyId);
    if (!this.store.isCoordinator(event.stugbyId)) {
      this.store.enqueueOutbox(event.stugbyId, stugby.coordinatorNodeId, event);
      return;
    }
    const grant = explicitGrant ?? (event.grantId ? this.store.getGrant(event.grantId) : null);
    const members = this.store.listMembers(event.stugbyId).filter((member) => member.state === "active"
      && member.nodeId !== this.identity.nodeId && member.nodeId !== event.authorityNodeId);
    for (const member of members) {
      if (grant && !grantAudienceIncludes(grant, member.nodeId)) continue;
      this.appendForMember(event.stugbyId, member.nodeId, event);
    }
  }

  private appendForMember(stugbyId: string, nodeId: string, event: StugbySignedEvent): void {
    const cursor = this.store.appendEventForMember(stugbyId, nodeId, event);
    if (cursor !== null && event.schema === "home.floorplan.v1" && event.operation === "upsert"
      && event.grantId && event.grantEpoch !== null) {
      const payload = event.payload as unknown as StugbyHomeFloorPlanPayload;
      for (const asset of payload.assets) {
        this.store.grantBlobAccess(stugbyId, asset.image.digest, nodeId, event.grantId, event.grantEpoch);
      }
    }
    if (cursor !== null && event.schema === "stugby.grant.v1" && event.operation === "tombstone"
      && event.grantId && event.grantEpoch !== null) {
      this.store.expectDeletion(stugbyId, nodeId, event.grantId, event.grantEpoch);
    }
    if (cursor !== null) {
      const notification = { stugbyId, targetNodeId: nodeId, cursor } satisfies Notification;
      if (this.#deferredNotifications) this.#deferredNotifications.push(notification);
      else this.#notifications.emit("event", notification);
    }
  }

  private publishMember(member: StugbyMember): void {
    const event = this.createEvent({
      stugbyId: member.stugbyId,
      eventKind: "member.updated",
      streamId: "members",
      schema: "stugby.member.v1",
      resourceId: member.nodeId,
      operation: "upsert",
      revision: Math.max(1, Date.parse(member.updatedAt)),
      grantId: null,
      grantEpoch: null,
      payload: asJson(member),
    });
    this.distribute(event);
    if (member.state !== "active" && member.nodeId !== this.identity.nodeId) {
      this.appendForMember(member.stugbyId, member.nodeId, event);
    }
  }

  private sendMemberSnapshot(member: StugbyMember, targetNodeId: string): void {
    const event = this.createEvent({
      stugbyId: member.stugbyId,
      eventKind: "member.updated",
      streamId: "members",
      schema: "stugby.member.v1",
      resourceId: member.nodeId,
      operation: "upsert",
      revision: Math.max(1, Date.parse(member.updatedAt)),
      grantId: null,
      grantEpoch: null,
      payload: asJson(member),
    });
    this.appendForMember(member.stugbyId, targetNodeId, event);
  }

  private sendSharedPropertySnapshot(property: StugbySharedProperty, targetNodeId: string): void {
    const event = this.createEvent({
      stugbyId: property.stugbyId,
      eventKind: "shared-property.updated",
      streamId: "shared-property",
      schema: "stugby.shared-property.v1",
      resourceId: property.stugbyId,
      operation: "upsert",
      revision: property.revision,
      grantId: null,
      grantEpoch: null,
      payload: property,
    });
    this.appendForMember(property.stugbyId, targetNodeId, event);
  }

  subscribeNotifications(stugbyId: string, nodeId: string, listener: (cursor: number) => void): () => void {
    const handler = (notification: Notification): void => {
      if (notification.stugbyId === stugbyId && notification.targetNodeId === nodeId) listener(notification.cursor);
    };
    this.#notifications.on("event", handler);
    return () => this.#notifications.off("event", handler);
  }

  replaceNotificationStream(stugbyId: string, nodeId: string, close: () => void): () => void {
    const key = `${stugbyId}\n${nodeId}`;
    const previous = this.#incomingNotificationStreams.get(key);
    this.#incomingNotificationStreams.set(key, close);
    previous?.();
    return () => {
      if (this.#incomingNotificationStreams.get(key) === close) this.#incomingNotificationStreams.delete(key);
    };
  }

  authenticateMachineRequest(stugbyId: string, proof: MachineRequestProof): StugbyMember {
    if (!proof.nodeId || !proof.timestamp || !proof.requestId || !proof.signature) {
      throw new StugbyError(401, "MISSING_REQUEST_PROOF", "Signed Stugby request headers are required");
    }
    if (!UUID.test(proof.requestId)) {
      throw new StugbyError(401, "INVALID_REQUEST_ID", "Stugby request id must be a UUID");
    }
    const timestamp = Date.parse(proof.timestamp);
    if (!ISO_DATE_TIME.test(proof.timestamp) || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > STUGBY_MAX_CLOCK_SKEW_SECONDS * 1_000) {
      throw new StugbyError(401, "STALE_REQUEST", "Stugby request timestamp is outside the accepted clock window");
    }
    const member = this.store.getMember(stugbyId, proof.nodeId);
    if (!member) throw new StugbyError(403, "MEMBERSHIP_INACTIVE", "Stugby membership is required");
    const eventPath = `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugbyId)}/events`;
    const finalPull = proof.method.toUpperCase() === "GET"
      && (proof.path === eventPath || proof.path.startsWith(`${eventPath}?`) || proof.path.startsWith(`${eventPath}/stream?`) || proof.path === `${eventPath}/stream`);
    if (member.state !== "active" && !finalPull) {
      throw new StugbyError(403, "MEMBERSHIP_INACTIVE", "Inactive members may only pull their final queued membership event");
    }
    const signingValue = requestSigningValue({
      method: proof.method,
      path: proof.path,
      bodyHash: sha256(proof.body),
      timestamp: proof.timestamp,
      requestId: proof.requestId,
      nodeId: proof.nodeId,
    });
    if (!this.keys.verify(signingValue, proof.signature, member.publicKey)) throw new StugbyError(401, "INVALID_REQUEST_PROOF", "Stugby request signature is invalid");
    if (!this.store.acceptRequest(member.nodeId, proof.requestId, new Date(Date.now() + STUGBY_MAX_CLOCK_SKEW_SECONDS * 1_000).toISOString())) {
      throw new StugbyError(409, "REPLAYED_REQUEST", "Stugby request id has already been used");
    }
    return member;
  }

  ingestEventBatch(actor: StugbyMember, stugbyId: string, batch: StugbyEventBatch): { accepted: string[]; duplicates: string[] } {
    this.requireCoordinator(stugbyId);
    if (batch.protocolVersion !== STUGBY_PROTOCOL_VERSION || !Array.isArray(batch.events) || batch.events.length > STUGBY_MAX_BATCH_EVENTS) {
      throw new StugbyError(400, "INVALID_EVENT_BATCH", `Event batch must contain at most ${STUGBY_MAX_BATCH_EVENTS} protocol v1 events`);
    }
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const candidate of batch.events) {
      const event = validateSignedEvent(candidate);
      if (event.stugbyId !== stugbyId || event.authorityNodeId !== actor.nodeId) throw new StugbyError(403, "EVENT_AUTHORITY_MISMATCH", "Event authority must match the authenticated node");
      if (!DATASET_SCHEMAS.has(event.schema) && event.schema !== "stugby.grant.v1") {
        throw new StugbyError(403, "EVENT_SCHEMA_FORBIDDEN", "Participant nodes may publish only grants and approved read-only datasets");
      }
      if (actor.role === "viewer") throw new StugbyError(403, "VIEWER_READ_ONLY", "Viewer nodes cannot publish grants or Home datasets");
      this.verifyEvent(event, actor.publicKey);
      const inboxStatus = this.store.inboxEventStatus(event);
      if (inboxStatus === "duplicate") { duplicates.push(event.eventId); continue; }
      if (inboxStatus === "non-monotonic") throw new StugbyError(409, "NON_MONOTONIC_EVENT", "Event sequence must increase within its authority stream");
      if (event.schema === "stugby.grant.v1") {
        // A revocation tombstone carries no payload; the coordinator already has the preceding grant.
        if (event.operation === "upsert") {
          const grant = validateShareGrant(event.payload);
          if (grant.authorityNodeId !== actor.nodeId || grant.stugbyId !== stugbyId || grant.id !== event.grantId
            || grant.id !== event.resourceId || grant.epoch !== event.grantEpoch || grant.revision !== event.revision) {
            throw new StugbyError(403, "GRANT_AUTHORITY_MISMATCH", "Grant payload does not match its signed event envelope");
          }
          if (grantExpired(grant)) throw new StugbyError(400, "GRANT_EXPIRED", "An expired grant cannot be published");
          this.validateGrantAgainstMembership(grant, actor.nodeId);
          validateGrantTransition(this.store.getGrant(grant.id), grant, 409);
          this.store.upsertGrant(grant);
          this.distribute(event, grant);
        } else {
          if (event.grantEpoch === null) throw new StugbyError(400, "INVALID_REVOCATION", "Revocation is missing its grant epoch");
          const revokedEpoch = event.grantEpoch;
          const grant = this.store.getGrant(event.grantId ?? "");
          if (!grant) {
            if (!event.grantId || event.resourceId !== event.grantId) throw new StugbyError(400, "INVALID_REVOCATION", "Unknown grant revocation has an invalid envelope");
            this.store.audit(stugbyId, "grant.revocation-noop", actor.nodeId, event.grantId, { epoch: revokedEpoch });
          } else {
            const alreadyApplied = grant.authorityNodeId === actor.nodeId && event.resourceId === grant.id
              && revokedEpoch === grant.epoch && event.revision === grant.revision && grant.revokedAt === event.occurredAt;
            if (!alreadyApplied && (grant.authorityNodeId !== actor.nodeId || revokedEpoch !== grant.epoch + 1
              || event.revision !== grant.revision + 1 || event.resourceId !== grant.id)) {
              throw new StugbyError(400, "INVALID_REVOCATION", "Revocation must advance a known grant by exactly one epoch and revision");
            }
            if (!alreadyApplied) {
              const revoked: StugbyShareGrant = { ...grant, epoch: revokedEpoch, revision: event.revision, revokedAt: event.occurredAt, updatedAt: event.occurredAt };
              this.store.upsertGrant(revoked);
            }
            if (!alreadyApplied && grantAudienceIncludes(grant, this.identity.nodeId)) {
              this.store.purgeGrantData(stugbyId, grant.id, revokedEpoch);
              this.deleteUnreferencedBlobs(this.store.purgeReplicaBlobReferences(stugbyId, grant.id, revokedEpoch));
            }
            this.distribute(event, grant);
            this.deleteUnreferencedBlobs(this.store.releaseRelayReferencesWithoutAccess(stugbyId, grant.id, revokedEpoch));
          }
        }
      } else {
        const grant = this.authorizeDatasetEvent(event);
        const floorPlan = event.schema === "home.floorplan.v1" && event.operation === "upsert"
          ? event.payload as unknown as StugbyHomeFloorPlanPayload : null;
        if (floorPlan) {
          for (const asset of floorPlan.assets) {
            const blob = this.readBlob(asset.image.digest);
            if (blob.data.byteLength !== asset.image.byteLength || blob.mediaType !== asset.image.mediaType) {
              throw new StugbyError(400, "FLOORPLAN_REFERENCE_MISMATCH", "Floor-plan asset metadata does not match the staged content-addressed blob");
            }
            this.store.registerBlobReference(stugbyId, asset.image.digest, grant.id, grant.epoch, "relay");
          }
        }
        if (grantAudienceIncludes(grant, this.identity.nodeId)) {
          this.store.applyDatasetEvent(event);
          const policy = enabledDataset(grant, event.schema as StugbyDataset);
          if (floorPlan && policy?.allowReplicaCache && policy.retentionDays > 0) {
            for (const asset of floorPlan.assets) this.store.registerBlobReference(stugbyId, asset.image.digest, grant.id, grant.epoch, "replica");
          }
        }
        this.distribute(event, grant);
        if (floorPlan) this.deleteUnreferencedBlobs(this.store.releaseRelayReferencesWithoutAccess(stugbyId, grant.id, grant.epoch));
      }
      if (!this.store.recordInboxEvent(event)) { duplicates.push(event.eventId); continue; }
      accepted.push(event.eventId);
    }
    return { accepted, duplicates };
  }

  eventPage(actor: StugbyMember, stugbyId: string, cursor: number, limit: number): StugbyEventPage {
    this.requireCoordinator(stugbyId);
    this.deleteUnreferencedBlobs(this.store.acknowledgeEventCursor(stugbyId, actor.nodeId, cursor));
    const page = this.store.eventPage(stugbyId, actor.nodeId, cursor, limit);
    return { protocolVersion: STUGBY_PROTOCOL_VERSION, ...page };
  }

  private authorizeDatasetEvent(event: StugbySignedEvent): StugbyShareGrant {
    if (!isStugbyDataset(event.schema) || !event.grantId || event.grantEpoch === null) throw new StugbyError(400, "INVALID_DATASET_EVENT", "Dataset event requires a grant and epoch");
    const grant = this.store.getGrant(event.grantId);
    if (!grant || grant.authorityNodeId !== event.authorityNodeId || grant.stugbyId !== event.stugbyId
      || grant.epoch !== event.grantEpoch || grant.revokedAt || grantExpired(grant)
      || !enabledDataset(grant, event.schema)) {
      throw new StugbyError(403, "DATASET_NOT_GRANTED", "Dataset is not authorized by the active grant epoch");
    }
    if (event.operation === "upsert") validateDatasetPayload(event.schema, event.payload);
    return grant;
  }

  private verifyEvent(event: StugbySignedEvent, publicKey: string): void {
    if (event.keyFingerprint !== publicKeyFingerprint(publicKey)) throw new StugbyError(401, "EVENT_KEY_MISMATCH", "Event signing key does not match member identity");
    const expectedHash = sha256(canonicalJson(event.payload));
    if (expectedHash !== event.payloadHash) throw new StugbyError(400, "EVENT_HASH_MISMATCH", "Event payload hash is invalid");
    if (!this.keys.verify(eventSigningValue(event), event.signature, publicKey)) throw new StugbyError(401, "INVALID_EVENT_SIGNATURE", "Event signature is invalid");
  }

  async syncNow(stugbyId: string): Promise<StugbySummary> {
    this.requireStugby(stugbyId);
    await this.trackSync(this.syncOne(stugbyId, true));
    return this.requireStugby(stugbyId);
  }

  async syncAll(): Promise<void> {
    if (this.#syncing) return this.#syncing;
    const operation = (async () => {
      this.deleteUnreferencedBlobs(this.store.staleUnreferencedBlobs(new Date(Date.now() - 86_400_000).toISOString()));
      this.ensureNotificationStreams();
      for (const stugby of this.store.listStugbys()) {
        this.expireLocalGrants(stugby.id);
        if (this.store.isCoordinator(stugby.id) || !["active", "suspended"].includes(stugby.localMemberState)) continue;
        await this.syncOne(stugby.id, false);
      }
    })();
    this.#syncing = this.trackSync(operation).finally(() => { this.#syncing = null; });
    return this.#syncing;
  }

  private ensureNotificationStreams(): void {
    if (!this.#started) return;
    for (const [stugbyId, controller] of this.#streamControllers) {
      const stugby = this.store.getStugby(stugbyId);
      if (!stugby || !["active", "suspended"].includes(stugby.localMemberState) || this.store.isCoordinator(stugbyId)) {
        controller.abort();
        this.#streamControllers.delete(stugbyId);
      }
    }
    for (const stugby of this.store.listStugbys()) {
      if (this.store.isCoordinator(stugby.id) || !["active", "suspended"].includes(stugby.localMemberState) || this.#streamControllers.has(stugby.id)) continue;
      const controller = new AbortController();
      this.#streamControllers.set(stugby.id, controller);
      const task = this.notificationLoop(stugby.id, controller);
      this.#streamTasks.set(stugby.id, task);
      void task.then(
        () => { if (this.#streamTasks.get(stugby.id) === task) this.#streamTasks.delete(stugby.id); },
        () => { if (this.#streamTasks.get(stugby.id) === task) this.#streamTasks.delete(stugby.id); },
      );
    }
  }

  private async notificationLoop(stugbyId: string, controller: AbortController): Promise<void> {
    try {
      while (!controller.signal.aborted && this.#started) {
        try {
          const stugby = this.requireStugby(stugbyId);
          const cursor = this.store.pullCursor(stugbyId);
          const path = `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugbyId)}/events/stream?cursor=${cursor}`;
          const response = await this.signedFetch(stugby, path, { method: "GET", signal: controller.signal });
          if (!response.ok || !response.body) throw await this.remoteError(response, "Stugby notification stream failed");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffered = "";
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
            if (Buffer.byteLength(buffered) > 64 * 1024) {
              throw new StugbyError(502, "INVALID_NOTIFICATION_STREAM", "Coordinator returned an oversized Stugby notification frame");
            }
            let boundary = buffered.indexOf("\n\n");
            while (boundary >= 0) {
              const frame = buffered.slice(0, boundary);
              buffered = buffered.slice(boundary + 2);
              const eventName = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
              const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
              if (eventName === "available" && data) {
                const next = JSON.parse(data) as { cursor?: unknown };
                if (typeof next.cursor === "number" && next.cursor > this.store.pullCursor(stugbyId)) await this.syncAll();
              }
              boundary = buffered.indexOf("\n\n");
            }
          }
        } catch {
          if (controller.signal.aborted) break;
        }
        if (!controller.signal.aborted) await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 5_000);
          const abort = (): void => { clearTimeout(timer); resolve(); };
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
    } finally {
      if (this.#streamControllers.get(stugbyId) === controller) this.#streamControllers.delete(stugbyId);
    }
  }

  private async syncOne(stugbyId: string, throwOnError: boolean): Promise<void> {
    const stugby = this.requireStugby(stugbyId);
    this.expireLocalGrants(stugbyId);
    this.store.enforceRetention(stugbyId);
    this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugbyId));
    if (this.store.isCoordinator(stugbyId)) { this.store.recordSync(stugbyId, this.store.pullCursor(stugbyId), null); return; }
    try {
      if (stugby.localMemberState === "active") await this.flushOutbox(stugby);
      let cursor = this.store.pullCursor(stugbyId);
      let hasMore = true;
      while (hasMore) {
        const response = await this.signedFetch(stugby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugbyId)}/events?cursor=${cursor}&limit=100`, { method: "GET" });
        if (!response.ok) throw await this.remoteError(response, "Stugby event pull failed");
        const rawPage = recordValue(
          await this.readJsonResponse(response, STUGBY_MAX_EVENT_PAGE_BYTES + 64 * 1024, "Event page"),
          "Event page",
        );
        if (rawPage.protocolVersion !== STUGBY_PROTOCOL_VERSION || !Array.isArray(rawPage.events)
          || rawPage.events.length > 100 || !Number.isSafeInteger(rawPage.cursor) || Number(rawPage.cursor) < cursor
          || typeof rawPage.hasMore !== "boolean"
          || (rawPage.events.length > 0 && Number(rawPage.cursor) <= cursor)
          || (rawPage.events.length === 0 && Number(rawPage.cursor) !== cursor)
          || (rawPage.hasMore && rawPage.events.length === 0)) {
          throw new StugbyError(502, "INVALID_EVENT_PAGE", "Coordinator returned an invalid or non-progressing Stugby event page");
        }
        for (const candidate of rawPage.events) await this.applyPulledEvent(stugby, validateSignedEvent(candidate));
        cursor = Number(rawPage.cursor);
        hasMore = rawPage.hasMore;
        this.store.recordSync(stugbyId, cursor, null);
      }
      this.store.markRemoteCurrent(stugbyId);
      this.store.enforceRetention(stugbyId);
      this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugbyId));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "Stugby sync failed";
      this.store.recordSync(stugbyId, this.store.pullCursor(stugbyId), message);
      if (throwOnError) throw error;
    }
  }

  private expireLocalGrants(stugbyId: string): void {
    const now = new Date().toISOString();
    for (const grant of this.store.listGrants(stugbyId, this.identity.nodeId)) {
      if (grant.revokedAt || !grantExpired(grant, Date.parse(now))) continue;
      this.atomicPublication(() => {
        const revoked = this.store.revokeGrant(grant.id);
        this.store.discardOutboxGrantEpoch(stugbyId, grant.id, grant.epoch);
        this.publishGrant({ ...revoked, audience: grant.audience }, "grant.revoked");
        this.store.audit(stugbyId, "grant.expired", this.identity.nodeId, grant.id, { epoch: revoked.epoch }, now);
        this.store.retireLocalBlobReferences(stugbyId, grant.id, grant.epoch);
      });
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    }
  }

  private async flushOutbox(stugby: StugbySummary): Promise<void> {
    const queued = this.store.dueOutbox(STUGBY_MAX_BATCH_EVENTS).filter((item) => item.stugbyId === stugby.id);
    for (const item of queued) {
      try {
        await this.uploadReferencedBlobs(stugby, item);
        const batch: StugbyEventBatch = { protocolVersion: STUGBY_PROTOCOL_VERSION, events: [item.event] };
        const response = await this.signedFetch(stugby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugby.id)}/events`, {
          method: "POST",
          body: JSON.stringify(batch),
        });
        if (!response.ok) throw await this.remoteError(response, "Stugby event publish failed");
        this.store.acknowledgeOutbox([item.id]);
      } catch (error) {
        this.store.failOutbox(item.id, item.attempts);
        throw error;
      }
    }
  }

  private async uploadReferencedBlobs(stugby: StugbySummary, item: StugbyOutboxItem): Promise<void> {
    if (item.event.schema !== "home.floorplan.v1" || item.event.operation !== "upsert") return;
    const payload = item.event.payload as unknown as StugbyHomeFloorPlanPayload;
    for (const asset of payload.assets) {
      const blob = this.readBlob(asset.image.digest);
      const response = await this.signedFetch(stugby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugby.id)}/blobs/${asset.image.digest}`, {
        method: "PUT",
        body: blob.data,
        contentType: blob.mediaType,
      });
      if (!response.ok) throw await this.remoteError(response, "Stugby floor-plan asset upload failed");
    }
  }

  private async applyPulledEvent(stugby: StugbySummary, event: StugbySignedEvent): Promise<void> {
    if (event.stugbyId !== stugby.id) throw new StugbyError(502, "EVENT_STUGBY_MISMATCH", "Coordinator returned an event for another Stugby");
    const authority = this.store.getMember(stugby.id, event.authorityNodeId);
    if (!authority) throw new StugbyError(502, "UNKNOWN_EVENT_AUTHORITY", "Coordinator returned an event from an unknown node");
    this.verifyEvent(event, authority.publicKey);
    const inboxStatus = this.store.inboxEventStatus(event);
    if (inboxStatus === "duplicate") {
      if (event.schema === "stugby.grant.v1" && event.operation === "tombstone" && event.grantId && event.grantEpoch !== null) {
        const receipt = this.store.getDeletionReceipt(stugby.id, this.identity.nodeId, event.grantId, event.grantEpoch);
        if (receipt) await this.sendDeletionReceipt(stugby, receipt);
      }
      return;
    }
    if (inboxStatus === "non-monotonic") throw new StugbyError(502, "NON_MONOTONIC_EVENT", "Coordinator returned a non-monotonic event sequence");
    if (event.schema === "stugby.member.v1" && event.operation === "upsert") {
      if (event.authorityNodeId !== stugby.coordinatorNodeId) throw new StugbyError(502, "INVALID_MEMBER_AUTHORITY", "Only the coordinator may publish membership events");
      const member = validatedMember(event.payload, stugby.id);
      const existingMember = this.store.getMember(stugby.id, member.nodeId);
      if (event.resourceId !== member.nodeId || (member.role === "steward" && member.nodeId !== stugby.coordinatorNodeId)
        || (member.nodeId === stugby.coordinatorNodeId && (member.role !== "steward" || member.state !== "active"))
        || (existingMember && (existingMember.publicKey !== member.publicKey
          || member.updatedAt < existingMember.updatedAt
          || (member.updatedAt === existingMember.updatedAt
            && canonicalJson(asJson(member)) !== canonicalJson(asJson(existingMember)))))) {
        throw new StugbyError(502, "INVALID_MEMBER_EVENT", "Member event conflicts with the pinned Stugby membership");
      }
      this.store.upsertMember(member);
      if (member.nodeId === this.identity.nodeId && member.state !== "active") {
        this.store.purgeDepartedReplicas(stugby.id);
        this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugby.id));
        this.#streamControllers.get(stugby.id)?.abort();
        this.#streamControllers.delete(stugby.id);
      }
      if (member.state === "active" && member.nodeId !== this.identity.nodeId) {
        for (const grant of this.store.listGrants(stugby.id, this.identity.nodeId)) {
          if (!grant.revokedAt && !grantExpired(grant) && grant.audience.kind === "all-members") {
            const house = this.database.getHouse(grant.localHouseId ?? "");
            if (house) {
              this.publishGrant(grant, "grant.upserted");
              this.publishGrantSnapshots(grant, house);
            }
          }
        }
      }
      this.store.recordInboxEvent(event);
      return;
    }
    if (event.schema === "stugby.shared-property.v1" && event.operation === "upsert") {
      if (event.authorityNodeId !== stugby.coordinatorNodeId || event.resourceId !== stugby.id) {
        throw new StugbyError(502, "INVALID_PROPERTY_AUTHORITY", "Only the coordinator may publish the shared property aggregate");
      }
      const property = validateSharedProperty(event.payload);
      if (property.stugbyId !== stugby.id || property.revision !== event.revision) throw new StugbyError(502, "INVALID_PROPERTY_EVENT", "Shared property payload does not match its event envelope");
      const existingProperty = this.store.getSharedProperty(stugby.id);
      if (existingProperty && (property.revision < existingProperty.revision
        || (property.revision === existingProperty.revision
          && canonicalJson(asJson(property)) !== canonicalJson(asJson(existingProperty))))) {
        throw new StugbyError(502, "PROPERTY_VERSION_CONFLICT", "Shared property revision is stale or conflicts with the stored revision");
      }
      this.store.saveSharedProperty(property);
      this.store.recordInboxEvent(event);
      return;
    }
    if (event.schema === "stugby.grant.v1") {
      if (authority.state !== "active" || authority.role === "viewer") throw new StugbyError(502, "INVALID_GRANT_AUTHORITY", "Grant authority is not an active publishing member");
      if (event.operation === "upsert") {
        const grant = validateShareGrant(event.payload);
        if (grant.stugbyId !== stugby.id || grant.authorityNodeId !== event.authorityNodeId || grant.id !== event.grantId
          || grant.id !== event.resourceId || grant.epoch !== event.grantEpoch || grant.revision !== event.revision
          || !grantAudienceIncludes(grant, this.identity.nodeId)) {
          throw new StugbyError(502, "INVALID_GRANT_EVENT", "Coordinator returned a grant that does not match its signed envelope or local audience");
        }
        if (grantExpired(grant)) throw new StugbyError(502, "EXPIRED_GRANT_EVENT", "Coordinator returned an expired grant");
        validateGrantTransition(this.store.getGrant(grant.id), grant, 502);
        this.store.upsertGrant(grant);
      }
      else if (event.grantId && event.grantEpoch !== null) {
        const existing = this.store.getGrant(event.grantId);
        if (existing) {
          const alreadyApplied = existing.authorityNodeId === event.authorityNodeId && event.resourceId === existing.id
            && existing.epoch === event.grantEpoch && existing.revision === event.revision
            && existing.revokedAt === event.occurredAt;
          if (!alreadyApplied && (existing.authorityNodeId !== event.authorityNodeId || event.resourceId !== existing.id
            || event.grantEpoch !== existing.epoch + 1 || event.revision !== existing.revision + 1)) {
            throw new StugbyError(502, "INVALID_REVOCATION", "Coordinator returned a non-monotonic grant revocation");
          }
          if (!alreadyApplied) {
            const revoked = { ...existing, epoch: event.grantEpoch, revision: event.revision, revokedAt: event.occurredAt, updatedAt: event.occurredAt };
            this.store.upsertGrant(revoked);
          }
          const receipt = this.store.getDeletionReceipt(stugby.id, this.identity.nodeId, event.grantId, event.grantEpoch)
            ?? this.store.purgeGrantData(stugby.id, event.grantId, event.grantEpoch);
          this.deleteUnreferencedBlobs(this.store.purgeReplicaBlobReferences(stugby.id, event.grantId, event.grantEpoch));
          this.store.recordInboxEvent(event);
          await this.sendDeletionReceipt(stugby, receipt);
          return;
        }
      }
      this.store.recordInboxEvent(event);
      return;
    }
    if (authority.state !== "active" || authority.role === "viewer") throw new StugbyError(502, "INVALID_DATASET_AUTHORITY", "Dataset authority is not an active publishing member");
    const grant = this.authorizeDatasetEvent(event);
    if (!grantAudienceIncludes(grant, this.identity.nodeId)) throw new StugbyError(502, "DATASET_AUDIENCE_MISMATCH", "Coordinator returned a dataset outside this node's grant audience");
    this.store.applyDatasetEvent(event);
    const policy = enabledDataset(grant, event.schema as StugbyDataset);
    if (event.schema === "home.floorplan.v1" && event.operation === "upsert" && policy?.allowReplicaCache && policy.retentionDays > 0) {
      await this.downloadReferencedBlobs(stugby, event, event.payload as unknown as StugbyHomeFloorPlanPayload);
    }
    this.store.recordInboxEvent(event);
  }

  private async sendDeletionReceipt(stugby: StugbySummary, receipt: StugbyDeletionReceipt): Promise<void> {
    const response = await this.signedFetch(stugby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugby.id)}/deletion-receipts`, {
      method: "POST",
      body: JSON.stringify(receipt),
    });
    if (!response.ok) throw await this.remoteError(response, "Stugby deletion acknowledgement failed");
  }

  recordDeletionReceipt(actor: StugbyMember, receipt: StugbyDeletionReceipt): void {
    const raw = recordValue(receipt, "Deletion receipt");
    const normalized: StugbyDeletionReceipt = {
      stugbyId: requiredText(raw.stugbyId, "Stugby id", 100),
      nodeId: requiredText(raw.nodeId, "Node id", 100),
      grantId: requiredText(raw.grantId, "Grant id", 100),
      grantEpoch: Number(raw.grantEpoch),
      deletedAt: parseIso(requiredText(raw.deletedAt, "deletedAt", 100), "deletedAt"),
    };
    if (!Number.isSafeInteger(normalized.grantEpoch) || normalized.grantEpoch < 1
      || normalized.nodeId !== actor.nodeId || normalized.stugbyId !== actor.stugbyId) {
      throw new StugbyError(400, "INVALID_DELETION_RECEIPT", "Deletion receipt identity or epoch is invalid");
    }
    const result = this.store.processDeletionReceipt(normalized);
    if (result === "unexpected") {
      throw new StugbyError(409, "DELETION_NOT_EXPECTED", "No matching deletion acknowledgement is pending for this node");
    }
    if (result === "conflict") {
      throw new StugbyError(409, "DELETION_RECEIPT_CONFLICT", "A different deletion receipt is already pinned for this grant epoch");
    }
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
  }

  private async downloadReferencedBlobs(stugby: StugbySummary, event: StugbySignedEvent, payload: StugbyHomeFloorPlanPayload): Promise<void> {
    if (!event.grantId || event.grantEpoch === null) throw new StugbyError(502, "INVALID_FLOORPLAN_EVENT", "Floor-plan event is missing its grant identity");
    for (const asset of payload.assets) {
      const existing = this.store.getBlob(asset.image.digest);
      if (existing && (existing.byteLength !== asset.image.byteLength || existing.mediaType !== asset.image.mediaType)) {
        throw new StugbyError(502, "FLOORPLAN_REFERENCE_MISMATCH", "Stored floor-plan asset metadata does not match its signed reference");
      }
      if (!existing) {
        const response = await this.signedFetch(stugby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugby.id)}/blobs/${asset.image.digest}`, { method: "GET" });
        if (!response.ok) throw await this.remoteError(response, "Stugby floor-plan asset download failed");
        const data = await this.readBoundedResponse(
          response,
          asset.image.byteLength,
          "REMOTE_BLOB_TOO_LARGE",
          "Coordinator returned a floor-plan asset larger than its signed byte length",
        );
        const stored = this.storeBlob(data, response.headers.get("content-type") ?? asset.image.mediaType, asset.image.digest);
        if (stored.byteLength !== asset.image.byteLength || stored.mediaType !== asset.image.mediaType) {
          throw new StugbyError(502, "FLOORPLAN_REFERENCE_MISMATCH", "Downloaded floor-plan asset metadata does not match its signed reference");
        }
      }
      this.store.registerBlobReference(stugby.id, asset.image.digest, event.grantId, event.grantEpoch, "replica");
    }
  }

  private async signedFetch(stugby: StugbySummary, path: string, input: { method: string; body?: string | Uint8Array; contentType?: string; signal?: AbortSignal }): Promise<Response> {
    const body = typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body ?? new Uint8Array();
    const timestamp = new Date().toISOString();
    const requestId = randomUUID();
    const signature = this.keys.sign(requestSigningValue({
      method: input.method,
      path,
      bodyHash: sha256(body),
      timestamp,
      requestId,
      nodeId: this.identity.nodeId,
    }));
    const signals = [this.#lifecycleController.signal, AbortSignal.timeout(input.signal ? 60_000 : 30_000)];
    if (input.signal) signals.push(input.signal);
    return this.#fetcher(`${stugby.coordinatorUrl}${path}`, {
      method: input.method,
      headers: {
        "accept": STUGBY_MEDIA_TYPE,
        "content-type": input.contentType ?? STUGBY_MEDIA_TYPE,
        "x-stugby-protocol": STUGBY_PROTOCOL_VERSION,
        "x-stugby-node-id": this.identity.nodeId,
        "x-stugby-timestamp": timestamp,
        "x-stugby-request-id": requestId,
        "x-stugby-signature": signature,
      },
      ...(body.byteLength ? { body: Buffer.from(body) } : {}),
      signal: AbortSignal.any(signals),
      redirect: "error",
    });
  }

  private async readBoundedResponse(response: Response, maximumBytes: number, code: string, message: string): Promise<Uint8Array> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new StugbyError(502, code, message);
      }
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const body = new Uint8Array(maximumBytes);
    let total = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const nextTotal = total + chunk.value.byteLength;
      if (nextTotal > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new StugbyError(502, code, message);
      }
      body.set(chunk.value, total);
      total = nextTotal;
    }
    return body.slice(0, total);
  }

  private async remoteError(response: Response, fallback: string): Promise<StugbyError> {
    let detail = fallback;
    try {
      const body = await this.readJsonResponse(response, 64 * 1024, "Remote error") as {
        error?: { message?: string; code?: string };
        message?: string;
      };
      detail = body.error?.message ?? body.message ?? fallback;
      return new StugbyError(response.status, body.error?.code ?? "REMOTE_ERROR", detail);
    } catch {
      return new StugbyError(response.status, "REMOTE_ERROR", detail);
    }
  }

  private async readJsonResponse(response: Response, maximumBytes: number, label: string): Promise<unknown> {
    const bytes = await this.readBoundedResponse(
      response,
      maximumBytes,
      "REMOTE_RESPONSE_TOO_LARGE",
      `${label} exceeds the maximum accepted size`,
    );
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new StugbyError(502, "INVALID_REMOTE_JSON", `${label} is not valid JSON`);
    }
  }

  private storeDataUrl(value: string): { digest: string; byteLength: number; mediaType: "image/png" | "image/jpeg" | "image/webp" } {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!match) throw new StugbyError(400, "INVALID_FLOORPLAN_ASSET", "Floor-plan image must be a PNG, JPEG, or WebP data URL");
    return this.storeBlob(Buffer.from(match[2]!, "base64"), match[1]!);
  }

  storeBlob(data: Uint8Array, mediaType: string, expectedDigest?: string): { digest: string; byteLength: number; mediaType: "image/png" | "image/jpeg" | "image/webp" } {
    if (data.byteLength === 0 || data.byteLength > STUGBY_MAX_BLOB_BYTES) throw new StugbyError(413, "BLOB_SIZE_INVALID", `Stugby assets must be between 1 and ${STUGBY_MAX_BLOB_BYTES} bytes`);
    if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType)) throw new StugbyError(415, "BLOB_TYPE_INVALID", "Only PNG, JPEG, and WebP floor-plan assets are accepted");
    const bytes = Buffer.from(data);
    const signatureValid = mediaType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mediaType === "image/jpeg" ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!signatureValid) throw new StugbyError(415, "BLOB_SIGNATURE_INVALID", "Floor-plan asset signature does not match its media type");
    const digest = sha256(bytes);
    if (expectedDigest && digest !== expectedDigest) throw new StugbyError(400, "BLOB_DIGEST_MISMATCH", "Floor-plan asset digest does not match its reference");
    const existing = this.store.getBlob(digest);
    if (existing && (existing.byteLength !== bytes.byteLength || existing.mediaType !== mediaType || existing.relativePath !== digest)) {
      throw new StugbyError(409, "BLOB_METADATA_CONFLICT", "Existing Stugby asset metadata conflicts with the uploaded bytes");
    }
    const finalPath = join(this.#assetDirectory, digest);
    if (!existsSync(finalPath)) {
      durableAtomicWriteFileSync(finalPath, bytes, { mode: 0o600 });
    }
    this.store.registerBlob(digest, bytes.byteLength, mediaType, digest);
    return { digest, byteLength: bytes.byteLength, mediaType: mediaType as "image/png" | "image/jpeg" | "image/webp" };
  }

  storeUploadedBlob(member: StugbyMember, stugbyId: string, data: Uint8Array, mediaType: string, expectedDigest: string): ReturnType<StugbyService["storeBlob"]> {
    if (member.stugbyId !== stugbyId || member.role === "viewer") {
      throw new StugbyError(403, "VIEWER_CANNOT_PUBLISH", "An active publishing member is required to upload federation assets");
    }
    const alreadyStored = this.store.getBlob(expectedDigest);
    if (!alreadyStored && this.store.unreferencedBlobBytes() + data.byteLength > STUGBY_MAX_STAGED_BLOB_BYTES) {
      throw new StugbyError(507, "BLOB_STAGING_QUOTA", "The coordinator's unreferenced Stugby asset staging quota is full");
    }
    return this.storeBlob(data, mediaType, expectedDigest);
  }

  private deleteUnreferencedBlobs(digests: string[]): void {
    for (const digest of new Set(digests)) {
      if (!/^[a-f0-9]{64}$/.test(digest) || this.store.hasBlobReferences(digest)) continue;
      try {
        const metadata = this.store.getBlob(digest);
        if (metadata) {
          const path = join(this.#assetDirectory, digest);
          if (existsSync(path)) unlinkSync(path);
        }
        this.store.unregisterBlob(digest);
      } catch {
        // The durable queue is retried on service start, synchronization, or
        // an identical deletion receipt. Never turn a committed consent
        // transition into a failed HTTP response because unlink was transient.
      }
    }
  }

  readBlob(digest: string): { data: Buffer; mediaType: string } {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new StugbyError(400, "INVALID_BLOB_DIGEST", "Invalid Stugby asset digest");
    const metadata = this.store.getBlob(digest);
    if (!metadata) throw new StugbyError(404, "BLOB_NOT_FOUND", "Stugby asset was not found");
    if (metadata.relativePath !== digest) throw new StugbyError(500, "BLOB_METADATA_INVALID", "Stored Stugby asset metadata is invalid");
    const data = readFileSync(join(this.#assetDirectory, digest));
    if (data.byteLength !== metadata.byteLength || sha256(data) !== digest) throw new StugbyError(500, "BLOB_INTEGRITY_FAILURE", "Stored Stugby asset failed integrity verification");
    return { data, mediaType: metadata.mediaType };
  }

  readBlobFor(member: StugbyMember, stugbyId: string, digest: string): { data: Buffer; mediaType: string } {
    if (member.stugbyId !== stugbyId || !this.store.canReadBlob(stugbyId, digest, member.nodeId)) {
      throw new StugbyError(404, "BLOB_NOT_FOUND", "Stugby asset was not found");
    }
    return this.readBlob(digest);
  }

  private requireStugby(id: string): StugbySummary {
    const stugby = this.store.getStugby(id);
    if (!stugby) throw new StugbyError(404, "STUGBY_NOT_FOUND", "Stugby was not found");
    return stugby;
  }

  private requireLocalPublisher(id: string): StugbySummary {
    const stugby = this.requireStugby(id);
    if (stugby.localMemberState !== "active" || stugby.localRole === "viewer") {
      throw new StugbyError(403, "PUBLISHING_FORBIDDEN", "An active steward, property manager, or participant node is required to publish Home data");
    }
    return stugby;
  }

  private requireCoordinator(id: string): StugbySummary {
    const stugby = this.requireStugby(id);
    if (!this.store.isCoordinator(id)) throw new StugbyError(409, "COORDINATOR_REQUIRED", "This operation must be performed by the Stugby coordinator");
    return stugby;
  }
}
