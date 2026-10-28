import { randomUUID } from "node:crypto";
import { type StugubyMember, type StugubyNodeIdentity, type StugubySharedProperty, type StugubySummary, STUGBY_PROTOCOL_VERSION } from "@climate-twin/stuguby-protocol";
import { StugubyRow } from "../support/store-types.js";
import { boundedLimit } from "../support/row-mappers.js";
import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

declare module "../core.js" {
  interface StugubyStoreInternals {
    transaction<T>(operation: () => T): T;
    createCoordinatedStuguby(input: {
            id?: string;
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }, identity: StugubyNodeIdentity): StugubySummary;
    saveJoinedStuguby(summary: StugubySummary, members: StugubyMember[], localMember: StugubyMember): StugubySummary;
    listStugubys(): StugubySummary[];
    getNodePublicOrigin(): string | null;
    setNodePublicOrigin(value: string, now?: string): number;
    getStuguby(id: string): StugubySummary | null;
    deleteStuguby(stugubyId: string): string[];
    isCoordinator(stugubyId: string): boolean;
    reconcileUnjoinedCoordinatorOrigins(coordinatorUrl: string, now?: string): number;
    reconcileUnjoinedCoordinatorOriginsInTransaction(coordinatorUrl: string, now: string): number;
    summaryFromRow(row: StugubyRow): StugubySummary;
    nextSequence(stugubyId: string, streamId: string): number;
    audit(stugubyId: string | null, eventType: string, actorNodeId: string | null, subjectId: string | null, details: Record<string, string | number | boolean | null>, createdAt?: string): void;
    listAudit(stugubyId: string, limit?: number): Array<Record<string, unknown>>;
    protocolVersion(): typeof STUGBY_PROTOCOL_VERSION;
  }

  interface StugubyStoreCore {
    transaction<T>(operation: () => T): T;
    createCoordinatedStuguby(input: {
            id?: string;
            name: string;
            description?: string | null;
            coordinatorUrl: string;
        }, identity: StugubyNodeIdentity): StugubySummary;
    saveJoinedStuguby(summary: StugubySummary, members: StugubyMember[], localMember: StugubyMember): StugubySummary;
    listStugubys(): StugubySummary[];
    getNodePublicOrigin(): string | null;
    setNodePublicOrigin(value: string, now?: string): number;
    getStuguby(id: string): StugubySummary | null;
    deleteStuguby(stugubyId: string): string[];
    isCoordinator(stugubyId: string): boolean;
    reconcileUnjoinedCoordinatorOrigins(coordinatorUrl: string, now?: string): number;
    nextSequence(stugubyId: string, streamId: string): number;
    audit(stugubyId: string | null, eventType: string, actorNodeId: string | null, subjectId: string | null, details: Record<string, string | number | boolean | null>, createdAt?: string): void;
    listAudit(stugubyId: string, limit?: number): Array<Record<string, unknown>>;
    protocolVersion(): typeof STUGBY_PROTOCOL_VERSION;
  }
}

