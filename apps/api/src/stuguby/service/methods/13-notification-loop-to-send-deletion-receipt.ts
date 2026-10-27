import { abortableDelay } from "../../../abortable-delay.js";
import {
  STUGBY_MAX_BATCH_EVENTS,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  STUGBY_PROTOCOL_VERSION,
  canonicalJson,
  validateHomeCommandResult,
  validatePropertyCommandResult,
  validateShareGrant,
  validateSharedProperty,
  validateSignedEvent,
  type StugubyDataset,
  type StugubyDeletionReceipt,
  type StugubyEventBatch,
  type StugubySignedEvent,
  type StugubySummary,
} from "@climate-twin/stuguby-protocol";
import {
  type StugubyOutboxItem,
} from "../../store.js";
import { StugubyError, asJson, enabledDataset, eventBlobReferences, grantAudienceIncludes, grantExpired, recordValue, validateGrantTransition, validatedMember } from "../support/01-stuguby-error-to-without-local-grant-identity.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

const STREAM_RETRY_BASE_MS = 5_000;
const STREAM_RETRY_MAX_MS = 300_000;
const STREAM_AUTH_RETRY_MIN_MS = 300_000;
const STREAM_STABLE_MS = 60_000;
const SLOW_STREAM_STATUS = new Set([401, 403, 404, 426]);

function streamRetryDelay(failures: number, status?: number): number {
  const exponential = Math.min(
    STREAM_RETRY_MAX_MS,
    STREAM_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, failures - 1), 8),
  );
  return status !== undefined && SLOW_STREAM_STATUS.has(status)
    ? Math.max(STREAM_AUTH_RETRY_MIN_MS, exponential)
    : exponential;
}

