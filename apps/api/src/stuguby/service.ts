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
import type { ClimateDatabase } from "../db.js";
import type { TelemetryBus } from "../events.js";
import type { StugubyNodeKeys } from "./identity.js";
import { publicKeyFingerprint } from "./identity.js";
import { durableAtomicWriteFileSync } from "./durable-write.js";
import {
  StugubyStore,
  type StugubyAuthorityTransfer,
  type StugubyHomeProjection,
  type StugubyLocalInvitation,
  type StugubyLocalMember,
  type StugubyOutboxItem,
  type StugubyPropertyAdoption,
} from "./store.js";

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
  stugubyId: string;
  targetNodeId: string;
  cursor: number;
}

type SharedPropertyInput = Pick<StugubySharedProperty,
  "name" | "description" | "location" | "areas" | "equipment" | "notes" | "maintenance"
> & Partial<Pick<StugubySharedProperty, "editPolicy" | "designatedSuccessorNodeId">>;

const DATASET_SCHEMAS = new Set<string>([
  "home.directory.v1", "home.location.v1", "home.structure.v1", "home.floorplan.v1",
  "home.sensor-catalog.v1", "home.telemetry.v1", "home.notes.v1", "home.observations.v1",
  "home.recovery.v1",
]);
const STUGBY_MAX_STAGED_BLOB_BYTES = 256 * 1024 * 1024;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROPERTY_AREA_KINDS = new Set<PropertyAreaKind>([
  "well", "beach", "garage", "plantation", "garden", "field", "forest", "shoreline", "dock", "road",
  "yard", "building", "other",
]);

