import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  STUGBY_PROTOCOL_VERSION,
  STUGBY_MAX_EVENT_PAGE_BYTES,
  type JsonValue,
  type StugbyDataset,
  type StugbyDeletionReceipt,
  type StugbyInvitation,
  type StugbyMember,
  type StugbyMemberState,
  type StugbyNodeIdentity,
  type StugbyRemoteResource,
  type StugbyRole,
  type StugbyShareGrant,
  type StugbySharedProperty,
  type StugbySignedEvent,
  type StugbySummary,
  type StugbyTelemetryPayload,
} from "@climate-twin/stugby-protocol";

interface StugbyRow {
  id: string;
  name: string;
  description: string | null;
  coordinator_node_id: string;
  coordinator_url: string;
  local_role: StugbyRole;
  local_member_state: StugbyMemberState;
  is_coordinator: number;
  created_at: string;
  updated_at: string;
  last_sync_at: string | null;
  last_sync_error: string | null;
  pull_cursor: number;
}

interface MemberRow {
  stugby_id: string;
  node_id: string;
  display_name: string;
  role: StugbyRole;
  state: StugbyMemberState;
  public_key: string;
  key_fingerprint: string;
  joined_at: string | null;
  updated_at: string;
}

interface InvitationRow {
  id: string;
  stugby_id: string;
  role: Exclude<StugbyRole, "steward">;
  secret_hash: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  revoked_at: string | null;
  coordinator_url: string;
}

interface JoinAdmissionRow {
  invitation_id: string;
  stugby_id: string;
  node_id: string;
  public_key: string;
  admitted_at: string;
  provisioned_at: string | null;
}

interface GrantRow { grant_json: string }
interface SharedPropertyRow { property_json: string }
interface OutboxRow {
  id: number;
  stugby_id: string;
  destination_node_id: string;
  event_json: string;
  attempts: number;
}

export interface StugbyOutboxItem {
  id: number;
  stugbyId: string;
  destinationNodeId: string;
  event: StugbySignedEvent;
  attempts: number;
}

export interface StugbyEventLogPage {
  events: StugbySignedEvent[];
  cursor: number;
  hasMore: boolean;
}

export type StugbyInvitationAdmission =
  | {
    status: "accepted";
    invitation: StugbyInvitation;
    member: StugbyMember;
    provisioned: boolean;
  }
  | {
    status: "retry";
    invitation: StugbyInvitation;
    member: StugbyMember;
    provisioned: boolean;
  }
  | { status: "invalid" }
  | { status: "node-conflict" };

export type StugbyDeletionReceiptResult = "accepted" | "retry" | "conflict" | "unexpected";

