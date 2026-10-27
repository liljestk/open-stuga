import type { StugubyPropertyAdoption } from "@climate-twin/contracts";
import { randomUUID } from "node:crypto";
import {
  type StugubyMember,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyEntityKind,
  type StugubyShareGrant,
  type StugubySharedProperty,
} from "@climate-twin/stuguby-protocol";
import { GrantRow, InvitationRow, JoinAdmissionRow, ProjectionResourceType, PublicationResourceType, SharedPropertyRow, StugubyInvitationAdmission, StugubyStoredPropertyCommand, invitationFromRow } from "../support/01-stuguby-row-to-event-blob-digests.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";
import { withStugubySavepoint } from "../savepoint.js";

registerStugubyStoreMethods({
  admitInvitation(this: StugubyStoreInternals, id: string, secretHash: string, identity: StugubyNodeIdentity,
      now = new Date().toISOString()): StugubyInvitationAdmission {
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        const row = this[stugubyStoreState].db.prepare(`SELECT invitation.* FROM stugby_invitations invitation
          JOIN stugby_federations federation ON federation.id=invitation.stugby_id
          WHERE invitation.id=? AND invitation.secret_hash=? AND invitation.revoked_at IS NULL
            AND federation.is_coordinator=1`)
          .get(id, secretHash) as unknown as InvitationRow | undefined;
        if (!row || (!row.used_at && row.expires_at <= now)) {
          this[stugubyStoreState].db.exec("COMMIT");
          return { status: "invalid" };
        }

        const existingMember = this.getMember(row.stugby_id, identity.nodeId);
        if (row.used_at) {
          const admission = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_join_admissions WHERE invitation_id=?")
            .get(row.id) as unknown as JoinAdmissionRow | undefined;
          const retryMatches = admission?.stugby_id === row.stugby_id
            && admission.node_id === identity.nodeId
            && admission.public_key === identity.publicKey
            && existingMember?.publicKey === identity.publicKey
            && existingMember?.state === "active";
          this[stugubyStoreState].db.exec("COMMIT");
          return retryMatches
            ? {
              status: "retry",
              invitation: invitationFromRow(row),
              member: existingMember,
              provisioned: admission.provisioned_at !== null,
            }
            : { status: "invalid" };
        }
        if (existingMember) {
          this[stugubyStoreState].db.exec("COMMIT");
          return { status: "node-conflict" };
        }

        const changed = this[stugubyStoreState].db.prepare(`UPDATE stugby_invitations SET used_at=?
          WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`).run(now, id, now);
        if (Number(changed.changes) !== 1) {
          this[stugubyStoreState].db.exec("ROLLBACK");
          return { status: "invalid" };
        }
        const member: StugubyMember = {
          stugubyId: row.stugby_id,
          nodeId: identity.nodeId,
          displayName: identity.displayName,
          role: row.role,
          state: "active",
          publicKey: identity.publicKey,
          keyFingerprint: identity.keyFingerprint,
          joinedAt: now,
          updatedAt: now,
        };
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_members
          (stugby_id,node_id,display_name,local_label,role,state,public_key,key_fingerprint,joined_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(member.stugubyId, member.nodeId, member.displayName, row.local_label, member.role, member.state,
            member.publicKey, member.keyFingerprint, member.joinedAt, member.updatedAt);
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_join_admissions
          (invitation_id,stugby_id,node_id,public_key,admitted_at) VALUES (?,?,?,?,?)`)
          .run(row.id, row.stugby_id, identity.nodeId, identity.publicKey, now);
        this.audit(row.stugby_id, "member.joined", member.nodeId, member.nodeId, { role: member.role }, now);
        this[stugubyStoreState].db.exec("COMMIT");
        return {
          status: "accepted",
          invitation: { ...invitationFromRow(row), usedAt: now },
          member,
          provisioned: false,
        };
      } catch (error) {
        this[stugubyStoreState].db.exec("ROLLBACK");
        throw error;
      }
    },
  markInvitationProvisioned(this: StugubyStoreInternals, invitationId: string, nodeId: string, now = new Date().toISOString()): void {
      this[stugubyStoreState].db.prepare(`UPDATE stugby_join_admissions SET provisioned_at=COALESCE(provisioned_at,?)
        WHERE invitation_id=? AND node_id=?`).run(now, invitationId, nodeId);
    },
  revokeInvitation(this: StugubyStoreInternals, stugubyId: string, invitationId: string): void {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare("UPDATE stugby_invitations SET revoked_at=? WHERE id=? AND stugby_id=? AND used_at IS NULL")
        .run(now, invitationId, stugubyId);
      this.audit(stugubyId, "invitation.revoked", this.localNodeId, invitationId, {}, now);
    },
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
      const existing = this[stugubyStoreState].db.prepare(`SELECT publication_id FROM stugby_publication_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
        .get(stugubyId, this.localNodeId, resourceType, localId) as { publication_id: string } | undefined;
      if (existing) return existing.publication_id;
      const publicationId = randomUUID();
      this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_publication_ids
        (stugby_id,authority_node_id,resource_type,local_id,publication_id,created_at) VALUES (?,?,?,?,?,?)`)
        .run(stugubyId, this.localNodeId, resourceType, localId, publicationId, new Date().toISOString());
      return (this[stugubyStoreState].db.prepare(`SELECT publication_id FROM stugby_publication_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
        .get(stugubyId, this.localNodeId, resourceType, localId) as { publication_id: string }).publication_id;
    },
  getGrant(this: StugubyStoreInternals, id: string): StugubyShareGrant | null {
      const row = this[stugubyStoreState].db.prepare("SELECT grant_json FROM stugby_share_grants WHERE id=?").get(id) as unknown as GrantRow | undefined;
      return row ? JSON.parse(row.grant_json) as StugubyShareGrant : null;
    },
  listGrants(this: StugubyStoreInternals, stugubyId: string, authorityNodeId?: string): StugubyShareGrant[] {
      const rows = authorityNodeId
        ? this[stugubyStoreState].db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? AND authority_node_id=? ORDER BY updated_at DESC")
          .all(stugubyId, authorityNodeId) as unknown as GrantRow[]
        : this[stugubyStoreState].db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? ORDER BY updated_at DESC")
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
      return this.transaction(() => {
        const grant = this.getGrant(id);
        if (!grant) throw new Error("Stuguby share grant not found");
        const candidates = this[stugubyStoreState].db.prepare(`SELECT digest FROM stugby_blob_references
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
          this[stugubyStoreState].db.prepare(`DELETE FROM ${table} WHERE stugby_id=? AND grant_id=?`)
            .run(grant.stugubyId, id);
        }
        for (const table of ["stugby_outbox", "stugby_event_log"]) {
          this[stugubyStoreState].db.prepare(`DELETE FROM ${table} WHERE stugby_id=?
            AND json_extract(event_json,'$.grantId')=?`).run(grant.stugubyId, id);
        }
        this[stugubyStoreState].db.prepare(`DELETE FROM stugby_stream_sequences
          WHERE stugby_id=? AND authority_node_id=? AND (stream_id=? OR stream_id LIKE ?)`)
          .run(grant.stugubyId, grant.authorityNodeId, `grant:${id}`, `dataset:${id}:%`);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_share_grants WHERE id=?").run(id);

        const publicationStillUsed = Boolean(this[stugubyStoreState].db.prepare(`SELECT 1 FROM stugby_share_grants
          WHERE stugby_id=? AND authority_node_id=? AND publication_id=? LIMIT 1`)
          .get(grant.stugubyId, grant.authorityNodeId, grant.publicationId));
        if (!publicationStillUsed) {
          for (const table of ["stugby_home_commands", "stugby_home_revisions"]) {
            this[stugubyStoreState].db.prepare(`DELETE FROM ${table}
              WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
              .run(grant.stugubyId, grant.authorityNodeId, grant.publicationId);
          }
          this[stugubyStoreState].db.prepare(`DELETE FROM stugby_publications
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
            .run(grant.stugubyId, grant.authorityNodeId, grant.publicationId);
          this[stugubyStoreState].db.prepare(`DELETE FROM stugby_publication_ids
            WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
            .run(grant.stugubyId, grant.authorityNodeId, grant.publicationId);
        }

        const queuedAt = new Date().toISOString();
        const unreferenced = candidates.map((row) => row.digest)
          .filter((digest) => !this.hasBlobReferences(digest));
        for (const digest of unreferenced) {
          this[stugubyStoreState].db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue
            (digest,queued_at) VALUES (?,?)`).run(digest, queuedAt);
        }
        return unreferenced;
      });
    },
  getSharedProperty(this: StugubyStoreInternals, stugubyId: string): StugubySharedProperty | null {
      const row = this[stugubyStoreState].db.prepare("SELECT property_json FROM stugby_shared_properties WHERE stugby_id=?")
        .get(stugubyId) as unknown as SharedPropertyRow | undefined;
      return row ? JSON.parse(row.property_json) as StugubySharedProperty : null;
    },
  saveSharedProperty(this: StugubyStoreInternals, property: StugubySharedProperty, expectedRevision?: number): StugubySharedProperty {
      const existing = this.getSharedProperty(property.stugubyId);
      if (expectedRevision !== undefined && existing?.revision !== expectedRevision) {
        throw new Error(`Stuguby shared property revision conflict; current revision is ${existing?.revision ?? 0}`);
      }
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(stugby_id) DO UPDATE SET revision=excluded.revision,property_json=excluded.property_json,updated_at=excluded.updated_at
        WHERE excluded.revision > stugby_shared_properties.revision`)
        .run(property.stugubyId, property.revision, JSON.stringify(property), property.updatedAt);
      return this.getSharedProperty(property.stugubyId)!;
    },
  getPropertyAdoption(this: StugubyStoreInternals, stugubyId: string): StugubyPropertyAdoption | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_property_adoptions WHERE stugby_id=?")
        .get(stugubyId) as {
          stugby_id: string;
          local_property_id: string;
          state: StugubyPropertyAdoption["state"];
          adopted_at: string;
          detached_at: string | null;
          last_materialized_revision: number;
        } | undefined;
      return row ? {
        stugubyId: row.stugby_id,
        localPropertyId: row.local_property_id,
        state: row.state,
        adoptedAt: row.adopted_at,
        detachedAt: row.detached_at,
        lastMaterializedRevision: Number(row.last_materialized_revision),
      } : null;
    },
  adoptProperty(this: StugubyStoreInternals, stugubyId: string, localPropertyId: string, revision: number, now = new Date().toISOString()): StugubyPropertyAdoption {
      const existing = this.getPropertyAdoption(stugubyId);
      if (existing && existing.localPropertyId !== localPropertyId) {
        throw new Error("This Stuguby is already adopted by another local Property");
      }
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_property_adoptions
        (stugby_id,local_property_id,state,adopted_at,detached_at,last_materialized_revision)
        VALUES (?,?,'adopted',?,NULL,?)
        ON CONFLICT(stugby_id) DO UPDATE SET state='adopted',detached_at=NULL,
          last_materialized_revision=MAX(stugby_property_adoptions.last_materialized_revision,excluded.last_materialized_revision)`)
        .run(stugubyId, localPropertyId, now, revision);
      return this.getPropertyAdoption(stugubyId)!;
    },
  releaseDetachedProperty(this: StugubyStoreInternals, localPropertyId: string, exceptStugubyId: string): number {
      return Number(this[stugubyStoreState].db.prepare(`DELETE FROM stugby_property_adoptions
        WHERE local_property_id=? AND stugby_id<>? AND state='detached'`)
        .run(localPropertyId, exceptStugubyId).changes);
    },
  markPropertyMaterialized(this: StugubyStoreInternals, stugubyId: string, revision: number): void {
      this[stugubyStoreState].db.prepare(`UPDATE stugby_property_adoptions
        SET last_materialized_revision=MAX(last_materialized_revision,?) WHERE stugby_id=? AND state='adopted'`)
        .run(revision, stugubyId);
    },
  detachProperty(this: StugubyStoreInternals, stugubyId: string, now = new Date().toISOString()): StugubyPropertyAdoption {
      const changed = this[stugubyStoreState].db.prepare(`UPDATE stugby_property_adoptions
        SET state='detached',detached_at=? WHERE stugby_id=? AND state='adopted'`).run(now, stugubyId);
      if (Number(changed.changes) !== 1) throw new Error("An adopted Stuguby Property was not found");
      return this.getPropertyAdoption(stugubyId)!;
    },
  projectionId(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: ProjectionResourceType,
      remoteId: string,
      preferredLocalId?: string,
    ): string {
      const get = (): string | null => {
        const row = this[stugubyStoreState].db.prepare(`SELECT local_id FROM stugby_projection_ids
          WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND remote_id=?`)
          .get(stugubyId, authorityNodeId, resourceType, remoteId) as { local_id: string } | undefined;
        return row?.local_id ?? null;
      };
      const existing = get();
      if (existing) return existing;
      const now = new Date().toISOString();
      const insert = (localId: string): boolean => {
        try {
          this[stugubyStoreState].db.prepare(`INSERT INTO stugby_projection_ids
            (stugby_id,authority_node_id,resource_type,remote_id,local_id,created_at) VALUES (?,?,?,?,?,?)`)
            .run(stugubyId, authorityNodeId, resourceType, remoteId, localId, now);
          return true;
        } catch (error) {
          if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return false;
          throw error;
        }
      };
      if (preferredLocalId && insert(preferredLocalId)) return preferredLocalId;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const localId = randomUUID();
        if (insert(localId)) return localId;
        const concurrent = get();
        if (concurrent) return concurrent;
      }
      throw new Error("Could not allocate a local Stuguby projection id");
    },
  listProjectionIds(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: ProjectionResourceType,
    ): Array<{ remoteId: string; localId: string }> {
      const rows = this[stugubyStoreState].db.prepare(`SELECT remote_id,local_id FROM stugby_projection_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? ORDER BY remote_id`)
        .all(stugubyId, authorityNodeId, resourceType) as Array<{ remote_id: string; local_id: string }>;
      return rows.map((row) => ({ remoteId: row.remote_id, localId: row.local_id }));
    },
  removeProjectionIds(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      projections: Array<{ resourceType: ProjectionResourceType; localId: string }>,
    ): number {
      if (projections.length === 0) return 0;
      const remove = this[stugubyStoreState].db.prepare(`DELETE FROM stugby_projection_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`);
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        let removed = 0;
        for (const projection of projections) {
          removed += Number(remove.run(
            stugubyId,
            authorityNodeId,
            projection.resourceType,
            projection.localId,
          ).changes);
        }
        this[stugubyStoreState].db.exec("COMMIT");
        return removed;
      } catch (error) {
        this[stugubyStoreState].db.exec("ROLLBACK");
        throw error;
      }
    },
  projectionRemoteId(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: ProjectionResourceType,
      localId: string,
    ): string {
      const existing = this[stugubyStoreState].db.prepare(`SELECT remote_id FROM stugby_projection_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
        .get(stugubyId, authorityNodeId, resourceType, localId) as { remote_id: string } | undefined;
      if (existing) return existing.remote_id;
      const remoteId = randomUUID();
      const allocated = this.projectionId(stugubyId, authorityNodeId, resourceType, remoteId, localId);
      if (allocated !== localId) throw new Error("Could not bind the local Home item to its shared id");
      return remoteId;
    },
  publicationLocalId(this: StugubyStoreInternals,
      stugubyId: string,
      authorityNodeId: string,
      resourceType: PublicationResourceType,
      publicationId: string,
      create = false,
    ): string | null {
      const existing = this[stugubyStoreState].db.prepare(`SELECT local_id FROM stugby_publication_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND publication_id=?`)
        .get(stugubyId, authorityNodeId, resourceType, publicationId) as { local_id: string } | undefined;
      if (existing) return existing.local_id;
      if (!create) return null;
      const localId = randomUUID();
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_publication_ids
        (stugby_id,authority_node_id,resource_type,local_id,publication_id,created_at) VALUES (?,?,?,?,?,?)`)
        .run(stugubyId, authorityNodeId, resourceType, localId, publicationId, new Date().toISOString());
      return localId;
    },
  enqueuePropertyCommand(this: StugubyStoreInternals, command: StugubyPropertyCommand): StugubyStoredPropertyCommand {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_property_commands
        (id,stugby_id,actor_node_id,command_json,status,result_json,attempts,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,'pending',NULL,0,?,?,?)
        ON CONFLICT(id) DO UPDATE SET command_json=excluded.command_json,
          attempts=0,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at
        WHERE stugby_property_commands.status='pending'`)
        .run(command.id, command.stugubyId, command.actorNodeId, JSON.stringify(command), now, command.createdAt, now);
      return this.getPropertyCommand(command.id)!;
    },
  pendingPropertyCommandFor(this: StugubyStoreInternals,
      stugubyId: string,
      actorNodeId: string,
      entityKind: StugubyPropertyEntityKind,
      entityId: string,
    ): StugubyStoredPropertyCommand | null {
      const row = this[stugubyStoreState].db.prepare(`SELECT id FROM stugby_property_commands
        WHERE stugby_id=? AND actor_node_id=? AND status='pending'
          AND json_extract(command_json,'$.entityKind')=?
          AND json_extract(command_json,'$.entityId')=?
        ORDER BY created_at DESC,id DESC LIMIT 1`)
        .get(stugubyId, actorNodeId, entityKind, entityId) as { id: string } | undefined;
      return row ? this.getPropertyCommand(row.id) : null;
    },
});