function recommendedHomeOverviewDatasets(): StugubyDatasetGrant[] {
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function recoveryAssetReferences(payload: StugubyHomeRecoveryPayload): StugubyBlobReference[] {
  if (payload.kind !== "assets") return [];
  return payload.records.map((record) => ({
    digest: String(record.digest),
    byteLength: Number(record.byteLength),
    mediaType: String(record.mimeType) as StugubyBlobMediaType,
  }));
}

function eventBlobReferences(event: StugubySignedEvent): StugubyBlobReference[] {
  if (event.operation !== "upsert") return [];
  if (event.schema === "home.floorplan.v1") {
    return (event.payload as unknown as StugubyHomeFloorPlanPayload).assets.map((asset) => asset.image);
  }
  if (event.schema === "home.recovery.v1") {
    return recoveryAssetReferences(event.payload as unknown as StugubyHomeRecoveryPayload);
  }
  return [];
}

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function normalizedBaseUrl(value: string): string {
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

function parseIso(value: string, label: string): string {
  const time = Date.parse(value);
  if (!ISO_DATE_TIME.test(value) || !Number.isFinite(time)) throw new StugubyError(400, "INVALID_TIMESTAMP", `${label} must be an ISO timestamp`);
  return new Date(time).toISOString();
}

function requiredText(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new StugubyError(400, "INVALID_INPUT", `${label} must contain 1 to ${maximum} characters`);
  }
  return value.trim();
}

function localLabel(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  return requiredText(value, "Private member label");
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StugubyError(400, "INVALID_INPUT", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function validatedNodeIdentity(value: unknown): StugubyNodeIdentity {
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

function validatedMember(value: unknown, stugubyId: string): StugubyMember {
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

function grantAudienceIncludes(grant: StugubyShareGrant, nodeId: string): boolean {
  return grant.audience.kind === "all-members" || grant.audience.nodeIds.includes(nodeId);
}

function enabledDataset(grant: StugubyShareGrant, dataset: StugubyDataset): StugubyDatasetGrant | null {
  return grant.datasets.find((item) => item.dataset === dataset && item.enabled) ?? null;
}

function grantExpired(grant: Pick<StugubyShareGrant, "expiresAt">, now = Date.now()): boolean {
  return Boolean(grant.expiresAt && Date.parse(grant.expiresAt) <= now);
}

function validateGrantTransition(existing: StugubyShareGrant | null, next: StugubyShareGrant, status: number): void {
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

function joinSigningValue(request: Pick<StugubyJoinRequest, "invitationId" | "joinSecret" | "identity">): string {
  return `${request.invitationId}\n${sha256(request.joinSecret)}\n${canonicalJson(asJson(request.identity))}`;
}

function withoutLocalGrantIdentity(grant: StugubyShareGrant): StugubyShareGrant {
  const wireGrant = { ...grant };
  delete wireGrant.localHouseId;
  return wireGrant;
}

export class StugubyService {
  readonly database: ClimateDatabase;
  readonly store: StugubyStore;
  readonly keys: StugubyNodeKeys;
  readonly suggestedPublicOrigin: string | null;
  readonly #deploymentPublicOrigin: boolean;
  readonly #uiPublicOriginAllowed: boolean;
  #publicOrigin: string | null;
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

  constructor(options: StugubyServiceOptions) {
    this.database = options.database;
    this.store = options.store;
    this.keys = options.keys;
    this.#bus = options.bus;
    this.#assetDirectory = join(options.assetDirectory, "stuguby");
    this.#fetcher = options.fetcher ?? fetch;
    this.#syncIntervalMs = Math.max(2_000, options.syncIntervalMs ?? 15_000);
    this.#deploymentPublicOrigin = Boolean(options.publicOrigin);
    this.#uiPublicOriginAllowed = options.allowUiPublicOrigin ?? true;
    this.suggestedPublicOrigin = options.suggestedPublicOrigin
      ? normalizedBaseUrl(options.suggestedPublicOrigin)
      : null;
    const storedPublicOrigin = this.#deploymentPublicOrigin ? null : this.store.getNodePublicOrigin();
    this.#publicOrigin = options.publicOrigin
      ? normalizedBaseUrl(options.publicOrigin)
      : storedPublicOrigin
        ? normalizedBaseUrl(storedPublicOrigin)
        : null;
    if (this.publicOrigin) this.store.reconcileUnjoinedCoordinatorOrigins(this.publicOrigin);
  }

  get publicOrigin(): string | null {
    return this.#publicOrigin;
  }

  get publicOriginConfigurable(): boolean {
    return !this.#deploymentPublicOrigin && this.#uiPublicOriginAllowed;
  }

  get identity(): StugubyNodeIdentity {
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
    this.#lifecycleController.abort(new Error("Stuguby service is stopping"));
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

  listStugubys(): StugubySummary[] { return this.store.listStugubys(); }
  getStuguby(id: string): StugubySummary { return this.requireStuguby(id); }

  async configurePublicOrigin(value: string): Promise<string> {
    const publicOrigin = normalizedBaseUrl(value);
    if (this.#deploymentPublicOrigin) {
      if (publicOrigin === this.publicOrigin) return publicOrigin;
      throw new StugubyError(
        409,
        "STUGBY_PUBLIC_ORIGIN_MANAGED",
        "The coordinator origin is managed by this deployment and cannot be changed in the UI",
      );
    }
    if (!this.#uiPublicOriginAllowed) {
      throw new StugubyError(
        409,
        "STUGBY_COORDINATOR_PROVISIONING_REQUIRED",
        "Reopen Stugu setup and choose Create a shared Stuguby for several homes",
      );
    }
    const establishedCoordinator = this.store.listStugubys().find((stuguby) => (
      this.store.isCoordinator(stuguby.id)
      && stuguby.coordinatorUrl !== publicOrigin
      && this.store.listMembers(stuguby.id).some((member) => member.nodeId !== this.identity.nodeId)
    ));
    if (establishedCoordinator) {
      throw new StugubyError(
        409,
        "STUGBY_COORDINATOR_ORIGIN_LOCKED",
        "A Stuguby with another node already uses a different coordinator origin",
      );
    }
    if (publicOrigin === this.publicOrigin) return publicOrigin;
    await this.verifyPublicOrigin(publicOrigin);
    this.store.setNodePublicOrigin(publicOrigin);
    this.#publicOrigin = publicOrigin;
    return publicOrigin;
  }

  private async verifyPublicOrigin(publicOrigin: string): Promise<void> {
    try {
      const response = await this.#fetcher(`${publicOrigin}/api/v1/stugby-protocol/join`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const body = await this.readBoundedResponse(
        response,
        8 * 1024,
        "STUGBY_ADDRESS_UNREACHABLE",
        "Stugu could not verify its secure address",
      );
      let errorCode: unknown;
      try {
        const payload = JSON.parse(Buffer.from(body).toString("utf8")) as { error?: { code?: unknown } };
        errorCode = payload.error?.code;
      } catch {
        errorCode = null;
      }
      if (
        ![400, 503].includes(response.status)
        || !["INVALID_BODY", "INVALID_INPUT", "STUGBY_PUBLIC_ORIGIN_REQUIRED"].includes(String(errorCode))
      ) {
        throw new Error(`Unexpected verification response ${response.status}`);
      }
    } catch {
      throw new StugubyError(
        422,
        "STUGBY_ADDRESS_UNREACHABLE",
        "Stugu could not reach its secure address. Check that the address opens this Stugu, then try again",
      );
    }
  }

  deleteStuguby(id: string): void {
    const stuguby = this.requireStuguby(id);
    if (this.store.getPropertyAdoption(id)?.state === "adopted") {
      throw new StugubyError(
        409,
        "STUGBY_PROPERTY_ADOPTED",
        "Permanently disconnect the adopted Property before deleting this Stuguby",
      );
    }
    const coordinator = this.store.isCoordinator(id);
    if (!coordinator && !["left", "revoked"].includes(stuguby.localMemberState)) {
      throw new StugubyError(
        409,
        "STUGBY_MEMBERSHIP_ACTIVE",
        "Leave this Stuguby or have its coordinator revoke this node before deleting the local record",
      );
    }
    const connectedMembers = coordinator ? this.store.listMembers(id).filter((member) => (
      member.nodeId !== this.identity.nodeId && !["left", "revoked"].includes(member.state)
    )) : [];
    if (connectedMembers.length > 0) {
      throw new StugubyError(
        409,
        "STUGBY_MEMBERS_ACTIVE",
        "Mark every other Stuguby member left or revoked before deleting this Stuguby",
      );
    }
    if (this.store.listGrants(id).some((grant) => !grant.revokedAt)) {
      throw new StugubyError(
        409,
        "STUGBY_SHARING_ACTIVE",
        "Revoke every active Home sharing grant before deleting this Stuguby",
      );
    }
    if (this.store.pendingDeletionsForStuguby(id) > 0) {
      throw new StugubyError(
        409,
        "STUGBY_DELETION_PENDING",
        "Wait for every replica deletion acknowledgement before deleting this Stuguby",
      );
    }

    const outgoingStream = this.#streamControllers.get(id);
    outgoingStream?.abort();
    this.#streamControllers.delete(id);
    for (const [key, close] of this.#incomingNotificationStreams) {
      if (!key.startsWith(`${id}\n`)) continue;
      this.#incomingNotificationStreams.delete(key);
      close();
    }
    if (this.#deferredNotifications) {
      this.#deferredNotifications = this.#deferredNotifications.filter((notification) => notification.stugubyId !== id);
    }
    this.database.clearStugubyLinks(id);
    this.deleteUnreferencedBlobs(this.store.deleteStuguby(id));
  }

  createStuguby(input: { name: string; description?: string | null; coordinatorUrl: string }): StugubySummary {
    const summary = this.store.createCoordinatedStuguby({
      name: requiredText(input.name, "Name"),
      description: typeof input.description === "string" ? input.description.trim().slice(0, 2_000) || null : null,
      coordinatorUrl: normalizedBaseUrl(input.coordinatorUrl),
    }, this.identity);
    return summary;
  }

  createInvitation(stugubyId: string, input: {
    role: Exclude<StugubyRole, "steward">;
    expiresAt?: string;
    localLabel?: unknown;
  }): StugubyLocalInvitation & { joinSecret: string; joinUrl: string } {
    const stuguby = this.requireReadyCoordinator(stugubyId);
    if (!["property-manager", "participant", "viewer"].includes(input.role)) {
      throw new StugubyError(400, "INVALID_ROLE", "Invitation role must be property-manager, participant, or viewer");
    }
    const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : new Date(Date.now() + 7 * 86_400_000).toISOString();
    if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 30 * 86_400_000) {
      throw new StugubyError(400, "INVALID_EXPIRY", "Invitation expiry must be within the next 30 days");
    }
    const joinSecret = randomBytes(32).toString("base64url");
    const invitation = this.store.createInvitation({
      stugubyId,
      localLabel: localLabel(input.localLabel),
      role: input.role,
      secretHash: sha256(joinSecret),
      expiresAt,
      coordinatorUrl: stuguby.coordinatorUrl,
    });
    const joinUrl = `${stuguby.coordinatorUrl}/invite-bootstrap#${encodeURIComponent(invitation.id)}.${joinSecret}`;
    return { ...invitation, joinSecret, joinUrl };
  }

  revokeInvitation(stugubyId: string, invitationId: string): void {
    this.requireCoordinator(stugubyId);
    const invitation = this.store.listInvitations(stugubyId).find((candidate) => candidate.id === invitationId);
    if (!invitation) throw new StugubyError(404, "INVITATION_NOT_FOUND", "Stuguby invitation was not found");
    if (invitation.usedAt || invitation.revokedAt) throw new StugubyError(409, "INVITATION_INACTIVE", "Only an unused active invitation can be revoked");
    this.store.revokeInvitation(stugubyId, invitationId);
  }

  assertGrantScope(stugubyId: string, grantId: string): void {
    const grant = this.store.getGrant(grantId);
    if (!grant || grant.stugubyId !== stugubyId) throw new StugubyError(404, "GRANT_NOT_FOUND", "Share grant was not found in this Stuguby");
  }

  async joinStuguby(input: { coordinatorUrl: string; invitationId: string; joinSecret: string }): Promise<StugubySummary> {
    const coordinatorUrl = normalizedBaseUrl(input.coordinatorUrl);
    const unsigned: Omit<StugubyJoinRequest, "signature"> = {
      invitationId: requiredText(input.invitationId, "Invitation id", 200),
      joinSecret: requiredText(input.joinSecret, "Join secret", 500),
      identity: this.identity,
    };
    const request: StugubyJoinRequest = { ...unsigned, signature: this.keys.sign(joinSigningValue(unsigned)) };
    const response = await this.#fetcher(`${coordinatorUrl}/api/v1/stugby-protocol/join`, {
      method: "POST",
      headers: { "content-type": STUGBY_MEDIA_TYPE, "accept": STUGBY_MEDIA_TYPE },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.any([this.#lifecycleController.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw await this.remoteError(response, "Stuguby join failed");
    let joined: StugubyJoinResponse;
    try {
      const raw = recordValue(await this.readJsonResponse(response, 2 * 1024 * 1024, "Join response"), "Join response");
      const rawSummary = recordValue(raw.stuguby, "Joined Stuguby");
      const stugubyId = requiredText(rawSummary.id, "Stuguby id", 100);
      const coordinatorIdentity = validatedNodeIdentity(raw.coordinatorIdentity);
      const rawMembers = Array.isArray(raw.members) ? raw.members : [];
      if (!rawMembers.length || rawMembers.length > 1_000) throw new Error("Invalid member list");
      const members = rawMembers.map((member) => validatedMember(member, stugubyId));
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
        stuguby: {
          id: stugubyId,
          name: requiredText(rawSummary.name, "Stuguby name"),
          description: rawSummary.description === null ? null : requiredText(rawSummary.description, "Stuguby description", 2_000),
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
      throw new StugubyError(502, "INVALID_JOIN_RESPONSE", error instanceof Error ? `Coordinator returned an invalid join response: ${error.message}` : "Coordinator returned an invalid join response");
    }
    const existingStuguby = this.store.getStuguby(joined.stuguby.id);
    if (existingStuguby) {
      const existingMember = this.store.getMember(joined.stuguby.id, this.identity.nodeId);
      if (existingStuguby.coordinatorUrl === coordinatorUrl
        && existingStuguby.coordinatorNodeId === joined.stuguby.coordinatorNodeId
        && existingMember?.publicKey === this.identity.publicKey
        && existingMember?.state === "active") {
        return existingStuguby;
      }
      throw new StugubyError(409, "STUGBY_ALREADY_EXISTS", "This Stugu has already joined a different Stuguby record with that id");
    }
    const local = joined.member;
    const saved = this.store.saveJoinedStuguby(joined.stuguby, joined.members, local);
    if (this.#started) this.ensureNotificationStreams();
    return saved;
  }

  acceptJoin(request: StugubyJoinRequest): StugubyJoinResponse {
    const raw = recordValue(request, "Join request");
    const normalized: StugubyJoinRequest = {
      invitationId: requiredText(raw.invitationId, "Invitation id", 200),
      joinSecret: requiredText(raw.joinSecret, "Join secret", 500),
      identity: validatedNodeIdentity(raw.identity),
      signature: requiredText(raw.signature, "Join signature", 512),
    };
    if (!this.keys.verify(joinSigningValue(normalized), normalized.signature, normalized.identity.publicKey)) {
      throw new StugubyError(401, "INVALID_JOIN_PROOF", "Join request proof is invalid");
    }
    const pendingInvitation = this.store.getInvitation(normalized.invitationId);
    if (pendingInvitation) this.requireReadyCoordinator(pendingInvitation.stugubyId);
    const secretHash = sha256(normalized.joinSecret);
    const admission = this.store.admitInvitation(normalized.invitationId, secretHash, normalized.identity);
    if (admission.status === "invalid") {
      throw new StugubyError(401, "INVALID_INVITATION", "Invitation is invalid, expired, revoked, used by another node, or otherwise inactive");
    }
    if (admission.status === "node-conflict") {
      throw new StugubyError(409, "NODE_ALREADY_MEMBER", "That node identity is already registered in this Stuguby");
    }
    const stuguby = this.requireReadyCoordinator(admission.invitation.stugubyId);
    const member = admission.member;
    if (!admission.provisioned) {
      this.publishMember(member);
      for (const existing of this.store.listMembers(stuguby.id)) this.sendMemberSnapshot(existing, member.nodeId);
      const property = this.store.getSharedProperty(stuguby.id);
      if (property) this.sendSharedPropertySnapshot(property, member.nodeId);
      for (const grant of this.store.listGrants(stuguby.id, this.identity.nodeId)) {
        if (grant.audience.kind !== "all-members" || grant.revokedAt || grantExpired(grant)) continue;
        const house = this.database.getHouse(grant.localHouseId ?? "");
        if (house) {
          this.publishGrant(grant, "grant.upserted");
          this.publishGrantSnapshots(grant, house);
        }
      }
      this.store.markInvitationProvisioned(admission.invitation.id, member.nodeId);
    }
    const participantSummary: StugubySummary = {
      ...this.store.getStuguby(stuguby.id)!,
      localRole: member.role,
      localMemberState: member.state,
    };
    return {
      stuguby: participantSummary,
      member,
      members: this.store.listMembers(stuguby.id),
      coordinatorIdentity: this.identity,
      cursor: 0,
    };
  }

  updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember {
    const stuguby = this.requireCoordinator(stugubyId);
    if (!(["steward", "property-manager", "participant", "viewer"] as string[]).includes(role)
      || !(["active", "suspended", "left", "revoked"] as string[]).includes(state)) {
      throw new StugubyError(400, "INVALID_MEMBERSHIP", "Invalid Stuguby role or membership state");
    }
    const existingMember = this.store.getMember(stugubyId, nodeId);
    if (!existingMember) throw new StugubyError(404, "MEMBER_NOT_FOUND", "Stuguby member was not found");
    if (role === "steward" && nodeId !== stuguby.coordinatorNodeId) throw new StugubyError(400, "INVALID_STEWARD", "Only the coordinator node can hold the steward role");
    if (nodeId === stuguby.coordinatorNodeId && (role !== "steward" || state !== "active")) {
      throw new StugubyError(409, "COORDINATOR_REQUIRED", "The coordinator steward cannot be demoted or deactivated");
    }
    // Expiry stops new reads immediately, but an unretired expired grant still
    // needs its tombstone/deletion handshake before either endpoint can leave.
    const activeGrants = this.store.listGrants(stugubyId).filter((grant) => !grant.revokedAt
        && (grant.authorityNodeId === nodeId || grantAudienceIncludes(grant, nodeId)));
    if (state !== "active") {
      if (activeGrants.length > 0) {
        throw new StugubyError(409, "MEMBER_DATA_STILL_SHARED", "Revoke or narrow every grant involving this node before deactivating its membership");
      }
      if (this.store.pendingDeletions(stugubyId, nodeId) > 0) {
        throw new StugubyError(409, "DELETION_ACK_PENDING", "Wait for this node to synchronize and acknowledge deletion before deactivating it");
      }
    }
    if (role === "viewer" && activeGrants.some((grant) => grant.authorityNodeId === nodeId)) {
      throw new StugubyError(409, "PUBLISHER_GRANT_ACTIVE", "Revoke this node's active Home grants before changing it to the read-only viewer role");
    }
    return this.atomicPublication(() => {
      const updated = this.store.updateMember(stugubyId, nodeId, role, state);
      this.publishMember(updated);
      if (updated.state === "active" && existingMember.state !== "active" && updated.nodeId !== this.identity.nodeId) {
        const property = this.store.getSharedProperty(stugubyId);
        if (property) this.sendSharedPropertySnapshot(property, updated.nodeId);
        for (const grant of this.store.listGrants(stugubyId, this.identity.nodeId)) {
          if (grant.audience.kind !== "all-members" || grant.revokedAt || grantExpired(grant)) continue;
          const house = this.database.getHouse(grant.localHouseId ?? "");
          if (!house) throw new StugubyError(409, "GRANT_HOUSE_MISSING", "An active all-member grant references a missing local Home");
          this.publishGrant(grant, "grant.upserted");
          this.publishGrantSnapshots(grant, house);
        }
      }
      return updated;
    });
  }

  updateMemberLocalLabel(stugubyId: string, nodeId: string, value: unknown): StugubyLocalMember {
    this.requireStuguby(stugubyId);
    if (!this.store.getMember(stugubyId, nodeId)) {
      throw new StugubyError(404, "MEMBER_NOT_FOUND", "Stuguby member was not found");
    }
    return this.store.updateMemberLocalLabel(stugubyId, nodeId, localLabel(value));
  }

  async updateSharedProperty(stugubyId: string, baseRevision: number, input: SharedPropertyInput): Promise<StugubySharedProperty> {
    const stuguby = this.requireStuguby(stugubyId);
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new StugubyError(400, "INVALID_REVISION", "baseRevision must be a positive integer");
    if (!this.store.isCoordinator(stugubyId)) {
      if (stuguby.localRole !== "property-manager") throw new StugubyError(403, "PROPERTY_WRITE_FORBIDDEN", "Only a Stuguby steward or property manager may edit shared property data");
      const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/property`, {
        method: "PUT",
        body: JSON.stringify({ baseRevision, property: input }),
      });
      if (!response.ok) throw await this.remoteError(response, "Shared property update failed");
      const property = validateSharedProperty(await this.readJsonResponse(response, 2 * 1024 * 1024, "Shared property response"));
      this.store.saveSharedProperty(property);
      this.materializeSharedProperty(property);
      return property;
    }
    return this.updateSharedPropertyAs(this.identity.nodeId, stugubyId, baseRevision, input);
  }

  updateSharedPropertyAs(actorNodeId: string, stugubyId: string, baseRevision: number, input: SharedPropertyInput): StugubySharedProperty {
    this.requireCoordinator(stugubyId);
    const actor = this.store.getMember(stugubyId, actorNodeId);
    const existing = this.store.getSharedProperty(stugubyId);
    if (!actor || actor.state !== "active" || actor.role === "viewer"
      || (actorNodeId !== this.identity.nodeId && existing?.editPolicy === "read-only")) {
      throw new StugubyError(403, "PROPERTY_WRITE_FORBIDDEN", existing?.editPolicy === "read-only"
        ? "The coordinator has shared this Property as read-only"
        : "Only an active Stuguby member with editing access may edit shared Property data");
    }
    const designatedSuccessorNodeId = input.designatedSuccessorNodeId === undefined
      ? existing?.designatedSuccessorNodeId ?? null
      : input.designatedSuccessorNodeId;
    if (designatedSuccessorNodeId) {
      const successor = this.store.getMember(stugubyId, designatedSuccessorNodeId);
      if (!successor || successor.state !== "active" || successor.nodeId === this.identity.nodeId) {
        throw new StugubyError(400, "INVALID_SUCCESSOR", "The designated Property successor must be one active remote member");
      }
    }
    assertSafeFederationPayload(input);
    const now = new Date().toISOString();
    const property: StugubySharedProperty = {
      ...input,
      stugubyId,
      name: requiredText(input.name, "Property name"),
      editPolicy: input.editPolicy ?? existing?.editPolicy ?? "collaborative",
      authorityEpoch: existing?.authorityEpoch ?? 1,
      designatedSuccessorNodeId,
      revision: baseRevision + 1,
      updatedAt: now,
    };
    validateSharedProperty(property);
    const updated = this.atomicPublication(() => {
      try { this.store.saveSharedProperty(property, baseRevision); } catch (error) {
        throw new StugubyError(409, "REVISION_CONFLICT", error instanceof Error ? error.message : "Shared property revision conflict");
      }
      this.store.setPropertyFieldRevisions(stugubyId, "property", stugubyId, ["name", "description", "location"], property.revision);
      for (const [kind, values] of [
        ["area", property.areas],
        ["equipment", property.equipment],
        ["note", property.notes],
        ["maintenance", property.maintenance],
      ] as const) {
        for (const value of values) {
          this.store.setPropertyFieldRevisions(stugubyId, kind, value.id,
            Object.keys(value).filter((field) => field !== "id"), property.revision);
        }
      }
      this.store.audit(stugubyId, "shared-property.updated", actorNodeId, stugubyId, { revision: property.revision }, now);
      this.publishSharedPropertyEvent(property);
      return property;
    });
    this.materializeSharedProperty(updated);
    return updated;
  }

  adoptProperty(stugubyId: string, localPropertyId?: string): StugubyPropertyAdoption {
    const stuguby = this.requireStuguby(stugubyId);
    if (stuguby.localMemberState !== "active") {
      throw new StugubyError(409, "STUGBY_NOT_ACTIVE", "Reconnect this Stuguby membership before adopting its Property");
    }
    const existingAdoption = this.store.getPropertyAdoption(stugubyId);
    if (existingAdoption?.state === "adopted") return existingAdoption;
    const shared = this.store.getSharedProperty(stugubyId);
    if (!shared) throw new StugubyError(409, "SHARED_PROPERTY_NOT_READY", "Synchronize the Stuguby Property before adopting it");

    return this.atomicPublication(() => {
      let target: Property;
      if (localPropertyId) {
        if (!this.store.isCoordinator(stugubyId)) {
          throw new StugubyError(400, "MIGRATION_REQUIRED", "A Client uses the Host Property first, then moves its local Property into it");
        }
        const local = this.database.getProperty(localPropertyId);
        if (!local) throw new StugubyError(404, "PROPERTY_NOT_FOUND", "The local Property was not found");
        if (local.stuguby && local.stuguby.syncState !== "detached" && local.stuguby.stugubyId !== stugubyId) {
          throw new StugubyError(409, "PROPERTY_ALREADY_SHARED", "That Property already belongs to another Stuguby");
        }
        this.store.releaseDetachedProperty(local.id, stugubyId);
        for (const house of this.database.listHouses(local.id)) {
          if (house.stuguby?.syncState === "detached") this.database.setHouseStugubyLink(house.id, null);
        }
        target = local;
        this.registerLocalPropertyMappings(stuguby, target.id);
        const seeded = this.sharedPropertyFromLocal(stugubyId, target.id, shared);
        this.updateSharedPropertyAs(this.identity.nodeId, stugubyId, shared.revision, seeded);
      } else {
        target = this.database.createProperty({
          name: shared.name,
          description: shared.description,
          location: shared.location ? { ...shared.location, source: "manual" } : null,
        });
      }

      const current = this.store.getSharedProperty(stugubyId)!;
      const adoption = this.store.adoptProperty(stugubyId, target.id, current.revision);
      this.materializeSharedProperty(current);
      this.materializeAllRemoteHomes(stugubyId);
      if (this.store.isCoordinator(stugubyId)) {
        for (const house of this.database.listHouses(target.id)) {
          if (!house.stuguby || house.stuguby.ownership === "local") this.markLocalHouseInAdoptedProperty(house.id);
        }
      }
      this.store.audit(stugubyId, "property.adopted", this.identity.nodeId, target.id, {
        revision: current.revision,
        coordinatorOwned: this.store.isCoordinator(stugubyId),
      });
      return adoption;
    });
  }

  migrateProperty(stugubyId: string, sourcePropertyId: string): {
    adoption: StugubyPropertyAdoption;
    migrationSnapshotId: string;
    moved: ReturnType<ClimateDatabase["migratePropertyInto"]>;
    createdGrants: StugubyShareGrant[];
  } {
    const stuguby = this.requireStuguby(stugubyId);
    if (this.store.isCoordinator(stugubyId)) {
      throw new StugubyError(
        409,
        "HOST_PROPERTY_MIGRATION_NOT_ALLOWED",
        "The Host selects the shared Property directly. Moving a local Property into it is available only on Clients",
      );
    }
    this.requireLocalPublisher(stugubyId);
    const adoption = this.store.getPropertyAdoption(stugubyId);
    if (!adoption || adoption.state !== "adopted") {
      throw new StugubyError(409, "PROPERTY_NOT_ADOPTED", "Use the Host Property before moving a local Property into it");
    }
    const source = this.database.getProperty(requiredText(sourcePropertyId, "Source Property id"));
    if (!source) throw new StugubyError(404, "PROPERTY_NOT_FOUND", "The local Property was not found");
    if (source.id === adoption.localPropertyId) throw new StugubyError(409, "PROPERTY_MIGRATION_SAME_TARGET", "The selected Property is already adopted");
    if (source.stuguby && source.stuguby.syncState !== "detached") {
      throw new StugubyError(409, "PROPERTY_ALREADY_SHARED", "A shared Property cannot be migrated into another shared Property");
    }

    return this.atomicPublication(() => {
      this.store.releaseDetachedProperty(source.id, stugubyId);
      const houses = this.database.listHouses(source.id);
      const areas = this.database.listPropertyAreas(source.id);
      const equipment = this.database.listAreaEquipment({ propertyId: source.id });
      const notes = this.database.listPropertyNotes({ propertyId: source.id });
      const maintenance = this.database.listMaintenanceTasks({ propertyId: source.id });
      const snapshot = {
        property: source,
        houses,
        areas,
        equipment,
        notes,
        maintenance,
      } as unknown as JsonValue;
      const migrationSnapshotId = this.store.saveMigrationSnapshot(
        stugubyId,
        source.id,
        adoption.localPropertyId,
        snapshot,
      );

      for (const area of areas) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "area", area.id, area.id);
      for (const item of equipment) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "equipment", item.id, item.id);
      for (const note of notes) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "note", note.id, note.id);
      for (const task of maintenance) this.store.projectionId(stugubyId, stuguby.coordinatorNodeId, "maintenance", task.id, task.id);

      const houseLinks = Object.fromEntries(houses.map((house) => [house.id, {
        stugubyId,
        authorityNodeId: this.identity.nodeId,
        publicationId: this.store.publicationId(stugubyId, "home", house.id),
        ownership: "local",
        editPolicy: "editable",
        syncState: "current",
        authorityEpoch: 1,
        pendingChangeCount: 0,
        conflictCount: 0,
        recoveryState: "not-enabled",
      } satisfies StugubyHouseLink]));
      const moved = this.database.migratePropertyInto(source.id, adoption.localPropertyId, houseLinks);
      const createdGrants = houses.flatMap((house) => {
        const grant = this.ensureRecommendedHomeOverviewGrant(stugubyId, house.id);
        return grant ? [grant] : [];
      });

      for (const area of areas) this.enqueueCorePropertyMutation(stugubyId, "area", area.id, "upsert", this.sharedArea(area));
      for (const item of equipment) this.enqueueCorePropertyMutation(
        stugubyId,
        "equipment",
        item.id,
        "upsert",
        this.sharedEquipment(stugubyId, item),
      );
      for (const note of notes) this.enqueueCorePropertyMutation(stugubyId, "note", note.id, "upsert", this.sharedNote(note));
      for (const task of maintenance) this.enqueueCorePropertyMutation(stugubyId, "maintenance", task.id, "upsert", this.sharedMaintenance(task));
      this.refreshPropertyLink(stugubyId);
      this.store.audit(stugubyId, "property.migrated", this.identity.nodeId, source.id, {
        targetPropertyId: adoption.localPropertyId,
        migrationSnapshotId,
        houses: houses.length,
        areas: areas.length,
        equipment: equipment.length,
        overviewGrants: createdGrants.length,
      });
      return { adoption: this.store.getPropertyAdoption(stugubyId)!, migrationSnapshotId, moved, createdGrants };
    });
  }

  detachProperty(stugubyId: string): StugubyPropertyAdoption {
    const adoption = this.store.getPropertyAdoption(stugubyId);
    if (!adoption || adoption.state !== "adopted") {
      throw new StugubyError(409, "PROPERTY_NOT_ADOPTED", "An adopted Stuguby Property was not found");
    }
    const property = this.database.getProperty(adoption.localPropertyId);
    const propertyLink = property?.stuguby;
    if (!property || !propertyLink) throw new StugubyError(409, "PROPERTY_PROJECTION_MISSING", "The adopted Property projection is missing");
    const detached = this.atomicPublication(() => {
      const now = new Date().toISOString();
      const cancelledPropertyCommands = this.store.cancelPendingPropertyCommands(stugubyId, now);
      const cancelledHomeCommands = this.store.cancelPendingHomeCommands(stugubyId, now);
      const adoptedLocalHouseIds = new Set(this.database.listHouses(property.id)
        .filter((house) => house.stuguby?.stugubyId === stugubyId && house.stuguby.ownership === "local")
        .map((house) => house.id));
      const localGrants = this.store.listGrants(stugubyId, this.identity.nodeId)
        .filter((grant) => !grant.revokedAt && typeof grant.localHouseId === "string"
          && adoptedLocalHouseIds.has(grant.localHouseId));
      for (const grant of localGrants) {
        this.store.discardOutboxGrantEpoch(stugubyId, grant.id, grant.epoch);
        const revoked = this.store.revokeGrant(grant.id);
        this.publishGrant({ ...revoked, audience: grant.audience }, "grant.revoked");
        this.store.retireLocalBlobReferences(stugubyId, grant.id, grant.epoch);
        this.store.audit(stugubyId, "grant.revoked", this.identity.nodeId, grant.id, {
          epoch: revoked.epoch,
          reason: "property-disconnected",
        }, now);
      }
      this.database.setPropertyStugubyLink(property.id, {
        ...propertyLink,
        editPolicy: "collaborative",
        syncState: "detached",
        pendingChangeCount: 0,
        detachedAt: now,
      });
      for (const house of this.database.listHouses(property.id)) {
        if (!house.stuguby || house.stuguby.stugubyId !== stugubyId) continue;
        if (house.stuguby.ownership === "local") {
          this.database.setHouseStugubyLink(house.id, null);
          continue;
        }
        const isReadySuccessor = house.stuguby.recoveryState === "ready"
          && house.stuguby.designatedSuccessorNodeId === this.identity.nodeId;
        if (isReadySuccessor) {
          this.promoteFullRecovery(stugubyId, house);
          this.database.setHouseStugubyLink(house.id, {
            ...house.stuguby,
            authorityNodeId: this.identity.nodeId,
            ownership: "local",
            editPolicy: "editable",
            syncState: "detached",
            authorityEpoch: house.stuguby.authorityEpoch + 1,
            pendingChangeCount: 0,
            conflictCount: 0,
            detachedAt: now,
          });
        } else {
          this.database.deleteHouse(house.id);
        }
      }
      const detached = this.store.detachProperty(stugubyId, now);
      this.store.audit(stugubyId, "property.detached", this.identity.nodeId, property.id, {
        cancelledPropertyCommands,
        cancelledHomeCommands,
        revokedLocalGrants: localGrants.length,
      }, now);
      return detached;
    });
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    return detached;
  }

  private promoteFullRecovery(stugubyId: string, house: House): void {
    const link = house.stuguby;
    if (!link) throw new StugubyError(409, "RECOVERY_LINK_MISSING", "The Home recovery link is missing");
    const payloads = this.store.listRemoteResources(stugubyId)
      .filter((resource) => resource.authorityNodeId === link.authorityNodeId
        && resource.publicationId === link.publicationId
        && resource.schema === "home.recovery.v1")
      .map((resource) => resource.payload as unknown as StugubyHomeRecoveryPayload);
    const generation = Math.max(0, ...payloads.map((payload) => payload.generation));
    const current = payloads.filter((payload) => payload.generation === generation);
    const records = (kind: StugubyHomeRecoveryKind): JsonObject[] => current
      .filter((payload) => payload.kind === kind)
      .flatMap((payload) => payload.records);
    const projectionMap = (type: "floor" | "room" | "plan-element" | "sensor") => new Map(
      this.store.listProjectionIds(stugubyId, link.authorityNodeId, type)
        .map((projection) => [projection.remoteId, projection.localId]),
    );
    const floorIds = projectionMap("floor");
    const roomIds = projectionMap("room");
    const elementIds = projectionMap("plan-element");
    const sensorIds = projectionMap("sensor");

    this.database.transaction(() => {
      for (const definition of records("measurement-definitions")) {
        const id = String(definition.id);
        if (this.database.getMeasurementDefinition(id)) continue;
        this.database.createMeasurementDefinition({
          id,
          labels: definition.labels as Record<string, string>,
          unit: String(definition.unit),
          ...(typeof definition.dimension === "string" ? { dimension: definition.dimension } : {}),
          ...(Array.isArray(definition.allowedUnits) ? { allowedUnits: definition.allowedUnits as string[] } : {}),
          ...(typeof definition.kind === "string" ? { kind: definition.kind as never } : {}),
          ...(typeof definition.defaultAggregation === "string"
            ? { defaultAggregation: definition.defaultAggregation as never }
            : {}),
          genericHistoryEnabled: true,
          genericStatsEnabled: true,
          precision: Number(definition.precision),
          validMin: definition.validMin === null ? null : Number(definition.validMin),
          validMax: definition.validMax === null ? null : Number(definition.validMax),
          displayMin: definition.displayMin === null ? null : Number(definition.displayMin),
          displayMax: definition.displayMax === null ? null : Number(definition.displayMax),
          interpolationDelta: Number(definition.interpolationDelta),
          colorScale: definition.colorScale as never,
          builtin: false,
          enabled: Boolean(definition.enabled),
          spatialInterpolation: Boolean(definition.spatialInterpolation),
          forecastSupported: Boolean(definition.forecastSupported),
        });
      }

      const restoredRules = new Map<string, string>();
      for (const rule of records("alert-rules")) {
        const sensorId = sensorIds.get(String(rule.sensorPublicationId));
        if (!sensorId || !this.database.getMeasurementDefinition(String(rule.metric))) continue;
        const restored = this.database.saveAlertRule({
          name: String(rule.name),
          sensorId,
          metric: String(rule.metric),
          operator: rule.operator as never,
          threshold: Number(rule.threshold),
          durationSeconds: Number(rule.durationSeconds),
          severity: rule.severity as never,
          enabled: Boolean(rule.enabled),
          webhookEnabled: false,
          telegramEnabled: false,
        });
        restoredRules.set(String(rule.ruleKey), restored.id);
        if (rule.retiredAt) this.database.deleteAlertRule(restored.id);
      }
      const insertAlert = this.database.db.prepare(`INSERT OR IGNORE INTO alert_events
        (id,rule_id,sensor_id,metric,value,threshold,severity,started_at,acknowledged_at,resolved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for (const event of records("alert-events")) {
        const ruleId = restoredRules.get(String(event.ruleKey));
        const sensorId = sensorIds.get(String(event.sensorPublicationId));
        if (!ruleId || !sensorId) continue;
        insertAlert.run(
          String(event.eventKey),
          ruleId,
          sensorId,
          String(event.metric),
          Number(event.value),
          Number(event.threshold),
          String(event.severity),
          String(event.startedAt),
          event.acknowledgedAt === null ? null : String(event.acknowledgedAt),
          event.resolvedAt === null ? null : String(event.resolvedAt),
        );
      }

      for (const parameter of records("static-parameters")) {
        const scopeType = String(parameter.scopeType) as "house" | "floor" | "room" | "sensor";
        const remoteScopeId = String(parameter.scopePublicationId);
        const scopeId = scopeType === "house"
          ? house.id
          : scopeType === "floor"
            ? floorIds.get(remoteScopeId)
            : scopeType === "room"
              ? roomIds.get(remoteScopeId)
              : sensorIds.get(remoteScopeId);
        if (!scopeId) continue;
        this.database.saveParameter({
          houseId: house.id,
          scopeType,
          scopeId,
          key: String(parameter.key),
          value: parameter.value as string | number | boolean,
          unit: parameter.unit === null ? null : String(parameter.unit),
          label: String(parameter.label),
        });
      }

      for (const opening of records("opening-states")) {
        const floorId = floorIds.get(String(opening.floorPublicationId));
        const elementId = elementIds.get(String(opening.planElementPublicationId));
        if (!floorId || !elementId) continue;
        this.database.recordOpeningStateObservation(house.id, {
          floorId,
          elementId,
          state: opening.state as never,
          ...(opening.openFraction !== null ? { openFraction: Number(opening.openFraction) } : {}),
          source: "api",
          observedAt: String(opening.observedAt),
          ...(opening.validUntil ? { validUntil: String(opening.validUntil) } : {}),
        });
      }

      this.database.db.prepare("DELETE FROM outdoor_temperature_samples WHERE house_id=?").run(house.id);
      const insertWeather = this.database.db.prepare(`INSERT OR IGNORE INTO outdoor_temperature_samples
        (house_id,location_key,timestamp,temperature_c,source,fetched_at,station_id,station_name,conditions_json)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const weather of records("weather-history")) {
        insertWeather.run(
          house.id,
          String(weather.locationKey),
          String(weather.timestamp),
          Number(weather.temperatureC),
          String(weather.source),
          String(weather.fetchedAt),
          weather.stationId === null ? null : String(weather.stationId),
          weather.stationName === null ? null : String(weather.stationName),
          weather.conditions === null ? null : JSON.stringify(weather.conditions),
        );
      }
      const insertPrice = this.database.db.prepare(`INSERT INTO electricity_price_points
        (property_id,start_at,end_at,raw_price_cents_per_kwh,margin_cents_per_kwh,fetched_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(property_id,start_at) DO UPDATE SET
          end_at=excluded.end_at,raw_price_cents_per_kwh=excluded.raw_price_cents_per_kwh,
          margin_cents_per_kwh=excluded.margin_cents_per_kwh,fetched_at=excluded.fetched_at`);
      for (const price of records("electricity-history")) {
        insertPrice.run(
          house.propertyId,
          String(price.startAt),
          String(price.endAt),
          Number(price.rawPriceCentsPerKwh),
          Number(price.marginCentsPerKwh),
          String(price.fetchedAt),
        );
      }
      this.database.db.prepare("DELETE FROM assets WHERE house_id=?").run(house.id);
      const insertAsset = this.database.db.prepare(`INSERT INTO assets
        (id,house_id,name,mime_type,kind,data,size,created_at) VALUES (?,?,?,?,?,?,?,?)`);
      for (const asset of records("assets")) {
        const digest = String(asset.digest);
        const blob = this.readBlob(digest);
        if (blob.data.byteLength !== Number(asset.byteLength) || blob.mediaType !== String(asset.mimeType)) {
          throw new StugubyError(409, "RECOVERY_ASSET_INCOMPLETE", `Home asset ${String(asset.name)} is incomplete`);
        }
        const localId = this.store.projectionId(
          stugubyId,
          link.authorityNodeId,
          "asset",
          String(asset.assetKey),
        );
        insertAsset.run(
          localId,
          house.id,
          String(asset.name),
          String(asset.mimeType),
          String(asset.kind),
          blob.data,
          blob.data.byteLength,
          String(asset.createdAt),
        );
      }
      this.store.promoteRecoveryTelemetry(stugubyId, link.authorityNodeId, link.publicationId);
    });
    this.store.audit(stugubyId, "home.recovery.promoted", this.identity.nodeId, link.publicationId, {
      generation,
      integrationsTransferred: false,
    });
  }

  assertPropertyWriteAllowed(propertyId: string): void {
    const property = this.database.getProperty(propertyId);
    // Resource existence and its endpoint-specific error contract belong to
    // the caller. This guard only adds Stuguby authority policy.
    if (!property) return;
    if (!property.stuguby || property.stuguby.syncState === "detached") return;
    if (property.stuguby.editPolicy === "read-only" && property.stuguby.authorityNodeId !== this.identity.nodeId) {
      throw new StugubyError(403, "PROPERTY_READ_ONLY", "The Stuguby coordinator has shared this Property as read-only");
    }
  }

  assertHouseWriteAllowed(houseId: string): void {
    const house = this.database.getHouse(houseId);
    if (!house) return;
    if (!house.stuguby || house.stuguby.syncState === "detached" || house.stuguby.ownership === "local") return;
    if (house.stuguby.editPolicy === "read-only") {
      throw new StugubyError(403, "HOME_READ_ONLY", "This shared Home is read-only. Its owner can explicitly enable editing");
    }
  }

  assertHouseLocalAuthority(houseId: string): void {
    const house = this.database.getHouse(houseId);
    if (!house) return;
    if (!house.stuguby || house.stuguby.syncState === "detached" || house.stuguby.ownership === "local") return;
    throw new StugubyError(
      403,
      "HOME_LOCAL_AUTHORITY_REQUIRED",
      "This setting stays with the authoritative Home and is not shared through Stuguby",
    );
  }

  assertSharedHouseFloorPlanAssetsUnchanged(houseId: string, floors: Floor[]): void {
    const house = this.database.getHouse(houseId);
    if (!house) return;
    if (!house.stuguby || house.stuguby.syncState === "detached" || house.stuguby.ownership === "local") return;
    const current = new Map(house.floors.map((floor) => [floor.id, floor.backgroundImage]));
    if (floors.some((floor) => floor.backgroundImage !== current.get(floor.id))) {
      throw new StugubyError(
        403,
        "HOME_FLOORPLAN_ASSET_LOCAL_AUTHORITY",
        "Floor-plan images remain with the authoritative Home and are not changed through shared editing",
      );
    }
  }

  captureHomeMutation(houseId: string): StugubyHomeCommand | null {
    const house = this.database.getHouse(houseId);
    if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Home was not found");
    const link = house.stuguby;
    if (!link || link.syncState === "detached") return null;
    if (link.ownership === "local") {
      const grants = this.store.listGrants(link.stugubyId, this.identity.nodeId)
        .filter((grant) => grant.localHouseId === house.id && !grant.revokedAt && !grantExpired(grant));
      if (grants.length === 0) return null;
      this.atomicPublication(() => {
        const revision = this.store.bumpHomeRevision(link.stugubyId, this.identity.nodeId, link.publicationId);
        for (const grant of grants) this.publishGrantSnapshots(grant, house, revision);
        this.store.audit(link.stugubyId, "home.updated", this.identity.nodeId, link.publicationId, { revision });
      });
      return null;
    }
    this.assertHouseWriteAllowed(house.id);
    const grant = this.store.listGrants(link.stugubyId, link.authorityNodeId)
      .find((candidate) => candidate.publicationId === link.publicationId
        && candidate.housePolicy.editPolicy === "editable"
        && !candidate.revokedAt
        && !grantExpired(candidate)
        && grantAudienceIncludes(candidate, this.identity.nodeId));
    if (!grant) throw new StugubyError(409, "EDITABLE_HOME_GRANT_MISSING", "The editable Home grant is no longer active");
    const pending = this.store.pendingHomeCommandFor(link.stugubyId, link.authorityNodeId, link.publicationId);
    const resources = this.store.listRemoteResources(link.stugubyId)
      .filter((resource) => resource.authorityNodeId === link.authorityNodeId
        && resource.publicationId === link.publicationId);
    const baseRevision = pending?.command.baseRevision
      ?? Math.max(1, ...resources.map((resource) => resource.revision));
    const command: StugubyHomeCommand = {
      id: pending?.command.id ?? randomUUID(),
      stugubyId: link.stugubyId,
      actorNodeId: this.identity.nodeId,
      authorityNodeId: link.authorityNodeId,
      publicationId: link.publicationId,
      grantId: grant.id,
      grantEpoch: grant.epoch,
      authorityEpoch: link.authorityEpoch,
      baseRevision,
      snapshot: this.editableHomeSnapshot(house),
      createdAt: pending?.command.createdAt ?? new Date().toISOString(),
    };
    validateHomeCommand(command);
    this.store.enqueueHomeCommand(command);
    const commandCounts = this.store.homeCommandCountsFor(link.stugubyId, link.authorityNodeId, link.publicationId);
    this.database.setHouseStugubyLink(house.id, {
      ...link,
      syncState: "pending",
      pendingChangeCount: commandCounts.pending,
      conflictCount: commandCounts.conflicts,
    });
    this.store.audit(link.stugubyId, "home.command.queued", this.identity.nodeId, link.publicationId, {
      commandId: command.id,
      baseRevision,
    });
    return command;
  }

  private editableHomeSnapshot(house: House): StugubyHomeCommandSnapshot {
    const link = house.stuguby;
    if (!link || link.ownership !== "shared") throw new StugubyError(409, "HOME_NOT_SHARED", "The Home is not a shared projection");
    const remoteId = (
      type: "floor" | "room" | "wall" | "plan-element" | "sensor" | "home-note" | "observation",
      localId: string,
    ) => this.store.projectionRemoteId(link.stugubyId, link.authorityNodeId, type, localId);
    const structure = {
      publicationId: link.publicationId,
      floors: house.floors.map((floor) => {
        const walls = floor.walls.map((wall) => ({
          wallPublicationId: remoteId("wall", wall.id),
          from: { x: wall.from.x, y: wall.from.y },
          to: { x: wall.to.x, y: wall.to.y },
        }));
        const rooms = floor.rooms.map((room) => ({
          roomPublicationId: remoteId("room", room.id),
          name: room.name,
          points: room.points.map((point) => ({ x: point.x, y: point.y })),
          ...(room.kind ? { kind: room.kind } : {}),
        }));
        const planElements = (floor.planElements ?? []).map((element) => {
          const projected: Record<string, JsonValue> = {
            planElementPublicationId: remoteId("plan-element", element.id),
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
            projected.wallPublicationId = remoteId("wall", element.wallId);
          }
          return projected;
        });
        const result: Record<string, JsonValue> = {
          floorPublicationId: remoteId("floor", floor.id),
          name: floor.name,
          width: floor.width,
          height: floor.height,
          elevation: floor.elevation,
          walls,
          rooms,
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
      }),
    } as unknown as StugubyHomeStructurePayload;
    const location: StugubyHomeLocationPayload | null = house.location ? {
      publicationId: link.publicationId,
      latitude: house.location.latitude,
      longitude: house.location.longitude,
      ...(house.location.label ? { label: house.location.label } : {}),
      ...(house.location.countryCode ? { countryCode: house.location.countryCode } : {}),
      ...(house.mapPlacement ? { mapPlacement: {
        latitude: house.mapPlacement.latitude,
        longitude: house.mapPlacement.longitude,
        metersPerPlanUnit: house.mapPlacement.metersPerPlanUnit,
        ...(house.mapPlacement.footprintFloorId
          ? { footprintFloorPublicationId: remoteId("floor", house.mapPlacement.footprintFloorId) }
          : {}),
      } } : {}),
      ...(house.orientationDegrees !== undefined ? { orientationDegrees: house.orientationDegrees } : {}),
    } : null;
    const sensorCatalog: StugubySensorCatalogPayload = {
      publicationId: link.publicationId,
      sensors: this.database.listSensors(house.id).map((sensor) => ({
        sensorPublicationId: remoteId("sensor", sensor.id),
        floorPublicationId: remoteId("floor", sensor.floorId),
        ...(sensor.roomId ? { roomPublicationId: remoteId("room", sensor.roomId) } : {}),
        name: sensor.name,
        model: sensor.model,
        tags: sensor.tags.filter((tag) => tag !== "stuguby-shared"),
        enabled: sensor.enabled,
        x: sensor.x,
        y: sensor.y,
        z: sensor.z,
        metricIds: this.sensorMetrics(sensor.id),
      })),
    };
    const notes: StugubyHomeNotesPayload = {
      publicationId: link.publicationId,
      notes: this.database.listPropertyNotes({ houseId: house.id, limit: 10_000 }).map((note) => ({
        notePublicationId: remoteId("home-note", note.id),
        kind: note.kind,
        text: note.text,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })),
    };
    const observations: StugubyHomeObservationsPayload = {
      publicationId: link.publicationId,
      observations: this.database.listObservations(house.id).map((observation) => ({
        observationPublicationId: remoteId("observation", observation.id),
        floorPublicationId: remoteId("floor", observation.floorId),
        ...(observation.sensorId ? { sensorPublicationId: remoteId("sensor", observation.sensorId) } : {}),
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
      })),
    };
    const snapshot: StugubyHomeCommandSnapshot = {
      directory: { publicationId: link.publicationId, name: house.name, timezone: house.timezone },
      location,
      structure,
      sensorCatalog,
      notes,
      observations,
    };
    assertSafeFederationPayload(snapshot);
    return snapshot;
  }

  applyHomeCommandAs(actorNodeId: string, candidate: unknown): StugubyHomeCommandResult {
    const command = validateHomeCommand(candidate);
    this.requireCoordinator(command.stugubyId);
    if (command.actorNodeId !== actorNodeId) {
      throw new StugubyError(403, "HOME_COMMAND_ACTOR_MISMATCH", "Home command actor does not match the authenticated node");
    }
    const actor = this.store.getMember(command.stugubyId, actorNodeId);
    if (!actor || actor.state !== "active" || actor.role === "viewer") {
      throw new StugubyError(403, "HOME_COMMAND_FORBIDDEN", "An active editing member is required");
    }
    const previous = this.store.getHomeCommand(command.id);
    if (previous?.result) return previous.result;
    const grant = this.store.getGrant(command.grantId);
    if (!grant || grant.stugubyId !== command.stugubyId || grant.authorityNodeId !== this.identity.nodeId
      || grant.publicationId !== command.publicationId || grant.epoch !== command.grantEpoch
      || grant.revokedAt || grantExpired(grant) || grant.housePolicy.editPolicy !== "editable"
      || !grantAudienceIncludes(grant, actorNodeId)) {
      throw new StugubyError(403, "HOME_COMMAND_NOT_AUTHORIZED", "The editable Home grant is inactive or does not include this member");
    }
    const house = this.database.getHouse(grant.localHouseId ?? "");
    if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "The authoritative Home was not found");
    const authorityEpoch = house.stuguby?.authorityEpoch ?? 1;
    if (command.authorityNodeId !== this.identity.nodeId || command.authorityEpoch !== authorityEpoch) {
      throw new StugubyError(409, "STALE_HOME_AUTHORITY", "The Home authority has changed; reload before editing");
    }
    this.store.enqueueHomeCommand(command);
    const currentRevision = this.store.homeRevision(command.stugubyId, this.identity.nodeId, command.publicationId);
    if (command.baseRevision !== currentRevision) {
      const result: StugubyHomeCommandResult = {
        commandId: command.id,
        status: "conflict",
        authorityRevision: currentRevision,
        message: "The Server kept its newer Home changes. Reload the Home before trying this edit again.",
      };
      this.store.completeHomeCommand(result);
      this.store.audit(command.stugubyId, "home.command.conflict", actorNodeId, command.publicationId, {
        commandId: command.id,
        baseRevision: command.baseRevision,
        authorityRevision: currentRevision,
      });
      return result;
    }
    try {
      return this.database.transaction(() => {
        this.applyEditableHomeSnapshot(command, house);
        const authoritative = this.database.getHouse(house.id)!;
        const revision = this.store.bumpHomeRevision(command.stugubyId, this.identity.nodeId, command.publicationId);
        const grants = this.store.listGrants(command.stugubyId, this.identity.nodeId)
          .filter((candidateGrant) => candidateGrant.localHouseId === house.id
            && !candidateGrant.revokedAt && !grantExpired(candidateGrant));
        for (const candidateGrant of grants) this.publishGrantSnapshots(candidateGrant, authoritative, revision);
        const result: StugubyHomeCommandResult = {
          commandId: command.id,
          status: "applied",
          authorityRevision: revision,
          message: "The Server accepted the shared Home changes.",
        };
        this.store.completeHomeCommand(result);
        this.store.audit(command.stugubyId, "home.command.applied", actorNodeId, command.publicationId, {
          commandId: command.id,
          revision,
        });
        return result;
      });
    } catch (error) {
      const result: StugubyHomeCommandResult = {
        commandId: command.id,
        status: "conflict",
        authorityRevision: currentRevision,
        message: error instanceof Error
          ? `The Server kept its Home because the shared edit could not be applied: ${error.message.slice(0, 300)}`
          : "The Server kept its Home because the shared edit could not be applied.",
      };
      this.store.completeHomeCommand(result);
      this.store.audit(command.stugubyId, "home.command.conflict", actorNodeId, command.publicationId, {
        commandId: command.id,
        reason: result.message,
      });
      return result;
    }
  }

  private applyEditableHomeSnapshot(command: StugubyHomeCommand, house: House): void {
    const snapshot = command.snapshot;
    const localId = (
      type: "floor" | "room" | "wall" | "plan-element" | "sensor" | "note" | "observation",
      publicationId: string,
    ) => this.store.publicationLocalId(command.stugubyId, this.identity.nodeId, type, publicationId, true)!;
    const currentFloorById = new Map(house.floors.map((floor) => [floor.id, floor]));
    const floorIds = new Map<string, string>();
    const roomIds = new Map<string, string>();
    const floors: Floor[] = snapshot.structure.floors.map((floor) => {
      const floorId = localId("floor", floor.floorPublicationId);
      floorIds.set(floor.floorPublicationId, floorId);
      const wallIds = new Map(floor.walls.map((wall) => [wall.wallPublicationId, localId("wall", wall.wallPublicationId)]));
      const existingFloor = currentFloorById.get(floorId);
      const existingElements = new Map((existingFloor?.planElements ?? []).map((element) => [element.id, element]));
      const rooms = floor.rooms.map((room) => {
        const roomId = localId("room", room.roomPublicationId);
        roomIds.set(room.roomPublicationId, roomId);
        return {
          id: roomId,
          name: room.name,
          points: room.points.map((point) => ({ x: point.x, y: point.y })),
          ...(room.kind ? { kind: room.kind } : {}),
        };
      });
      const planElements = floor.planElements.flatMap((element) => {
        const id = localId("plan-element", element.planElementPublicationId);
        const projected: Record<string, unknown> = {
          id,
          kind: element.kind,
          position: { x: element.position.x, y: element.position.y },
          rotationDegrees: element.rotationDegrees,
        };
        for (const key of ["width", "height", "label", "state", "openFraction", "bottomOffsetM", "variant",
          "nominalFlowM3h", "verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"] as const) {
          if (element[key] !== undefined) projected[key] = element[key];
        }
        if (element.wallPublicationId) {
          const wallId = wallIds.get(element.wallPublicationId);
          if (!wallId) return [];
          projected.wallId = wallId;
        }
        const existingElement = existingElements.get(id);
        if (existingElement && "stateBinding" in existingElement && existingElement.stateBinding) {
          projected.stateBinding = existingElement.stateBinding;
        }
        return [projected];
      });
      const projected: Record<string, unknown> = {
        id: floorId,
        name: floor.name,
        width: floor.width,
        height: floor.height,
        elevation: floor.elevation,
        walls: floor.walls.map((wall) => ({
          id: wallIds.get(wall.wallPublicationId)!,
          from: { x: wall.from.x, y: wall.from.y },
          to: { x: wall.to.x, y: wall.to.y },
        })),
        rooms,
        planElements,
      };
      for (const key of ["type", "metersPerPlanUnit", "ceilingHeight", "wallHeight"] as const) {
        if (floor[key] !== undefined) projected[key] = floor[key];
      }
      if (floor.roof) projected.roof = { ...floor.roof };
      if (existingFloor?.backgroundImage) projected.backgroundImage = existingFloor.backgroundImage;
      return projected as unknown as Floor;
    });

    const incomingFloorIds = new Set(floors.map((floor) => floor.id));
    const transitionalFloors = [...floors, ...house.floors.filter((floor) => !incomingFloorIds.has(floor.id))];
    const locationPayload = snapshot.location;
    const location = locationPayload ? {
      latitude: locationPayload.latitude,
      longitude: locationPayload.longitude,
      ...(locationPayload.label ? { label: locationPayload.label } : {}),
      ...(locationPayload.countryCode ? { countryCode: locationPayload.countryCode } : {}),
      source: "manual" as const,
    } : null;
    const footprintFloorId = locationPayload?.mapPlacement?.footprintFloorPublicationId
      ? floorIds.get(locationPayload.mapPlacement.footprintFloorPublicationId)
      : undefined;
    const mapPlacement = locationPayload?.mapPlacement ? {
      latitude: locationPayload.mapPlacement.latitude,
      longitude: locationPayload.mapPlacement.longitude,
      metersPerPlanUnit: locationPayload.mapPlacement.metersPerPlanUnit,
      ...(footprintFloorId ? { footprintFloorId } : {}),
    } : null;
    this.database.updateHouse(house.id, {
      name: snapshot.directory.name,
      timezone: snapshot.directory.timezone,
      location,
      mapPlacement,
      orientationDegrees: locationPayload?.orientationDegrees ?? null,
      floors: transitionalFloors,
    }, "system-service");

    const expectedSensors = new Set<string>();
    for (const item of snapshot.sensorCatalog.sensors) {
      const floorId = floorIds.get(item.floorPublicationId);
      if (!floorId) throw new Error(`Sensor ${item.sensorPublicationId} references an unknown floor`);
      const id = localId("sensor", item.sensorPublicationId);
      expectedSensors.add(id);
      const roomId = item.roomPublicationId ? roomIds.get(item.roomPublicationId) ?? null : null;
      const room = roomId
        ? floors.find((floor) => floor.id === floorId)?.rooms.find((candidate) => candidate.id === roomId)?.name ?? ""
        : "";
      const existing = this.database.getSensor(id);
      if (existing) {
        this.database.updateSensor(id, {
          houseId: house.id,
          floorId,
          name: item.name,
          roomId,
          room,
          model: item.model,
          x: item.x,
          y: item.y,
          z: item.z,
          tags: item.tags.filter((tag) => tag !== "stuguby-shared"),
          enabled: item.enabled,
        });
      } else {
        this.database.createSensor({
          id,
          houseId: house.id,
          floorId,
          name: item.name,
          roomId,
          room,
          model: item.model,
          x: item.x,
          y: item.y,
          z: item.z,
          tags: item.tags.filter((tag) => tag !== "stuguby-shared"),
          enabled: item.enabled,
        });
      }
    }

    const expectedObservations = new Set<string>();
    for (const item of snapshot.observations.observations) {
      const floorId = floorIds.get(item.floorPublicationId);
      if (!floorId) throw new Error(`Observation ${item.observationPublicationId} references an unknown floor`);
      const sensorId = item.sensorPublicationId ? localId("sensor", item.sensorPublicationId) : null;
      if (sensorId && !this.database.getSensor(sensorId)) throw new Error(`Observation ${item.observationPublicationId} references an unknown sensor`);
      const id = localId("observation", item.observationPublicationId);
      expectedObservations.add(id);
      const existing = this.database.getObservation(id);
      if (!existing) {
        const created = this.database.createObservation({
          id,
          houseId: house.id,
          floorId,
          sensorId,
          kind: item.kind as never,
          severity: item.severity as never,
          note: item.note,
          x: item.x,
          y: item.y,
          occurredAt: item.occurredAt,
          ...(item.timePrecision ? { timePrecision: item.timePrecision as never } : {}),
          ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
          ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
          source: "unknown",
          sourceDetail: `Shared edit from ${command.actorNodeId}`,
          ...(item.confidence ? { confidence: item.confidence as never } : {}),
        }, "system-service");
        if (item.status === "resolved") {
          this.database.updateObservation(id, {
            baseRevision: created.revision ?? 1,
            status: "resolved",
            resolutionNote: item.resolutionNote ?? "Resolved in shared Home",
          }, "system-service");
        }
      } else {
        this.database.updateObservation(id, {
          baseRevision: existing.revision,
          floorId,
          sensorId,
          kind: item.kind as never,
          severity: item.severity as never,
          note: item.note,
          x: item.x,
          y: item.y,
          occurredAt: item.occurredAt,
          ...(item.timePrecision ? { timePrecision: item.timePrecision as never } : {}),
          ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
          ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
          ...(item.confidence ? { confidence: item.confidence as never } : {}),
          ...(item.status ? { status: item.status as never } : {}),
          ...(item.resolutionNote !== undefined ? { resolutionNote: item.resolutionNote } : {}),
        }, "system-service");
      }
    }
    for (const existing of this.database.listObservations(house.id)) {
      if (!expectedObservations.has(existing.id)) this.database.deleteObservation(existing.id);
    }
    for (const existing of this.database.listSensors(house.id)) {
      if (!expectedSensors.has(existing.id)) this.database.deleteSensor(existing.id);
    }

    const expectedNotes = new Set<string>();
    for (const item of snapshot.notes.notes) {
      const id = localId("note", item.notePublicationId);
      expectedNotes.add(id);
      const existing = this.database.getPropertyNote(id);
      if (existing) {
        this.database.updatePropertyNote(id, {
          houseId: house.id,
          areaId: null,
          equipmentId: null,
          kind: item.kind,
          text: item.text,
        });
      } else {
        this.database.createPropertyNote({
          id,
          propertyId: house.propertyId,
          houseId: house.id,
          areaId: null,
          equipmentId: null,
          kind: item.kind,
          text: item.text,
        });
      }
    }
    for (const existing of this.database.listPropertyNotes({ houseId: house.id, limit: 10_000 })) {
      if (!expectedNotes.has(existing.id)) this.database.deletePropertyNote(existing.id);
    }
    if (transitionalFloors.length !== floors.length) {
      this.database.updateHouse(house.id, { floors }, "system-service");
    }
  }

  capturePropertyMutation(
    propertyId: string,
    entityKind: StugubyPropertyEntityKind,
    entityId: string,
    operation: "upsert" | "delete",
    value: JsonObject | null,
    changedFields?: string[],
  ): StugubyPropertyCommand | null {
    const property = this.database.getProperty(propertyId);
    if (!property?.stuguby || property.stuguby.syncState === "detached") return null;
    const link = property.stuguby;
    this.assertPropertyWriteAllowed(propertyId);
    const remoteId = (
      resourceType: Exclude<StugubyPropertyEntityKind, "property">,
      localId: string,
    ): string => this.store.projectionRemoteId(
      link.stugubyId,
      link.authorityNodeId,
      resourceType,
      localId,
    );
    const sharedEntityId = entityKind === "property"
      ? link.stugubyId
      : remoteId(entityKind, entityId);
    const sharedValue = value ? { ...value } : null;
    const projectReference = (
      resourceType: "area" | "equipment",
      field: "areaId" | "equipmentId",
    ): void => {
      const localId = sharedValue?.[field];
      if (typeof localId === "string") sharedValue![field] = remoteId(resourceType, localId);
    };
    if (sharedValue && entityKind !== "property") {
      sharedValue.id = sharedEntityId;
      if (entityKind === "equipment") {
        projectReference("area", "areaId");
      } else if (entityKind === "note" || entityKind === "maintenance") {
        projectReference("area", "areaId");
        projectReference("equipment", "equipmentId");
      }
    }
    const projectedChangedFields = entityKind === "equipment" && changedFields
      ? [...new Set(changedFields.flatMap((field) => (
        field === "houseId"
          ? ["areaId", "home"]
          : field === "areaId"
            ? ["areaId", "home"]
            : [field]
      )))]
      : changedFields;
    return this.enqueueCorePropertyMutation(
      link.stugubyId,
      entityKind,
      sharedEntityId,
      operation,
      sharedValue,
      projectedChangedFields,
    );
  }

  captureCurrentPropertyEntity(
    propertyId: string,
    entityKind: StugubyPropertyEntityKind,
    entityId: string,
    operation: "upsert" | "delete",
    changedFields?: string[],
  ): StugubyPropertyCommand | null {
    const propertyLink = this.database.getProperty(propertyId)?.stuguby;
    if (!propertyLink || propertyLink.syncState === "detached") return null;
    if (operation === "delete") {
      return this.capturePropertyMutation(propertyId, entityKind, entityId, "delete", null);
    }
    let value: JsonObject | null = null;
    if (entityKind === "property") {
      const property = this.database.getProperty(entityId);
      if (property) value = {
        name: property.name,
        description: property.description,
        location: property.location ? {
          latitude: property.location.latitude,
          longitude: property.location.longitude,
          ...(property.location.label ? { label: property.location.label } : {}),
        } : null,
      };
    } else if (entityKind === "area") {
      const area = this.database.getPropertyArea(entityId);
      if (area) value = this.sharedArea(area);
    } else if (entityKind === "equipment") {
      const equipment = this.database.getAreaEquipment(entityId);
      if (equipment) value = this.sharedEquipment(propertyLink.stugubyId, equipment);
    } else if (entityKind === "note") {
      const note = this.database.getPropertyNote(entityId);
      if (note) value = this.sharedNote(note);
    } else {
      const maintenance = this.database.getMaintenanceTask(entityId);
      if (maintenance) value = this.sharedMaintenance(maintenance);
    }
    if (!value) throw new StugubyError(404, "PROPERTY_ENTITY_NOT_FOUND", "The changed Property item was not found");
    return this.capturePropertyMutation(propertyId, entityKind, entityId, "upsert", value, changedFields);
  }

  private enqueueCorePropertyMutation(
    stugubyId: string,
    entityKind: StugubyPropertyEntityKind,
    entityId: string,
    operation: "upsert" | "delete",
    value: JsonObject | null,
    changedFields?: string[],
  ): StugubyPropertyCommand {
    const property = this.store.getSharedProperty(stugubyId);
    if (!property) throw new StugubyError(409, "SHARED_PROPERTY_NOT_READY", "Shared Property data is not available");
    const pending = this.store.pendingPropertyCommandFor(
      stugubyId,
      this.identity.nodeId,
      entityKind,
      entityId,
    );
    const nextFields = operation === "delete"
      ? []
      : [...new Set([...(pending?.command.changedFields ?? []),
        ...(changedFields ?? Object.keys(value ?? {}).filter((field) => field !== "id"))])];
    const command: StugubyPropertyCommand = {
      id: pending?.command.id ?? randomUUID(),
      stugubyId,
      actorNodeId: this.identity.nodeId,
      baseRevision: pending?.command.baseRevision ?? property.revision,
      entityKind,
      entityId,
      operation,
      changedFields: nextFields,
      value,
      createdAt: pending?.command.createdAt ?? new Date().toISOString(),
    };
    validatePropertyCommand(command);
    this.store.enqueuePropertyCommand(command);
    if (this.store.isCoordinator(stugubyId)) this.applyPropertyCommandAs(this.identity.nodeId, command);
    this.refreshPropertyLink(stugubyId);
    return command;
  }

  applyPropertyCommandAs(actorNodeId: string, candidate: unknown): StugubyPropertyCommandResult {
    const command = validatePropertyCommand(candidate);
    if (command.actorNodeId !== actorNodeId) {
      throw new StugubyError(403, "PROPERTY_COMMAND_ACTOR_MISMATCH", "Property command actor does not match the authenticated node");
    }
    this.requireCoordinator(command.stugubyId);
    const actor = this.store.getMember(command.stugubyId, actorNodeId);
    const currentProperty = this.store.getSharedProperty(command.stugubyId);
    if (!actor || actor.state !== "active" || actor.role === "viewer" || !currentProperty) {
      throw new StugubyError(403, "PROPERTY_WRITE_FORBIDDEN", "This member cannot edit the shared Property");
    }
    if (actorNodeId !== this.identity.nodeId && currentProperty.editPolicy === "read-only") {
      throw new StugubyError(403, "PROPERTY_READ_ONLY", "The coordinator has shared this Property as read-only");
    }
    const previous = this.store.getPropertyCommand(command.id);
    if (previous?.result) return previous.result;
    if (!previous) this.store.enqueuePropertyCommand(command);

    const arrays: Record<Exclude<StugubyPropertyEntityKind, "property">, keyof Pick<StugubySharedProperty,
      "areas" | "equipment" | "notes" | "maintenance"
    >> = {
      area: "areas",
      equipment: "equipment",
      note: "notes",
      maintenance: "maintenance",
    };
    const allowedFields: Record<StugubyPropertyEntityKind, readonly string[]> = {
      property: ["name", "description", "location"],
      area: ["name", "kind", "description", "location", "polygon"],
      equipment: ["areaId", "home", "location", "name", "kind", "manufacturer", "model", "serialNumber", "status", "notes"],
      note: ["areaId", "equipmentId", "kind", "text", "createdAt", "updatedAt"],
      maintenance: ["title", "description", "areaId", "equipmentId", "state", "dueAt", "completedAt", "createdAt", "updatedAt"],
    };
    if (command.entityKind === "property" && command.entityId !== command.stugubyId) {
      throw new StugubyError(400, "INVALID_PROPERTY_COMMAND", "Property commands must target the Stuguby id");
    }
    if (command.changedFields.some((field) => !allowedFields[command.entityKind].includes(field))) {
      throw new StugubyError(400, "INVALID_PROPERTY_COMMAND", "Property command contains unsupported fields");
    }

    const currentValue = command.entityKind === "property"
      ? {
        name: currentProperty.name,
        description: currentProperty.description,
        location: currentProperty.location,
      } as JsonObject
      : (currentProperty[arrays[command.entityKind]] as unknown as JsonObject[])
        .find((item) => item.id === command.entityId) ?? null;
    const fieldRevisions = this.store.propertyFieldRevisions(command.stugubyId, command.entityKind, command.entityId);
    const consideredFields = command.operation === "delete"
      ? Object.keys(currentValue ?? {}).filter((field) => field !== "id")
      : command.changedFields;
    const conflictingFields = consideredFields.filter((field) => (fieldRevisions[field] ?? 1) > command.baseRevision);
    const appliedFields = command.operation === "delete"
      ? (conflictingFields.length === 0 ? consideredFields : [])
      : command.changedFields.filter((field) => !conflictingFields.includes(field));
    const detectedAt = new Date().toISOString();
    const conflict: StugubyPropertyConflict | null = conflictingFields.length > 0 ? {
      commandId: command.id,
      entityKind: command.entityKind,
      entityId: command.entityId,
      fields: conflictingFields,
      message: `The Server kept its newer ${command.entityKind} value for ${conflictingFields.join(", ")}.`,
      serverValue: currentValue,
      clientValue: command.value,
      detectedAt,
      resolvedAt: null,
    } : null;

    let next = structuredClone(currentProperty);
    let changed = false;
    if (command.operation === "delete") {
      if (currentValue && conflictingFields.length === 0 && command.entityKind !== "property") {
        const key = arrays[command.entityKind];
        (next[key] as unknown as JsonObject[]) = (next[key] as unknown as JsonObject[])
          .filter((item) => item.id !== command.entityId);
        changed = true;
      }
    } else if (appliedFields.length > 0 && command.value) {
      if (command.entityKind === "property") {
        const writable = next as unknown as Record<string, JsonValue>;
        for (const field of appliedFields) writable[field] = command.value[field]!;
      } else {
        const key = arrays[command.entityKind];
        const items = next[key] as unknown as JsonObject[];
        const index = items.findIndex((item) => item.id === command.entityId);
        const entity: JsonObject = index >= 0 ? { ...items[index]! } : { id: command.entityId };
        for (const field of appliedFields) entity[field] = command.value[field]!;
        if (index >= 0) items[index] = entity;
        else items.push(entity);
      }
      changed = true;
    }

    if (changed) {
      next.revision = currentProperty.revision + 1;
      next.updatedAt = detectedAt;
      validateSharedProperty(next);
    }
    const result: StugubyPropertyCommandResult = {
      commandId: command.id,
      status: conflict ? "conflict" : "applied",
      appliedFields,
      conflict,
      property: changed ? next : currentProperty,
    };
    const completed = this.atomicPublication(() => {
      if (changed) {
        this.store.saveSharedProperty(next, currentProperty.revision);
        this.store.setPropertyFieldRevisions(command.stugubyId, command.entityKind, command.entityId,
          command.operation === "delete" ? consideredFields : appliedFields, next.revision);
        this.publishSharedPropertyEvent(next);
      }
      this.store.completePropertyCommand(result);
      this.store.audit(command.stugubyId, conflict ? "property.command.conflict" : "property.command.applied",
        actorNodeId, command.entityId, {
          commandId: command.id,
          entityKind: command.entityKind,
          appliedFields: appliedFields.length,
          conflictFields: conflictingFields.length,
          revision: result.property.revision,
        }, detectedAt);
      return result;
    });
    this.materializeSharedProperty(completed.property);
    return completed;
  }

  private publishSharedPropertyEvent(property: StugubySharedProperty): void {
    const event = this.createEvent({
      stugubyId: property.stugubyId,
      eventKind: "shared-property.updated",
      streamId: "shared-property",
      schema: "stuguby.shared-property.v2",
      resourceId: property.stugubyId,
      operation: "upsert",
      revision: property.revision,
      grantId: null,
      grantEpoch: null,
      payload: property,
    });
    this.distribute(event);
  }

  private refreshPropertyLink(stugubyId: string, forcedState?: StugubyPropertyLink["syncState"]): void {
    const adoption = this.store.getPropertyAdoption(stugubyId);
    const shared = this.store.getSharedProperty(stugubyId);
    const stuguby = this.store.getStuguby(stugubyId);
    if (!adoption || adoption.state !== "adopted" || !shared || !stuguby) return;
    const counts = this.store.propertyCommandCounts(stugubyId);
    const syncState = forcedState ?? (counts.conflicts > 0 ? "conflict" : counts.pending > 0 ? "pending" : "current");
    this.database.setPropertyStugubyLink(adoption.localPropertyId, {
      stugubyId,
      authorityNodeId: stuguby.coordinatorNodeId,
      isAuthority: stuguby.coordinatorNodeId === this.identity.nodeId,
      editPolicy: shared.editPolicy,
      syncState,
      authorityEpoch: shared.authorityEpoch,
      lastSyncedRevision: shared.revision,
      pendingChangeCount: counts.pending,
      conflictCount: this.store.listPropertyConflicts(stugubyId).length,
    });
  }

  private registerLocalPropertyMappings(stuguby: StugubySummary, propertyId: string): void {
    for (const area of this.database.listPropertyAreas(propertyId)) {
      this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "area", area.id, area.id);
    }
    for (const item of this.database.listAreaEquipment({ propertyId })) {
      this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "equipment", item.id, item.id);
    }
    for (const note of this.database.listPropertyNotes({ propertyId })) {
      this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "note", note.id, note.id);
    }
    for (const task of this.database.listMaintenanceTasks({ propertyId })) {
      this.store.projectionId(stuguby.id, stuguby.coordinatorNodeId, "maintenance", task.id, task.id);
    }
  }

  private sharedPropertyFromLocal(stugubyId: string, propertyId: string, previous: StugubySharedProperty): SharedPropertyInput {
    const property = this.database.getProperty(propertyId);
    if (!property) throw new StugubyError(404, "PROPERTY_NOT_FOUND", "Local Property was not found");
    return {
      name: property.name,
      description: property.description,
      location: property.location ? {
        latitude: property.location.latitude,
        longitude: property.location.longitude,
        ...(property.location.label ? { label: property.location.label } : {}),
      } : null,
      areas: this.database.listPropertyAreas(propertyId).map((area) => this.sharedArea(area)),
      equipment: this.database.listAreaEquipment({ propertyId }).map((item) => this.sharedEquipment(stugubyId, item)),
      notes: this.database.listPropertyNotes({ propertyId }).map((note) => this.sharedNote(note)),
      maintenance: this.database.listMaintenanceTasks({ propertyId }).map((task) => this.sharedMaintenance(task)),
      editPolicy: previous.editPolicy,
      designatedSuccessorNodeId: previous.designatedSuccessorNodeId,
    };
  }

  private sharedArea(area: PropertyArea): StugubySharedProperty["areas"][number] {
    return {
      id: area.id,
      name: area.name,
      kind: area.kind,
      description: area.description,
      ...(area.location ? { location: { latitude: area.location.latitude, longitude: area.location.longitude } } : {}),
      polygon: area.polygon.map((point) => ({ latitude: point.latitude, longitude: point.longitude })),
    } as unknown as StugubySharedProperty["areas"][number];
  }

  private sharedEquipment(stugubyId: string, item: AreaEquipment): StugubySharedProperty["equipment"][number] {
    const house = item.houseId ? this.database.getHouse(item.houseId) : null;
    let home: StugubySharedProperty["equipment"][number]["home"] = null;
    if (house) {
      const authorityNodeId = house.stuguby?.stugubyId === stugubyId
        ? house.stuguby.authorityNodeId
        : this.identity.nodeId;
      const publicationId = house.stuguby?.stugubyId === stugubyId
        ? house.stuguby.publicationId
        : this.store.publicationId(stugubyId, "home", house.id);
      this.store.projectionId(stugubyId, authorityNodeId, "home", publicationId, house.id);
      home = { authorityNodeId, publicationId };
    }
    return {
      id: item.id,
      areaId: item.areaId,
      home,
      ...(item.location ? {
        location: {
          latitude: item.location.latitude,
          longitude: item.location.longitude,
        },
      } : {}),
      name: item.name,
      kind: item.kind,
      manufacturer: item.manufacturer,
      model: item.model,
      serialNumber: item.serialNumber,
      status: item.status,
      notes: item.notes,
    };
  }

  private sharedNote(note: PropertyNote): StugubySharedProperty["notes"][number] {
    return {
      id: note.id,
      areaId: note.areaId,
      equipmentId: note.equipmentId,
      kind: note.kind,
      text: note.text,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }

  private sharedMaintenance(task: MaintenanceTask): StugubySharedProperty["maintenance"][number] {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      areaId: task.areaId ?? null,
      equipmentId: task.equipmentId ?? null,
      state: task.status === "completed" || task.status === "verified" ? "done" : task.status,
      dueAt: task.dueBy ? `${task.dueBy}T23:59:59.000Z` : null,
      completedAt: task.completedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private materializeSharedProperty(shared: StugubySharedProperty): void {
    const adoption = this.store.getPropertyAdoption(shared.stugubyId);
    const stuguby = this.store.getStuguby(shared.stugubyId);
    if (!adoption || adoption.state !== "adopted" || !stuguby) return;
    const propertyId = adoption.localPropertyId;
    if (!this.database.getProperty(propertyId)) {
      throw new StugubyError(409, "PROPERTY_PROJECTION_MISSING", "The adopted local Property no longer exists");
    }
    this.database.updateProperty(propertyId, {
      name: shared.name,
      description: shared.description,
      location: shared.location ? { ...shared.location, source: "manual" } : null,
    });

    const areaIds = new Map(shared.areas.map((area) => [
      area.id,
      this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "area", area.id),
    ]));
    const equipmentIds = new Map(shared.equipment.map((item) => [
      item.id,
      this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "equipment", item.id),
    ]));
    const noteIds = new Map(shared.notes.map((note) => [
      note.id,
      this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "note", note.id),
    ]));
    const maintenanceIds = new Map(shared.maintenance.map((task) => [
      task.id,
      this.store.projectionId(shared.stugubyId, stuguby.coordinatorNodeId, "maintenance", task.id),
    ]));

    for (const area of shared.areas) {
      const id = areaIds.get(area.id)!;
      const kind = PROPERTY_AREA_KINDS.has(area.kind as PropertyAreaKind) ? area.kind as PropertyAreaKind : "other";
      const existing = this.database.getPropertyArea(id);
      if (existing) {
        this.database.updatePropertyArea(id, {
          propertyId,
          name: area.name,
          kind,
          description: area.description,
          location: area.location ?? null,
          polygon: area.polygon,
        });
      } else {
        this.database.createPropertyArea({
          id,
          propertyId,
          name: area.name,
          kind,
          description: area.description,
          ...(area.location ? { location: area.location } : {}),
          polygon: area.polygon,
        });
      }
    }
    for (const item of shared.equipment) {
      const id = equipmentIds.get(item.id)!;
      const areaId = item.areaId ? areaIds.get(item.areaId) ?? null : null;
      if (item.areaId && !areaId) {
        throw new StugubyError(502, "INVALID_SHARED_PROPERTY", `Equipment ${item.id} references an unknown area`);
      }
      const projectedHouseId = item.home
        ? this.store.projectionId(
          shared.stugubyId,
          item.home.authorityNodeId,
          "home",
          item.home.publicationId,
        )
        : null;
      const houseId = projectedHouseId && this.database.getHouse(projectedHouseId)
        ? projectedHouseId
        : null;
      const existing = this.database.getAreaEquipment(id);
      if (existing) {
        this.database.updateAreaEquipment(id, {
          areaId,
          houseId,
          location: item.location ?? null,
          name: item.name,
          kind: item.kind,
          manufacturer: item.manufacturer,
          model: item.model,
          serialNumber: item.serialNumber,
          status: item.status,
          notes: item.notes,
        });
      } else {
        this.database.createAreaEquipment({
          id,
          propertyId,
          areaId,
          houseId,
          ...(item.location ? { location: item.location } : {}),
          name: item.name,
          kind: item.kind,
          manufacturer: item.manufacturer,
          model: item.model,
          serialNumber: item.serialNumber,
          status: item.status,
          notes: item.notes,
        });
      }
    }
    for (const note of shared.notes) {
      const id = noteIds.get(note.id)!;
      const value = {
        houseId: null,
        areaId: note.areaId ? areaIds.get(note.areaId) ?? null : null,
        equipmentId: note.equipmentId ? equipmentIds.get(note.equipmentId) ?? null : null,
        kind: note.kind,
        text: note.text,
      } as const;
      if (this.database.getPropertyNote(id)) this.database.updatePropertyNote(id, value);
      else this.database.createPropertyNote({ id, propertyId, ...value });
    }
    for (const task of shared.maintenance) {
      const id = maintenanceIds.get(task.id)!;
      const status = task.state === "done" ? "completed" : task.state;
      let current = this.database.getMaintenanceTask(id);
      if (!current) {
        current = this.database.createMaintenanceTask({
          id,
          propertyId,
          houseId: null,
          areaId: task.areaId ? areaIds.get(task.areaId) ?? null : null,
          equipmentId: task.equipmentId ? equipmentIds.get(task.equipmentId) ?? null : null,
          title: task.title,
          description: task.description,
          basis: "scheduled",
          dueBy: task.dueAt?.slice(0, 10) ?? null,
        }, "system-service");
      }
      const patch = {
        baseRevision: current.revision,
        areaId: task.areaId ? areaIds.get(task.areaId) ?? null : null,
        equipmentId: task.equipmentId ? equipmentIds.get(task.equipmentId) ?? null : null,
        title: task.title,
        description: task.description,
        dueBy: task.dueAt?.slice(0, 10) ?? null,
        status,
      } as const;
      this.database.updateMaintenanceTask(id, patch, "system-service");
    }

    const staleNotes = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "note")
      .filter((item) => !noteIds.has(item.remoteId));
    const staleMaintenance = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "maintenance")
      .filter((item) => !maintenanceIds.has(item.remoteId));
    const staleEquipment = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "equipment")
      .filter((item) => !equipmentIds.has(item.remoteId));
    const staleAreas = this.store.listProjectionIds(shared.stugubyId, stuguby.coordinatorNodeId, "area")
      .filter((item) => !areaIds.has(item.remoteId));
    for (const item of staleNotes) this.database.deletePropertyNote(item.localId);
    for (const item of staleMaintenance) this.database.deleteMaintenanceTask(item.localId);
    for (const item of staleEquipment) this.database.deleteAreaEquipment(item.localId);
    for (const item of staleAreas) this.database.deletePropertyArea(item.localId);

    this.store.markPropertyMaterialized(shared.stugubyId, shared.revision);
    this.refreshPropertyLink(shared.stugubyId);
  }

  private materializeAllRemoteHomes(stugubyId: string): void {
    for (const grant of this.store.listGrants(stugubyId)) {
      if (grant.authorityNodeId === this.identity.nodeId || grant.revokedAt || grantExpired(grant)) continue;
      this.materializeRemoteHome(stugubyId, grant.authorityNodeId, grant.publicationId);
    }
  }

  private materializeRemoteHome(stugubyId: string, authorityNodeId: string, publicationId: string): void {
    const adoption = this.store.getPropertyAdoption(stugubyId);
    if (!adoption || adoption.state !== "adopted") return;
    const grant = this.store.listGrants(stugubyId, authorityNodeId)
      .find((item) => item.publicationId === publicationId && !item.revokedAt && !grantExpired(item));
    if (!grant) return;
    const resources = this.store.listRemoteResources(stugubyId)
      .filter((resource) => resource.authorityNodeId === authorityNodeId && resource.publicationId === publicationId);
    const bySchema = new Map(resources.map((resource) => [resource.schema, resource]));
    const directory = bySchema.get("home.directory.v1")?.payload as unknown as StugubyHomeDirectoryPayload | undefined;
    if (!directory) return;

    const localHouseId = this.store.projectionId(stugubyId, authorityNodeId, "home", publicationId);
    const structure = bySchema.get("home.structure.v1")?.payload as unknown as StugubyHomeStructurePayload | undefined;
    const floorIds = new Map<string, string>();
    const roomIds = new Map<string, string>();
    const floors: Floor[] | undefined = structure?.floors.map((floor) => {
      const floorId = this.store.projectionId(stugubyId, authorityNodeId, "floor", floor.floorPublicationId);
      floorIds.set(floor.floorPublicationId, floorId);
      const wallIds = new Map(floor.walls.map((wall) => [
        wall.wallPublicationId,
        this.store.projectionId(stugubyId, authorityNodeId, "wall", wall.wallPublicationId),
      ]));
      const rooms = floor.rooms.map((room) => {
        const roomId = this.store.projectionId(stugubyId, authorityNodeId, "room", room.roomPublicationId);
        roomIds.set(room.roomPublicationId, roomId);
        return {
          id: roomId,
          name: room.name,
          points: room.points.map((point) => ({ x: point.x, y: point.y })),
          ...(room.kind ? { kind: room.kind } : {}),
        };
      });
      const planElements = floor.planElements.flatMap((element) => {
        if (!["door", "window", "fireplace", "vent", "fireEscape"].includes(element.kind)) return [];
        const projected: Record<string, unknown> = {
          id: this.store.projectionId(stugubyId, authorityNodeId, "plan-element", element.planElementPublicationId),
          kind: element.kind,
          position: { x: element.position.x, y: element.position.y },
          rotationDegrees: element.rotationDegrees,
        };
        for (const key of ["width", "height", "label", "state", "openFraction", "bottomOffsetM", "variant",
          "nominalFlowM3h", "verticalExtent", "chimneyHeightAboveRoof", "chimneyWidth", "chimneyDepth", "projection"] as const) {
          if (element[key] !== undefined) projected[key] = element[key];
        }
        if (element.wallPublicationId) {
          const wallId = wallIds.get(element.wallPublicationId);
          if (!wallId) return [];
          projected.wallId = wallId;
        }
        return [projected];
      });
      const projected: Record<string, unknown> = {
        id: floorId,
        name: floor.name,
        width: floor.width,
        height: floor.height,
        elevation: floor.elevation,
        walls: floor.walls.map((wall) => ({
          id: wallIds.get(wall.wallPublicationId)!,
          from: { x: wall.from.x, y: wall.from.y },
          to: { x: wall.to.x, y: wall.to.y },
        })),
        rooms,
        planElements,
      };
      for (const key of ["type", "metersPerPlanUnit", "ceilingHeight", "wallHeight"] as const) {
        if (floor[key] !== undefined) projected[key] = floor[key];
      }
      if (floor.roof) projected.roof = { ...floor.roof };
      return projected as unknown as Floor;
    });

    const locationPayload = bySchema.get("home.location.v1")?.payload as unknown as StugubyHomeLocationPayload | undefined;
    const location = locationPayload ? {
      latitude: locationPayload.latitude,
      longitude: locationPayload.longitude,
      ...(locationPayload.label ? { label: locationPayload.label } : {}),
      ...(locationPayload.countryCode ? { countryCode: locationPayload.countryCode } : {}),
      source: "manual" as const,
    } : undefined;
    const footprintFloorId = locationPayload?.mapPlacement?.footprintFloorPublicationId
      ? floorIds.get(locationPayload.mapPlacement.footprintFloorPublicationId)
      : undefined;
    const mapPlacement = locationPayload?.mapPlacement ? {
      latitude: locationPayload.mapPlacement.latitude,
      longitude: locationPayload.mapPlacement.longitude,
      metersPerPlanUnit: locationPayload.mapPlacement.metersPerPlanUnit,
      ...(footprintFloorId ? { footprintFloorId } : {}),
    } : undefined;

    let house = this.database.getHouse(localHouseId);
    if (house && floors) {
      const validFloorIds = new Set(floors.map((floor) => floor.id));
      for (const sensor of this.database.listSensors(house.id)) {
        if (sensor.tags.includes("stuguby-shared") && !validFloorIds.has(sensor.floorId)) this.database.deleteSensor(sensor.id);
      }
    }
    if (!house) {
      house = this.database.createHouse({
        id: localHouseId,
        propertyId: adoption.localPropertyId,
        name: directory.name,
        timezone: directory.timezone,
        ...(location ? { location } : {}),
        ...(mapPlacement ? { mapPlacement } : {}),
        ...(locationPayload?.orientationDegrees !== undefined ? { orientationDegrees: locationPayload.orientationDegrees } : {}),
        floors: floors ?? [],
      });
    } else {
      house = this.database.updateHouse(house.id, {
        propertyId: adoption.localPropertyId,
        name: directory.name,
        timezone: directory.timezone,
        ...(location ? { location } : {}),
        ...(mapPlacement ? { mapPlacement } : {}),
        ...(locationPayload?.orientationDegrees !== undefined ? { orientationDegrees: locationPayload.orientationDegrees } : {}),
        ...(floors ? { floors } : {}),
      }, "system-service")!;
    }

    const floorPlan = bySchema.get("home.floorplan.v1")?.payload as unknown as StugubyHomeFloorPlanPayload | undefined;
    if (floorPlan && floors) {
      const floorById = new Map(house.floors.map((floor) => [floor.id, { ...floor }]));
      for (const asset of floorPlan.assets) {
        const localFloorId = floorIds.get(asset.floorPublicationId);
        const floor = localFloorId ? floorById.get(localFloorId) : null;
        if (!floor) continue;
        try {
          const blob = this.readBlob(asset.image.digest);
          floor.backgroundImage = `data:${blob.mediaType};base64,${blob.data.toString("base64")}`;
        } catch {
          // The recovery state below remains incomplete until the cached blob arrives.
        }
      }
      house = this.database.updateHouse(house.id, { floors: [...floorById.values()] }, "system-service")!;
    }

    const sensorCatalog = bySchema.get("home.sensor-catalog.v1")?.payload as unknown as StugubySensorCatalogPayload | undefined;
    if (sensorCatalog) {
      const expected = new Set<string>();
      for (const item of sensorCatalog.sensors) {
        const floorId = floorIds.get(item.floorPublicationId);
        if (!floorId) continue;
        const id = this.store.projectionId(stugubyId, authorityNodeId, "sensor", item.sensorPublicationId);
        expected.add(id);
        const roomId = item.roomPublicationId ? roomIds.get(item.roomPublicationId) ?? null : null;
        const room = roomId
          ? house.floors.find((floor) => floor.id === floorId)?.rooms.find((candidate) => candidate.id === roomId)?.name ?? ""
          : "";
        const existing = this.database.getSensor(id);
        if (existing) {
          this.database.updateSensor(id, {
            houseId: house.id,
            floorId,
            name: item.name,
            roomId,
            room,
            model: item.model,
            x: item.x,
            y: item.y,
            z: item.z,
            tags: [...item.tags.filter((tag) => tag !== "stuguby-shared"), "stuguby-shared"],
            enabled: item.enabled,
            measurementEntityIds: {},
          });
        } else {
          this.database.createSensor({
            id,
            houseId: house.id,
            floorId,
            name: item.name,
            roomId,
            room,
            model: item.model,
            x: item.x,
            y: item.y,
            z: item.z,
            tags: [...item.tags.filter((tag) => tag !== "stuguby-shared"), "stuguby-shared"],
            enabled: item.enabled,
          });
        }
      }
      for (const sensor of this.database.listSensors(house.id)) {
        if (sensor.tags.includes("stuguby-shared") && !expected.has(sensor.id)) this.database.deleteSensor(sensor.id);
      }
    }

    const notesPayload = bySchema.get("home.notes.v1")?.payload as unknown as StugubyHomeNotesPayload | undefined;
    if (notesPayload) {
      const expected = new Set<string>();
      for (const item of notesPayload.notes) {
        const id = this.store.projectionId(stugubyId, authorityNodeId, "home-note", item.notePublicationId);
        expected.add(id);
        const existing = this.database.getPropertyNote(id);
        if (existing) {
          this.database.updatePropertyNote(id, { houseId: house.id, areaId: null, equipmentId: null, kind: item.kind, text: item.text });
        } else {
          this.database.createPropertyNote({
            id,
            propertyId: adoption.localPropertyId,
            houseId: house.id,
            areaId: null,
            equipmentId: null,
            kind: item.kind,
            text: item.text,
          });
        }
        this.database.db.prepare("UPDATE property_notes SET created_at=?,updated_at=? WHERE id=?")
          .run(item.createdAt, item.updatedAt, id);
      }
      for (const projection of this.store.listProjectionIds(stugubyId, authorityNodeId, "home-note")) {
        if (!expected.has(projection.localId)) this.database.deletePropertyNote(projection.localId);
      }
    }

    const observationsPayload = bySchema.get("home.observations.v1")?.payload as unknown as StugubyHomeObservationsPayload | undefined;
    if (observationsPayload) {
      const expected = new Set<string>();
      for (const item of observationsPayload.observations) {
        const floorId = floorIds.get(item.floorPublicationId);
        if (!floorId) continue;
        const sensorId = item.sensorPublicationId
          ? this.store.projectionId(stugubyId, authorityNodeId, "sensor", item.sensorPublicationId)
          : null;
        if (sensorId && !this.database.getSensor(sensorId)) continue;
        const id = this.store.projectionId(stugubyId, authorityNodeId, "observation", item.observationPublicationId);
        expected.add(id);
        const existing = this.database.getObservation(id);
        if (!existing) {
          this.database.createObservation({
            id,
            houseId: house.id,
            floorId,
            sensorId,
            kind: item.kind as never,
            severity: item.severity as never,
            note: item.note,
            x: item.x,
            y: item.y,
            occurredAt: item.occurredAt,
            ...(item.timePrecision ? { timePrecision: item.timePrecision as never } : {}),
            ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
            ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
            source: "unknown",
            sourceDetail: "Stuguby shared history",
            ...(item.confidence ? { confidence: item.confidence as never } : {}),
          }, "system-service");
        } else {
          this.database.updateObservation(id, {
            baseRevision: existing.revision,
            floorId,
            sensorId,
            kind: item.kind as never,
            severity: item.severity as never,
            note: item.note,
            x: item.x,
            y: item.y,
            occurredAt: item.occurredAt,
            ...(item.timePrecision ? { timePrecision: item.timePrecision as never } : {}),
            ...(item.validFrom !== undefined ? { validFrom: item.validFrom } : {}),
            ...(item.validTo !== undefined ? { validTo: item.validTo } : {}),
            ...(item.confidence ? { confidence: item.confidence as never } : {}),
            ...(item.status ? { status: item.status as never } : {}),
            ...(item.resolutionNote !== undefined ? { resolutionNote: item.resolutionNote } : {}),
          }, "system-service");
        }
      }
      for (const projection of this.store.listProjectionIds(stugubyId, authorityNodeId, "observation")) {
        if (!expected.has(projection.localId)) this.database.deleteObservation(projection.localId);
      }
    }

    const recoveryEligible = grant.housePolicy.recoveryMode === "full"
      && grant.housePolicy.designatedSuccessorNodeId === this.identity.nodeId;
    const requiredSchemas: StugubyDataset[] = [
      "home.directory.v1", "home.structure.v1", "home.floorplan.v1",
      "home.sensor-catalog.v1", "home.notes.v1", "home.observations.v1", "home.recovery.v1",
    ];
    const recoveryPayloads = resources
      .filter((resource) => resource.schema === "home.recovery.v1")
      .map((resource) => resource.payload as unknown as StugubyHomeRecoveryPayload);
    const recoveryGeneration = Math.max(0, ...recoveryPayloads.map((payload) => payload.generation));
    const currentRecovery = recoveryPayloads.filter((payload) => payload.generation === recoveryGeneration);
    const recoveryKinds: StugubyHomeRecoveryKind[] = [
      "manifest", "measurement-definitions", "alert-rules", "alert-events", "static-parameters",
      "opening-states", "weather-history", "electricity-history", "assets",
    ];
    const manifest = currentRecovery.find((payload) => payload.kind === "manifest" && payload.complete)
      ?.records[0] as { telemetrySamples?: number } | undefined;
    const recoveryArchiveReady = recoveryKinds.every((kind) => currentRecovery.some((payload) => (
      payload.kind === kind && payload.complete
    ))) && Number.isSafeInteger(manifest?.telemetrySamples)
      && this.store.remoteTelemetryCount(stugubyId, authorityNodeId, publicationId) >= Number(manifest?.telemetrySamples ?? Infinity);
    const recoveryAssets = currentRecovery.flatMap(recoveryAssetReferences);
    const blobsReady = (!floorPlan || floorPlan.assets.every((asset) => {
      try { this.readBlob(asset.image.digest); return true; } catch { return false; }
    })) && recoveryAssets.every((asset) => {
      try {
        const blob = this.readBlob(asset.digest);
        return blob.data.byteLength === asset.byteLength && blob.mediaType === asset.mediaType;
      } catch {
        return false;
      }
    });
    const recoveryReady = recoveryEligible
      && requiredSchemas.every((schema) => bySchema.has(schema))
      && recoveryArchiveReady
      && blobsReady;
    const syncedThrough = resources.map((resource) => resource.receivedAt).sort().at(-1) ?? null;
    const projection: StugubyHomeProjection = {
      stugubyId,
      authorityNodeId,
      publicationId,
      localHouseId: house.id,
      editPolicy: grant.housePolicy.editPolicy,
      recoveryMode: grant.housePolicy.recoveryMode,
      recoveryState: recoveryEligible ? (recoveryReady ? "ready" : "syncing") : "not-enabled",
      designatedSuccessorNodeId: grant.housePolicy.designatedSuccessorNodeId,
      recoverySyncedThrough: recoveryReady ? syncedThrough : null,
      authorityEpoch: 1,
      detachedAt: null,
      updatedAt: new Date().toISOString(),
    };
    this.store.upsertHomeProjection(projection);
    const commandCounts = this.store.homeCommandCountsFor(stugubyId, authorityNodeId, publicationId);
    const syncState = resources.some((resource) => resource.stale)
      ? "offline"
      : commandCounts.conflicts > 0
        ? "conflict"
        : commandCounts.pending > 0
          ? "pending"
          : "current";
    this.database.setHouseStugubyLink(house.id, {
      stugubyId,
      authorityNodeId,
      publicationId,
      ownership: "shared",
      editPolicy: projection.editPolicy,
      syncState,
      authorityEpoch: projection.authorityEpoch,
      pendingChangeCount: commandCounts.pending,
      conflictCount: commandCounts.conflicts,
      recoveryState: projection.recoveryState,
      ...(projection.designatedSuccessorNodeId ? { designatedSuccessorNodeId: projection.designatedSuccessorNodeId } : {}),
      ...(projection.recoverySyncedThrough ? { recoverySyncedThrough: projection.recoverySyncedThrough } : {}),
    });
    const sharedProperty = this.store.getSharedProperty(stugubyId);
    if (sharedProperty?.equipment.some((item) => (
      item.home?.authorityNodeId === authorityNodeId
      && item.home.publicationId === publicationId
    ))) {
      this.materializeSharedProperty(sharedProperty);
    }
  }

  private ensureRecommendedHomeOverviewGrant(stugubyId: string, localHouseId: string): StugubyShareGrant | null {
    const existing = this.store.listGrants(stugubyId, this.identity.nodeId)
      .find((grant) => grant.localHouseId === localHouseId && !grant.revokedAt && !grantExpired(grant));
    if (existing) return null;
    return this.createGrant(stugubyId, {
      localHouseId,
      audience: { kind: "all-members", nodeIds: [] },
      datasets: recommendedHomeOverviewDatasets(),
      housePolicy: {
        editPolicy: "read-only",
        recoveryMode: "none",
        designatedSuccessorNodeId: null,
      },
      expiresAt: null,
    });
  }

  private backfillRecommendedHomeOverviews(stugubyId: string): void {
    const stuguby = this.store.getStuguby(stugubyId);
    const adoption = this.store.getPropertyAdoption(stugubyId);
    if (!stuguby || stuguby.localMemberState !== "active" || stuguby.localRole === "viewer"
      || !adoption || adoption.state !== "adopted") return;
    const grants = this.store.listGrants(stugubyId, this.identity.nodeId);
    for (const house of this.database.listHouses(adoption.localPropertyId)) {
      if (house.stuguby?.stugubyId !== stugubyId || house.stuguby.ownership !== "local") continue;
      // Never replace an explicitly revoked or expired grant. This only repairs
      // Homes linked by the older Property flow, which created no grant at all.
      if (!grants.some((grant) => grant.localHouseId === house.id)) {
        this.ensureRecommendedHomeOverviewGrant(stugubyId, house.id);
      }
    }
  }

  createGrant(stugubyId: string, input: {
    localHouseId: string;
    audience: StugubyGrantAudience;
    datasets: StugubyDatasetGrant[];
    housePolicy?: StugubyShareGrant["housePolicy"];
    expiresAt?: string | null;
  }): StugubyShareGrant {
    this.requireLocalPublisher(stugubyId);
    const house = this.database.getHouse(requiredText(input.localHouseId, "House id"));
    if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Local house was not found");
    const publicationId = this.store.publicationId(stugubyId, "home", house.id);
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : null;
    if (expiresAt && expiresAt <= now) throw new StugubyError(400, "INVALID_EXPIRY", "Grant expiry must be in the future");
    const grant: StugubyShareGrant = {
      id: randomUUID(),
      stugubyId,
      authorityNodeId: this.identity.nodeId,
      publicationId,
      localHouseId: house.id,
      audience: input.audience,
      datasets: input.datasets,
      housePolicy: input.housePolicy ?? {
        editPolicy: "read-only",
        recoveryMode: "none",
        designatedSuccessorNodeId: null,
      },
      epoch: 1,
      revision: 1,
      expiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (grant.housePolicy.editPolicy === "editable" && !this.store.isCoordinator(stugubyId)) {
      throw new StugubyError(409, "EDITABLE_HOME_REQUIRES_COORDINATOR_AUTHORITY", "Only a coordinator-owned Home can currently accept shared edits");
    }
    this.validateEditableHomeGrant(grant);
    this.validateGrantAgainstMembership(grant);
    validateShareGrant(grant);
    this.atomicPublication(() => {
      this.validateUniqueRecoverySuccessor(grant);
      this.validateUniqueActiveHomeGrant(grant);
      this.store.upsertGrant(grant);
      this.store.audit(stugubyId, "grant.created", this.identity.nodeId, grant.id, {
        revision: grant.revision, epoch: grant.epoch, audience: grant.audience.kind,
        enabledDatasets: grant.datasets.filter((dataset) => dataset.enabled).length,
      });
      this.publishGrant(grant, "grant.upserted");
      this.publishGrantSnapshots(grant, house);
    });
    this.markLocalSharedHouse(grant, house);
    return grant;
  }

  localPublicationCatalog(stugubyId: string, localHouseId: string): {
    house: { localHouseId: string; publicationId: string; name: string };
    sensors: Array<{ localSensorId: string; sensorPublicationId: string; name: string; metricIds: string[] }>;
  } {
    this.requireLocalPublisher(stugubyId);
    const house = this.database.getHouse(requiredText(localHouseId, "House id"));
    if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Local house was not found");
    return {
      house: {
        localHouseId: house.id,
        publicationId: this.store.publicationId(stugubyId, "home", house.id),
        name: house.name,
      },
      sensors: this.database.listSensors(house.id).map((sensor) => ({
        localSensorId: sensor.id,
        sensorPublicationId: this.store.publicationId(stugubyId, "sensor", sensor.id),
        name: sensor.name,
        metricIds: this.sensorMetrics(sensor.id),
      })),
    };
  }

  updateGrant(grantId: string, baseRevision: number, input: Pick<StugubyShareGrant, "audience" | "datasets" | "expiresAt" | "housePolicy">): StugubyShareGrant {
    const existing = this.store.getGrant(grantId);
    if (!existing) throw new StugubyError(404, "GRANT_NOT_FOUND", "Share grant was not found");
    if (existing.authorityNodeId !== this.identity.nodeId) throw new StugubyError(403, "GRANT_AUTHORITY_REQUIRED", "Only the authoritative local Stugu may edit this grant");
    if (existing.revokedAt) throw new StugubyError(409, "GRANT_REVOKED", "A revoked grant cannot be edited");
    this.requireLocalPublisher(existing.stugubyId);
    if (existing.revision !== baseRevision) throw new StugubyError(409, "REVISION_CONFLICT", `Current grant revision is ${existing.revision}`);
    const retiredAt = new Date().toISOString();
    const retired: StugubyShareGrant = {
      ...existing,
      epoch: existing.epoch + 1,
      revision: existing.revision + 1,
      revokedAt: retiredAt,
      updatedAt: retiredAt,
    };
    const expiresAt = input.expiresAt ? parseIso(input.expiresAt, "expiresAt") : null;
    if (expiresAt && expiresAt <= retiredAt) throw new StugubyError(400, "INVALID_EXPIRY", "Grant expiry must be in the future");
    const grant: StugubyShareGrant = {
      ...existing,
      audience: input.audience,
      datasets: input.datasets,
      housePolicy: input.housePolicy,
      expiresAt,
      epoch: existing.epoch + 2,
      revision: existing.revision + 2,
      revokedAt: null,
      updatedAt: new Date().toISOString(),
    };
    if (grant.housePolicy.editPolicy === "editable" && !this.store.isCoordinator(existing.stugubyId)) {
      throw new StugubyError(409, "EDITABLE_HOME_REQUIRES_COORDINATOR_AUTHORITY", "Only a coordinator-owned Home can currently accept shared edits");
    }
    this.validateEditableHomeGrant(grant);
    this.validateGrantAgainstMembership(grant);
    validateShareGrant(grant);
    const house = this.database.getHouse(existing.localHouseId ?? "");
    if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Grant house was not found");
    // Every former recipient first receives a tombstone and must acknowledge
    // deletion. Continuing recipients then receive a fresh epoch and snapshot.
    this.atomicPublication(() => {
      this.validateUniqueRecoverySuccessor(grant);
      this.store.discardOutboxGrantEpoch(existing.stugubyId, existing.id, existing.epoch);
      this.publishGrant(retired, "grant.revoked");
      this.store.upsertGrant(grant);
      this.store.audit(grant.stugubyId, "grant.updated", this.identity.nodeId, grant.id, {
        revision: grant.revision, epoch: grant.epoch, audience: grant.audience.kind,
        enabledDatasets: grant.datasets.filter((dataset) => dataset.enabled).length,
      });
      this.publishGrant(grant, "grant.upserted");
      this.publishGrantSnapshots(grant, house);
      this.store.retireLocalBlobReferences(grant.stugubyId, grant.id, existing.epoch);
    });
    this.markLocalSharedHouse(grant, house);
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    return grant;
  }

  revokeGrant(grantId: string): StugubyShareGrant {
    const previous = this.store.getGrant(grantId);
    if (!previous) throw new StugubyError(404, "GRANT_NOT_FOUND", "Share grant was not found");
    if (previous.authorityNodeId !== this.identity.nodeId) throw new StugubyError(403, "GRANT_AUTHORITY_REQUIRED", "Only the authoritative local Stugu may revoke this grant");
    if (previous.revokedAt) throw new StugubyError(409, "GRANT_REVOKED", "Share grant is already revoked");
    this.requireLocalPublisher(previous.stugubyId);
    const revoked = this.atomicPublication(() => {
      const retired = this.store.revokeGrant(grantId);
      // Keep the old audience on the revocation so every former recipient purges its replica.
      this.store.discardOutboxGrantEpoch(previous.stugubyId, previous.id, previous.epoch);
      this.publishGrant({ ...retired, audience: previous.audience }, "grant.revoked");
      this.store.audit(retired.stugubyId, "grant.revoked", this.identity.nodeId, retired.id, { epoch: retired.epoch });
      this.store.retireLocalBlobReferences(retired.stugubyId, retired.id, previous.epoch);
      return retired;
    });
    this.refreshLocalSharedHouseLink(revoked.stugubyId, previous.localHouseId ?? "");
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    return revoked;
  }

  republishGrant(grantId: string): void {
    const grant = this.store.getGrant(grantId);
    if (!grant || grant.authorityNodeId !== this.identity.nodeId || grant.revokedAt || grantExpired(grant)) throw new StugubyError(404, "GRANT_NOT_FOUND", "Active local share grant was not found");
    this.requireLocalPublisher(grant.stugubyId);
    const house = this.database.getHouse(grant.localHouseId ?? "");
    if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Grant house was not found");
    this.publishGrant(grant, "grant.upserted");
    this.publishGrantSnapshots(grant, house);
    this.store.audit(grant.stugubyId, "grant.republished", this.identity.nodeId, grant.id, { revision: grant.revision, epoch: grant.epoch });
  }

  private validateGrantAgainstMembership(grant: StugubyShareGrant, authorityNodeId = this.identity.nodeId): void {
    if (grant.audience.kind === "members" && grant.audience.nodeIds.length === 0) {
      throw new StugubyError(400, "EMPTY_AUDIENCE", "A member-specific grant requires at least one participant");
    }
    const active = new Set(this.store.listMembers(grant.stugubyId).filter((member) => member.state === "active").map((member) => member.nodeId));
    for (const nodeId of grant.audience.nodeIds) {
      if (!active.has(nodeId) || nodeId === authorityNodeId) throw new StugubyError(400, "INVALID_AUDIENCE", `Node ${nodeId} is not an eligible active participant`);
    }
    const successor = grant.housePolicy.designatedSuccessorNodeId;
    if (successor && (!active.has(successor) || successor === authorityNodeId)) {
      throw new StugubyError(400, "INVALID_SUCCESSOR", "The designated Home successor must be one active remote member");
    }
  }

  private validateEditableHomeGrant(grant: StugubyShareGrant): void {
    if (grant.housePolicy.editPolicy !== "editable") return;
    const enabled = new Map(grant.datasets.filter((dataset) => dataset.enabled).map((dataset) => [dataset.dataset, dataset]));
    for (const dataset of [
      "home.directory.v1", "home.location.v1", "home.structure.v1",
      "home.sensor-catalog.v1", "home.notes.v1", "home.observations.v1",
    ] as const) {
      const policy = enabled.get(dataset);
      if (!policy?.allowReplicaCache || policy.retentionDays < 1) {
        throw new StugubyError(
          400,
          "EDITABLE_HOME_DATASETS_REQUIRED",
          "Editable Homes require directory, location, structure, sensors, notes, and observations with durable local caching",
        );
      }
    }
  }

  private validateUniqueRecoverySuccessor(grant: StugubyShareGrant): void {
    if (grant.housePolicy.recoveryMode !== "full") return;
    const successor = grant.housePolicy.designatedSuccessorNodeId;
    const competing = this.store.listGrants(grant.stugubyId, grant.authorityNodeId)
      .find((candidate) => candidate.id !== grant.id
        && candidate.localHouseId === grant.localHouseId
        && candidate.housePolicy.recoveryMode === "full"
        && candidate.housePolicy.designatedSuccessorNodeId !== successor
        && !candidate.revokedAt
        && !grantExpired(candidate));
    if (competing) {
      throw new StugubyError(
        409,
        "HOME_SUCCESSOR_ALREADY_DESIGNATED",
        "This Home already has a different designated recovery successor",
      );
    }
  }

  private validateUniqueActiveHomeGrant(grant: StugubyShareGrant): void {
    const existing = this.store.listGrants(grant.stugubyId, grant.authorityNodeId)
      .find((candidate) => candidate.id !== grant.id
        && candidate.localHouseId === grant.localHouseId
        && !candidate.revokedAt
        && !grantExpired(candidate));
    if (existing) {
      throw new StugubyError(
        409,
        "HOME_ALREADY_SHARED",
        "This Home already has an active share grant. Update or revoke it before creating another",
      );
    }
  }

  markLocalHouseInAdoptedProperty(houseId: string): House {
    const house = this.database.getHouse(houseId);
    if (!house) throw new StugubyError(404, "HOUSE_NOT_FOUND", "Home was not found");
    const propertyLink = this.database.getProperty(house.propertyId)?.stuguby;
    if (!propertyLink || propertyLink.syncState === "detached") return house;
    if (house.stuguby && house.stuguby.stugubyId !== propertyLink.stugubyId
      && house.stuguby.syncState !== "detached") {
      throw new StugubyError(409, "HOUSE_ALREADY_SHARED", "This Home already belongs to another Stuguby");
    }
    const linked = this.database.setHouseStugubyLink(house.id, {
      stugubyId: propertyLink.stugubyId,
      authorityNodeId: this.identity.nodeId,
      publicationId: this.store.publicationId(propertyLink.stugubyId, "home", house.id),
      ownership: "local",
      editPolicy: "editable",
      syncState: "current",
      authorityEpoch: house.stuguby?.authorityEpoch ?? 1,
      pendingChangeCount: 0,
      conflictCount: 0,
      recoveryState: "not-enabled",
    })!;
    this.ensureRecommendedHomeOverviewGrant(propertyLink.stugubyId, house.id);
    return linked;
  }

  private markLocalSharedHouse(grant: StugubyShareGrant, house: House): void {
    const existing = this.database.getHouse(house.id);
    if (!existing) return;
    this.database.setHouseStugubyLink(house.id, {
      stugubyId: grant.stugubyId,
      authorityNodeId: this.identity.nodeId,
      publicationId: grant.publicationId,
      ownership: "local",
      editPolicy: "editable",
      syncState: "current",
      authorityEpoch: existing.stuguby?.authorityEpoch ?? 1,
      pendingChangeCount: 0,
      conflictCount: 0,
      recoveryState: "not-enabled",
    });
  }

  private refreshLocalSharedHouseLink(stugubyId: string, houseId: string): void {
    const house = this.database.getHouse(houseId);
    if (!house?.stuguby || house.stuguby.stugubyId !== stugubyId || house.stuguby.ownership !== "local") return;
    const stillShared = this.store.listGrants(stugubyId, this.identity.nodeId)
      .some((grant) => grant.localHouseId === houseId && !grant.revokedAt && !grantExpired(grant));
    if (stillShared) return;
    const propertyLink = this.database.getProperty(house.propertyId)?.stuguby;
    if (!propertyLink || propertyLink.stugubyId !== stugubyId || propertyLink.syncState === "detached") {
      this.database.setHouseStugubyLink(houseId, null);
    }
  }

  private publishGrant(grant: StugubyShareGrant, eventKind: "grant.upserted" | "grant.revoked"): void {
    const wireGrant = withoutLocalGrantIdentity(grant);
    const event = this.createEvent({
      stugubyId: grant.stugubyId,
      eventKind,
      streamId: `grant:${grant.id}`,
      schema: "stuguby.grant.v2",
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
    if (this.#deferredNotifications) return operation();
    const notifications: Notification[] = [];
    this.#deferredNotifications = notifications;
    try {
      const result = this.database.transaction(operation);
      for (const notification of notifications) this.#notifications.emit("event", notification);
      return result;
    } finally {
      this.#deferredNotifications = null;
    }
  }

  private publishGrantSnapshots(
    grant: StugubyShareGrant,
    house: House,
    revision = this.store.homeRevision(grant.stugubyId, this.identity.nodeId, grant.publicationId),
  ): void {
    let recoveryTelemetrySamples = 0;
    for (const dataset of grant.datasets) {
      if (!dataset.enabled) continue;
      if (dataset.dataset === "home.telemetry.v1") {
        recoveryTelemetrySamples = grant.housePolicy.recoveryMode === "full"
          ? this.publishFullRecoveryTelemetry(grant, house, dataset)
          : (this.publishHistoricalTelemetry(grant, house, dataset), 0);
        continue;
      }
      if (dataset.dataset === "home.recovery.v1") {
        this.publishRecoveryArchive(grant, house, recoveryTelemetrySamples, revision);
        continue;
      }
      const projected = this.projectDataset(grant, house, dataset);
      if (!projected) continue;
      this.publishDataset(grant, dataset.dataset, projected, `${grant.publicationId}:${dataset.dataset}`, revision);
    }
  }

  private projectDataset(grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): JsonValue | null {
    const local = dataset.includeLocalIds;
    const publicationId = grant.publicationId;
    switch (dataset.dataset) {
      case "home.directory.v1": {
        const payload: StugubyHomeDirectoryPayload = {
          publicationId,
          name: house.name,
          timezone: house.timezone,
          ...(local ? { localHouseId: house.id } : {}),
        };
        return payload;
      }
      case "home.location.v1": {
        if (!house.location) return null;
        const payload: StugubyHomeLocationPayload = {
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
              footprintFloorPublicationId: this.store.publicationId(grant.stugubyId, "floor", house.mapPlacement.footprintFloorId),
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
          notePublicationId: this.store.publicationId(grant.stugubyId, "note", note.id),
          ...(local ? { localNoteId: note.id } : {}),
          kind: note.kind,
          text: note.text,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }));
        return { publicationId, notes } satisfies StugubyHomeNotesPayload;
      }
      case "home.observations.v1": {
        const observations = this.database.listObservations(house.id).map((observation) => ({
          observationPublicationId: this.store.publicationId(grant.stugubyId, "observation", observation.id),
          ...(local ? { localObservationId: observation.id } : {}),
          floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", observation.floorId),
          ...(observation.sensorId ? { sensorPublicationId: this.store.publicationId(grant.stugubyId, "sensor", observation.sensorId) } : {}),
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
        return { publicationId, observations } satisfies StugubyHomeObservationsPayload;
      }
      case "home.recovery.v1":
      case "home.telemetry.v1":
        return null;
    }
  }

  private projectStructure(grant: StugubyShareGrant, house: House, local: boolean): StugubyHomeStructurePayload {
    const floors = house.floors.map((floor) => {
      const walls = floor.walls.map((wall) => ({
        wallPublicationId: this.store.publicationId(grant.stugubyId, "wall", wall.id),
        ...(local ? { localWallId: wall.id } : {}),
        from: { x: wall.from.x, y: wall.from.y },
        to: { x: wall.to.x, y: wall.to.y },
      }));
      const rooms = floor.rooms.map((room) => ({
        roomPublicationId: this.store.publicationId(grant.stugubyId, "room", room.id),
        ...(local ? { localRoomId: room.id } : {}),
        name: room.name,
        points: room.points.map((point) => ({ x: point.x, y: point.y })),
        ...(room.kind ? { kind: room.kind } : {}),
      }));
      const planElements = (floor.planElements ?? []).map((element) => {
        const projected: Record<string, JsonValue> = {
          planElementPublicationId: this.store.publicationId(grant.stugubyId, "plan-element", element.id),
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
          projected.wallPublicationId = this.store.publicationId(grant.stugubyId, "wall", element.wallId);
        }
        return projected;
      });
      const result: Record<string, JsonValue> = {
        floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", floor.id),
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
    const payload = { publicationId: grant.publicationId, floors } as unknown as StugubyHomeStructurePayload;
    assertSafeFederationPayload(payload);
    return payload;
  }

  private projectFloorPlans(grant: StugubyShareGrant, house: House): StugubyHomeFloorPlanPayload {
    const assets = house.floors.flatMap((floor) => {
      if (!floor.backgroundImage) return [];
      const image = this.storeDataUrl(floor.backgroundImage);
      this.store.registerBlobReference(grant.stugubyId, image.digest, grant.id, grant.epoch, "local");
      return [{ floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", floor.id), image }];
    });
    return { publicationId: grant.publicationId, assets };
  }

  private projectSensors(grant: StugubyShareGrant, house: House, local: boolean): StugubySensorCatalogPayload {
    const sensors = this.database.listSensors(house.id).map((sensor) => ({
      sensorPublicationId: this.store.publicationId(grant.stugubyId, "sensor", sensor.id),
      ...(local ? { localSensorId: sensor.id } : {}),
      floorPublicationId: this.store.publicationId(grant.stugubyId, "floor", sensor.floorId),
      ...(sensor.roomId ? { roomPublicationId: this.store.publicationId(grant.stugubyId, "room", sensor.roomId) } : {}),
      name: sensor.name,
      model: sensor.model,
      tags: sensor.tags.filter((tag) => tag !== "stuguby-shared"),
      enabled: sensor.enabled,
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

  private publishHistoricalTelemetry(grant: StugubyShareGrant, house: House, dataset: StugubyDatasetGrant): void {
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
      this.store.publicationId(grant.stugubyId, "sensor", sensor.id),
    ]));
    const samples: StugubyTelemetryPayload["samples"] = rows.map((sample) => ({
      sensorPublicationId: publications.get(sample.sensor_id)!,
      metricId: sample.metric,
      timestamp: sample.timestamp,
      value: sample.value,
      quality: sample.quality,
    }));
    const byHour = new Map<string, StugubyTelemetryPayload["samples"]>();
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
        const payload: StugubyTelemetryPayload = {
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

  private publishFullRecoveryTelemetry(
    grant: StugubyShareGrant,
    house: House,
    dataset: StugubyDatasetGrant,
  ): number {
    const policy = dataset.telemetry;
    if (!policy?.historyFrom) throw new StugubyError(400, "RECOVERY_HISTORY_REQUIRED", "Full recovery requires a telemetry history start");
    const from = parseIso(policy.historyFrom, "Telemetry history start");
    const to = new Date().toISOString();
    const sensors = this.database.listSensors(house.id);
    const publications = new Map(sensors.map((sensor) => [
      sensor.id,
      this.store.publicationId(grant.stugubyId, "sensor", sensor.id),
    ]));
    const revision = this.store.homeRevision(grant.stugubyId, this.identity.nodeId, grant.publicationId);
    const statement = sensors.length > 0
      ? this.database.db.prepare(`SELECT sensor_id,metric,timestamp,value,quality
          FROM measurement_samples WHERE timestamp>=? AND timestamp<=?
            AND sensor_id IN (${sensors.map(() => "?").join(",")})
          ORDER BY timestamp,sensor_id,metric,id`)
      : null;
    const rows = statement
      ? statement.iterate(from, to, ...sensors.map((sensor) => sensor.id)) as NodeJS.Iterator<{
        sensor_id: string;
        metric: string;
        timestamp: string;
        value: number;
        quality: "good" | "estimated" | "stale";
      }>
      : [][Symbol.iterator]();
    let samples: StugubyTelemetryPayload["samples"] = [];
    let count = 0;
    let chunkIndex = 0;
    const flush = (): void => {
      if (samples.length === 0) return;
      const chunkId = sha256(`${grant.id}\n${grant.epoch}\nfull-recovery\n${chunkIndex}`);
      this.publishDataset(grant, "home.telemetry.v1", {
        publicationId: grant.publicationId,
        chunkId,
        from: samples[0]!.timestamp,
        to: samples.at(-1)!.timestamp,
        complete: false,
        samples,
      } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:recovery:${chunkIndex}`, revision);
      chunkIndex += 1;
      samples = [];
    };
    for (const row of rows) {
      samples.push({
        sensorPublicationId: publications.get(row.sensor_id)!,
        metricId: row.metric,
        timestamp: row.timestamp,
        value: row.value,
        quality: row.quality,
      });
      count += 1;
      if (samples.length >= 2_000) flush();
    }
    flush();
    const completionId = sha256(`${grant.id}\n${grant.epoch}\nfull-recovery\ncomplete`);
    this.publishDataset(grant, "home.telemetry.v1", {
      publicationId: grant.publicationId,
      chunkId: completionId,
      from,
      to,
      complete: true,
      samples: [],
    } satisfies StugubyTelemetryPayload, `${grant.publicationId}:telemetry:recovery:complete`, revision);
    return count;
  }

  private publishRecoveryArchive(
    grant: StugubyShareGrant,
    house: House,
    telemetrySamples: number,
    generation: number,
  ): void {
    if (grant.housePolicy.recoveryMode !== "full") {
      throw new StugubyError(400, "RECOVERY_SUCCESSOR_REQUIRED", "Recovery archives require one designated full-recovery successor");
    }
    const sensorPublication = (sensorId: string) => this.store.publicationId(grant.stugubyId, "sensor", sensorId);
    const floorPublication = (floorId: string) => this.store.publicationId(grant.stugubyId, "floor", floorId);
    const elementPublication = (elementId: string) => this.store.publicationId(grant.stugubyId, "plan-element", elementId);
    const ruleKey = (ruleId: string) => sha256(`stuguby-rule\n${grant.stugubyId}\n${ruleId}`);
    const metricIds = new Set((this.database.db.prepare(`SELECT DISTINCT sample.metric
      FROM measurement_samples sample JOIN sensors sensor ON sensor.id=sample.sensor_id
      WHERE sensor.house_id=?`).all(house.id) as Array<{ metric: string }>).map((row) => row.metric));
    const definitions = this.database.listMeasurementDefinitions()
      .filter((definition) => metricIds.has(definition.id))
      .map((definition) => ({
        id: definition.id,
        labels: definition.labels,
        unit: definition.unit,
        ...(definition.dimension ? { dimension: definition.dimension } : {}),
        ...(definition.allowedUnits ? { allowedUnits: definition.allowedUnits } : {}),
        ...(definition.kind ? { kind: definition.kind } : {}),
        ...(definition.defaultAggregation ? { defaultAggregation: definition.defaultAggregation } : {}),
        precision: definition.precision,
        validMin: definition.validMin,
        validMax: definition.validMax,
        displayMin: definition.displayMin,
        displayMax: definition.displayMax,
        interpolationDelta: definition.interpolationDelta,
        colorScale: definition.colorScale,
        enabled: definition.enabled,
        spatialInterpolation: definition.spatialInterpolation,
        forecastSupported: definition.forecastSupported,
      }));
    const rules = (this.database.db.prepare(`SELECT * FROM alert_rules WHERE sensor_id IN (
      SELECT id FROM sensors WHERE house_id=?) ORDER BY id`).all(house.id) as Array<{
        id: string; name: string; sensor_id: string; metric: string; operator: string; threshold: number;
        duration_seconds: number; severity: string; enabled: number; retired_at: string | null;
      }>).map((rule) => ({
        ruleKey: ruleKey(rule.id),
        name: rule.name,
        sensorPublicationId: sensorPublication(rule.sensor_id),
        metric: rule.metric,
        operator: rule.operator,
        threshold: rule.threshold,
        durationSeconds: rule.duration_seconds,
        severity: rule.severity,
        enabled: Boolean(rule.enabled),
        retiredAt: rule.retired_at,
      }));
    const alertEvents = (this.database.db.prepare(`SELECT event.* FROM alert_events event
      JOIN sensors sensor ON sensor.id=event.sensor_id WHERE sensor.house_id=? ORDER BY event.started_at,event.id`)
      .all(house.id) as Array<{
        id: string; rule_id: string; sensor_id: string; metric: string; value: number; threshold: number;
        severity: string; started_at: string; acknowledged_at: string | null; resolved_at: string | null;
      }>).map((event) => ({
        eventKey: sha256(`stuguby-alert\n${grant.stugubyId}\n${event.id}`),
        ruleKey: ruleKey(event.rule_id),
        sensorPublicationId: sensorPublication(event.sensor_id),
        metric: event.metric,
        value: event.value,
        threshold: event.threshold,
        severity: event.severity,
        startedAt: event.started_at,
        acknowledgedAt: event.acknowledged_at,
        resolvedAt: event.resolved_at,
      }));
    const staticParameters = this.database.listParameters(house.id).map((parameter) => {
      const scopePublicationId = parameter.scopeType === "house"
        ? grant.publicationId
        : parameter.scopeType === "floor"
          ? floorPublication(parameter.scopeId)
          : parameter.scopeType === "room"
            ? this.store.publicationId(grant.stugubyId, "room", parameter.scopeId)
            : sensorPublication(parameter.scopeId);
      return {
        parameterKey: sha256(`stuguby-parameter\n${grant.stugubyId}\n${parameter.id}`),
        scopeType: parameter.scopeType,
        scopePublicationId,
        key: parameter.key,
        value: parameter.value,
        unit: parameter.unit,
        label: parameter.label,
      };
    });
    const openingStates = (this.database.db.prepare(`SELECT id,floor_id,element_id,state,open_fraction,observed_at,valid_until
      FROM opening_state_observations WHERE house_id=? ORDER BY observed_at,id`).all(house.id) as Array<{
        id: string; floor_id: string; element_id: string; state: string; open_fraction: number | null;
        observed_at: string; valid_until: string | null;
      }>).map((item) => ({
        openingKey: sha256(`stuguby-opening\n${grant.stugubyId}\n${item.id}`),
        floorPublicationId: floorPublication(item.floor_id),
        planElementPublicationId: elementPublication(item.element_id),
        state: item.state,
        openFraction: item.open_fraction,
        observedAt: item.observed_at,
        validUntil: item.valid_until,
      }));
    const weather = (this.database.db.prepare(`SELECT location_key,timestamp,temperature_c,source,fetched_at,
      station_id,station_name,conditions_json FROM outdoor_temperature_samples WHERE house_id=?
      ORDER BY timestamp,rowid`).all(house.id) as Array<{
        location_key: string; timestamp: string; temperature_c: number; source: string; fetched_at: string;
        station_id: string | null; station_name: string | null; conditions_json: string | null;
      }>).map((item) => ({
        weatherKey: sha256(`stuguby-weather\n${grant.stugubyId}\n${item.location_key}\n${item.timestamp}\n${item.source}`),
        locationKey: item.location_key,
        timestamp: item.timestamp,
        temperatureC: item.temperature_c,
        source: item.source,
        fetchedAt: item.fetched_at,
        stationId: item.station_id,
        stationName: item.station_name,
        conditions: item.conditions_json ? JSON.parse(item.conditions_json) as JsonValue : null,
      }));
    const electricity = (this.database.db.prepare(`SELECT start_at,end_at,raw_price_cents_per_kwh,
      margin_cents_per_kwh,fetched_at FROM electricity_price_points WHERE property_id=? ORDER BY start_at`)
      .all(house.propertyId) as Array<{
        start_at: string; end_at: string; raw_price_cents_per_kwh: number; margin_cents_per_kwh: number; fetched_at: string;
      }>).map((item) => ({
        priceKey: sha256(`stuguby-price\n${grant.stugubyId}\n${item.start_at}`),
        startAt: item.start_at,
        endAt: item.end_at,
        rawPriceCentsPerKwh: item.raw_price_cents_per_kwh,
        marginCentsPerKwh: item.margin_cents_per_kwh,
        fetchedAt: item.fetched_at,
      }));
    const assets = this.database.listAssets(house.id).map((metadata) => {
      const asset = this.database.getAsset(metadata.id);
      if (!asset) throw new StugubyError(409, "RECOVERY_ASSET_MISSING", `Home asset ${metadata.name} could not be read`);
      const blob = this.storeBlob(asset.data, asset.mimeType);
      this.store.registerBlobReference(grant.stugubyId, blob.digest, grant.id, grant.epoch, "local");
      return {
        assetKey: sha256(`stuguby-asset\n${grant.stugubyId}\n${asset.id}`),
        name: asset.name,
        mimeType: blob.mediaType,
        kind: asset.kind,
        digest: blob.digest,
        byteLength: blob.byteLength,
        createdAt: asset.createdAt,
      };
    });
    const archives: Array<[StugubyHomeRecoveryKind, JsonObject[]]> = [
      ["measurement-definitions", definitions as unknown as JsonObject[]],
      ["alert-rules", rules as unknown as JsonObject[]],
      ["alert-events", alertEvents as unknown as JsonObject[]],
      ["static-parameters", staticParameters as unknown as JsonObject[]],
      ["opening-states", openingStates as unknown as JsonObject[]],
      ["weather-history", weather as unknown as JsonObject[]],
      ["electricity-history", electricity as unknown as JsonObject[]],
      ["assets", assets as unknown as JsonObject[]],
      ["manifest", [{ telemetrySamples, generatedAt: new Date().toISOString() }]],
    ];
    for (const [kind, records] of archives) this.publishRecoveryChunks(grant, kind, records, generation);
  }

  private publishRecoveryChunks(
    grant: StugubyShareGrant,
    kind: StugubyHomeRecoveryKind,
    records: JsonObject[],
    generation: number,
  ): void {
    const chunks: JsonObject[][] = [];
    let current: JsonObject[] = [];
    let bytes = 0;
    for (const record of records) {
      const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
      if (current.length > 0 && (current.length >= 1_000 || bytes + recordBytes > 450_000)) {
        chunks.push(current);
        current = [];
        bytes = 0;
      }
      current.push(record);
      bytes += recordBytes;
    }
    if (current.length > 0 || chunks.length === 0) chunks.push(current);
    chunks.forEach((chunk, index) => {
      const chunkId = sha256(`${grant.id}\n${grant.epoch}\n${generation}\n${kind}\n${index}\n${canonicalJson(chunk)}`);
      const payload: StugubyHomeRecoveryPayload = {
        publicationId: grant.publicationId,
        chunkId,
        generation,
        kind,
        complete: index === chunks.length - 1,
        records: chunk,
      };
      this.publishDataset(
        grant,
        "home.recovery.v1",
        payload,
        `${grant.publicationId}:recovery:${kind}:${index}`,
        generation,
      );
    });
  }

  private selectedSensors(grant: StugubyShareGrant, house: House, publications: string[]): Sensor[] {
    const sensors = this.database.listSensors(house.id);
    if (!publications.length) return sensors;
    const selected = new Set(publications);
    return sensors.filter((sensor) => selected.has(this.store.publicationId(grant.stugubyId, "sensor", sensor.id)));
  }

  private publishLiveTelemetry(sample: MeasurementSample): void {
    const sensor = this.database.db.prepare("SELECT house_id FROM sensors WHERE id=?")
      .get(sample.sensorId) as { house_id: string } | undefined;
    if (!sensor) return;
    for (const stuguby of this.store.listStugubys()) {
      if (stuguby.localMemberState !== "active" || stuguby.localRole === "viewer") continue;
      for (const grant of this.store.listGrants(stuguby.id, this.identity.nodeId)) {
        if (grant.revokedAt || grantExpired(grant) || grant.localHouseId !== sensor.house_id) continue;
        const dataset = enabledDataset(grant, "home.telemetry.v1");
        const policy = dataset?.telemetry;
        if (!dataset || !policy?.live) continue;
        const sensorPublicationId = this.store.publicationId(grant.stugubyId, "sensor", sample.sensorId);
        if (policy.sensorPublicationIds.length && !policy.sensorPublicationIds.includes(sensorPublicationId)) continue;
        if (policy.metricIds.length && !policy.metricIds.includes(sample.metric)) continue;
        const utcHour = new Date(Date.parse(sample.timestamp)).toISOString().slice(0, 13);
        this.atomicPublication(() => {
          if (!this.store.reserveLiveTelemetrySample(grant.stugubyId, grant.id, utcHour, policy.maxSamplesPerHour)) return;
          const chunkId = randomUUID();
          const payload: StugubyTelemetryPayload = {
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

  private publishDataset(grant: StugubyShareGrant, dataset: StugubyDataset, payload: JsonValue, resourceId: string, revision: number): void {
    validateDatasetPayload(dataset, payload);
    const event = this.createEvent({
      stugubyId: grant.stugubyId,
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

  private createEvent(input: Omit<StugubyWireEvent, "protocolVersion" | "eventId" | "authorityNodeId" | "sequence" | "occurredAt" | "payloadHash">): StugubySignedEvent {
    const payload = input.operation === "tombstone" ? null : input.payload;
    const wire: StugubyWireEvent = {
      protocolVersion: STUGBY_PROTOCOL_VERSION,
      stugubyId: input.stugubyId,
      eventId: randomUUID(),
      eventKind: input.eventKind,
      authorityNodeId: this.identity.nodeId,
      streamId: input.streamId,
      sequence: this.store.nextSequence(input.stugubyId, input.streamId),
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

  private distribute(event: StugubySignedEvent, explicitGrant?: StugubyShareGrant): void {
    const stuguby = this.requireStuguby(event.stugubyId);
    if (!this.store.isCoordinator(event.stugubyId)) {
      this.store.enqueueOutbox(event.stugubyId, stuguby.coordinatorNodeId, event);
      return;
    }
    const grant = explicitGrant ?? (event.grantId ? this.store.getGrant(event.grantId) : null);
    const members = this.store.listMembers(event.stugubyId).filter((member) => member.state === "active"
      && member.nodeId !== this.identity.nodeId && member.nodeId !== event.authorityNodeId);
    for (const member of members) {
      if (grant && !grantAudienceIncludes(grant, member.nodeId)) continue;
      this.appendForMember(event.stugubyId, member.nodeId, event);
    }
  }

  private appendForMember(stugubyId: string, nodeId: string, event: StugubySignedEvent): void {
    const cursor = this.store.appendEventForMember(stugubyId, nodeId, event);
    if (cursor !== null && event.grantId && event.grantEpoch !== null) {
      for (const blob of eventBlobReferences(event)) {
        this.store.grantBlobAccess(stugubyId, blob.digest, nodeId, event.grantId, event.grantEpoch);
      }
    }
    if (cursor !== null && event.schema === "stuguby.grant.v2" && event.operation === "tombstone"
      && event.grantId && event.grantEpoch !== null) {
      this.store.expectDeletion(stugubyId, nodeId, event.grantId, event.grantEpoch);
    }
    if (cursor !== null) {
      const notification = { stugubyId, targetNodeId: nodeId, cursor } satisfies Notification;
      if (this.#deferredNotifications) this.#deferredNotifications.push(notification);
      else this.#notifications.emit("event", notification);
    }
  }

  private publishMember(member: StugubyMember): void {
    const event = this.createEvent({
      stugubyId: member.stugubyId,
      eventKind: "member.updated",
      streamId: "members",
      schema: "stuguby.member.v2",
      resourceId: member.nodeId,
      operation: "upsert",
      revision: Math.max(1, Date.parse(member.updatedAt)),
      grantId: null,
      grantEpoch: null,
      payload: asJson(member),
    });
    this.distribute(event);
    if (member.state !== "active" && member.nodeId !== this.identity.nodeId) {
      this.appendForMember(member.stugubyId, member.nodeId, event);
    }
  }

  private sendMemberSnapshot(member: StugubyMember, targetNodeId: string): void {
    const event = this.createEvent({
      stugubyId: member.stugubyId,
      eventKind: "member.updated",
      streamId: "members",
      schema: "stuguby.member.v2",
      resourceId: member.nodeId,
      operation: "upsert",
      revision: Math.max(1, Date.parse(member.updatedAt)),
      grantId: null,
      grantEpoch: null,
      payload: asJson(member),
    });
    this.appendForMember(member.stugubyId, targetNodeId, event);
  }

  private sendSharedPropertySnapshot(property: StugubySharedProperty, targetNodeId: string): void {
    const event = this.createEvent({
      stugubyId: property.stugubyId,
      eventKind: "shared-property.updated",
      streamId: "shared-property",
      schema: "stuguby.shared-property.v2",
      resourceId: property.stugubyId,
      operation: "upsert",
      revision: property.revision,
      grantId: null,
      grantEpoch: null,
      payload: property,
    });
    this.appendForMember(property.stugubyId, targetNodeId, event);
  }

  subscribeNotifications(stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void {
    const handler = (notification: Notification): void => {
      if (notification.stugubyId === stugubyId && notification.targetNodeId === nodeId) listener(notification.cursor);
    };
    this.#notifications.on("event", handler);
    return () => this.#notifications.off("event", handler);
  }

  replaceNotificationStream(stugubyId: string, nodeId: string, close: () => void): () => void {
    const key = `${stugubyId}\n${nodeId}`;
    const previous = this.#incomingNotificationStreams.get(key);
    this.#incomingNotificationStreams.set(key, close);
    previous?.();
    return () => {
      if (this.#incomingNotificationStreams.get(key) === close) this.#incomingNotificationStreams.delete(key);
    };
  }

  authenticateMachineRequest(stugubyId: string, proof: MachineRequestProof): StugubyMember {
    if (!proof.nodeId || !proof.timestamp || !proof.requestId || !proof.signature) {
      throw new StugubyError(401, "MISSING_REQUEST_PROOF", "Signed Stuguby request headers are required");
    }
    if (!UUID.test(proof.requestId)) {
      throw new StugubyError(401, "INVALID_REQUEST_ID", "Stuguby request id must be a UUID");
    }
    const timestamp = Date.parse(proof.timestamp);
    if (!ISO_DATE_TIME.test(proof.timestamp) || !Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > STUGBY_MAX_CLOCK_SKEW_SECONDS * 1_000) {
      throw new StugubyError(401, "STALE_REQUEST", "Stuguby request timestamp is outside the accepted clock window");
    }
    const member = this.store.getMember(stugubyId, proof.nodeId);
    if (!member) throw new StugubyError(403, "MEMBERSHIP_INACTIVE", "Stuguby membership is required");
    const eventPath = `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/events`;
    const finalPull = proof.method.toUpperCase() === "GET"
      && (proof.path === eventPath || proof.path.startsWith(`${eventPath}?`) || proof.path.startsWith(`${eventPath}/stream?`) || proof.path === `${eventPath}/stream`);
    if (member.state !== "active" && !finalPull) {
      throw new StugubyError(403, "MEMBERSHIP_INACTIVE", "Inactive members may only pull their final queued membership event");
    }
    const signingValue = requestSigningValue({
      method: proof.method,
      path: proof.path,
      bodyHash: sha256(proof.body),
      timestamp: proof.timestamp,
      requestId: proof.requestId,
      nodeId: proof.nodeId,
    });
    if (!this.keys.verify(signingValue, proof.signature, member.publicKey)) throw new StugubyError(401, "INVALID_REQUEST_PROOF", "Stuguby request signature is invalid");
    if (!this.store.acceptRequest(member.nodeId, proof.requestId, new Date(Date.now() + STUGBY_MAX_CLOCK_SKEW_SECONDS * 1_000).toISOString())) {
      throw new StugubyError(409, "REPLAYED_REQUEST", "Stuguby request id has already been used");
    }
    return member;
  }

  ingestEventBatch(actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): { accepted: string[]; duplicates: string[] } {
    this.requireCoordinator(stugubyId);
    if (batch.protocolVersion !== STUGBY_PROTOCOL_VERSION || !Array.isArray(batch.events) || batch.events.length > STUGBY_MAX_BATCH_EVENTS) {
      throw new StugubyError(400, "INVALID_EVENT_BATCH", `Event batch must contain at most ${STUGBY_MAX_BATCH_EVENTS} protocol v1 events`);
    }
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const candidate of batch.events) {
      const event = validateSignedEvent(candidate);
      if (event.stugubyId !== stugubyId || event.authorityNodeId !== actor.nodeId) throw new StugubyError(403, "EVENT_AUTHORITY_MISMATCH", "Event authority must match the authenticated node");
      if (!DATASET_SCHEMAS.has(event.schema) && event.schema !== "stuguby.grant.v2") {
        throw new StugubyError(403, "EVENT_SCHEMA_FORBIDDEN", "Participant nodes may publish only grants and approved read-only datasets");
      }
      if (actor.role === "viewer") throw new StugubyError(403, "VIEWER_READ_ONLY", "Viewer nodes cannot publish grants or Home datasets");
      this.verifyEvent(event, actor.publicKey);
      const inboxStatus = this.store.inboxEventStatus(event);
      if (inboxStatus === "duplicate") { duplicates.push(event.eventId); continue; }
      if (inboxStatus === "non-monotonic") throw new StugubyError(409, "NON_MONOTONIC_EVENT", "Event sequence must increase within its authority stream");
      if (event.schema === "stuguby.grant.v2") {
        // A revocation tombstone carries no payload; the coordinator already has the preceding grant.
        if (event.operation === "upsert") {
          const grant = validateShareGrant(event.payload);
          if (grant.authorityNodeId !== actor.nodeId || grant.stugubyId !== stugubyId || grant.id !== event.grantId
            || grant.id !== event.resourceId || grant.epoch !== event.grantEpoch || grant.revision !== event.revision) {
            throw new StugubyError(403, "GRANT_AUTHORITY_MISMATCH", "Grant payload does not match its signed event envelope");
          }
          if (grantExpired(grant)) throw new StugubyError(400, "GRANT_EXPIRED", "An expired grant cannot be published");
          this.validateGrantAgainstMembership(grant, actor.nodeId);
          validateGrantTransition(this.store.getGrant(grant.id), grant, 409);
          this.store.upsertGrant(grant);
          if (grantAudienceIncludes(grant, this.identity.nodeId)) {
            this.materializeRemoteHome(stugubyId, grant.authorityNodeId, grant.publicationId);
          }
          this.distribute(event, grant);
        } else {
          if (event.grantEpoch === null) throw new StugubyError(400, "INVALID_REVOCATION", "Revocation is missing its grant epoch");
          const revokedEpoch = event.grantEpoch;
          const grant = this.store.getGrant(event.grantId ?? "");
          if (!grant) {
            if (!event.grantId || event.resourceId !== event.grantId) throw new StugubyError(400, "INVALID_REVOCATION", "Unknown grant revocation has an invalid envelope");
            this.store.audit(stugubyId, "grant.revocation-noop", actor.nodeId, event.grantId, { epoch: revokedEpoch });
          } else {
            const alreadyApplied = grant.authorityNodeId === actor.nodeId && event.resourceId === grant.id
              && revokedEpoch === grant.epoch && event.revision === grant.revision && grant.revokedAt === event.occurredAt;
            if (!alreadyApplied && (grant.authorityNodeId !== actor.nodeId || revokedEpoch !== grant.epoch + 1
              || event.revision !== grant.revision + 1 || event.resourceId !== grant.id)) {
              throw new StugubyError(400, "INVALID_REVOCATION", "Revocation must advance a known grant by exactly one epoch and revision");
            }
            if (!alreadyApplied) {
              const revoked: StugubyShareGrant = { ...grant, epoch: revokedEpoch, revision: event.revision, revokedAt: event.occurredAt, updatedAt: event.occurredAt };
              this.store.upsertGrant(revoked);
            }
            if (!alreadyApplied && grantAudienceIncludes(grant, this.identity.nodeId)) {
              this.store.purgeGrantData(stugubyId, grant.id, revokedEpoch);
              this.deleteUnreferencedBlobs(this.store.purgeReplicaBlobReferences(stugubyId, grant.id, revokedEpoch));
            }
            this.distribute(event, grant);
            this.deleteUnreferencedBlobs(this.store.releaseRelayReferencesWithoutAccess(stugubyId, grant.id, revokedEpoch));
          }
        }
      } else {
        const grant = this.authorizeDatasetEvent(event);
        const blobReferences = eventBlobReferences(event);
        for (const reference of blobReferences) {
          const blob = this.readBlob(reference.digest);
          if (blob.data.byteLength !== reference.byteLength || blob.mediaType !== reference.mediaType) {
            throw new StugubyError(400, "HOME_ASSET_REFERENCE_MISMATCH", "Home asset metadata does not match the staged content-addressed blob");
          }
          this.store.registerBlobReference(stugubyId, reference.digest, grant.id, grant.epoch, "relay");
        }
        if (grantAudienceIncludes(grant, this.identity.nodeId)) {
          this.store.applyDatasetEvent(event);
          if (event.operation === "upsert" && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
            this.materializeRemoteHome(stugubyId, event.authorityNodeId, String(event.payload.publicationId));
          }
          const policy = enabledDataset(grant, event.schema as StugubyDataset);
          if (policy?.allowReplicaCache && policy.retentionDays > 0) {
            for (const reference of blobReferences) {
              this.store.registerBlobReference(stugubyId, reference.digest, grant.id, grant.epoch, "replica");
            }
          }
        }
        this.distribute(event, grant);
        if (blobReferences.length > 0) {
          this.deleteUnreferencedBlobs(this.store.releaseRelayReferencesWithoutAccess(stugubyId, grant.id, grant.epoch));
        }
      }
      if (!this.store.recordInboxEvent(event)) { duplicates.push(event.eventId); continue; }
      accepted.push(event.eventId);
    }
    return { accepted, duplicates };
  }

  eventPage(actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage {
    this.requireCoordinator(stugubyId);
    this.deleteUnreferencedBlobs(this.store.acknowledgeEventCursor(stugubyId, actor.nodeId, cursor));
    const page = this.store.eventPage(stugubyId, actor.nodeId, cursor, limit);
    return { protocolVersion: STUGBY_PROTOCOL_VERSION, ...page };
  }

  private authorizeDatasetEvent(event: StugubySignedEvent): StugubyShareGrant {
    if (!isStugubyDataset(event.schema) || !event.grantId || event.grantEpoch === null) throw new StugubyError(400, "INVALID_DATASET_EVENT", "Dataset event requires a grant and epoch");
    const grant = this.store.getGrant(event.grantId);
    if (!grant || grant.authorityNodeId !== event.authorityNodeId || grant.stugubyId !== event.stugubyId
      || grant.epoch !== event.grantEpoch || grant.revokedAt || grantExpired(grant)
      || !enabledDataset(grant, event.schema)) {
      throw new StugubyError(403, "DATASET_NOT_GRANTED", "Dataset is not authorized by the active grant epoch");
    }
    if (event.operation === "upsert") validateDatasetPayload(event.schema, event.payload);
    return grant;
  }

  private verifyEvent(event: StugubySignedEvent, publicKey: string): void {
    if (event.keyFingerprint !== publicKeyFingerprint(publicKey)) throw new StugubyError(401, "EVENT_KEY_MISMATCH", "Event signing key does not match member identity");
    const expectedHash = sha256(canonicalJson(event.payload));
    if (expectedHash !== event.payloadHash) throw new StugubyError(400, "EVENT_HASH_MISMATCH", "Event payload hash is invalid");
    if (!this.keys.verify(eventSigningValue(event), event.signature, publicKey)) throw new StugubyError(401, "INVALID_EVENT_SIGNATURE", "Event signature is invalid");
  }

  async syncNow(stugubyId: string): Promise<StugubySummary> {
    this.requireStuguby(stugubyId);
    this.backfillRecommendedHomeOverviews(stugubyId);
    await this.trackSync(this.syncOne(stugubyId, true));
    return this.requireStuguby(stugubyId);
  }

  async syncAll(): Promise<void> {
    if (this.#syncing) return this.#syncing;
    const operation = (async () => {
      this.deleteUnreferencedBlobs(this.store.staleUnreferencedBlobs(new Date(Date.now() - 86_400_000).toISOString()));
      this.ensureNotificationStreams();
      for (const stuguby of this.store.listStugubys()) {
        this.backfillRecommendedHomeOverviews(stuguby.id);
        this.expireLocalGrants(stuguby.id);
        if (this.store.isCoordinator(stuguby.id) || !["active", "suspended"].includes(stuguby.localMemberState)) continue;
        await this.syncOne(stuguby.id, false);
      }
    })();
    this.#syncing = this.trackSync(operation).finally(() => { this.#syncing = null; });
    return this.#syncing;
  }

  private ensureNotificationStreams(): void {
    if (!this.#started) return;
    for (const [stugubyId, controller] of this.#streamControllers) {
      const stuguby = this.store.getStuguby(stugubyId);
      if (!stuguby || !["active", "suspended"].includes(stuguby.localMemberState) || this.store.isCoordinator(stugubyId)) {
        controller.abort();
        this.#streamControllers.delete(stugubyId);
      }
    }
    for (const stuguby of this.store.listStugubys()) {
      if (this.store.isCoordinator(stuguby.id) || !["active", "suspended"].includes(stuguby.localMemberState) || this.#streamControllers.has(stuguby.id)) continue;
      const controller = new AbortController();
      this.#streamControllers.set(stuguby.id, controller);
      const task = this.notificationLoop(stuguby.id, controller);
      this.#streamTasks.set(stuguby.id, task);
      void task.then(
        () => { if (this.#streamTasks.get(stuguby.id) === task) this.#streamTasks.delete(stuguby.id); },
        () => { if (this.#streamTasks.get(stuguby.id) === task) this.#streamTasks.delete(stuguby.id); },
      );
    }
  }

  private async notificationLoop(stugubyId: string, controller: AbortController): Promise<void> {
    try {
      while (!controller.signal.aborted && this.#started) {
        try {
          const stuguby = this.requireStuguby(stugubyId);
          const cursor = this.store.pullCursor(stugubyId);
          const path = `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/events/stream?cursor=${cursor}`;
          const response = await this.signedFetch(stuguby, path, { method: "GET", signal: controller.signal });
          if (!response.ok || !response.body) throw await this.remoteError(response, "Stuguby notification stream failed");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffered = "";
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffered += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
            if (Buffer.byteLength(buffered) > 64 * 1024) {
              throw new StugubyError(502, "INVALID_NOTIFICATION_STREAM", "Coordinator returned an oversized Stuguby notification frame");
            }
            let boundary = buffered.indexOf("\n\n");
            while (boundary >= 0) {
              const frame = buffered.slice(0, boundary);
              buffered = buffered.slice(boundary + 2);
              const eventName = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
              const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
              if (eventName === "available" && data) {
                const next = JSON.parse(data) as { cursor?: unknown };
                if (typeof next.cursor === "number" && next.cursor > this.store.pullCursor(stugubyId)) await this.syncAll();
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
      if (this.#streamControllers.get(stugubyId) === controller) this.#streamControllers.delete(stugubyId);
    }
  }

  private async syncOne(stugubyId: string, throwOnError: boolean): Promise<void> {
    const stuguby = this.requireStuguby(stugubyId);
    this.expireLocalGrants(stugubyId);
    this.store.enforceRetention(stugubyId);
    this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugubyId));
    if (this.store.isCoordinator(stugubyId)) {
      this.store.recordSync(stugubyId, this.store.pullCursor(stugubyId), null);
      this.refreshPropertyLink(stugubyId);
      return;
    }
    try {
      if (stuguby.localMemberState === "active") {
        await this.flushHomeCommands(stuguby);
        await this.flushPropertyCommands(stuguby);
        await this.flushOutbox(stuguby);
      }
      let cursor = this.store.pullCursor(stugubyId);
      let hasMore = true;
      while (hasMore) {
        const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/events?cursor=${cursor}&limit=100`, { method: "GET" });
        if (!response.ok) throw await this.remoteError(response, "Stuguby event pull failed");
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
          throw new StugubyError(502, "INVALID_EVENT_PAGE", "Coordinator returned an invalid or non-progressing Stuguby event page");
        }
        for (const candidate of rawPage.events) await this.applyPulledEvent(stuguby, validateSignedEvent(candidate));
        cursor = Number(rawPage.cursor);
        hasMore = rawPage.hasMore;
        this.store.recordSync(stugubyId, cursor, null);
      }
      this.store.markRemoteCurrent(stugubyId);
      this.materializeAllRemoteHomes(stugubyId);
      this.refreshPropertyLink(stugubyId);
      this.store.enforceRetention(stugubyId);
      this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugubyId));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1_000) : "Stuguby sync failed";
      this.store.recordSync(stugubyId, this.store.pullCursor(stugubyId), message);
      this.store.markRemoteStale(stugubyId);
      this.materializeAllRemoteHomes(stugubyId);
      this.refreshPropertyLink(stugubyId, "offline");
      if (throwOnError) throw error;
    }
  }

  private expireLocalGrants(stugubyId: string): void {
    const now = new Date().toISOString();
    for (const grant of this.store.listGrants(stugubyId, this.identity.nodeId)) {
      if (grant.revokedAt || !grantExpired(grant, Date.parse(now))) continue;
      this.atomicPublication(() => {
        const revoked = this.store.revokeGrant(grant.id);
        this.store.discardOutboxGrantEpoch(stugubyId, grant.id, grant.epoch);
        this.publishGrant({ ...revoked, audience: grant.audience }, "grant.revoked");
        this.store.audit(stugubyId, "grant.expired", this.identity.nodeId, grant.id, { epoch: revoked.epoch }, now);
        this.store.retireLocalBlobReferences(stugubyId, grant.id, grant.epoch);
      });
      this.refreshLocalSharedHouseLink(stugubyId, grant.localHouseId ?? "");
      this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
    }
  }

  private async flushOutbox(stuguby: StugubySummary): Promise<void> {
    const queued = this.store.dueOutbox(STUGBY_MAX_BATCH_EVENTS).filter((item) => item.stugubyId === stuguby.id);
    for (const item of queued) {
      try {
        await this.uploadReferencedBlobs(stuguby, item);
        const batch: StugubyEventBatch = { protocolVersion: STUGBY_PROTOCOL_VERSION, events: [item.event] };
        const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/events`, {
          method: "POST",
          body: JSON.stringify(batch),
        });
        if (!response.ok) throw await this.remoteError(response, "Stuguby event publish failed");
        this.store.acknowledgeOutbox([item.id]);
      } catch (error) {
        this.store.failOutbox(item.id, item.attempts);
        throw error;
      }
    }
  }

  private async flushHomeCommands(stuguby: StugubySummary): Promise<void> {
    for (const queued of this.store.pendingHomeCommands(stuguby.id, 100)) {
      try {
        const response = await this.signedFetch(stuguby,
          `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/home-commands`, {
            method: "POST",
            body: JSON.stringify(queued.command),
          });
        if (!response.ok) throw await this.remoteError(response, "Shared Home change failed");
        const result = validateHomeCommandResult(
          await this.readJsonResponse(response, 128 * 1024, "Home command response"),
        );
        if (result.commandId !== queued.command.id) {
          throw new StugubyError(502, "INVALID_HOME_COMMAND_RESPONSE", "Coordinator returned a result for another Home change");
        }
        this.store.completeHomeCommand(result);
        const projection = this.store.getHomeProjection(
          stuguby.id,
          queued.command.authorityNodeId,
          queued.command.publicationId,
        );
        const house = projection ? this.database.getHouse(projection.localHouseId) : null;
        if (house?.stuguby && result.status === "conflict") {
          const counts = this.store.homeCommandCountsFor(
            stuguby.id,
            queued.command.authorityNodeId,
            queued.command.publicationId,
          );
          this.database.setHouseStugubyLink(house.id, {
            ...house.stuguby,
            syncState: "conflict",
            pendingChangeCount: counts.pending,
            conflictCount: counts.conflicts,
          });
        }
      } catch (error) {
        const attempts = queued.attempts + 1;
        const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
        this.store.deferHomeCommand(queued.command.id, attempts, new Date(Date.now() + delayMs).toISOString());
        throw error;
      }
    }
  }

  private async flushPropertyCommands(stuguby: StugubySummary): Promise<void> {
    for (const queued of this.store.pendingPropertyCommands(stuguby.id, 100)) {
      try {
        const response = await this.signedFetch(stuguby,
          `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/property-commands`, {
            method: "POST",
            body: JSON.stringify(queued.command),
          });
        if (!response.ok) throw await this.remoteError(response, "Shared Property change failed");
        const result = validatePropertyCommandResult(
          await this.readJsonResponse(response, 2 * 1024 * 1024, "Property command response"),
        );
        if (result.commandId !== queued.command.id || result.property.stugubyId !== stuguby.id) {
          throw new StugubyError(502, "INVALID_PROPERTY_COMMAND_RESPONSE", "Coordinator returned a result for another Property change");
        }
        this.store.completePropertyCommand(result);
        this.store.saveSharedProperty(result.property);
        this.materializeSharedProperty(result.property);
      } catch (error) {
        const attempts = queued.attempts + 1;
        const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
        this.store.deferPropertyCommand(queued.command.id, attempts, new Date(Date.now() + delayMs).toISOString());
        throw error;
      }
    }
  }

  private async uploadReferencedBlobs(stuguby: StugubySummary, item: StugubyOutboxItem): Promise<void> {
    for (const reference of eventBlobReferences(item.event)) {
      const blob = this.readBlob(reference.digest);
      const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/blobs/${reference.digest}`, {
        method: "PUT",
        body: blob.data,
        contentType: blob.mediaType,
      });
      if (!response.ok) throw await this.remoteError(response, "Stuguby Home asset upload failed");
    }
  }

  private async applyPulledEvent(stuguby: StugubySummary, event: StugubySignedEvent): Promise<void> {
    if (event.stugubyId !== stuguby.id) throw new StugubyError(502, "EVENT_STUGBY_MISMATCH", "Coordinator returned an event for another Stuguby");
    const authority = this.store.getMember(stuguby.id, event.authorityNodeId);
    if (!authority) throw new StugubyError(502, "UNKNOWN_EVENT_AUTHORITY", "Coordinator returned an event from an unknown node");
    this.verifyEvent(event, authority.publicKey);
    const inboxStatus = this.store.inboxEventStatus(event);
    if (inboxStatus === "duplicate") {
      if (event.schema === "stuguby.grant.v2" && event.operation === "tombstone" && event.grantId && event.grantEpoch !== null) {
        const receipt = this.store.getDeletionReceipt(stuguby.id, this.identity.nodeId, event.grantId, event.grantEpoch);
        if (receipt) await this.sendDeletionReceipt(stuguby, receipt);
      }
      return;
    }
    if (inboxStatus === "non-monotonic") throw new StugubyError(502, "NON_MONOTONIC_EVENT", "Coordinator returned a non-monotonic event sequence");
    if (event.schema === "stuguby.member.v2" && event.operation === "upsert") {
      if (event.authorityNodeId !== stuguby.coordinatorNodeId) throw new StugubyError(502, "INVALID_MEMBER_AUTHORITY", "Only the coordinator may publish membership events");
      const member = validatedMember(event.payload, stuguby.id);
      const existingMember = this.store.getMember(stuguby.id, member.nodeId);
      if (event.resourceId !== member.nodeId || (member.role === "steward" && member.nodeId !== stuguby.coordinatorNodeId)
        || (member.nodeId === stuguby.coordinatorNodeId && (member.role !== "steward" || member.state !== "active"))
        || (existingMember && (existingMember.publicKey !== member.publicKey
          || member.updatedAt < existingMember.updatedAt
          || (member.updatedAt === existingMember.updatedAt
            && canonicalJson(asJson(member)) !== canonicalJson(asJson(existingMember)))))) {
        throw new StugubyError(502, "INVALID_MEMBER_EVENT", "Member event conflicts with the pinned Stuguby membership");
      }
      this.store.upsertMember(member);
      if (member.nodeId === this.identity.nodeId && member.state !== "active") {
        this.store.purgeDepartedReplicas(stuguby.id);
        this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stuguby.id));
        this.#streamControllers.get(stuguby.id)?.abort();
        this.#streamControllers.delete(stuguby.id);
      }
      if (member.state === "active" && member.nodeId !== this.identity.nodeId) {
        for (const grant of this.store.listGrants(stuguby.id, this.identity.nodeId)) {
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
    if (event.schema === "stuguby.shared-property.v2" && event.operation === "upsert") {
      if (event.authorityNodeId !== stuguby.coordinatorNodeId || event.resourceId !== stuguby.id) {
        throw new StugubyError(502, "INVALID_PROPERTY_AUTHORITY", "Only the coordinator may publish the shared property aggregate");
      }
      const property = validateSharedProperty(event.payload);
      if (property.stugubyId !== stuguby.id || property.revision !== event.revision) throw new StugubyError(502, "INVALID_PROPERTY_EVENT", "Shared property payload does not match its event envelope");
      const existingProperty = this.store.getSharedProperty(stuguby.id);
      if (existingProperty && (property.revision < existingProperty.revision
        || (property.revision === existingProperty.revision
          && canonicalJson(asJson(property)) !== canonicalJson(asJson(existingProperty))))) {
        throw new StugubyError(502, "PROPERTY_VERSION_CONFLICT", "Shared property revision is stale or conflicts with the stored revision");
      }
      this.store.saveSharedProperty(property);
      this.store.recordInboxEvent(event);
      this.materializeSharedProperty(property);
      return;
    }
    if (event.schema === "stuguby.grant.v2") {
      if (authority.state !== "active" || authority.role === "viewer") throw new StugubyError(502, "INVALID_GRANT_AUTHORITY", "Grant authority is not an active publishing member");
      if (event.operation === "upsert") {
        const grant = validateShareGrant(event.payload);
        if (grant.stugubyId !== stuguby.id || grant.authorityNodeId !== event.authorityNodeId || grant.id !== event.grantId
          || grant.id !== event.resourceId || grant.epoch !== event.grantEpoch || grant.revision !== event.revision
          || !grantAudienceIncludes(grant, this.identity.nodeId)) {
          throw new StugubyError(502, "INVALID_GRANT_EVENT", "Coordinator returned a grant that does not match its signed envelope or local audience");
        }
        if (grantExpired(grant)) throw new StugubyError(502, "EXPIRED_GRANT_EVENT", "Coordinator returned an expired grant");
        validateGrantTransition(this.store.getGrant(grant.id), grant, 502);
        this.store.upsertGrant(grant);
        this.materializeRemoteHome(stuguby.id, grant.authorityNodeId, grant.publicationId);
      }
      else if (event.grantId && event.grantEpoch !== null) {
        const existing = this.store.getGrant(event.grantId);
        if (existing) {
          const alreadyApplied = existing.authorityNodeId === event.authorityNodeId && event.resourceId === existing.id
            && existing.epoch === event.grantEpoch && existing.revision === event.revision
            && existing.revokedAt === event.occurredAt;
          if (!alreadyApplied && (existing.authorityNodeId !== event.authorityNodeId || event.resourceId !== existing.id
            || event.grantEpoch !== existing.epoch + 1 || event.revision !== existing.revision + 1)) {
            throw new StugubyError(502, "INVALID_REVOCATION", "Coordinator returned a non-monotonic grant revocation");
          }
          if (!alreadyApplied) {
            const revoked = { ...existing, epoch: event.grantEpoch, revision: event.revision, revokedAt: event.occurredAt, updatedAt: event.occurredAt };
            this.store.upsertGrant(revoked);
          }
          const receipt = this.store.getDeletionReceipt(stuguby.id, this.identity.nodeId, event.grantId, event.grantEpoch)
            ?? this.store.purgeGrantData(stuguby.id, event.grantId, event.grantEpoch);
          this.deleteUnreferencedBlobs(this.store.purgeReplicaBlobReferences(stuguby.id, event.grantId, event.grantEpoch));
          this.store.recordInboxEvent(event);
          await this.sendDeletionReceipt(stuguby, receipt);
          return;
        }
      }
      this.store.recordInboxEvent(event);
      return;
    }
    if (authority.state !== "active" || authority.role === "viewer") throw new StugubyError(502, "INVALID_DATASET_AUTHORITY", "Dataset authority is not an active publishing member");
    const grant = this.authorizeDatasetEvent(event);
    if (!grantAudienceIncludes(grant, this.identity.nodeId)) throw new StugubyError(502, "DATASET_AUDIENCE_MISMATCH", "Coordinator returned a dataset outside this node's grant audience");
    this.store.applyDatasetEvent(event);
    if (event.operation === "upsert" && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
      this.materializeRemoteHome(stuguby.id, event.authorityNodeId, String(event.payload.publicationId));
    }
    const policy = enabledDataset(grant, event.schema as StugubyDataset);
    const blobReferences = eventBlobReferences(event);
    if (blobReferences.length > 0 && policy?.allowReplicaCache && policy.retentionDays > 0) {
      await this.downloadReferencedBlobs(stuguby, event, blobReferences);
      if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
        this.materializeRemoteHome(stuguby.id, event.authorityNodeId, String(event.payload.publicationId));
      }
    }
    this.store.recordInboxEvent(event);
  }

  private async sendDeletionReceipt(stuguby: StugubySummary, receipt: StugubyDeletionReceipt): Promise<void> {
    const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/deletion-receipts`, {
      method: "POST",
      body: JSON.stringify(receipt),
    });
    if (!response.ok) throw await this.remoteError(response, "Stuguby deletion acknowledgement failed");
  }

  recordDeletionReceipt(actor: StugubyMember, receipt: StugubyDeletionReceipt): void {
    const raw = recordValue(receipt, "Deletion receipt");
    const normalized: StugubyDeletionReceipt = {
      stugubyId: requiredText(raw.stugubyId, "Stuguby id", 100),
      nodeId: requiredText(raw.nodeId, "Node id", 100),
      grantId: requiredText(raw.grantId, "Grant id", 100),
      grantEpoch: Number(raw.grantEpoch),
      deletedAt: parseIso(requiredText(raw.deletedAt, "deletedAt", 100), "deletedAt"),
    };
    if (!Number.isSafeInteger(normalized.grantEpoch) || normalized.grantEpoch < 1
      || normalized.nodeId !== actor.nodeId || normalized.stugubyId !== actor.stugubyId) {
      throw new StugubyError(400, "INVALID_DELETION_RECEIPT", "Deletion receipt identity or epoch is invalid");
    }
    const result = this.store.processDeletionReceipt(normalized);
    if (result === "unexpected") {
      throw new StugubyError(409, "DELETION_NOT_EXPECTED", "No matching deletion acknowledgement is pending for this node");
    }
    if (result === "conflict") {
      throw new StugubyError(409, "DELETION_RECEIPT_CONFLICT", "A different deletion receipt is already pinned for this grant epoch");
    }
    this.deleteUnreferencedBlobs(this.store.pendingBlobDeletions(1_000));
  }

  private async downloadReferencedBlobs(
    stuguby: StugubySummary,
    event: StugubySignedEvent,
    references: StugubyBlobReference[],
  ): Promise<void> {
    if (!event.grantId || event.grantEpoch === null) {
      throw new StugubyError(502, "INVALID_HOME_ASSET_EVENT", "Home asset event is missing its grant identity");
    }
    for (const reference of references) {
      const existing = this.store.getBlob(reference.digest);
      if (existing && (existing.byteLength !== reference.byteLength || existing.mediaType !== reference.mediaType)) {
        throw new StugubyError(502, "HOME_ASSET_REFERENCE_MISMATCH", "Stored Home asset metadata does not match its signed reference");
      }
      if (!existing) {
        const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/blobs/${reference.digest}`, { method: "GET" });
        if (!response.ok) throw await this.remoteError(response, "Stuguby Home asset download failed");
        const data = await this.readBoundedResponse(
          response,
          reference.byteLength,
          "REMOTE_BLOB_TOO_LARGE",
          "Coordinator returned a Home asset larger than its signed byte length",
        );
        const stored = this.storeBlob(data, response.headers.get("content-type") ?? reference.mediaType, reference.digest);
        if (stored.byteLength !== reference.byteLength || stored.mediaType !== reference.mediaType) {
          throw new StugubyError(502, "HOME_ASSET_REFERENCE_MISMATCH", "Downloaded Home asset metadata does not match its signed reference");
        }
      }
      this.store.registerBlobReference(stuguby.id, reference.digest, event.grantId, event.grantEpoch, "replica");
    }
  }

  private async signedFetch(stuguby: StugubySummary, path: string, input: { method: string; body?: string | Uint8Array; contentType?: string; signal?: AbortSignal }): Promise<Response> {
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
    return this.#fetcher(`${stuguby.coordinatorUrl}${path}`, {
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
        throw new StugubyError(502, code, message);
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
        throw new StugubyError(502, code, message);
      }
      body.set(chunk.value, total);
      total = nextTotal;
    }
    return body.slice(0, total);
  }

  private async remoteError(response: Response, fallback: string): Promise<StugubyError> {
    let detail = fallback;
    try {
      const body = await this.readJsonResponse(response, 64 * 1024, "Remote error") as {
        error?: { message?: string; code?: string };
        message?: string;
      };
      detail = body.error?.message ?? body.message ?? fallback;
      return new StugubyError(response.status, body.error?.code ?? "REMOTE_ERROR", detail);
    } catch {
      return new StugubyError(response.status, "REMOTE_ERROR", detail);
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
      throw new StugubyError(502, "INVALID_REMOTE_JSON", `${label} is not valid JSON`);
    }
  }

  private storeDataUrl(value: string): { digest: string; byteLength: number; mediaType: "image/png" | "image/jpeg" | "image/webp" } {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!match) throw new StugubyError(400, "INVALID_FLOORPLAN_ASSET", "Floor-plan image must be a PNG, JPEG, or WebP data URL");
    const stored = this.storeBlob(Buffer.from(match[2]!, "base64"), match[1]!);
    return { ...stored, mediaType: stored.mediaType as "image/png" | "image/jpeg" | "image/webp" };
  }

  storeBlob(data: Uint8Array, mediaType: string, expectedDigest?: string): { digest: string; byteLength: number; mediaType: StugubyBlobMediaType } {
    if (data.byteLength === 0 || data.byteLength > STUGBY_MAX_BLOB_BYTES) throw new StugubyError(413, "BLOB_SIZE_INVALID", `Stuguby assets must be between 1 and ${STUGBY_MAX_BLOB_BYTES} bytes`);
    const normalizedMediaType = mediaType.split(";", 1)[0]!.trim().toLowerCase() as StugubyBlobMediaType;
    if (!["image/png", "image/jpeg", "image/webp", "model/gltf+json", "model/gltf-binary"].includes(normalizedMediaType)) {
      throw new StugubyError(415, "BLOB_TYPE_INVALID", "Stuguby accepts PNG, JPEG, WebP, glTF, and GLB Home assets");
    }
    const bytes = Buffer.from(data);
    let signatureValid = normalizedMediaType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : normalizedMediaType === "image/jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9
        : normalizedMediaType === "image/webp"
          ? bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
          : normalizedMediaType === "model/gltf-binary"
            ? bytes.byteLength >= 12 && bytes.subarray(0, 4).toString("ascii") === "glTF"
              && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.byteLength
            : false;
    if (normalizedMediaType === "model/gltf+json") {
      try {
        const gltf = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { asset?: { version?: unknown } };
        signatureValid = Boolean(gltf && typeof gltf === "object" && gltf.asset
          && typeof gltf.asset === "object" && typeof gltf.asset.version === "string");
      } catch {
        signatureValid = false;
      }
    }
    if (!signatureValid) throw new StugubyError(415, "BLOB_SIGNATURE_INVALID", "Home asset signature does not match its media type");
    const digest = sha256(bytes);
    if (expectedDigest && digest !== expectedDigest) throw new StugubyError(400, "BLOB_DIGEST_MISMATCH", "Home asset digest does not match its reference");
    const existing = this.store.getBlob(digest);
    if (existing && (existing.byteLength !== bytes.byteLength || existing.mediaType !== normalizedMediaType || existing.relativePath !== digest)) {
      throw new StugubyError(409, "BLOB_METADATA_CONFLICT", "Existing Stuguby asset metadata conflicts with the uploaded bytes");
    }
    const finalPath = join(this.#assetDirectory, digest);
    if (!existsSync(finalPath)) {
      durableAtomicWriteFileSync(finalPath, bytes, { mode: 0o600 });
    }
    this.store.registerBlob(digest, bytes.byteLength, normalizedMediaType, digest);
    return { digest, byteLength: bytes.byteLength, mediaType: normalizedMediaType };
  }

  storeUploadedBlob(member: StugubyMember, stugubyId: string, data: Uint8Array, mediaType: string, expectedDigest: string): ReturnType<StugubyService["storeBlob"]> {
    if (member.stugubyId !== stugubyId || member.role === "viewer") {
      throw new StugubyError(403, "VIEWER_CANNOT_PUBLISH", "An active publishing member is required to upload federation assets");
    }
    const alreadyStored = this.store.getBlob(expectedDigest);
    if (!alreadyStored && this.store.unreferencedBlobBytes() + data.byteLength > STUGBY_MAX_STAGED_BLOB_BYTES) {
      throw new StugubyError(507, "BLOB_STAGING_QUOTA", "The coordinator's unreferenced Stuguby asset staging quota is full");
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
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new StugubyError(400, "INVALID_BLOB_DIGEST", "Invalid Stuguby asset digest");
    const metadata = this.store.getBlob(digest);
    if (!metadata) throw new StugubyError(404, "BLOB_NOT_FOUND", "Stuguby asset was not found");
    if (metadata.relativePath !== digest) throw new StugubyError(500, "BLOB_METADATA_INVALID", "Stored Stuguby asset metadata is invalid");
    const data = readFileSync(join(this.#assetDirectory, digest));
    if (data.byteLength !== metadata.byteLength || sha256(data) !== digest) throw new StugubyError(500, "BLOB_INTEGRITY_FAILURE", "Stored Stuguby asset failed integrity verification");
    return { data, mediaType: metadata.mediaType };
  }

  readBlobFor(member: StugubyMember, stugubyId: string, digest: string): { data: Buffer; mediaType: string } {
    if (member.stugubyId !== stugubyId || !this.store.canReadBlob(stugubyId, digest, member.nodeId)) {
      throw new StugubyError(404, "BLOB_NOT_FOUND", "Stuguby asset was not found");
    }
    return this.readBlob(digest);
  }

  private requireStuguby(id: string): StugubySummary {
    const stuguby = this.store.getStuguby(id);
    if (!stuguby) throw new StugubyError(404, "STUGBY_NOT_FOUND", "Stuguby was not found");
    return stuguby;
  }

  private requireLocalPublisher(id: string): StugubySummary {
    const stuguby = this.requireStuguby(id);
    if (stuguby.localMemberState !== "active" || stuguby.localRole === "viewer") {
      throw new StugubyError(403, "PUBLISHING_FORBIDDEN", "An active steward, property manager, or participant node is required to publish Home data");
    }
    return stuguby;
  }

  private requireCoordinator(id: string): StugubySummary {
    const stuguby = this.requireStuguby(id);
    if (!this.store.isCoordinator(id)) throw new StugubyError(409, "COORDINATOR_REQUIRED", "This operation must be performed by the Stuguby coordinator");
    return stuguby;
  }

  private requireReadyCoordinator(id: string): StugubySummary {
    const stuguby = this.requireCoordinator(id);
    const loopback = (() => {
      try { return isLoopbackHostname(new URL(stuguby.coordinatorUrl).hostname); } catch { return false; }
    })();
    if ((this.publicOrigin && stuguby.coordinatorUrl !== this.publicOrigin) || (!this.publicOrigin && !loopback)) {
      throw new StugubyError(
        503,
        "STUGBY_COORDINATOR_ORIGIN_MISMATCH",
        "The stored Stuguby coordinator URL does not match this server's configured public origin",
      );
    }
    return stuguby;
  }
}
