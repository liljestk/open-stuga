import { randomUUID } from "node:crypto";
import type { StugubyShareGrant } from "@climate-twin/stuguby-protocol";
import { GrantRow, PublicationResourceType } from "../support/store-types.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";
import { withStugubySavepoint } from "../savepoint.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    upsertGrant(grant: StugubyShareGrant): void;
    publicationId(stugubyId: string, resourceType: PublicationResourceType, localId: string): string;
    getGrant(id: string): StugubyShareGrant | null;
    listGrants(stugubyId: string, authorityNodeId?: string): StugubyShareGrant[];
    revokeGrant(id: string): StugubyShareGrant;
    removeInvalidGrant(id: string): string[];
    publicationLocalId(stugubyId: string, authorityNodeId: string, resourceType: PublicationResourceType, publicationId: string, create?: boolean): string | null;
  }

  interface StugubyStoreCore {
    upsertGrant(grant: StugubyShareGrant): void;
    publicationId(stugubyId: string, resourceType: PublicationResourceType, localId: string): string;
    getGrant(id: string): StugubyShareGrant | null;
    listGrants(stugubyId: string, authorityNodeId?: string): StugubyShareGrant[];
    revokeGrant(id: string): StugubyShareGrant;
    removeInvalidGrant(id: string): string[];
    publicationLocalId(stugubyId: string, authorityNodeId: string, resourceType: PublicationResourceType, publicationId: string, create?: boolean): string | null;
  }
}

