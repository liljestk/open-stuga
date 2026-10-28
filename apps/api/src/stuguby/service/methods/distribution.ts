import { STUGBY_MAX_BATCH_EVENTS, STUGBY_MAX_CLOCK_SKEW_SECONDS, STUGBY_PROTOCOL_VERSION, eventPayloadHashValue, eventSigningValue, isStugubyDataset, requestSigningValue, validateDatasetPayload, validateShareGrant, validateSignedEvent, type StugubyDataset, type StugubyEventBatch, type StugubyEventPage, type StugubyMember, type StugubyShareGrant, type StugubySharedProperty, type StugubySignedEvent, type StugubySummary, canonicalJson, validateSharedProperty } from "@climate-twin/stuguby-protocol";
import { publicKeyFingerprint } from "../../identity.js";
import { DATASET_SCHEMAS, ISO_DATE_TIME, UUID, asJson, enabledDataset, eventBlobReferences, grantAudienceIncludes, grantExpired, sha256, validateGrantTransition, validatedMember } from "../support/federation-validation.js";
import { MachineRequestProof, Notification, StugubyError } from "../support/service-types.js";
import { registerStugubyServiceMethods, stugubyServiceState, type StugubyServiceInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    distribute(event: StugubySignedEvent, explicitGrant?: StugubyShareGrant): void;
    appendForMember(stugubyId: string, nodeId: string, event: StugubySignedEvent): void;
    publishMember(member: StugubyMember): void;
    sendMemberSnapshot(member: StugubyMember, targetNodeId: string): void;
    sendSharedPropertySnapshot(property: StugubySharedProperty, targetNodeId: string): void;
    subscribeNotifications(stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void;
    replaceNotificationStream(stugubyId: string, nodeId: string, close: () => void): () => void;
    authenticateMachineRequest(stugubyId: string, proof: MachineRequestProof): StugubyMember;
    ingestEventBatch(actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): {
            accepted: string[];
            duplicates: string[];
        };
    eventPage(actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage;
    authorizeDatasetEvent(event: StugubySignedEvent): StugubyShareGrant;
    verifyEvent(event: StugubySignedEvent, publicKey: string): void;
    applyPulledEvent(stuguby: StugubySummary, event: StugubySignedEvent): Promise<void>;
  }

  interface StugubyServiceCore {
    subscribeNotifications(stugubyId: string, nodeId: string, listener: (cursor: number) => void): () => void;
    replaceNotificationStream(stugubyId: string, nodeId: string, close: () => void): () => void;
    authenticateMachineRequest(stugubyId: string, proof: MachineRequestProof): StugubyMember;
    ingestEventBatch(actor: StugubyMember, stugubyId: string, batch: StugubyEventBatch): {
            accepted: string[];
            duplicates: string[];
        };
    eventPage(actor: StugubyMember, stugubyId: string, cursor: number, limit: number): StugubyEventPage;
  }
}

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
      const state = this[stugubyServiceState];
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
        if (state.deferredNotifications) state.deferredNotifications.push(notification);
        else state.notifications.emit("event", notification);
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
      const state = this[stugubyServiceState];
      const handler = (notification: Notification): void => {
        if (notification.stugubyId === stugubyId && notification.targetNodeId === nodeId) listener(notification.cursor);
      };
      state.notifications.on("event", handler);
      return () => state.notifications.off("event", handler);
    },
  replaceNotificationStream(this: StugubyServiceInternals, stugubyId: string, nodeId: string, close: () => void): () => void {
      const state = this[stugubyServiceState];
      const key = `${stugubyId}\n${nodeId}`;
      const previous = state.incomingNotificationStreams.get(key);
      state.incomingNotificationStreams.set(key, close);
      previous?.();
      return () => {
        if (state.incomingNotificationStreams.get(key) === close) state.incomingNotificationStreams.delete(key);
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
  async applyPulledEvent(this: StugubyServiceInternals, stuguby: StugubySummary, event: StugubySignedEvent): Promise<void> {
      const state = this[stugubyServiceState];
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
            state.streamControllers.get(stuguby.id)?.abort();
            state.streamControllers.delete(stuguby.id);
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
});
