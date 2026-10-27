import {
  STUGBY_PROTOCOL_VERSION,
  type StugubyDeletionReceipt,
  type StugubySignedEvent,
} from "@climate-twin/stuguby-protocol";
import { StugubyDeletionReceiptResult, boundedLimit, eventBlobDigests, resourceBlobDigests } from "../support/01-stuguby-row-to-event-blob-digests.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

registerStugubyStoreMethods({
  grantBlobAccess(this: StugubyStoreInternals, stugubyId: string, digest: string, nodeId: string, grantId: string, grantEpoch: number): void {
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_blob_access
        (stugby_id,digest,node_id,grant_id,grant_epoch,created_at) VALUES (?,?,?,?,?,?)`)
        .run(stugubyId, digest, nodeId, grantId, grantEpoch, new Date().toISOString());
    },
  registerBlobReference(this: StugubyStoreInternals, stugubyId: string, digest: string, grantId: string, grantEpoch: number, kind: "local" | "relay" | "replica"): void {
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_blob_references
        (stugby_id,digest,grant_id,grant_epoch,kind,created_at) VALUES (?,?,?,?,?,?)`)
        .run(stugubyId, digest, grantId, grantEpoch, kind, new Date().toISOString());
    },
  canReadBlob(this: StugubyStoreInternals, stugubyId: string, digest: string, nodeId: string): boolean {
      return Boolean(this[stugubyStoreState].db.prepare(`SELECT 1 FROM stugby_blob_access access
        JOIN stugby_share_grants grant ON grant.id=access.grant_id
        WHERE access.stugby_id=? AND access.digest=? AND access.node_id=?
          AND ((grant.epoch=access.grant_epoch AND grant.revoked_at IS NULL
                AND (grant.expires_at IS NULL OR julianday(grant.expires_at)>julianday(?)))
            OR EXISTS (SELECT 1 FROM stugby_pending_deletions pending
              WHERE pending.stugby_id=access.stugby_id AND pending.node_id=access.node_id
                AND pending.grant_id=access.grant_id AND pending.grant_epoch>access.grant_epoch
                AND pending.acknowledged_at IS NULL)) LIMIT 1`)
        .get(stugubyId, digest, nodeId, new Date().toISOString()));
    },
  acknowledgeEventCursor(this: StugubyStoreInternals, stugubyId: string, nodeId: string, cursor: number): string[] {
      if (cursor <= 0) return [];
      const rows = this[stugubyStoreState].db.prepare(`SELECT event_json FROM stugby_event_log
        WHERE stugby_id=? AND target_node_id=? AND cursor<=?`).all(stugubyId, nodeId, cursor) as unknown as Array<{ event_json: string }>;
      const blobEvents = rows.map((row) => JSON.parse(row.event_json) as StugubySignedEvent)
        .filter((event) => eventBlobDigests(event).length > 0 && event.grantId && event.grantEpoch !== null);
      const released = new Set<string>();
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND cursor<=?")
          .run(stugubyId, nodeId, cursor);
        for (const event of blobEvents) {
          for (const digest of eventBlobDigests(event)) {
            this[stugubyStoreState].db.prepare(`DELETE FROM stugby_blob_access
              WHERE stugby_id=? AND digest=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
              .run(stugubyId, digest, nodeId, event.grantId, event.grantEpoch);
            released.add(digest);
          }
        }
        this[stugubyStoreState].db.exec("COMMIT");
      } catch (error) {
        this[stugubyStoreState].db.exec("ROLLBACK");
        throw error;
      }
      for (const event of blobEvents) this.releaseRelayReferencesWithoutAccess(stugubyId, event.grantId!, event.grantEpoch!);
      return [...released].filter((digest) => !this.hasBlobReferences(digest));
    },
  releaseRelayReferencesWithoutAccess(this: StugubyStoreInternals, stugubyId: string, grantId: string, beforeOrAtEpoch: number): string[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT digest,grant_epoch FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='relay' AND grant_epoch<=?`)
        .all(stugubyId, grantId, beforeOrAtEpoch) as unknown as Array<{ digest: string; grant_epoch: number }>;
      const released = new Set<string>();
      for (const row of rows) {
        const inUse = this[stugubyStoreState].db.prepare(`SELECT 1 FROM stugby_blob_access
          WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? LIMIT 1`)
          .get(stugubyId, row.digest, grantId, row.grant_epoch);
        if (inUse) continue;
        this[stugubyStoreState].db.prepare(`DELETE FROM stugby_blob_references
          WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='relay'`)
          .run(stugubyId, row.digest, grantId, row.grant_epoch);
        released.add(row.digest);
      }
      return [...released].filter((digest) => !this.hasBlobReferences(digest));
    },
  purgeReplicaBlobReferences(this: StugubyStoreInternals, stugubyId: string, grantId: string, beforeEpoch: number): string[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
        .all(stugubyId, grantId, beforeEpoch) as unknown as Array<{ digest: string }>;
      this[stugubyStoreState].db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
        .run(stugubyId, grantId, beforeEpoch);
      return rows.map((row) => row.digest).filter((digest) => !this.hasBlobReferences(digest));
    },
  reconcileReplicaBlobReferences(this: StugubyStoreInternals, stugubyId: string): string[] {
      const retained = new Set<string>();
      const resources = this[stugubyStoreState].db.prepare(`SELECT grant_id,grant_epoch,schema_name,payload_json FROM stugby_remote_resources
        WHERE stugby_id=? AND schema_name IN ('home.floorplan.v1','home.recovery.v1')`).all(stugubyId) as unknown as Array<{
          grant_id: string; grant_epoch: number; schema_name: string; payload_json: string;
        }>;
      for (const resource of resources) {
        for (const digest of resourceBlobDigests(resource.schema_name, JSON.parse(resource.payload_json))) {
          retained.add(`${resource.grant_id}\n${resource.grant_epoch}\n${digest}`);
        }
      }
      const references = this[stugubyStoreState].db.prepare(`SELECT digest,grant_id,grant_epoch FROM stugby_blob_references
        WHERE stugby_id=? AND kind='replica'`).all(stugubyId) as unknown as Array<{ digest: string; grant_id: string; grant_epoch: number }>;
      const released = new Set<string>();
      for (const reference of references) {
        if (retained.has(`${reference.grant_id}\n${reference.grant_epoch}\n${reference.digest}`)) continue;
        this[stugubyStoreState].db.prepare(`DELETE FROM stugby_blob_references
          WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='replica'`)
          .run(stugubyId, reference.digest, reference.grant_id, reference.grant_epoch);
        released.add(reference.digest);
      }
      return [...released].filter((digest) => !this.hasBlobReferences(digest));
    },
  retireLocalBlobReferences(this: StugubyStoreInternals, stugubyId: string, grantId: string, throughEpoch: number): void {
      const rows = this[stugubyStoreState].db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
        .all(stugubyId, grantId, throughEpoch) as unknown as Array<{ digest: string }>;
      this[stugubyStoreState].db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
        .run(stugubyId, grantId, throughEpoch);
      const queuedAt = new Date().toISOString();
      for (const { digest } of rows) {
        if (this.hasBlobReferences(digest)) continue;
        this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)`)
          .run(digest, queuedAt);
      }
    },
  hasBlobReferences(this: StugubyStoreInternals, digest: string): boolean {
      return Boolean(this[stugubyStoreState].db.prepare(`SELECT 1 FROM stugby_blob_references WHERE digest=?
        UNION ALL SELECT 1 FROM stugby_blob_access WHERE digest=? LIMIT 1`).get(digest, digest));
    },
  unregisterBlob(this: StugubyStoreInternals, digest: string): void {
      this[stugubyStoreState].db.prepare("DELETE FROM stugby_blob_metadata WHERE digest=?").run(digest);
      this[stugubyStoreState].db.prepare("DELETE FROM stugby_blob_deletion_queue WHERE digest=?").run(digest);
    },
  pendingBlobDeletions(this: StugubyStoreInternals, limit = 100): string[] {
      return (this[stugubyStoreState].db.prepare("SELECT digest FROM stugby_blob_deletion_queue ORDER BY queued_at,digest LIMIT ?")
        .all(boundedLimit(limit, 100, 1_000)) as unknown as Array<{ digest: string }>).map((row) => row.digest);
    },
  unreferencedBlobBytes(this: StugubyStoreInternals): number {
      return Number((this[stugubyStoreState].db.prepare(`SELECT COALESCE(sum(byte_length),0) AS bytes FROM stugby_blob_metadata metadata
        WHERE NOT EXISTS (SELECT 1 FROM stugby_blob_references reference WHERE reference.digest=metadata.digest)
          AND NOT EXISTS (SELECT 1 FROM stugby_blob_access access WHERE access.digest=metadata.digest)`)
        .get() as { bytes: number }).bytes);
    },
  staleUnreferencedBlobs(this: StugubyStoreInternals, cutoff: string, limit = 100): string[] {
      return (this[stugubyStoreState].db.prepare(`SELECT digest FROM stugby_blob_metadata metadata
        WHERE metadata.created_at<?
          AND NOT EXISTS (SELECT 1 FROM stugby_blob_references reference WHERE reference.digest=metadata.digest)
          AND NOT EXISTS (SELECT 1 FROM stugby_blob_access access WHERE access.digest=metadata.digest)
        ORDER BY metadata.created_at LIMIT ?`).all(cutoff, boundedLimit(limit, 100, 1_000)) as unknown as Array<{ digest: string }>)
        .map((row) => row.digest);
    },
  listDeletionReceipts(this: StugubyStoreInternals, stugubyId: string): StugubyDeletionReceipt[] {
      return this[stugubyStoreState].db.prepare(`SELECT stugby_id AS stugubyId,node_id AS nodeId,grant_id AS grantId,
        grant_epoch AS grantEpoch,deleted_at AS deletedAt FROM stugby_deletion_receipts WHERE stugby_id=? ORDER BY deleted_at DESC`)
        .all(stugubyId) as unknown as StugubyDeletionReceipt[];
    },
  getDeletionReceipt(this: StugubyStoreInternals, stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt | null {
      return (this[stugubyStoreState].db.prepare(`SELECT stugby_id AS stugubyId,node_id AS nodeId,grant_id AS grantId,
        grant_epoch AS grantEpoch,deleted_at AS deletedAt FROM stugby_deletion_receipts
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
        .get(stugubyId, nodeId, grantId, grantEpoch) as unknown as StugubyDeletionReceipt | undefined) ?? null;
    },
  expectDeletion(this: StugubyStoreInternals, stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): void {
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_pending_deletions
        (stugby_id,node_id,grant_id,grant_epoch,created_at) VALUES (?,?,?,?,?)`)
        .run(stugubyId, nodeId, grantId, grantEpoch, new Date().toISOString());
    },
  hasPendingDeletion(this: StugubyStoreInternals, stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): boolean {
      return Boolean(this[stugubyStoreState].db.prepare(`SELECT 1 FROM stugby_pending_deletions
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=? AND acknowledged_at IS NULL`)
        .get(stugubyId, nodeId, grantId, grantEpoch));
    },
  releaseDeletionBlobAccess(this: StugubyStoreInternals, receipt: StugubyDeletionReceipt): string[] {
      const rows = this[stugubyStoreState].db.prepare(`SELECT DISTINCT digest FROM stugby_blob_access
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
        .all(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as unknown as Array<{ digest: string }>;
      this[stugubyStoreState].db.prepare(`DELETE FROM stugby_blob_access
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
        .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
      const candidates = new Set(rows.map((row) => row.digest));
      for (const digest of this.releaseRelayReferencesWithoutAccess(receipt.stugubyId, receipt.grantId, receipt.grantEpoch - 1)) candidates.add(digest);
      return [...candidates].filter((digest) => !this.hasBlobReferences(digest));
    },
  processDeletionReceipt(this: StugubyStoreInternals, receipt: StugubyDeletionReceipt): StugubyDeletionReceiptResult {
      return this.transaction(() => {
        const existing = this.getDeletionReceipt(
          receipt.stugubyId,
          receipt.nodeId,
          receipt.grantId,
          receipt.grantEpoch,
        );
        if (existing && existing.deletedAt !== receipt.deletedAt) return "conflict";

        const pending = this[stugubyStoreState].db.prepare(`SELECT acknowledged_at FROM stugby_pending_deletions
          WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
          .get(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as {
            acknowledged_at: string | null;
          } | undefined;
        if (!existing && !pending) return "unexpected";
        if (!existing && pending?.acknowledged_at && pending.acknowledged_at !== receipt.deletedAt) return "conflict";

        const inserted = this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_deletion_receipts
          (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
          .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
        this[stugubyStoreState].db.prepare(`UPDATE stugby_pending_deletions SET acknowledged_at=COALESCE(acknowledged_at,?)
          WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
          .run(receipt.deletedAt, receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
        this[stugubyStoreState].db.prepare(`DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=?
          AND json_extract(event_json,'$.grantId')=?
          AND COALESCE(json_extract(event_json,'$.grantEpoch'),0)<?`)
          .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
        if (Number(inserted.changes) === 1) {
          this.audit(receipt.stugubyId, "deletion.acknowledged", receipt.nodeId, receipt.grantId,
            { epoch: receipt.grantEpoch }, receipt.deletedAt);
        }
        for (const digest of this.releaseDeletionBlobAccess(receipt)) {
          this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)`)
            .run(digest, new Date().toISOString());
        }
        return existing ? "retry" : "accepted";
      });
    },
  pendingDeletions(this: StugubyStoreInternals, stugubyId: string, nodeId: string): number {
      return Number((this[stugubyStoreState].db.prepare(`SELECT count(*) AS count FROM stugby_pending_deletions
        WHERE stugby_id=? AND node_id=? AND acknowledged_at IS NULL`).get(stugubyId, nodeId) as { count: number }).count);
    },
  pendingDeletionsForStuguby(this: StugubyStoreInternals, stugubyId: string): number {
      return Number((this[stugubyStoreState].db.prepare(`SELECT count(*) AS count FROM stugby_pending_deletions
        WHERE stugby_id=? AND acknowledged_at IS NULL`).get(stugubyId) as { count: number }).count);
    },
  audit(this: StugubyStoreInternals, stugubyId: string | null, eventType: string, actorNodeId: string | null, subjectId: string | null,
      details: Record<string, string | number | boolean | null>, createdAt = new Date().toISOString()): void {
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_audit_events(stugby_id,event_type,actor_node_id,subject_id,details_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(stugubyId, eventType, actorNodeId, subjectId, JSON.stringify(details), createdAt);
    },
  listAudit(this: StugubyStoreInternals, stugubyId: string, limit = 100): Array<Record<string, unknown>> {
      return (this[stugubyStoreState].db.prepare(`SELECT id,event_type,actor_node_id,subject_id,details_json,created_at
        FROM stugby_audit_events WHERE stugby_id=? ORDER BY id DESC LIMIT ?`)
        .all(stugubyId, boundedLimit(limit, 100, 500)) as unknown as Array<{
          id: number; event_type: string; actor_node_id: string | null; subject_id: string | null; details_json: string; created_at: string;
        }>).map((row) => ({
          id: row.id,
          eventType: row.event_type,
          actorNodeId: row.actor_node_id,
          subjectId: row.subject_id,
          details: JSON.parse(row.details_json) as Record<string, unknown>,
          createdAt: row.created_at,
        }));
    },
  protocolVersion(this: StugubyStoreInternals): typeof STUGBY_PROTOCOL_VERSION {
      return STUGBY_PROTOCOL_VERSION;
    },
});
