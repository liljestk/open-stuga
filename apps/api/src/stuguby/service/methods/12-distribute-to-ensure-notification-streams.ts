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
  eventPayloadHashValue,
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
import { DATASET_SCHEMAS, ISO_DATE_TIME, MachineRequestProof, Notification, StugubyError, UUID, asJson, enabledDataset, eventBlobReferences, grantAudienceIncludes, grantExpired, sha256, validateGrantTransition } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

registerStugubyServiceMethods({
  distribute(this: StugubyServiceInternals, event: StugubySignedEvent, explicitGrant?: StugubyShareGrant): void {
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
    },
  appendForMember(this: StugubyServiceInternals, stugubyId: string, nodeId: string, event: StugubySignedEvent): void {
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
        if (this[stugubyServiceState].deferredNotifications) this[stugubyServiceState].deferredNotifications.push(notification);
        else this[stugubyServiceState].notifications.emit("event", notification);
      }
    },
  publishMember(this: StugubyServiceInternals, member: StugubyMember): void {
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
    },
  sendMemberSnapshot(this: StugubyServiceInternals, member: StugubyMember, targetNodeId: string): void {
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
    },
  sendSharedPropertySnapshot(this: StugubyServiceInternals, property: StugubySharedProperty, targetNodeId: string): void {
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
    },
  subscribeNotifications(this: StugubyServiceInternals, stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void {
      const handler = (notification: Notification): void => {
        if (notification.stugubyId === stugubyId && notification.targetNodeId === nodeId) listener(notification.cursor);
      };
      this[stugubyServiceState].notifications.on("event", handler);
      return () => this[stugubyServiceState].notifications.off("event", handler);
    },
  replaceNotificationStream(this: StugubyServiceInternals, stugubyId: string, nodeId: string, close: () => void): () => void {
      const key = `${stugubyId}\n${nodeId}`;
      const previous = this[stugubyServiceState].incomingNotificationStreams.get(key);
      this[stugubyServiceState].incomingNotificationStreams.set(key, close);
      previous?.();
      return () => {
        if (this[stugubyServiceState].incomingNotificationStreams.get(key) === close) this[stugubyServiceState].incomingNotificationStreams.delete(key);
      };
    },
  authenticateMachineRequest(this: StugubyServiceInternals, stugubyId: string, proof: MachineRequestProof): StugubyMember {
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
    },
  ingestEventBatch(this: StugubyServiceInternals, actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): { accepted: string[]; duplicates: string[] } {
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
            const previousGrant = this.store.getGrant(grant.id);
            validateGrantTransition(previousGrant, grant, 409);
            this.store.upsertGrant(grant);
            if (previousGrant
              && grantAudienceIncludes(previousGrant, this.identity.nodeId)
              && !grantAudienceIncludes(grant, this.identity.nodeId)) {
              this.store.purgeGrantData(stugubyId, grant.id, grant.epoch);
              this.deleteUnreferencedBlobs(this.store.purgeReplicaBlobReferences(stugubyId, grant.id, grant.epoch));
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
              if (grantAudienceIncludes(grant, this.identity.nodeId)) {
                this.materializeRemoteHome(stugubyId, grant.authorityNodeId, grant.publicationId);
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
            this.materializeRemoteHome(stugubyId, grant.authorityNodeId, grant.publicationId);
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
    },
  eventPage(this: StugubyServiceInternals, actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage {
      this.requireCoordinator(stugubyId);
      this.deleteUnreferencedBlobs(this.store.acknowledgeEventCursor(stugubyId, actor.nodeId, cursor));
      const page = this.store.eventPage(stugubyId, actor.nodeId, cursor, limit);
      return { protocolVersion: STUGBY_PROTOCOL_VERSION, ...page };
    },
  authorizeDatasetEvent(this: StugubyServiceInternals, event: StugubySignedEvent): StugubyShareGrant {
      if (!isStugubyDataset(event.schema) || !event.grantId || event.grantEpoch === null) throw new StugubyError(400, "INVALID_DATASET_EVENT", "Dataset event requires a grant and epoch");
      const grant = this.store.getGrant(event.grantId);
      if (!grant || grant.authorityNodeId !== event.authorityNodeId || grant.stugubyId !== event.stugubyId
        || grant.epoch !== event.grantEpoch || grant.revokedAt || grantExpired(grant)
        || !enabledDataset(grant, event.schema)) {
        throw new StugubyError(403, "DATASET_NOT_GRANTED", "Dataset is not authorized by the active grant epoch");
      }
      if (event.operation === "upsert") validateDatasetPayload(event.schema, event.payload);
      return grant;
    },
  verifyEvent(this: StugubyServiceInternals, event: StugubySignedEvent, publicKey: string): void {
      if (event.keyFingerprint !== publicKeyFingerprint(publicKey)) throw new StugubyError(401, "EVENT_KEY_MISMATCH", "Event signing key does not match member identity");
      const expectedHash = sha256(eventPayloadHashValue(event));
      if (expectedHash !== event.payloadHash) throw new StugubyError(400, "EVENT_HASH_MISMATCH", "Event payload hash is invalid");
      if (!this.keys.verify(eventSigningValue(event), event.signature, publicKey)) throw new StugubyError(401, "INVALID_EVENT_SIGNATURE", "Event signature is invalid");
    },
  async syncNow(this: StugubyServiceInternals, stugubyId: string): Promise<StugubySummary> {
      this.requireStuguby(stugubyId);
      this.backfillRecommendedHomeOverviews(stugubyId);
      await this.trackSync(this.syncOne(stugubyId, true));
      return this.requireStuguby(stugubyId);
    },
  async syncAll(this: StugubyServiceInternals): Promise<void> {
      if (this[stugubyServiceState].syncing) return this[stugubyServiceState].syncing;
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
      this[stugubyServiceState].syncing = this.trackSync(operation).finally(() => { this[stugubyServiceState].syncing = null; });
      return this[stugubyServiceState].syncing;
    },
  ensureNotificationStreams(this: StugubyServiceInternals): void {
      if (!this[stugubyServiceState].started) return;
      for (const [stugubyId, controller] of this[stugubyServiceState].streamControllers) {
        const stuguby = this.store.getStuguby(stugubyId);
        if (!stuguby || !["active", "suspended"].includes(stuguby.localMemberState) || this.store.isCoordinator(stugubyId)) {
          controller.abort();
          this[stugubyServiceState].streamControllers.delete(stugubyId);
        }
      }
      for (const stuguby of this.store.listStugubys()) {
        if (this.store.isCoordinator(stuguby.id) || !["active", "suspended"].includes(stuguby.localMemberState) || this[stugubyServiceState].streamControllers.has(stuguby.id)) continue;
        const controller = new AbortController();
        this[stugubyServiceState].streamControllers.set(stuguby.id, controller);
        const task = this.notificationLoop(stuguby.id, controller);
        this[stugubyServiceState].streamTasks.set(stuguby.id, task);
        void task.then(
          () => { if (this[stugubyServiceState].streamTasks.get(stuguby.id) === task) this[stugubyServiceState].streamTasks.delete(stuguby.id); },
          () => { if (this[stugubyServiceState].streamTasks.get(stuguby.id) === task) this[stugubyServiceState].streamTasks.delete(stuguby.id); },
        );
      }
    },
});
