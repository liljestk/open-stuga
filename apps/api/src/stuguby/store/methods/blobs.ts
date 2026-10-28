import { boundedLimit, resourceBlobDigests } from "../support/row-mappers.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    registerBlob(digest: string, byteLength: number, mediaType: string, relativePath: string): void;
    getBlob(digest: string): {
            digest: string;
            byteLength: number;
            mediaType: string;
            relativePath: string;
        } | null;
    grantBlobAccess(stugubyId: string, digest: string, nodeId: string, grantId: string, grantEpoch: number): void;
    registerBlobReference(stugubyId: string, digest: string, grantId: string, grantEpoch: number, kind: "local" | "relay" | "replica"): void;
    canReadBlob(stugubyId: string, digest: string, nodeId: string): boolean;
    releaseRelayReferencesWithoutAccess(stugubyId: string, grantId: string, beforeOrAtEpoch: number): string[];
    purgeReplicaBlobReferences(stugubyId: string, grantId: string, beforeEpoch: number): string[];
    reconcileReplicaBlobReferences(stugubyId: string): string[];
    retireLocalBlobReferences(stugubyId: string, grantId: string, throughEpoch: number): void;
    hasBlobReferences(digest: string): boolean;
    unregisterBlob(digest: string): void;
    pendingBlobDeletions(limit?: number): string[];
    unreferencedBlobBytes(): number;
    staleUnreferencedBlobs(cutoff: string, limit?: number): string[];
  }

  interface StugubyStoreCore {
    registerBlob(digest: string, byteLength: number, mediaType: string, relativePath: string): void;
    getBlob(digest: string): {
            digest: string;
            byteLength: number;
            mediaType: string;
            relativePath: string;
        } | null;
    grantBlobAccess(stugubyId: string, digest: string, nodeId: string, grantId: string, grantEpoch: number): void;
    registerBlobReference(stugubyId: string, digest: string, grantId: string, grantEpoch: number, kind: "local" | "relay" | "replica"): void;
    canReadBlob(stugubyId: string, digest: string, nodeId: string): boolean;
    releaseRelayReferencesWithoutAccess(stugubyId: string, grantId: string, beforeOrAtEpoch: number): string[];
    purgeReplicaBlobReferences(stugubyId: string, grantId: string, beforeEpoch: number): string[];
    reconcileReplicaBlobReferences(stugubyId: string): string[];
    retireLocalBlobReferences(stugubyId: string, grantId: string, throughEpoch: number): void;
    hasBlobReferences(digest: string): boolean;
    unregisterBlob(digest: string): void;
    pendingBlobDeletions(limit?: number): string[];
    unreferencedBlobBytes(): number;
    staleUnreferencedBlobs(cutoff: string, limit?: number): string[];
  }
}

