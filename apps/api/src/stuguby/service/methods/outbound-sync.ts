import { STUGBY_MAX_BATCH_EVENTS, STUGBY_PROTOCOL_VERSION, validateHomeCommandResult, validatePropertyCommandResult, type StugubyDeletionReceipt, type StugubyEventBatch, type StugubySummary, type StugubyMember } from "@climate-twin/stuguby-protocol";
import type { StugubyOutboxItem } from "../../store.js";
import { StugubyError } from "../support/service-types.js";
import { eventBlobReferences, grantExpired, recordValue, parseIso, requiredText } from "../support/federation-validation.js";
import { registerStugubyServiceMethods, type StugubyServiceInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyServiceInternals {
    expireLocalGrants(stugubyId: string): void;
    flushOutbox(stuguby: StugubySummary): Promise<void>;
    flushHomeCommands(stuguby: StugubySummary): Promise<void>;
    flushPropertyCommands(stuguby: StugubySummary): Promise<void>;
    uploadReferencedBlobs(stuguby: StugubySummary, item: StugubyOutboxItem): Promise<void>;
    sendDeletionReceipt(stuguby: StugubySummary, receipt: StugubyDeletionReceipt): Promise<void>;
    recordDeletionReceipt(actor: StugubyMember, receipt: StugubyDeletionReceipt): void;
  }

  interface StugubyServiceCore {
    recordDeletionReceipt(actor: StugubyMember, receipt: StugubyDeletionReceipt): void;
  }
}

registerStugubyServiceMethods({
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
  async sendDeletionReceipt(this: StugubyServiceInternals, stuguby: StugubySummary, receipt: StugubyDeletionReceipt): Promise<void> {
      const response = await this.signedFetch(stuguby, `/api/v1/stugby-protocol/stugbys/${encodeURIComponent(stuguby.id)}/deletion-receipts`, {
        method: "POST",
        body: JSON.stringify(receipt),
      });
      if (!response.ok) throw await this.remoteError(response, "Stuguby deletion acknowledgement failed");
    },
  recordDeletionReceipt(this: StugubyServiceInternals, actor: StugubyMember, receipt: StugubyDeletionReceipt): void {
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
    },
});