export interface RemoteTelemetryQuery {
  stugbyId: string;
  authorityNodeId?: string;
  publicationId?: string;
  sensorPublicationId?: string;
  metricId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

function memberFromRow(row: MemberRow): StugbyMember {
  return {
    stugbyId: row.stugby_id,
    nodeId: row.node_id,
    displayName: row.display_name,
    role: row.role,
    state: row.state,
    publicKey: row.public_key,
    keyFingerprint: row.key_fingerprint,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

function invitationFromRow(row: InvitationRow): StugbyInvitation {
  return {
    id: row.id,
    stugbyId: row.stugby_id,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    coordinatorUrl: row.coordinator_url,
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback;
}

export class StugbyStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly localNodeId: string,
  ) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stugby_federations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
        description TEXT,
        coordinator_node_id TEXT NOT NULL,
        coordinator_url TEXT NOT NULL,
        local_role TEXT NOT NULL CHECK (local_role IN ('steward','property-manager','participant','viewer')),
        local_member_state TEXT NOT NULL CHECK (local_member_state IN ('invited','active','suspended','left','revoked')),
        is_coordinator INTEGER NOT NULL CHECK (is_coordinator IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_sync_at TEXT,
        last_sync_error TEXT,
        pull_cursor INTEGER NOT NULL DEFAULT 0 CHECK (pull_cursor >= 0)
      );
      CREATE TABLE IF NOT EXISTS stugby_members (
        stugby_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('steward','property-manager','participant','viewer')),
        state TEXT NOT NULL CHECK (state IN ('invited','active','suspended','left','revoked')),
        public_key TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        joined_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, node_id),
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_members_state ON stugby_members(stugby_id, state, node_id);
      CREATE TABLE IF NOT EXISTS stugby_invitations (
        id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('property-manager','participant','viewer')),
        secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT,
        coordinator_url TEXT NOT NULL,
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_invitations_active ON stugby_invitations(stugby_id, expires_at);
      CREATE TABLE IF NOT EXISTS stugby_join_admissions (
        invitation_id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        admitted_at TEXT NOT NULL,
        provisioned_at TEXT,
        UNIQUE (stugby_id, node_id),
        FOREIGN KEY (invitation_id) REFERENCES stugby_invitations(id) ON DELETE CASCADE,
        FOREIGN KEY (stugby_id, node_id) REFERENCES stugby_members(stugby_id, node_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stugby_publications (
        stugby_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        local_house_id TEXT,
        display_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, publication_id),
        UNIQUE (stugby_id, authority_node_id, local_house_id)
      );
      CREATE TABLE IF NOT EXISTS stugby_publication_ids (
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('home','floor','room','wall','plan-element','sensor','note','observation')),
        local_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, authority_node_id, resource_type, local_id),
        UNIQUE (stugby_id, publication_id)
      );
      CREATE TABLE IF NOT EXISTS stugby_share_grants (
        id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK (epoch >= 1),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        expires_at TEXT,
        revoked_at TEXT,
        grant_json TEXT NOT NULL CHECK (json_valid(grant_json)),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_grants_authority ON stugby_share_grants(stugby_id, authority_node_id, publication_id);
      CREATE TABLE IF NOT EXISTS stugby_shared_properties (
        stugby_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        property_json TEXT NOT NULL CHECK (json_valid(property_json)),
        updated_at TEXT NOT NULL,
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stugby_remote_resources (
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        received_at TEXT NOT NULL,
        source_occurred_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
        PRIMARY KEY (stugby_id, authority_node_id, schema_name, resource_id)
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_remote_publication ON stugby_remote_resources(stugby_id, publication_id, schema_name);
      CREATE TABLE IF NOT EXISTS stugby_remote_telemetry (
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        chunk_id TEXT NOT NULL,
        sensor_publication_id TEXT NOT NULL,
        metric_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        value REAL NOT NULL,
        quality TEXT NOT NULL CHECK (quality IN ('good','estimated','stale')),
        correction_of TEXT,
        received_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, authority_node_id, sensor_publication_id, metric_id, timestamp, chunk_id)
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_remote_telemetry_query
        ON stugby_remote_telemetry(stugby_id, publication_id, sensor_publication_id, metric_id, timestamp);
      CREATE TABLE IF NOT EXISTS stugby_stream_sequences (
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        PRIMARY KEY (stugby_id, authority_node_id, stream_id)
      );
      CREATE TABLE IF NOT EXISTS stugby_live_telemetry_usage (
        stugby_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        utc_hour TEXT NOT NULL CHECK (length(utc_hour) = 13),
        sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, grant_id, utc_hour)
      );
      CREATE TABLE IF NOT EXISTS stugby_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stugby_id TEXT NOT NULL,
        destination_node_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (destination_node_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_outbox_due ON stugby_outbox(next_attempt_at, id);
      CREATE TABLE IF NOT EXISTS stugby_inbox (
        authority_node_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (authority_node_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS stugby_event_log (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        stugby_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        created_at TEXT NOT NULL,
        UNIQUE (stugby_id, target_node_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_event_log_pull ON stugby_event_log(stugby_id, target_node_id, cursor);
      CREATE TABLE IF NOT EXISTS stugby_request_replays (
        node_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (node_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_request_replays_expiry ON stugby_request_replays(expires_at);
      CREATE TABLE IF NOT EXISTS stugby_blob_metadata (
        digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
        byte_length INTEGER NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp')),
        relative_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stugby_blob_deletion_queue (
        digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
        queued_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stugby_blob_access (
        stugby_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        node_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, digest, node_id, grant_id, grant_epoch)
      );
      CREATE TABLE IF NOT EXISTS stugby_blob_references (
        stugby_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local','relay','replica')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, digest, grant_id, grant_epoch, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_blob_references_digest ON stugby_blob_references(digest);
      CREATE TABLE IF NOT EXISTS stugby_deletion_receipts (
        stugby_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id, node_id, grant_id, grant_epoch)
      );
      CREATE TABLE IF NOT EXISTS stugby_pending_deletions (
        stugby_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        PRIMARY KEY (stugby_id, node_id, grant_id, grant_epoch)
      );
      CREATE TABLE IF NOT EXISTS stugby_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stugby_id TEXT,
        event_type TEXT NOT NULL,
        actor_node_id TEXT,
        subject_id TEXT,
        details_json TEXT NOT NULL CHECK (json_valid(details_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_audit_recent ON stugby_audit_events(stugby_id, id DESC);
    `);
    // Raw telemetry has its own indexed projection. Keeping every chunk a
    // second time as a generic JSON resource makes the owner detail endpoint
    // grow without bound and doubles sensitive storage.
    this.db.prepare("DELETE FROM stugby_remote_resources WHERE schema_name='home.telemetry.v1'").run();
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the operation error; SQLite may already have rolled back a
        // statement-level failure.
      }
      throw error;
    }
  }

  createCoordinatedStugby(input: { id?: string; name: string; description?: string | null; coordinatorUrl: string }, identity: StugbyNodeIdentity): StugbySummary {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO stugby_federations
        (id,name,description,coordinator_node_id,coordinator_url,local_role,local_member_state,is_coordinator,created_at,updated_at)
        VALUES (?,?,?,?,?,'steward','active',1,?,?)`)
        .run(id, input.name.trim(), input.description?.trim() || null, identity.nodeId, input.coordinatorUrl, now, now);
      this.db.prepare(`INSERT INTO stugby_members
        (stugby_id,node_id,display_name,role,state,public_key,key_fingerprint,joined_at,updated_at)
        VALUES (?,?,?,'steward','active',?,?,?,?)`)
        .run(id, identity.nodeId, identity.displayName, identity.publicKey, identity.keyFingerprint, now, now);
      const property: StugbySharedProperty = {
        stugbyId: id,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        location: null,
        areas: [],
        equipment: [],
        notes: [],
        maintenance: [],
        revision: 1,
        updatedAt: now,
      };
      this.db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)`)
        .run(id, 1, JSON.stringify(property), now);
      this.audit(id, "stugby.created", identity.nodeId, id, { role: "steward" }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getStugby(id)!;
  }

  saveJoinedStugby(summary: StugbySummary, members: StugbyMember[], localMember: StugbyMember): StugbySummary {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO stugby_federations
        (id,name,description,coordinator_node_id,coordinator_url,local_role,local_member_state,is_coordinator,created_at,updated_at,pull_cursor)
        VALUES (?,?,?,?,?,?,?,0,?,?,0)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,
          coordinator_node_id=excluded.coordinator_node_id,coordinator_url=excluded.coordinator_url,
          local_role=excluded.local_role,local_member_state=excluded.local_member_state,updated_at=excluded.updated_at`)
        .run(summary.id, summary.name, summary.description, summary.coordinatorNodeId, summary.coordinatorUrl,
          localMember.role, localMember.state, summary.createdAt, now);
      for (const member of members) this.upsertMember(member);
      this.audit(summary.id, "stugby.joined", this.localNodeId, summary.id, { role: localMember.role }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getStugby(summary.id)!;
  }

  listStugbys(): StugbySummary[] {
    const rows = this.db.prepare("SELECT * FROM stugby_federations ORDER BY name,id").all() as unknown as StugbyRow[];
    return rows.map((row) => this.summaryFromRow(row));
  }

  getStugby(id: string): StugbySummary | null {
    const row = this.db.prepare("SELECT * FROM stugby_federations WHERE id=?").get(id) as unknown as StugbyRow | undefined;
    return row ? this.summaryFromRow(row) : null;
  }

  isCoordinator(stugbyId: string): boolean {
    return Boolean((this.db.prepare("SELECT is_coordinator FROM stugby_federations WHERE id=?").get(stugbyId) as { is_coordinator?: number } | undefined)?.is_coordinator);
  }

  private summaryFromRow(row: StugbyRow): StugbySummary {
    const memberCount = Number((this.db.prepare(`SELECT count(*) AS count FROM stugby_members WHERE stugby_id=? AND state='active'`)
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
  }

  listMembers(stugbyId: string): StugbyMember[] {
    return (this.db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? ORDER BY display_name,node_id")
      .all(stugbyId) as unknown as MemberRow[]).map(memberFromRow);
  }

  getMember(stugbyId: string, nodeId: string): StugbyMember | null {
    const row = this.db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? AND node_id=?")
      .get(stugbyId, nodeId) as unknown as MemberRow | undefined;
    return row ? memberFromRow(row) : null;
  }

  upsertMember(member: StugbyMember): void {
    this.db.prepare(`INSERT INTO stugby_members
      (stugby_id,node_id,display_name,role,state,public_key,key_fingerprint,joined_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(stugby_id,node_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,
        state=excluded.state,public_key=excluded.public_key,key_fingerprint=excluded.key_fingerprint,
        joined_at=COALESCE(stugby_members.joined_at,excluded.joined_at),updated_at=excluded.updated_at`)
      .run(member.stugbyId, member.nodeId, member.displayName, member.role, member.state, member.publicKey,
        member.keyFingerprint, member.joinedAt, member.updatedAt);
    if (member.nodeId === this.localNodeId) {
      this.db.prepare(`UPDATE stugby_federations SET local_role=?,local_member_state=?,updated_at=? WHERE id=?`)
        .run(member.role, member.state, member.updatedAt, member.stugbyId);
    }
  }

  updateMember(stugbyId: string, nodeId: string, role: StugbyRole, state: StugbyMemberState): StugbyMember {
    const existing = this.getMember(stugbyId, nodeId);
    if (!existing) throw new Error("Stugby member not found");
    if (existing.role === "steward" && (role !== "steward" || state !== "active")) throw new Error("The coordinator steward cannot be demoted or revoked");
    const updated = { ...existing, role, state, updatedAt: new Date().toISOString() };
    this.upsertMember(updated);
    this.audit(stugbyId, "member.updated", this.localNodeId, nodeId, { role, state }, updated.updatedAt);
    return updated;
  }

  createInvitation(input: {
    stugbyId: string;
    role: Exclude<StugbyRole, "steward">;
    secretHash: string;
    expiresAt: string;
    coordinatorUrl: string;
  }): StugbyInvitation {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO stugby_invitations
      (id,stugby_id,role,secret_hash,expires_at,created_at,coordinator_url) VALUES (?,?,?,?,?,?,?)`)
      .run(id, input.stugbyId, input.role, input.secretHash, input.expiresAt, now, input.coordinatorUrl);
    this.audit(input.stugbyId, "invitation.created", this.localNodeId, id, { role: input.role, expiresAt: input.expiresAt }, now);
    return invitationFromRow(this.db.prepare("SELECT * FROM stugby_invitations WHERE id=?").get(id) as unknown as InvitationRow);
  }

  listInvitations(stugbyId: string): StugbyInvitation[] {
    return (this.db.prepare("SELECT * FROM stugby_invitations WHERE stugby_id=? ORDER BY created_at DESC")
      .all(stugbyId) as unknown as InvitationRow[]).map(invitationFromRow);
  }

  admitInvitation(id: string, secretHash: string, identity: StugbyNodeIdentity,
    now = new Date().toISOString()): StugbyInvitationAdmission {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT invitation.* FROM stugby_invitations invitation
        JOIN stugby_federations federation ON federation.id=invitation.stugby_id
        WHERE invitation.id=? AND invitation.secret_hash=? AND invitation.revoked_at IS NULL
          AND federation.is_coordinator=1`)
        .get(id, secretHash) as unknown as InvitationRow | undefined;
      if (!row || (!row.used_at && row.expires_at <= now)) {
        this.db.exec("COMMIT");
        return { status: "invalid" };
      }

      const existingMember = this.getMember(row.stugby_id, identity.nodeId);
      if (row.used_at) {
        const admission = this.db.prepare("SELECT * FROM stugby_join_admissions WHERE invitation_id=?")
          .get(row.id) as unknown as JoinAdmissionRow | undefined;
        const retryMatches = admission?.stugby_id === row.stugby_id
          && admission.node_id === identity.nodeId
          && admission.public_key === identity.publicKey
          && existingMember?.publicKey === identity.publicKey
          && existingMember?.state === "active";
        this.db.exec("COMMIT");
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
        this.db.exec("COMMIT");
        return { status: "node-conflict" };
      }

      const changed = this.db.prepare(`UPDATE stugby_invitations SET used_at=?
        WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`).run(now, id, now);
      if (Number(changed.changes) !== 1) {
        this.db.exec("ROLLBACK");
        return { status: "invalid" };
      }
      const member: StugbyMember = {
        stugbyId: row.stugby_id,
        nodeId: identity.nodeId,
        displayName: identity.displayName,
        role: row.role,
        state: "active",
        publicKey: identity.publicKey,
        keyFingerprint: identity.keyFingerprint,
        joinedAt: now,
        updatedAt: now,
      };
      this.db.prepare(`INSERT INTO stugby_members
        (stugby_id,node_id,display_name,role,state,public_key,key_fingerprint,joined_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(member.stugbyId, member.nodeId, member.displayName, member.role, member.state,
          member.publicKey, member.keyFingerprint, member.joinedAt, member.updatedAt);
      this.db.prepare(`INSERT INTO stugby_join_admissions
        (invitation_id,stugby_id,node_id,public_key,admitted_at) VALUES (?,?,?,?,?)`)
        .run(row.id, row.stugby_id, identity.nodeId, identity.publicKey, now);
      this.audit(row.stugby_id, "member.joined", member.nodeId, member.nodeId, { role: member.role }, now);
      this.db.exec("COMMIT");
      return {
        status: "accepted",
        invitation: { ...invitationFromRow(row), usedAt: now },
        member,
        provisioned: false,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markInvitationProvisioned(invitationId: string, nodeId: string, now = new Date().toISOString()): void {
    this.db.prepare(`UPDATE stugby_join_admissions SET provisioned_at=COALESCE(provisioned_at,?)
      WHERE invitation_id=? AND node_id=?`).run(now, invitationId, nodeId);
  }

  revokeInvitation(stugbyId: string, invitationId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE stugby_invitations SET revoked_at=? WHERE id=? AND stugby_id=? AND used_at IS NULL")
      .run(now, invitationId, stugbyId);
    this.audit(stugbyId, "invitation.revoked", this.localNodeId, invitationId, {}, now);
  }

  upsertGrant(grant: StugbyShareGrant): void {
    this.db.prepare(`INSERT INTO stugby_share_grants
      (id,stugby_id,authority_node_id,publication_id,epoch,revision,expires_at,revoked_at,grant_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET publication_id=excluded.publication_id,epoch=excluded.epoch,
        revision=excluded.revision,expires_at=excluded.expires_at,revoked_at=excluded.revoked_at,
        grant_json=excluded.grant_json,updated_at=excluded.updated_at
      WHERE excluded.revision > stugby_share_grants.revision OR excluded.epoch > stugby_share_grants.epoch`)
      .run(grant.id, grant.stugbyId, grant.authorityNodeId, grant.publicationId, grant.epoch, grant.revision,
        grant.expiresAt, grant.revokedAt, JSON.stringify(grant), grant.updatedAt);
    this.db.prepare(`INSERT INTO stugby_publications
      (stugby_id,publication_id,authority_node_id,local_house_id,display_name,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(stugby_id,publication_id) DO UPDATE SET
        local_house_id=excluded.local_house_id,display_name=excluded.display_name,updated_at=excluded.updated_at`)
      .run(grant.stugbyId, grant.publicationId, grant.authorityNodeId, grant.localHouseId ?? null, grant.publicationId, grant.updatedAt);
  }

  publicationId(stugbyId: string, resourceType: "home" | "floor" | "room" | "wall" | "plan-element" | "sensor" | "note" | "observation", localId: string): string {
    const existing = this.db.prepare(`SELECT publication_id FROM stugby_publication_ids
      WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
      .get(stugbyId, this.localNodeId, resourceType, localId) as { publication_id: string } | undefined;
    if (existing) return existing.publication_id;
    const publicationId = randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO stugby_publication_ids
      (stugby_id,authority_node_id,resource_type,local_id,publication_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugbyId, this.localNodeId, resourceType, localId, publicationId, new Date().toISOString());
    return (this.db.prepare(`SELECT publication_id FROM stugby_publication_ids
      WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
      .get(stugbyId, this.localNodeId, resourceType, localId) as { publication_id: string }).publication_id;
  }

  getGrant(id: string): StugbyShareGrant | null {
    const row = this.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE id=?").get(id) as unknown as GrantRow | undefined;
    return row ? JSON.parse(row.grant_json) as StugbyShareGrant : null;
  }

  listGrants(stugbyId: string, authorityNodeId?: string): StugbyShareGrant[] {
    const rows = authorityNodeId
      ? this.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? AND authority_node_id=? ORDER BY updated_at DESC")
        .all(stugbyId, authorityNodeId) as unknown as GrantRow[]
      : this.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? ORDER BY updated_at DESC")
        .all(stugbyId) as unknown as GrantRow[];
    return rows.map((row) => JSON.parse(row.grant_json) as StugbyShareGrant);
  }

  revokeGrant(id: string): StugbyShareGrant {
    const grant = this.getGrant(id);
    if (!grant) throw new Error("Stugby share grant not found");
    if (grant.authorityNodeId !== this.localNodeId) throw new Error("Only the authoritative Stuga can revoke this grant");
    const updated: StugbyShareGrant = {
      ...grant,
      epoch: grant.epoch + 1,
      revision: grant.revision + 1,
      revokedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.upsertGrant(updated);
    return updated;
  }

  getSharedProperty(stugbyId: string): StugbySharedProperty | null {
    const row = this.db.prepare("SELECT property_json FROM stugby_shared_properties WHERE stugby_id=?")
      .get(stugbyId) as unknown as SharedPropertyRow | undefined;
    return row ? JSON.parse(row.property_json) as StugbySharedProperty : null;
  }

  saveSharedProperty(property: StugbySharedProperty, expectedRevision?: number): StugbySharedProperty {
    const existing = this.getSharedProperty(property.stugbyId);
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) {
      throw new Error(`Stugby shared property revision conflict; current revision is ${existing?.revision ?? 0}`);
    }
    this.db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(stugby_id) DO UPDATE SET revision=excluded.revision,property_json=excluded.property_json,updated_at=excluded.updated_at
      WHERE excluded.revision > stugby_shared_properties.revision`)
      .run(property.stugbyId, property.revision, JSON.stringify(property), property.updatedAt);
    return this.getSharedProperty(property.stugbyId)!;
  }

  nextSequence(stugbyId: string, streamId: string): number {
    this.db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
      VALUES (?,?,?,0) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO NOTHING`)
      .run(stugbyId, this.localNodeId, streamId);
    this.db.prepare(`UPDATE stugby_stream_sequences SET sequence=sequence+1
      WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`).run(stugbyId, this.localNodeId, streamId);
    return Number((this.db.prepare(`SELECT sequence FROM stugby_stream_sequences
      WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
      .get(stugbyId, this.localNodeId, streamId) as { sequence: number }).sequence);
  }

  reserveLiveTelemetrySample(stugbyId: string, grantId: string, utcHour: string, maximum: number): boolean {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO stugby_live_telemetry_usage
      (stugby_id,grant_id,utc_hour,sample_count,updated_at) VALUES (?,?,?,0,?)`)
      .run(stugbyId, grantId, utcHour, now);
    const result = this.db.prepare(`UPDATE stugby_live_telemetry_usage
      SET sample_count=sample_count+1,updated_at=?
      WHERE stugby_id=? AND grant_id=? AND utc_hour=? AND sample_count<?`)
      .run(now, stugbyId, grantId, utcHour, maximum);
    return Number(result.changes) === 1;
  }

  enqueueOutbox(stugbyId: string, destinationNodeId: string, event: StugbySignedEvent): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO stugby_outbox
      (stugby_id,destination_node_id,event_id,event_json,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugbyId, destinationNodeId, event.eventId, JSON.stringify(event), now, now);
  }

  dueOutbox(limit = 100): StugbyOutboxItem[] {
    const rows = this.db.prepare(`SELECT id,stugby_id,destination_node_id,event_json,attempts FROM stugby_outbox
      WHERE next_attempt_at<=? ORDER BY id LIMIT ?`).all(new Date().toISOString(), boundedLimit(limit, 100, 250)) as unknown as OutboxRow[];
    return rows.map((row) => ({
      id: row.id,
      stugbyId: row.stugby_id,
      destinationNodeId: row.destination_node_id,
      event: JSON.parse(row.event_json) as StugbySignedEvent,
      attempts: row.attempts,
    }));
  }

  acknowledgeOutbox(ids: number[]): void {
    const statement = this.db.prepare("DELETE FROM stugby_outbox WHERE id=?");
    for (const id of ids) statement.run(id);
  }

  discardOutboxGrantEpoch(stugbyId: string, grantId: string, throughEpoch: number): void {
    this.db.prepare(`DELETE FROM stugby_outbox WHERE stugby_id=?
      AND json_extract(event_json,'$.grantId')=?
      AND COALESCE(json_extract(event_json,'$.grantEpoch'),0)<=?`)
      .run(stugbyId, grantId, throughEpoch);
  }

  failOutbox(id: number, attempts: number): void {
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
    this.db.prepare("UPDATE stugby_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() + delayMs).toISOString(), id);
  }

  inboxEventStatus(event: StugbySignedEvent): "new" | "duplicate" | "non-monotonic" {
    const duplicate = this.db.prepare("SELECT 1 AS present FROM stugby_inbox WHERE authority_node_id=? AND event_id=?")
      .get(event.authorityNodeId, event.eventId) as { present: number } | undefined;
    if (duplicate) return "duplicate";
    const current = this.db.prepare(`SELECT sequence FROM stugby_stream_sequences
      WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
      .get(event.stugbyId, event.authorityNodeId, event.streamId) as { sequence: number } | undefined;
    return current && event.sequence <= current.sequence ? "non-monotonic" : "new";
  }

  recordInboxEvent(event: StugbySignedEvent): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("INSERT OR IGNORE INTO stugby_inbox(authority_node_id,event_id,received_at) VALUES (?,?,?)")
        .run(event.authorityNodeId, event.eventId, new Date().toISOString());
      if (Number(result.changes) === 1) {
        this.db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
          VALUES (?,?,?,?) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO UPDATE SET sequence=excluded.sequence
          WHERE excluded.sequence > stugby_stream_sequences.sequence`)
          .run(event.stugbyId, event.authorityNodeId, event.streamId, event.sequence);
      }
      this.db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendEventForMember(stugbyId: string, targetNodeId: string, event: StugbySignedEvent): number | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO stugby_event_log
      (stugby_id,target_node_id,event_id,event_json,created_at) VALUES (?,?,?,?,?)`)
      .run(stugbyId, targetNodeId, event.eventId, JSON.stringify(event), now);
    if (Number(result.changes) === 0) return null;
    return Number((this.db.prepare("SELECT cursor FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND event_id=?")
      .get(stugbyId, targetNodeId, event.eventId) as { cursor: number }).cursor);
  }

  eventPage(stugbyId: string, targetNodeId: string, afterCursor: number, limit = 100): StugbyEventLogPage {
    const pageSize = boundedLimit(limit, 100, 250);
    const rows = this.db.prepare(`SELECT cursor,event_json FROM stugby_event_log
      WHERE stugby_id=? AND target_node_id=? AND cursor>? ORDER BY cursor LIMIT ?`)
      .iterate(stugbyId, targetNodeId, Math.max(0, afterCursor), pageSize + 1) as NodeJS.Iterator<{
        cursor: number;
        event_json: string;
      }>;
    const selected: Array<{ cursor: number; event_json: string }> = [];
    let encodedBytes = 0;
    let hasMore = false;
    for (const row of rows) {
      if (selected.length >= pageSize) {
        hasMore = true;
        break;
      }
      const nextBytes = Buffer.byteLength(row.event_json) + (selected.length > 0 ? 1 : 0);
      if (selected.length > 0 && encodedBytes + nextBytes > STUGBY_MAX_EVENT_PAGE_BYTES) {
        hasMore = true;
        break;
      }
      selected.push(row);
      encodedBytes += nextBytes;
    }
    return {
      events: selected.map((row) => JSON.parse(row.event_json) as StugbySignedEvent),
      cursor: selected.at(-1)?.cursor ?? afterCursor,
      hasMore,
    };
  }

  applyDatasetEvent(event: StugbySignedEvent): { applied: boolean; deletionReceipt?: StugbyDeletionReceipt } {
    if (!event.grantId || event.grantEpoch === null) throw new Error("Dataset events require a grant and epoch");
    const grant = this.getGrant(event.grantId);
    if (!grant || grant.epoch !== event.grantEpoch || grant.revokedAt
      || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())) {
      throw new Error("Dataset event refers to an inactive or superseded grant epoch");
    }
    if (grant.stugbyId !== event.stugbyId || grant.authorityNodeId !== event.authorityNodeId) throw new Error("Dataset grant authority mismatch");
    const datasetGrant = grant.datasets.find((item) => item.dataset === event.schema && item.enabled);
    if (!datasetGrant) throw new Error("Dataset is not enabled by this grant");
    const existing = this.db.prepare(`SELECT revision FROM stugby_remote_resources
      WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?`)
      .get(event.stugbyId, event.authorityNodeId, event.schema, event.resourceId) as { revision: number } | undefined;
    if (existing && existing.revision >= event.revision) return { applied: false };
    if (event.operation === "tombstone") {
      this.db.prepare(`DELETE FROM stugby_remote_resources WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?`)
        .run(event.stugbyId, event.authorityNodeId, event.schema, event.resourceId);
      if (event.schema === "home.telemetry.v1") {
        this.db.prepare(`DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND authority_node_id=? AND grant_id=?`)
          .run(event.stugbyId, event.authorityNodeId, event.grantId);
      }
      return { applied: true };
    }
    // A zero retention or disabled replica-cache permission means the event may
    // wake live consumers but must not be written to the durable projection.
    if (!datasetGrant.allowReplicaCache || datasetGrant.retentionDays === 0) return { applied: true };
    const receivedAt = new Date().toISOString();
    if (event.schema === "home.telemetry.v1") {
      this.insertTelemetry(event, event.payload as unknown as StugbyTelemetryPayload, receivedAt);
      return { applied: true };
    }
    const payload = event.payload as Record<string, JsonValue>;
    const publicationId = String(payload.publicationId);
    this.db.prepare(`INSERT INTO stugby_remote_resources
      (stugby_id,authority_node_id,schema_name,resource_id,publication_id,grant_id,grant_epoch,revision,payload_json,received_at,source_occurred_at,stale)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(stugby_id,authority_node_id,schema_name,resource_id) DO UPDATE SET
        publication_id=excluded.publication_id,grant_id=excluded.grant_id,grant_epoch=excluded.grant_epoch,
        revision=excluded.revision,payload_json=excluded.payload_json,received_at=excluded.received_at,
        source_occurred_at=excluded.source_occurred_at,stale=0 WHERE excluded.revision>stugby_remote_resources.revision`)
      .run(event.stugbyId, event.authorityNodeId, event.schema, event.resourceId, publicationId, event.grantId,
        event.grantEpoch, event.revision, JSON.stringify(event.payload), receivedAt, event.occurredAt);
    return { applied: true };
  }

  private insertTelemetry(event: StugbySignedEvent, payload: StugbyTelemetryPayload, receivedAt: string): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM stugby_remote_telemetry
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=? AND chunk_id=?`)
        .run(event.stugbyId, event.authorityNodeId, payload.publicationId, event.grantId, event.grantEpoch, payload.chunkId);
      const statement = this.db.prepare(`INSERT INTO stugby_remote_telemetry
        (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
         metric_id,timestamp,value,quality,correction_of,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const sample of payload.samples) {
        statement.run(event.stugbyId, event.authorityNodeId, payload.publicationId, event.grantId, event.grantEpoch,
          payload.chunkId, sample.sensorPublicationId, sample.metricId, sample.timestamp, sample.value, sample.quality,
          sample.correctionOf ?? null, receivedAt);
      }
    });
  }

  purgeGrantData(stugbyId: string, grantId: string, grantEpoch: number): StugbyDeletionReceipt {
    this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
      .run(stugbyId, grantId, grantEpoch);
    this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
      .run(stugbyId, grantId, grantEpoch);
    const receipt: StugbyDeletionReceipt = {
      stugbyId,
      nodeId: this.localNodeId,
      grantId,
      grantEpoch,
      deletedAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT OR REPLACE INTO stugby_deletion_receipts
      (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
      .run(receipt.stugbyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
    return receipt;
  }

  listRemoteResources(stugbyId: string): StugbyRemoteResource[] {
    const rows = this.db.prepare(`SELECT stugby_id,authority_node_id,schema_name,resource_id,publication_id,revision,
      payload_json,received_at,source_occurred_at,stale FROM stugby_remote_resources WHERE stugby_id=?
      ORDER BY authority_node_id,publication_id,schema_name`).all(stugbyId) as unknown as Array<{
        stugby_id: string; authority_node_id: string; schema_name: StugbyDataset; resource_id: string;
        publication_id: string; revision: number; payload_json: string; received_at: string;
        source_occurred_at: string; stale: number;
      }>;
    return rows.map((row) => ({
      stugbyId: row.stugby_id,
      authorityNodeId: row.authority_node_id,
      schema: row.schema_name,
      resourceId: row.resource_id,
      publicationId: row.publication_id,
      revision: row.revision,
      payload: JSON.parse(row.payload_json) as JsonValue,
      receivedAt: row.received_at,
      sourceOccurredAt: row.source_occurred_at,
      stale: Boolean(row.stale),
    }));
  }

  remoteTelemetry(query: RemoteTelemetryQuery): Array<Record<string, string | number | null>> {
    const clauses = ["stugby_id=?"];
    const parameters: Array<string | number> = [query.stugbyId];
    for (const [column, value] of [
      ["authority_node_id", query.authorityNodeId],
      ["publication_id", query.publicationId],
      ["sensor_publication_id", query.sensorPublicationId],
      ["metric_id", query.metricId],
    ] as const) {
      if (value) { clauses.push(`${column}=?`); parameters.push(value); }
    }
    if (query.from) { clauses.push("timestamp>=?"); parameters.push(query.from); }
    if (query.to) { clauses.push("timestamp<=?"); parameters.push(query.to); }
    parameters.push(boundedLimit(query.limit, 5_000, 25_000));
    return this.db.prepare(`SELECT authority_node_id AS authorityNodeId,publication_id AS publicationId,
      sensor_publication_id AS sensorPublicationId,metric_id AS metricId,timestamp,value,quality,correction_of AS correctionOf
      FROM stugby_remote_telemetry WHERE ${clauses.join(" AND ")} ORDER BY timestamp LIMIT ?`)
      .all(...parameters) as unknown as Array<Record<string, string | number | null>>;
  }

  markRemoteStale(stugbyId: string): void {
    this.db.prepare("UPDATE stugby_remote_resources SET stale=1 WHERE stugby_id=?").run(stugbyId);
  }

  markRemoteCurrent(stugbyId: string): void {
    this.db.prepare("UPDATE stugby_remote_resources SET stale=0 WHERE stugby_id=?").run(stugbyId);
  }

  purgeDepartedReplicas(stugbyId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=?").run(stugbyId);
      this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=?").run(stugbyId);
      this.db.prepare("DELETE FROM stugby_shared_properties WHERE stugby_id=?").run(stugbyId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enforceRetention(stugbyId: string): void {
    const now = Date.now();
    for (const grant of this.listGrants(stugbyId)) {
      if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= now)) {
        this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=?").run(stugbyId, grant.id);
        this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugbyId, grant.id);
        continue;
      }
      for (const dataset of grant.datasets) {
        if (!dataset.enabled || !dataset.allowReplicaCache || dataset.retentionDays === 0) {
          this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND schema_name=?")
            .run(stugbyId, grant.id, dataset.dataset);
          if (dataset.dataset === "home.telemetry.v1") {
            this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugbyId, grant.id);
          }
          continue;
        }
        const cutoff = new Date(now - dataset.retentionDays * 86_400_000).toISOString();
        this.db.prepare(`DELETE FROM stugby_remote_resources
          WHERE stugby_id=? AND grant_id=? AND schema_name=? AND received_at<?`)
          .run(stugbyId, grant.id, dataset.dataset, cutoff);
        if (dataset.dataset === "home.telemetry.v1") {
          this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND received_at<?")
            .run(stugbyId, grant.id, cutoff);
        }
      }
    }
  }

  pullCursor(stugbyId: string): number {
    return Number((this.db.prepare("SELECT pull_cursor FROM stugby_federations WHERE id=?").get(stugbyId) as { pull_cursor?: number } | undefined)?.pull_cursor ?? 0);
  }

  recordSync(stugbyId: string, cursor: number, error: string | null): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE stugby_federations SET pull_cursor=max(pull_cursor,?),
      last_sync_at=CASE WHEN ? IS NULL THEN ? ELSE last_sync_at END,last_sync_error=?,updated_at=? WHERE id=?`)
      .run(cursor, error, now, error, now, stugbyId);
    if (error) this.markRemoteStale(stugbyId);
  }

  acceptRequest(nodeId: string, requestId: string, expiresAt: string): boolean {
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM stugby_request_replays WHERE expires_at<=?").run(now);
    const result = this.db.prepare("INSERT OR IGNORE INTO stugby_request_replays(node_id,request_id,expires_at) VALUES (?,?,?)")
      .run(nodeId, requestId, expiresAt);
    return Number(result.changes) === 1;
  }

  registerBlob(digest: string, byteLength: number, mediaType: string, relativePath: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_metadata(digest,byte_length,media_type,relative_path,created_at)
      VALUES (?,?,?,?,?)`).run(digest, byteLength, mediaType, relativePath, new Date().toISOString());
  }

  getBlob(digest: string): { digest: string; byteLength: number; mediaType: string; relativePath: string } | null {
    const row = this.db.prepare(`SELECT digest,byte_length AS byteLength,media_type AS mediaType,relative_path AS relativePath
      FROM stugby_blob_metadata WHERE digest=?`).get(digest) as unknown as { digest: string; byteLength: number; mediaType: string; relativePath: string } | undefined;
    return row ?? null;
  }

  grantBlobAccess(stugbyId: string, digest: string, nodeId: string, grantId: string, grantEpoch: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_access
      (stugby_id,digest,node_id,grant_id,grant_epoch,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugbyId, digest, nodeId, grantId, grantEpoch, new Date().toISOString());
  }

  registerBlobReference(stugbyId: string, digest: string, grantId: string, grantEpoch: number, kind: "local" | "relay" | "replica"): void {
    this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_references
      (stugby_id,digest,grant_id,grant_epoch,kind,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugbyId, digest, grantId, grantEpoch, kind, new Date().toISOString());
  }

  canReadBlob(stugbyId: string, digest: string, nodeId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM stugby_blob_access access
      JOIN stugby_share_grants grant ON grant.id=access.grant_id
      WHERE access.stugby_id=? AND access.digest=? AND access.node_id=?
        AND ((grant.epoch=access.grant_epoch AND grant.revoked_at IS NULL
              AND (grant.expires_at IS NULL OR julianday(grant.expires_at)>julianday(?)))
          OR EXISTS (SELECT 1 FROM stugby_pending_deletions pending
            WHERE pending.stugby_id=access.stugby_id AND pending.node_id=access.node_id
              AND pending.grant_id=access.grant_id AND pending.grant_epoch>access.grant_epoch
              AND pending.acknowledged_at IS NULL)) LIMIT 1`)
      .get(stugbyId, digest, nodeId, new Date().toISOString()));
  }

  acknowledgeEventCursor(stugbyId: string, nodeId: string, cursor: number): string[] {
    if (cursor <= 0) return [];
    const rows = this.db.prepare(`SELECT event_json FROM stugby_event_log
      WHERE stugby_id=? AND target_node_id=? AND cursor<=?`).all(stugbyId, nodeId, cursor) as unknown as Array<{ event_json: string }>;
    const floorEvents = rows.map((row) => JSON.parse(row.event_json) as StugbySignedEvent)
      .filter((event) => event.schema === "home.floorplan.v1" && event.operation === "upsert" && event.grantId && event.grantEpoch !== null);
    const released = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND cursor<=?")
        .run(stugbyId, nodeId, cursor);
      for (const event of floorEvents) {
        const payload = event.payload as unknown as { assets: Array<{ image: { digest: string } }> };
        for (const asset of payload.assets) {
          this.db.prepare(`DELETE FROM stugby_blob_access
            WHERE stugby_id=? AND digest=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
            .run(stugbyId, asset.image.digest, nodeId, event.grantId, event.grantEpoch);
          released.add(asset.image.digest);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const event of floorEvents) this.releaseRelayReferencesWithoutAccess(stugbyId, event.grantId!, event.grantEpoch!);
    return [...released].filter((digest) => !this.hasBlobReferences(digest));
  }

  releaseRelayReferencesWithoutAccess(stugbyId: string, grantId: string, beforeOrAtEpoch: number): string[] {
    const rows = this.db.prepare(`SELECT digest,grant_epoch FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='relay' AND grant_epoch<=?`)
      .all(stugbyId, grantId, beforeOrAtEpoch) as unknown as Array<{ digest: string; grant_epoch: number }>;
    const released = new Set<string>();
    for (const row of rows) {
      const inUse = this.db.prepare(`SELECT 1 FROM stugby_blob_access
        WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? LIMIT 1`)
        .get(stugbyId, row.digest, grantId, row.grant_epoch);
      if (inUse) continue;
      this.db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='relay'`)
        .run(stugbyId, row.digest, grantId, row.grant_epoch);
      released.add(row.digest);
    }
    return [...released].filter((digest) => !this.hasBlobReferences(digest));
  }

  purgeReplicaBlobReferences(stugbyId: string, grantId: string, beforeEpoch: number): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
      .all(stugbyId, grantId, beforeEpoch) as unknown as Array<{ digest: string }>;
    this.db.prepare(`DELETE FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
      .run(stugbyId, grantId, beforeEpoch);
    return rows.map((row) => row.digest).filter((digest) => !this.hasBlobReferences(digest));
  }

  reconcileReplicaBlobReferences(stugbyId: string): string[] {
    const retained = new Set<string>();
    const resources = this.db.prepare(`SELECT grant_id,grant_epoch,payload_json FROM stugby_remote_resources
      WHERE stugby_id=? AND schema_name='home.floorplan.v1'`).all(stugbyId) as unknown as Array<{
        grant_id: string; grant_epoch: number; payload_json: string;
      }>;
    for (const resource of resources) {
      const payload = JSON.parse(resource.payload_json) as { assets?: Array<{ image?: { digest?: string } }> };
      for (const asset of payload.assets ?? []) {
        if (asset.image?.digest) retained.add(`${resource.grant_id}\n${resource.grant_epoch}\n${asset.image.digest}`);
      }
    }
    const references = this.db.prepare(`SELECT digest,grant_id,grant_epoch FROM stugby_blob_references
      WHERE stugby_id=? AND kind='replica'`).all(stugbyId) as unknown as Array<{ digest: string; grant_id: string; grant_epoch: number }>;
    const released = new Set<string>();
    for (const reference of references) {
      if (retained.has(`${reference.grant_id}\n${reference.grant_epoch}\n${reference.digest}`)) continue;
      this.db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='replica'`)
        .run(stugbyId, reference.digest, reference.grant_id, reference.grant_epoch);
      released.add(reference.digest);
    }
    return [...released].filter((digest) => !this.hasBlobReferences(digest));
  }

  retireLocalBlobReferences(stugbyId: string, grantId: string, throughEpoch: number): void {
    const rows = this.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
      .all(stugbyId, grantId, throughEpoch) as unknown as Array<{ digest: string }>;
    this.db.prepare(`DELETE FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
      .run(stugbyId, grantId, throughEpoch);
    const queuedAt = new Date().toISOString();
    for (const { digest } of rows) {
      if (this.hasBlobReferences(digest)) continue;
      this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)`)
        .run(digest, queuedAt);
    }
  }

  hasBlobReferences(digest: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM stugby_blob_references WHERE digest=?
      UNION ALL SELECT 1 FROM stugby_blob_access WHERE digest=? LIMIT 1`).get(digest, digest));
  }

  unregisterBlob(digest: string): void {
    this.db.prepare("DELETE FROM stugby_blob_metadata WHERE digest=?").run(digest);
    this.db.prepare("DELETE FROM stugby_blob_deletion_queue WHERE digest=?").run(digest);
  }

  pendingBlobDeletions(limit = 100): string[] {
    return (this.db.prepare("SELECT digest FROM stugby_blob_deletion_queue ORDER BY queued_at,digest LIMIT ?")
      .all(boundedLimit(limit, 100, 1_000)) as unknown as Array<{ digest: string }>).map((row) => row.digest);
  }

  unreferencedBlobBytes(): number {
    return Number((this.db.prepare(`SELECT COALESCE(sum(byte_length),0) AS bytes FROM stugby_blob_metadata metadata
      WHERE NOT EXISTS (SELECT 1 FROM stugby_blob_references reference WHERE reference.digest=metadata.digest)
        AND NOT EXISTS (SELECT 1 FROM stugby_blob_access access WHERE access.digest=metadata.digest)`)
      .get() as { bytes: number }).bytes);
  }

  staleUnreferencedBlobs(cutoff: string, limit = 100): string[] {
    return (this.db.prepare(`SELECT digest FROM stugby_blob_metadata metadata
      WHERE metadata.created_at<?
        AND NOT EXISTS (SELECT 1 FROM stugby_blob_references reference WHERE reference.digest=metadata.digest)
        AND NOT EXISTS (SELECT 1 FROM stugby_blob_access access WHERE access.digest=metadata.digest)
      ORDER BY metadata.created_at LIMIT ?`).all(cutoff, boundedLimit(limit, 100, 1_000)) as unknown as Array<{ digest: string }>)
      .map((row) => row.digest);
  }

  listDeletionReceipts(stugbyId: string): StugbyDeletionReceipt[] {
    return this.db.prepare(`SELECT stugby_id AS stugbyId,node_id AS nodeId,grant_id AS grantId,
      grant_epoch AS grantEpoch,deleted_at AS deletedAt FROM stugby_deletion_receipts WHERE stugby_id=? ORDER BY deleted_at DESC`)
      .all(stugbyId) as unknown as StugbyDeletionReceipt[];
  }

  getDeletionReceipt(stugbyId: string, nodeId: string, grantId: string, grantEpoch: number): StugbyDeletionReceipt | null {
    return (this.db.prepare(`SELECT stugby_id AS stugbyId,node_id AS nodeId,grant_id AS grantId,
      grant_epoch AS grantEpoch,deleted_at AS deletedAt FROM stugby_deletion_receipts
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
      .get(stugbyId, nodeId, grantId, grantEpoch) as unknown as StugbyDeletionReceipt | undefined) ?? null;
  }

  expectDeletion(stugbyId: string, nodeId: string, grantId: string, grantEpoch: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO stugby_pending_deletions
      (stugby_id,node_id,grant_id,grant_epoch,created_at) VALUES (?,?,?,?,?)`)
      .run(stugbyId, nodeId, grantId, grantEpoch, new Date().toISOString());
  }

  hasPendingDeletion(stugbyId: string, nodeId: string, grantId: string, grantEpoch: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM stugby_pending_deletions
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=? AND acknowledged_at IS NULL`)
      .get(stugbyId, nodeId, grantId, grantEpoch));
  }

  releaseDeletionBlobAccess(receipt: StugbyDeletionReceipt): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_access
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
      .all(receipt.stugbyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as unknown as Array<{ digest: string }>;
    this.db.prepare(`DELETE FROM stugby_blob_access
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
      .run(receipt.stugbyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
    const candidates = new Set(rows.map((row) => row.digest));
    for (const digest of this.releaseRelayReferencesWithoutAccess(receipt.stugbyId, receipt.grantId, receipt.grantEpoch - 1)) candidates.add(digest);
    return [...candidates].filter((digest) => !this.hasBlobReferences(digest));
  }

  processDeletionReceipt(receipt: StugbyDeletionReceipt): StugbyDeletionReceiptResult {
    return this.transaction(() => {
      const existing = this.getDeletionReceipt(
        receipt.stugbyId,
        receipt.nodeId,
        receipt.grantId,
        receipt.grantEpoch,
      );
      if (existing && existing.deletedAt !== receipt.deletedAt) return "conflict";

      const pending = this.db.prepare(`SELECT acknowledged_at FROM stugby_pending_deletions
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
        .get(receipt.stugbyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as {
          acknowledged_at: string | null;
        } | undefined;
      if (!existing && !pending) return "unexpected";
      if (!existing && pending?.acknowledged_at && pending.acknowledged_at !== receipt.deletedAt) return "conflict";

      const inserted = this.db.prepare(`INSERT OR IGNORE INTO stugby_deletion_receipts
        (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
        .run(receipt.stugbyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
      this.db.prepare(`UPDATE stugby_pending_deletions SET acknowledged_at=COALESCE(acknowledged_at,?)
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
        .run(receipt.deletedAt, receipt.stugbyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
      this.db.prepare(`DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=?
        AND json_extract(event_json,'$.grantId')=?
        AND COALESCE(json_extract(event_json,'$.grantEpoch'),0)<?`)
        .run(receipt.stugbyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
      if (Number(inserted.changes) === 1) {
        this.audit(receipt.stugbyId, "deletion.acknowledged", receipt.nodeId, receipt.grantId,
          { epoch: receipt.grantEpoch }, receipt.deletedAt);
      }
      for (const digest of this.releaseDeletionBlobAccess(receipt)) {
        this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)`)
          .run(digest, new Date().toISOString());
      }
      return existing ? "retry" : "accepted";
    });
  }

  pendingDeletions(stugbyId: string, nodeId: string): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM stugby_pending_deletions
      WHERE stugby_id=? AND node_id=? AND acknowledged_at IS NULL`).get(stugbyId, nodeId) as { count: number }).count);
  }

  audit(stugbyId: string | null, eventType: string, actorNodeId: string | null, subjectId: string | null,
    details: Record<string, string | number | boolean | null>, createdAt = new Date().toISOString()): void {
    this.db.prepare(`INSERT INTO stugby_audit_events(stugby_id,event_type,actor_node_id,subject_id,details_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(stugbyId, eventType, actorNodeId, subjectId, JSON.stringify(details), createdAt);
  }

  listAudit(stugbyId: string, limit = 100): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT id,event_type,actor_node_id,subject_id,details_json,created_at
      FROM stugby_audit_events WHERE stugby_id=? ORDER BY id DESC LIMIT ?`)
      .all(stugbyId, boundedLimit(limit, 100, 500)) as unknown as Array<{
        id: number; event_type: string; actor_node_id: string | null; subject_id: string | null; details_json: string; created_at: string;
      }>).map((row) => ({
        id: row.id,
        eventType: row.event_type,
        actorNodeId: row.actor_node_id,
        subjectId: row.subject_id,
        details: JSON.parse(row.details_json) as Record<string, unknown>,
        createdAt: row.created_at,
      }));
  }

  protocolVersion(): typeof STUGBY_PROTOCOL_VERSION {
    return STUGBY_PROTOCOL_VERSION;
  }
}