registerStugubyStoreMethods({
  transaction<T>(this: StugubyStoreInternals, operation: () => T): T {
      const state = this[stugubyStoreState];
      state.db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        state.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          state.db.exec("ROLLBACK");
        } catch {
          // Preserve the operation error; SQLite may already have rolled back a
          // statement-level failure.
        }
        throw error;
      }
    },
  createCoordinatedStuguby(this: StugubyStoreInternals, input: { id?: string; name: string; description?: string | null; coordinatorUrl: string }, identity: StugubyNodeIdentity): StugubySummary {
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      const id = input.id ?? randomUUID();
      state.db.exec("BEGIN IMMEDIATE");
      try {
        state.db.prepare(`INSERT INTO stugby_federations
          (id,name,description,coordinator_node_id,coordinator_url,local_role,local_member_state,is_coordinator,created_at,updated_at)
          VALUES (?,?,?,?,?,'steward','active',1,?,?)`)
          .run(id, input.name.trim(), input.description?.trim() || null, identity.nodeId, input.coordinatorUrl, now, now);
        state.db.prepare(`INSERT INTO stugby_members
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
        state.db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)`)
          .run(id, 1, JSON.stringify(property), now);
        this.audit(id, "stuguby.created", identity.nodeId, id, { role: "steward" }, now);
        state.db.exec("COMMIT");
      } catch (error) {
        state.db.exec("ROLLBACK");
        throw error;
      }
      return this.getStuguby(id)!;
    },
  saveJoinedStuguby(this: StugubyStoreInternals, summary: StugubySummary, members: StugubyMember[], localMember: StugubyMember): StugubySummary {
      const state = this[stugubyStoreState];
      const now = new Date().toISOString();
      state.db.exec("BEGIN IMMEDIATE");
      try {
        state.db.prepare(`INSERT INTO stugby_federations
          (id,name,description,coordinator_node_id,coordinator_url,local_role,local_member_state,is_coordinator,created_at,updated_at,pull_cursor)
          VALUES (?,?,?,?,?,?,?,0,?,?,0)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
            coordinator_node_id=excluded.coordinator_node_id,coordinator_url=excluded.coordinator_url,
            local_role=excluded.local_role,local_member_state=excluded.local_member_state,updated_at=excluded.updated_at`)
          .run(summary.id, summary.name, summary.description, summary.coordinatorNodeId, summary.coordinatorUrl,
            localMember.role, localMember.state, summary.createdAt, now);
        for (const member of members) this.upsertMember(member);
        this.audit(summary.id, "stuguby.joined", this.localNodeId, summary.id, { role: localMember.role }, now);
        state.db.exec("COMMIT");
      } catch (error) {
        state.db.exec("ROLLBACK");
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
      const state = this[stugubyStoreState];
      return this.transaction(() => {
        const candidates = state.db.prepare(`SELECT digest FROM stugby_blob_references WHERE stugby_id=?
          UNION SELECT digest FROM stugby_blob_access WHERE stugby_id=?`)
          .all(stugubyId, stugubyId) as unknown as Array<{ digest: string }>;

        state.db.prepare("DELETE FROM stugby_join_admissions WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_publications WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_publication_ids WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_remote_telemetry_staging WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_remote_telemetry_epochs WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_stream_sequences WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_live_telemetry_usage WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_outbox WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_event_log WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_blob_access WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_blob_references WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_deletion_receipts WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_pending_deletions WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_audit_events WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_share_grants WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_shared_properties WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_invitations WHERE stugby_id=?").run(stugubyId);
        state.db.prepare("DELETE FROM stugby_members WHERE stugby_id=?").run(stugubyId);
        const deleted = state.db.prepare("DELETE FROM stugby_federations WHERE id=?").run(stugubyId);
        if (Number(deleted.changes) !== 1) throw new Error("Stuguby was not found");

        const queuedAt = new Date().toISOString();
        const unreferenced = candidates.map((row) => row.digest).filter((digest) => !this.hasBlobReferences(digest));
        for (const digest of unreferenced) {
          state.db.prepare("INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)")
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
      const state = this[stugubyStoreState];
      const rows = state.db.prepare(`SELECT federation.id,federation.coordinator_url
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
        const invitations = state.db.prepare(`SELECT id FROM stugby_invitations
          WHERE stugby_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
          .all(row.id, now) as unknown as Array<{ id: string }>;
        state.db.prepare("UPDATE stugby_federations SET coordinator_url=?,updated_at=? WHERE id=?")
          .run(coordinatorUrl, now, row.id);
        for (const invitation of invitations) {
          state.db.prepare("UPDATE stugby_invitations SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL")
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
  nextSequence(this: StugubyStoreInternals, stugubyId: string, streamId: string): number {
      const state = this[stugubyStoreState];
      state.db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
        VALUES (?,?,?,0) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO NOTHING`)
        .run(stugubyId, this.localNodeId, streamId);
      state.db.prepare(`UPDATE stugby_stream_sequences SET sequence=sequence+1
        WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`).run(stugubyId, this.localNodeId, streamId);
      return Number((state.db.prepare(`SELECT sequence FROM stugby_stream_sequences
        WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
        .get(stugubyId, this.localNodeId, streamId) as { sequence: number }).sequence);
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
