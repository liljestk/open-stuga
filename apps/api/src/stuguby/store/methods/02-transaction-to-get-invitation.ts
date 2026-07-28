import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  STUGBY_PROTOCOL_VERSION,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  type JsonValue,
  type StugubyDataset,
  type StugubyDeletionReceipt,
  type StugubyInvitation,
  type StugubyHomeCommand,
  type StugubyHomeCommandResult,
  type StugubyMember,
  type StugubyMemberState,
  type StugubyNodeIdentity,
  type StugubyPropertyCommand,
  type StugubyPropertyCommandResult,
  type StugubyPropertyConflict,
  type StugubyPropertyEntityKind,
  type StugubyRemoteResource,
  type StugubyRole,
  type StugubyShareGrant,
  type StugubySharedProperty,
  type StugubySignedEvent,
  type StugubySummary,
  type StugubyTelemetryPayload,
} from "@climate-twin/stuguby-protocol";
import { InvitationRow, MemberRow, StugubyLocalInvitation, StugubyLocalMember, StugubyRow, invitationFromRow, localInvitationFromRow, localMemberFromRow, memberFromRow } from "../support/01-stuguby-row-to-event-blob-digests.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

registerStugubyStoreMethods({
  transaction<T>(this: StugubyStoreInternals, operation: () => T): T {
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this[stugubyStoreState].db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this[stugubyStoreState].db.exec("ROLLBACK");
        } catch {
          // Preserve the operation error; SQLite may already have rolled back a
          // statement-level failure.
        }
        throw error;
      }
    },
  createCoordinatedStuguby(this: StugubyStoreInternals, input: { id?: string; name: string; description?: string | null; coordinatorUrl: string }, identity: StugubyNodeIdentity): StugubySummary {
      const now = new Date().toISOString();
      const id = input.id ?? randomUUID();
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_federations
          (id,name,description,coordinator_node_id,coordinator_url,local_role,local_member_state,is_coordinator,created_at,updated_at)
          VALUES (?,?,?,?,?,'steward','active',1,?,?)`)
          .run(id, input.name.trim(), input.description?.trim() || null, identity.nodeId, input.coordinatorUrl, now, now);
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_members
          (stugby_id,node_id,display_name,role,state,public_key,key_fingerprint,joined_at,updated_at)
          VALUES (?,?,?,'steward','active',?,?,?,?)`)
          .run(id, identity.nodeId, identity.displayName, identity.publicKey, identity.keyFingerprint, now, now);
        const property: StugubySharedProperty = {
          stugubyId: id,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          location: null,
          areas: [],
          equipment: [],
          notes: [],
          maintenance: [],
          editPolicy: "collaborative",
          authorityEpoch: 1,
          designatedSuccessorNodeId: null,
          revision: 1,
          updatedAt: now,
        };
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)`)
          .run(id, 1, JSON.stringify(property), now);
        this.audit(id, "stuguby.created", identity.nodeId, id, { role: "steward" }, now);
        this[stugubyStoreState].db.exec("COMMIT");
      } catch (error) {
        this[stugubyStoreState].db.exec("ROLLBACK");
        throw error;
      }
      return this.getStuguby(id)!;
    },
  saveJoinedStuguby(this: StugubyStoreInternals, summary: StugubySummary, members: StugubyMember[], localMember: StugubyMember): StugubySummary {
      const now = new Date().toISOString();
      this[stugubyStoreState].db.exec("BEGIN IMMEDIATE");
      try {
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_federations
          (id,name,description,coordinator_node_id,coordinator_url,local_role,local_member_state,is_coordinator,created_at,updated_at,pull_cursor)
          VALUES (?,?,?,?,?,?,?,0,?,?,0)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
            coordinator_node_id=excluded.coordinator_node_id,coordinator_url=excluded.coordinator_url,
            local_role=excluded.local_role,local_member_state=excluded.local_member_state,updated_at=excluded.updated_at`)
          .run(summary.id, summary.name, summary.description, summary.coordinatorNodeId, summary.coordinatorUrl,
            localMember.role, localMember.state, summary.createdAt, now);
        for (const member of members) this.upsertMember(member);
        this.audit(summary.id, "stuguby.joined", this.localNodeId, summary.id, { role: localMember.role }, now);
        this[stugubyStoreState].db.exec("COMMIT");
      } catch (error) {
        this[stugubyStoreState].db.exec("ROLLBACK");
        throw error;
      }
      return this.getStuguby(summary.id)!;
    },
  listStugubys(this: StugubyStoreInternals): StugubySummary[] {
      const rows = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_federations ORDER BY name,id").all() as unknown as StugubyRow[];
      return rows.map((row) => this.summaryFromRow(row));
    },
  getNodePublicOrigin(this: StugubyStoreInternals): string | null {
      const row = this[stugubyStoreState].db.prepare("SELECT value FROM stugby_node_settings WHERE key='public-origin'")
        .get() as { value: string } | undefined;
      return row?.value ?? null;
    },
  setNodePublicOrigin(this: StugubyStoreInternals, value: string, now = new Date().toISOString()): number {
      return this.transaction(() => {
        this[stugubyStoreState].db.prepare(`INSERT INTO stugby_node_settings(key,value,updated_at) VALUES ('public-origin',?,?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
          .run(value, now);
        return this.reconcileUnjoinedCoordinatorOriginsInTransaction(value, now);
      });
    },
  getStuguby(this: StugubyStoreInternals, id: string): StugubySummary | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_federations WHERE id=?").get(id) as unknown as StugubyRow | undefined;
      return row ? this.summaryFromRow(row) : null;
    },
  deleteStuguby(this: StugubyStoreInternals, stugubyId: string): string[] {
      return this.transaction(() => {
        const candidates = this[stugubyStoreState].db.prepare(`SELECT digest FROM stugby_blob_references WHERE stugby_id=?
          UNION SELECT digest FROM stugby_blob_access WHERE stugby_id=?`)
          .all(stugubyId, stugubyId) as unknown as Array<{ digest: string }>;

        this[stugubyStoreState].db.prepare("DELETE FROM stugby_join_admissions WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_publications WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_publication_ids WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_stream_sequences WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_live_telemetry_usage WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_outbox WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_event_log WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_blob_access WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_blob_references WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_deletion_receipts WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_pending_deletions WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_audit_events WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_share_grants WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_shared_properties WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_invitations WHERE stugby_id=?").run(stugubyId);
        this[stugubyStoreState].db.prepare("DELETE FROM stugby_members WHERE stugby_id=?").run(stugubyId);
        const deleted = this[stugubyStoreState].db.prepare("DELETE FROM stugby_federations WHERE id=?").run(stugubyId);
        if (Number(deleted.changes) !== 1) throw new Error("Stuguby was not found");

        const queuedAt = new Date().toISOString();
        const unreferenced = candidates.map((row) => row.digest).filter((digest) => !this.hasBlobReferences(digest));
        for (const digest of unreferenced) {
          this[stugubyStoreState].db.prepare("INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)")
            .run(digest, queuedAt);
        }
        return unreferenced;
      });
    },
  isCoordinator(this: StugubyStoreInternals, stugubyId: string): boolean {
      return Boolean(this[stugubyStoreState].db.prepare(`SELECT 1 AS present FROM stugby_federations
        WHERE id=? AND is_coordinator=1 AND coordinator_node_id=?`)
        .get(stugubyId, this.localNodeId));
    },
  reconcileUnjoinedCoordinatorOrigins(this: StugubyStoreInternals, coordinatorUrl: string, now = new Date().toISOString()): number {
      return this.transaction(() => this.reconcileUnjoinedCoordinatorOriginsInTransaction(coordinatorUrl, now));
    },
  reconcileUnjoinedCoordinatorOriginsInTransaction(this: StugubyStoreInternals, coordinatorUrl: string, now: string): number {
      const rows = this[stugubyStoreState].db.prepare(`SELECT federation.id,federation.coordinator_url
        FROM stugby_federations federation
        WHERE federation.is_coordinator=1 AND federation.coordinator_url<>?
          AND NOT EXISTS (
            SELECT 1 FROM stugby_members member
            WHERE member.stugby_id=federation.id AND member.node_id<>?
          )`).all(coordinatorUrl, this.localNodeId) as unknown as Array<{
          id: string;
          coordinator_url: string;
        }>;
      for (const row of rows) {
        const invitations = this[stugubyStoreState].db.prepare(`SELECT id FROM stugby_invitations
          WHERE stugby_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
          .all(row.id, now) as unknown as Array<{ id: string }>;
        this[stugubyStoreState].db.prepare("UPDATE stugby_federations SET coordinator_url=?,updated_at=? WHERE id=?")
          .run(coordinatorUrl, now, row.id);
        for (const invitation of invitations) {
          this[stugubyStoreState].db.prepare("UPDATE stugby_invitations SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL")
            .run(now, invitation.id);
          this.audit(row.id, "invitation.revoked", this.localNodeId, invitation.id, {
            reason: "coordinator-origin-changed",
          }, now);
        }
        this.audit(row.id, "coordinator.origin.updated", this.localNodeId, row.id, {
          previousOrigin: row.coordinator_url,
          coordinatorOrigin: coordinatorUrl,
          revokedInvitations: invitations.length,
        }, now);
      }
      return rows.length;
    },
  summaryFromRow(this: StugubyStoreInternals, row: StugubyRow): StugubySummary {
      const memberCount = Number((this[stugubyStoreState].db.prepare(`SELECT count(*) AS count FROM stugby_members WHERE stugby_id=? AND state='active'`)
        .get(row.id) as { count: number }).count);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        coordinatorNodeId: row.coordinator_node_id,
        coordinatorUrl: row.coordinator_url,
        localRole: row.local_role,
        localMemberState: row.local_member_state,
        memberCount,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastSyncAt: row.last_sync_at,
        lastSyncError: row.last_sync_error,
      };
    },
  listMembers(this: StugubyStoreInternals, stugubyId: string): StugubyMember[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? ORDER BY display_name,node_id")
        .all(stugubyId) as unknown as MemberRow[]).map(memberFromRow);
    },
  listLocalMembers(this: StugubyStoreInternals, stugubyId: string): StugubyLocalMember[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? ORDER BY display_name,node_id")
        .all(stugubyId) as unknown as MemberRow[]).map(localMemberFromRow);
    },
  getMember(this: StugubyStoreInternals, stugubyId: string, nodeId: string): StugubyMember | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? AND node_id=?")
        .get(stugubyId, nodeId) as unknown as MemberRow | undefined;
      return row ? memberFromRow(row) : null;
    },
  upsertMember(this: StugubyStoreInternals, member: StugubyMember): void {
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_members
        (stugby_id,node_id,display_name,role,state,public_key,key_fingerprint,joined_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(stugby_id,node_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,
          state=excluded.state,public_key=excluded.public_key,key_fingerprint=excluded.key_fingerprint,
          joined_at=COALESCE(stugby_members.joined_at,excluded.joined_at),updated_at=excluded.updated_at`)
        .run(member.stugubyId, member.nodeId, member.displayName, member.role, member.state, member.publicKey,
          member.keyFingerprint, member.joinedAt, member.updatedAt);
      if (member.nodeId === this.localNodeId) {
        this[stugubyStoreState].db.prepare(`UPDATE stugby_federations SET local_role=?,local_member_state=?,updated_at=? WHERE id=?`)
          .run(member.role, member.state, member.updatedAt, member.stugubyId);
      }
    },
  updateMember(this: StugubyStoreInternals, stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember {
      const existing = this.getMember(stugubyId, nodeId);
      if (!existing) throw new Error("Stuguby member not found");
      if (existing.role === "steward" && (role !== "steward" || state !== "active")) throw new Error("The coordinator steward cannot be demoted or revoked");
      const updated = { ...existing, role, state, updatedAt: new Date().toISOString() };
      this.upsertMember(updated);
      this.audit(stugubyId, "member.updated", this.localNodeId, nodeId, { role, state }, updated.updatedAt);
      return updated;
    },
  updateMemberLocalLabel(this: StugubyStoreInternals, stugubyId: string, nodeId: string, localLabel: string | null): StugubyLocalMember {
      const changed = this[stugubyStoreState].db.prepare("UPDATE stugby_members SET local_label=? WHERE stugby_id=? AND node_id=?")
        .run(localLabel, stugubyId, nodeId);
      if (Number(changed.changes) !== 1) throw new Error("Stuguby member not found");
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? AND node_id=?")
        .get(stugubyId, nodeId) as unknown as MemberRow;
      return localMemberFromRow(row);
    },
  createInvitation(this: StugubyStoreInternals, input: {
      stugubyId: string;
      localLabel?: string | null;
      role: Exclude<StugubyRole, "steward">;
      secretHash: string;
      expiresAt: string;
      coordinatorUrl: string;
    }): StugubyLocalInvitation {
      const now = new Date().toISOString();
      const id = randomUUID();
      this[stugubyStoreState].db.prepare(`INSERT INTO stugby_invitations
        (id,stugby_id,local_label,role,secret_hash,expires_at,created_at,coordinator_url) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, input.stugubyId, input.localLabel ?? null, input.role, input.secretHash, input.expiresAt, now, input.coordinatorUrl);
      this.audit(input.stugubyId, "invitation.created", this.localNodeId, id, { role: input.role, expiresAt: input.expiresAt }, now);
      return localInvitationFromRow(this[stugubyStoreState].db.prepare("SELECT * FROM stugby_invitations WHERE id=?").get(id) as unknown as InvitationRow);
    },
  listInvitations(this: StugubyStoreInternals, stugubyId: string): StugubyInvitation[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_invitations WHERE stugby_id=? ORDER BY created_at DESC")
        .all(stugubyId) as unknown as InvitationRow[]).map(invitationFromRow);
    },
  listLocalInvitations(this: StugubyStoreInternals, stugubyId: string): StugubyLocalInvitation[] {
      return (this[stugubyStoreState].db.prepare("SELECT * FROM stugby_invitations WHERE stugby_id=? ORDER BY created_at DESC")
        .all(stugubyId) as unknown as InvitationRow[]).map(localInvitationFromRow);
    },
  getInvitation(this: StugubyStoreInternals, id: string): StugubyInvitation | null {
      const row = this[stugubyStoreState].db.prepare("SELECT * FROM stugby_invitations WHERE id=?")
        .get(id) as unknown as InvitationRow | undefined;
      return row ? invitationFromRow(row) : null;
    },
});