registerStugubyServiceMethods({
  async notificationLoop(this: StugubyServiceInternals, stugubyId: string, controller: AbortController): Promise<void> {
      let failures = 0;
      try {
        while (!controller.signal.aborted && this[stugubyServiceState].started) {
          let connectedAt: number | null = null;
          let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
          let failure: unknown;
          try {
            const stuguby = this.requireStuguby(stugubyId);
            const cursor = this.store.pullCursor(stugubyId);
            const path = `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stugubyId)}/events/stream?cursor=${cursor}`;
            const response = await this.signedFetch(stuguby, path, {
              method: "GET",
              signal: controller.signal,
              stream: true,
            });
            if (!response.ok || !response.body) throw await this.remoteError(response, "Stuguby notification stream failed");
            connectedAt = Date.now();
            reader = response.body.getReader();
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
                  if (typeof next.cursor === "number" && next.cursor > this.store.pullCursor(stugubyId)) {
                    await this.syncFederation(stugubyId, false);
                  }
                }
                boundary = buffered.indexOf("\n\n");
              }
            }
            if (!controller.signal.aborted) throw new Error("Stuguby notification stream ended");
          } catch (error) {
            failure = error;
          } finally {
            await reader?.cancel().catch(() => undefined);
          }
          if (controller.signal.aborted || !this[stugubyServiceState].started) break;
          if (connectedAt !== null && Date.now() - connectedAt >= STREAM_STABLE_MS) failures = 0;
          failures += 1;
          const status = failure instanceof StugubyError ? failure.status : undefined;
          await abortableDelay(streamRetryDelay(failures, status), controller.signal);
        }
      } finally {
        if (this[stugubyServiceState].streamControllers.get(stugubyId) === controller) this[stugubyServiceState].streamControllers.delete(stugubyId);
      }
    },
  async syncOne(this: StugubyServiceInternals, stugubyId: string, throwOnError: boolean): Promise<void> {
      const stuguby = this.requireStuguby(stugubyId);
      this.expireLocalGrants(stugubyId);
      this.store.enforceRetention(stugubyId);
      this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stugubyId));
      if (this.store.isCoordinator(stugubyId)) {
        this.store.recordSync(stugubyId, this.store.pullCursor(stugubyId), null);
        this.materializeAllRemoteHomes(stugubyId);
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
    },
  expireLocalGrants(this: StugubyServiceInternals, stugubyId: string): void {
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
    },
  async flushOutbox(this: StugubyServiceInternals, stuguby: StugubySummary): Promise<void> {
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
    },
  async flushHomeCommands(this: StugubyServiceInternals, stuguby: StugubySummary): Promise<void> {
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
    },
  async flushPropertyCommands(this: StugubyServiceInternals, stuguby: StugubySummary): Promise<void> {
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
    },
  async uploadReferencedBlobs(this: StugubyServiceInternals, stuguby: StugubySummary, item: StugubyOutboxItem): Promise<void> {
      for (const reference of eventBlobReferences(item.event)) {
        const blob = this.readBlob(reference.digest);
        const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/blobs/${reference.digest}`, {
          method: "PUT",
          body: blob.data,
          contentType: blob.mediaType,
        });
        if (!response.ok) throw await this.remoteError(response, "Stuguby Home asset upload failed");
      }
    },
  async applyPulledEvent(this: StugubyServiceInternals, stuguby: StugubySummary, event: StugubySignedEvent): Promise<void> {
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
          const now = new Date().toISOString();
          const terminalDeparture = member.state === "left" || member.state === "revoked";
          for (const projection of this.store.listHomeProjections(stuguby.id)) {
            this.removeRemoteHomeProjection(
              stuguby.id,
              projection.authorityNodeId,
              projection.publicationId,
            );
          }
          const adoption = this.store.getPropertyAdoption(stuguby.id);
          if (adoption?.state === "adopted") {
            this.database.transaction(() => {
              if (terminalDeparture) {
                for (const house of this.database.listHouses(adoption.localPropertyId)) {
                  if (house.stuguby?.stugubyId === stuguby.id && house.stuguby.ownership === "local") {
                    this.database.setHouseStugubyLink(house.id, null);
                  }
                }
              }
              for (const projection of this.store.listProjectionIds(
                stuguby.id,
                stuguby.coordinatorNodeId,
                "note",
              )) {
                if (this.database.getPropertyNote(projection.localId)?.propertyId === adoption.localPropertyId) {
                  this.database.deletePropertyNote(projection.localId);
                }
              }
              for (const projection of this.store.listProjectionIds(
                stuguby.id,
                stuguby.coordinatorNodeId,
                "maintenance",
              )) {
                if (this.database.getMaintenanceTask(projection.localId)?.propertyId === adoption.localPropertyId) {
                  this.database.deleteMaintenanceTask(projection.localId);
                }
              }
              for (const projection of this.store.listProjectionIds(
                stuguby.id,
                stuguby.coordinatorNodeId,
                "equipment",
              )) {
                if (this.database.getAreaEquipment(projection.localId)?.propertyId === adoption.localPropertyId) {
                  this.database.deleteAreaEquipment(projection.localId);
                }
              }
              for (const projection of this.store.listProjectionIds(
                stuguby.id,
                stuguby.coordinatorNodeId,
                "area",
              )) {
                if (this.database.getPropertyArea(projection.localId)?.propertyId === adoption.localPropertyId) {
                  this.database.deletePropertyArea(projection.localId);
                }
              }
              const property = this.database.getProperty(adoption.localPropertyId);
              if (property?.stuguby?.stugubyId === stuguby.id) {
                this.database.updateProperty(property.id, {
                  name: stuguby.name,
                  description: null,
                  location: null,
                });
                this.database.setPropertyStugubyLink(property.id, {
                  ...property.stuguby,
                  syncState: terminalDeparture ? "detached" : "offline",
                  pendingChangeCount: 0,
                  conflictCount: 0,
                  ...(terminalDeparture ? { detachedAt: now } : {}),
                });
              }
            });
            if (terminalDeparture) this.store.detachProperty(stuguby.id, now);
          }
          this.store.purgeDepartedReplicas(stuguby.id);
          this.deleteUnreferencedBlobs(this.store.reconcileReplicaBlobReferences(stuguby.id));
          if (terminalDeparture) {
            this[stugubyServiceState].streamControllers.get(stuguby.id)?.abort();
            this[stugubyServiceState].streamControllers.delete(stuguby.id);
          }
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
            this.materializeRemoteHome(stuguby.id, existing.authorityNodeId, existing.publicationId);
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
      this.materializeRemoteHome(stuguby.id, grant.authorityNodeId, grant.publicationId);
      const policy = enabledDataset(grant, event.schema as StugubyDataset);
      const blobReferences = eventBlobReferences(event);
      if (blobReferences.length > 0 && policy?.allowReplicaCache && policy.retentionDays > 0) {
        await this.downloadReferencedBlobs(stuguby, event, blobReferences);
        if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
          this.materializeRemoteHome(stuguby.id, event.authorityNodeId, String(event.payload.publicationId));
        }
      }
      this.store.recordInboxEvent(event);
    },
  async sendDeletionReceipt(this: StugubyServiceInternals, stuguby: StugubySummary, receipt: StugubyDeletionReceipt): Promise<void> {
      const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/deletion-receipts`, {
        method: "POST",
        body: JSON.stringify(receipt),
      });
      if (!response.ok) throw await this.remoteError(response, "Stuguby deletion acknowledgement failed");
    },
});
