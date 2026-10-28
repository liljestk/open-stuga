import type { StugubyDeletionReceipt } from "@climate-twin/stuguby-protocol";
import { StugubyDeletionReceiptResult } from "../support/store-types.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    listDeletionReceipts(stugubyId: string): StugubyDeletionReceipt[];
    getDeletionReceipt(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt | null;
    expectDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): void;
    hasPendingDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): boolean;
    releaseDeletionBlobAccess(receipt: StugubyDeletionReceipt): string[];
    processDeletionReceipt(receipt: StugubyDeletionReceipt): StugubyDeletionReceiptResult;
    pendingDeletions(stugubyId: string, nodeId: string): number;
    pendingDeletionsForStuguby(stugubyId: string): number;
  }

  interface StugubyStoreCore {
    listDeletionReceipts(stugubyId: string): StugubyDeletionReceipt[];
    getDeletionReceipt(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt | null;
    expectDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): void;
    hasPendingDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): boolean;
    releaseDeletionBlobAccess(receipt: StugubyDeletionReceipt): string[];
    processDeletionReceipt(receipt: StugubyDeletionReceipt): StugubyDeletionReceiptResult;
    pendingDeletions(stugubyId: string, nodeId: string): number;
    pendingDeletionsForStuguby(stugubyId: string): number;
  }
}

registerStugubyStoreMethods({
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
      const state = this[stugubyStoreState];
      const rows = state.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_access
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
        .all(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as unknown as Array<{ digest: string }>;
      state.db.prepare(`DELETE FROM stugby_blob_access
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
        .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
      const candidates = new Set(rows.map((row) => row.digest));
      for (const digest of this.releaseRelayReferencesWithoutAccess(receipt.stugubyId, receipt.grantId, receipt.grantEpoch - 1)) candidates.add(digest);
      return [...candidates].filter((digest) => !this.hasBlobReferences(digest));
    },
  processDeletionReceipt(this: StugubyStoreInternals, receipt: StugubyDeletionReceipt): StugubyDeletionReceiptResult {
      const state = this[stugubyStoreState];
      return this.transaction(() => {
        const existing = this.getDeletionReceipt(
          receipt.stugubyId,
          receipt.nodeId,
          receipt.grantId,
          receipt.grantEpoch,
        );
        if (existing && existing.deletedAt !== receipt.deletedAt) return "conflict";

        const pending = state.db.prepare(`SELECT acknowledged_at FROM stugby_pending_deletions
          WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
          .get(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as {
            acknowledged_at: string | null;
          } | undefined;
        if (!existing && !pending) return "unexpected";
        if (!existing && pending?.acknowledged_at && pending.acknowledged_at !== receipt.deletedAt) return "conflict";

        const inserted = state.db.prepare(`INSERT OR IGNORE INTO stugby_deletion_receipts
          (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
          .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
        state.db.prepare(`UPDATE stugby_pending_deletions SET acknowledged_at=COALESCE(acknowledged_at,?)
          WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
          .run(receipt.deletedAt, receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
        state.db.prepare(`DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=?
          AND json_extract(event_json,'$.grantId')=?
          AND COALESCE(json_extract(event_json,'$.grantEpoch'),0)<?`)
          .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
        if (Number(inserted.changes) === 1) {
          this.audit(receipt.stugubyId, "deletion.acknowledged", receipt.nodeId, receipt.grantId,
            { epoch: receipt.grantEpoch }, receipt.deletedAt);
        }
        for (const digest of this.releaseDeletionBlobAccess(receipt)) {
          state.db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)`)
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
});