registerStugubyStoreMethods({
  registerBlob(this: StugubyStoreInternals, digest: string, byteLength: number, mediaType: string, relativePath: string): void {
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_blob_metadata(digest,byte_length,media_type,relative_path,created_at)
        VALUES (?,?,?,?,?)`).run(digest, byteLength, mediaType, relativePath, new Date().toISOString());
    },
  getBlob(this: StugubyStoreInternals, digest: string): { digest: string; byteLength: number; mediaType: string; relativePath: string } | null {
      const row = this[stugubyStoreState].db.prepare(`SELECT digest,byte_length AS byteLength,media_type AS mediaType,relative_path AS relativePath
        FROM stugby_blob_metadata WHERE digest=?`).get(digest) as unknown as { digest: string; byteLength: number; mediaType: string; relativePath: string } | undefined;
      return row ?? null;
    },
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
  releaseRelayReferencesWithoutAccess(this: StugubyStoreInternals, stugubyId: string, grantId: string, beforeOrAtEpoch: number): string[] {
      const state = this[stugubyStoreState];
      const rows = state.db.prepare(`SELECT digest,grant_epoch FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='relay' AND grant_epoch<=?`)
        .all(stugubyId, grantId, beforeOrAtEpoch) as unknown as Array<{ digest: string; grant_epoch: number }>;
      const released = new Set<string>();
      for (const row of rows) {
        const inUse = state.db.prepare(`SELECT 1 FROM stugby_blob_access
          WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? LIMIT 1`)
          .get(stugubyId, row.digest, grantId, row.grant_epoch);
        if (inUse) continue;
        state.db.prepare(`DELETE FROM stugby_blob_references
          WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='relay'`)
          .run(stugubyId, row.digest, grantId, row.grant_epoch);
        released.add(row.digest);
      }
      return [...released].filter((digest) => !this.hasBlobReferences(digest));
    },
  purgeReplicaBlobReferences(this: StugubyStoreInternals, stugubyId: string, grantId: string, beforeEpoch: number): string[] {
      const state = this[stugubyStoreState];
      const rows = state.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
        .all(stugubyId, grantId, beforeEpoch) as unknown as Array<{ digest: string }>;
      state.db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
        .run(stugubyId, grantId, beforeEpoch);
      return rows.map((row) => row.digest).filter((digest) => !this.hasBlobReferences(digest));
    },
  reconcileReplicaBlobReferences(this: StugubyStoreInternals, stugubyId: string): string[] {
      const state = this[stugubyStoreState];
      const retained = new Set<string>();
      const resources = state.db.prepare(`SELECT grant_id,grant_epoch,schema_name,payload_json FROM stugby_remote_resources
        WHERE stugby_id=? AND schema_name IN ('home.floorplan.v1','home.recovery.v1')`).all(stugubyId) as unknown as Array<{
          grant_id: string; grant_epoch: number; schema_name: string; payload_json: string;
        }>;
      for (const resource of resources) {
        for (const digest of resourceBlobDigests(resource.schema_name, JSON.parse(resource.payload_json))) {
          retained.add(`${resource.grant_id}\n${resource.grant_epoch}\n${digest}`);
        }
      }
      const references = state.db.prepare(`SELECT digest,grant_id,grant_epoch FROM stugby_blob_references
        WHERE stugby_id=? AND kind='replica'`).all(stugubyId) as unknown as Array<{ digest: string; grant_id: string; grant_epoch: number }>;
      const released = new Set<string>();
      for (const reference of references) {
        if (retained.has(`${reference.grant_id}\n${reference.grant_epoch}\n${reference.digest}`)) continue;
        state.db.prepare(`DELETE FROM stugby_blob_references
          WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='replica'`)
          .run(stugubyId, reference.digest, reference.grant_id, reference.grant_epoch);
        released.add(reference.digest);
      }
      return [...released].filter((digest) => !this.hasBlobReferences(digest));
    },
  retireLocalBlobReferences(this: StugubyStoreInternals, stugubyId: string, grantId: string, throughEpoch: number): void {
      const state = this[stugubyStoreState];
      const rows = state.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
        .all(stugubyId, grantId, throughEpoch) as unknown as Array<{ digest: string }>;
      state.db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
        .run(stugubyId, grantId, throughEpoch);
      const queuedAt = new Date().toISOString();
      for (const { digest } of rows) {
        if (this.hasBlobReferences(digest)) continue;
        state.db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)`)
          .run(digest, queuedAt);
      }
    },
  hasBlobReferences(this: StugubyStoreInternals, digest: string): boolean {
      return Boolean(this[stugubyStoreState].db.prepare(`SELECT 1 FROM stugby_blob_references WHERE digest=?
        UNION ALL SELECT 1 FROM stugby_blob_access WHERE digest=? LIMIT 1`).get(digest, digest));
    },
  unregisterBlob(this: StugubyStoreInternals, digest: string): void {
      const state = this[stugubyStoreState];
      state.db.prepare("DELETE FROM stugby_blob_metadata WHERE digest=?").run(digest);
      state.db.prepare("DELETE FROM stugby_blob_deletion_queue WHERE digest=?").run(digest);
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
});