registerStugubyStoreMethods({
  upsertGrant(this: StugubyStoreInternals, grant: StugubyShareGrant): void {
      const db = this[stugubyStoreState].db;
      const operation = (): void => {
        const previous = db.prepare("SELECT epoch FROM stugby_share_grants WHERE id=?")
          .get(grant.id) as { epoch: number } | undefined;
        db.prepare(`INSERT INTO stugby_share_grants
          (id,stugby_id,authority_node_id,publication_id,epoch,revision,expires_at,revoked_at,grant_json,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET publication_id=excluded.publication_id,epoch=excluded.epoch,
            revision=excluded.revision,expires_at=excluded.expires_at,revoked_at=excluded.revoked_at,
            grant_json=excluded.grant_json,updated_at=excluded.updated_at
          WHERE excluded.revision > stugby_share_grants.revision OR excluded.epoch > stugby_share_grants.epoch`)
          .run(grant.id, grant.stugubyId, grant.authorityNodeId, grant.publicationId, grant.epoch, grant.revision,
            grant.expiresAt, grant.revokedAt, JSON.stringify(grant), grant.updatedAt);
        db.prepare(`INSERT INTO stugby_publications
          (stugby_id,publication_id,authority_node_id,local_house_id,display_name,updated_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(stugby_id,publication_id) DO UPDATE SET
            local_house_id=excluded.local_house_id,display_name=excluded.display_name,updated_at=excluded.updated_at`)
          .run(grant.stugubyId, grant.publicationId, grant.authorityNodeId, grant.localHouseId ?? null,
            grant.publicationId, grant.updatedAt);
        if (previous && grant.epoch > previous.epoch) {
          db.prepare(`DELETE FROM stugby_remote_resources
            WHERE stugby_id=? AND grant_id=? AND grant_epoch<?`).run(grant.stugubyId, grant.id, grant.epoch);
          db.prepare(`DELETE FROM stugby_remote_telemetry
            WHERE stugby_id=? AND grant_id=? AND grant_epoch<?`).run(grant.stugubyId, grant.id, grant.epoch);
          db.prepare(`DELETE FROM stugby_remote_telemetry_staging
            WHERE stugby_id=? AND grant_id=? AND grant_epoch<?`).run(grant.stugubyId, grant.id, grant.epoch);
          db.prepare(`DELETE FROM stugby_remote_telemetry_epochs
            WHERE stugby_id=? AND grant_id=? AND grant_epoch<?`).run(grant.stugubyId, grant.id, grant.epoch);
        }
      };
      withStugubySavepoint(db, "stuguby_grant_epoch", operation);
    },
  publicationId(this: StugubyStoreInternals, stugubyId: string, resourceType: PublicationResourceType, localId: string): string {
      const state = this[stugubyStoreState];
      const existing = state.db.prepare(`SELECT publication_id FROM stugby_publication_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
        .get(stugubyId, this.localNodeId, resourceType, localId) as { publication_id: string } | undefined;
      if (existing) return existing.publication_id;
      const publicationId = randomUUID();
      state.db.prepare(`INSERT OR IGNORE INTO stugby_publication_ids
        (stugby_id,authority_node_id,resource_type,local_id,publication_id,created_at) VALUES (?,?,?,?,?,?)`)
        .run(stugubyId, this.localNodeId, resourceType, localId, publicationId, new Date().toISOString());
      return (state.db.prepare(`SELECT publication_id FROM stugby_publication_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
        .get(stugubyId, this.localNodeId, resourceType, localId) as { publication_id: string }).publication_id;
    },
  getGrant(this: StugubyStoreInternals, id: string): StugubyShareGrant | null {
      const row = this[stugubyStoreState].db.prepare("SELECT grant_json FROM stugby_share_grants WHERE id=?").get(id) as unknown as GrantRow | undefined;
      return row ? JSON.parse(row.grant_json) as StugubyShareGrant : null;
    },
  listGrants(this: StugubyStoreInternals, stugubyId: string, authorityNodeId?: string): StugubyShareGrant[] {
      const state = this[stugubyStoreState];
      const rows = authorityNodeId
        ? state.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? AND authority_node_id=? ORDER BY updated_at DESC")
          .all(stugubyId, authorityNodeId) as unknown as GrantRow[]
        : state.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? ORDER BY updated_at DESC")
          .all(stugubyId) as unknown as GrantRow[];
      return rows.map((row) => JSON.parse(row.grant_json) as StugubyShareGrant);
    },
  revokeGrant(this: StugubyStoreInternals, id: string): StugubyShareGrant {
      const grant = this.getGrant(id);
      if (!grant) throw new Error("Stuguby share grant not found");
      if (grant.authorityNodeId !== this.localNodeId) throw new Error("Only the authoritative Stugu can revoke this grant");
      const updated: StugubyShareGrant = {
        ...grant,
        epoch: grant.epoch + 1,
        revision: grant.revision + 1,
        revokedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.upsertGrant(updated);
      return updated;
    },
  removeInvalidGrant(this: StugubyStoreInternals, id: string): string[] {
      const state = this[stugubyStoreState];
      return this.transaction(() => {
        const grant = this.getGrant(id);
        if (!grant) throw new Error("Stuguby share grant not found");
        const candidates = state.db.prepare(`SELECT digest FROM stugby_blob_references
          WHERE stugby_id=? AND grant_id=?
          UNION SELECT digest FROM stugby_blob_access WHERE stugby_id=? AND grant_id=?`)
          .all(grant.stugubyId, id, grant.stugubyId, id) as Array<{ digest: string }>;

        for (const table of [
          "stugby_remote_resources",
          "stugby_remote_telemetry",
          "stugby_remote_telemetry_staging",
          "stugby_remote_telemetry_epochs",
          "stugby_live_telemetry_usage",
          "stugby_blob_access",
          "stugby_blob_references",
          "stugby_pending_deletions",
          "stugby_deletion_receipts",
        ]) {
          state.db.prepare(`DELETE FROM ${table} WHERE stugby_id=? AND grant_id=?`)
            .run(grant.stugubyId, id);
        }
        for (const table of ["stugby_outbox", "stugby_event_log"]) {
          state.db.prepare(`DELETE FROM ${table} WHERE stugby_id=?
            AND json_extract(event_json,'$.grantId')=?`).run(grant.stugubyId, id);
        }
        state.db.prepare(`DELETE FROM stugby_stream_sequences
          WHERE stugby_id=? AND authority_node_id=? AND (stream_id=? OR stream_id LIKE ?)`)
          .run(grant.stugubyId, grant.authorityNodeId, `grant:${id}`, `dataset:${id}:%`);
        state.db.prepare("DELETE FROM stugby_share_grants WHERE id=?").run(id);

        const publicationStillUsed = Boolean(state.db.prepare(`SELECT 1 FROM stugby_share_grants
          WHERE stugby_id=? AND authority_node_id=? AND publication_id=? LIMIT 1`)
          .get(grant.stugubyId, grant.authorityNodeId, grant.publicationId));
        if (!publicationStillUsed) {
          for (const table of ["stugby_home_commands", "stugby_home_revisions"]) {
            state.db.prepare(`DELETE FROM ${table}
              WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
              .run(grant.stugubyId, grant.authorityNodeId, grant.publicationId);
          }
          state.db.prepare(`DELETE FROM stugby_publications
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
            .run(grant.stugubyId, grant.authorityNodeId, grant.publicationId);
          state.db.prepare(`DELETE FROM stugby_publication_ids
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
            .run(grant.stugubyId, grant.authorityNodeId, grant.publicationId);
        }

        const queuedAt = new Date().toISOString();
        const unreferenced = candidates.map((row) => row.digest)
          .filter((digest) => !this.hasBlobReferences(digest));
        for (const digest of unreferenced) {
          state.db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue
            (digest,queued_at) VALUES (?,?)`).run(digest, queuedAt);
        }
        return unreferenced;
      });
    },
  publicationLocalId(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: PublicationResourceType,
      publicationId: string,
      create = false,
    ): string | null {
      const state = this[stugubyStoreState];
      const existing = state.db.prepare(`SELECT local_id FROM stugby_publication_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND publication_id=?`)
        .get(stugubyId, authorityNodeId, resourceType, publicationId) as { local_id: string } | undefined;
      if (existing) return existing.local_id;
      if (!create) return null;
      const localId = randomUUID();
      state.db.prepare(`INSERT INTO stugby_publication_ids
        (stugby_id,authority_node_id,resource_type,local_id,publication_id,created_at) VALUES (?,?,?,?,?,?)`)
        .run(stugubyId, authorityNodeId, resourceType, localId, publicationId, new Date().toISOString());
      return localId;
    },
});
