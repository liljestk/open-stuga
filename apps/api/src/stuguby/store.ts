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

interface StugubyRow {
  id: string;
  name: string;
  description: string | null;
  coordinator_node_id: string;
  coordinator_url: string;
  local_role: StugubyRole;
  local_member_state: StugubyMemberState;
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
  local_label: string | null;
  role: StugubyRole;
  state: StugubyMemberState;
  public_key: string;
  key_fingerprint: string;
  joined_at: string | null;
  updated_at: string;
}

interface InvitationRow {
  id: string;
  stugby_id: string;
  local_label: string | null;
  role: Exclude<StugubyRole, "steward">;
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

export interface StugubyOutboxItem {
  id: number;
  stugubyId: string;
  destinationNodeId: string;
  event: StugubySignedEvent;
  attempts: number;
}

export interface StugubyLocalMember extends StugubyMember {
  /** Private to this Stugu installation and never included in federation events. */
  localLabel: string | null;
}

export interface StugubyLocalInvitation extends StugubyInvitation {
  /** Private to the coordinator and copied to its local member roster on admission. */
  localLabel: string | null;
}

export interface StugubyEventLogPage {
  events: StugubySignedEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface StugubyPropertyAdoption {
  stugubyId: string;
  localPropertyId: string;
  state: "adopted" | "detached";
  adoptedAt: string;
  detachedAt: string | null;
  lastMaterializedRevision: number;
}

export interface StugubyStoredPropertyCommand {
  command: StugubyPropertyCommand;
  status: "pending" | "applied" | "conflict" | "cancelled";
  result: StugubyPropertyCommandResult | null;
  attempts: number;
  nextAttemptAt: string;
  updatedAt: string;
}

export interface StugubyStoredHomeCommand {
  command: StugubyHomeCommand;
  status: "pending" | "applied" | "conflict" | "cancelled";
  result: StugubyHomeCommandResult | null;
  attempts: number;
  nextAttemptAt: string;
  updatedAt: string;
}

type ProjectionResourceType =
  | "area" | "equipment" | "note" | "maintenance"
  | "home" | "floor" | "room" | "wall" | "plan-element" | "sensor"
  | "home-note" | "observation" | "asset";

type PublicationResourceType =
  | "home" | "floor" | "room" | "wall" | "plan-element" | "sensor" | "note" | "observation";

export interface StugubyHomeProjection {
  stugubyId: string;
  authorityNodeId: string;
  publicationId: string;
  localHouseId: string;
  editPolicy: "read-only" | "editable";
  recoveryMode: "none" | "full";
  recoveryState: "not-enabled" | "syncing" | "ready" | "incomplete";
  designatedSuccessorNodeId: string | null;
  recoverySyncedThrough: string | null;
  authorityEpoch: number;
  detachedAt: string | null;
  updatedAt: string;
}

export interface StugubyAuthorityTransfer {
  id: string;
  stugubyId: string;
  scope: "property" | "home";
  resourceId: string;
  fromNodeId: string;
  toNodeId: string;
  fromEpoch: number;
  toEpoch: number;
  status: "prepared" | "completed" | "cancelled";
  snapshotHash: string;
  requestedAt: string;
  completedAt: string | null;
}

export type StugubyInvitationAdmission =
  | {
    status: "accepted";
    invitation: StugubyInvitation;
    member: StugubyMember;
    provisioned: boolean;
  }
  | {
    status: "retry";
    invitation: StugubyInvitation;
    member: StugubyMember;
    provisioned: boolean;
  }
  | { status: "invalid" }
  | { status: "node-conflict" };

export type StugubyDeletionReceiptResult = "accepted" | "retry" | "conflict" | "unexpected";

export interface RemoteTelemetryQuery {
  stugubyId: string;
  authorityNodeId?: string;
  publicationId?: string;
  sensorPublicationId?: string;
  metricId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

function memberFromRow(row: MemberRow): StugubyMember {
  return {
    stugubyId: row.stugby_id,
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

function localMemberFromRow(row: MemberRow): StugubyLocalMember {
  return { ...memberFromRow(row), localLabel: row.local_label };
}

function invitationFromRow(row: InvitationRow): StugubyInvitation {
  return {
    id: row.id,
    stugubyId: row.stugby_id,
    role: row.role,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
    coordinatorUrl: row.coordinator_url,
  };
}

function localInvitationFromRow(row: InvitationRow): StugubyLocalInvitation {
  return { ...invitationFromRow(row), localLabel: row.local_label };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback;
}

function resourceBlobDigests(schemaName: string, payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = payload as Record<string, unknown>;
  if (schemaName === "home.floorplan.v1") {
    if (!Array.isArray(value.assets)) return [];
    return value.assets.flatMap((asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) return [];
      const image = (asset as Record<string, unknown>).image;
      if (!image || typeof image !== "object" || Array.isArray(image)) return [];
      const digest = (image as Record<string, unknown>).digest;
      return typeof digest === "string" ? [digest] : [];
    });
  }
  if (schemaName === "home.recovery.v1" && value.kind === "assets") {
    if (!Array.isArray(value.records)) return [];
    return value.records.flatMap((record) => {
      if (!record || typeof record !== "object" || Array.isArray(record)) return [];
      const digest = (record as Record<string, unknown>).digest;
      return typeof digest === "string" ? [digest] : [];
    });
  }
  return [];
}

function eventBlobDigests(event: StugubySignedEvent): string[] {
  return event.operation === "upsert" ? resourceBlobDigests(event.schema, event.payload) : [];
}

export class StugubyStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly localNodeId: string,
    options: { readOnly?: boolean } = {},
  ) {
    if (!options.readOnly) this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stugby_node_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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
        local_label TEXT,
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
        local_label TEXT,
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
      CREATE TABLE IF NOT EXISTS stugby_property_adoptions (
        stugby_id TEXT PRIMARY KEY,
        local_property_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('adopted','detached')),
        adopted_at TEXT NOT NULL,
        detached_at TEXT,
        last_materialized_revision INTEGER NOT NULL CHECK (last_materialized_revision >= 0),
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stugby_property_commands (
        id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        actor_node_id TEXT NOT NULL,
        command_json TEXT NOT NULL CHECK (json_valid(command_json)),
        status TEXT NOT NULL CHECK (status IN ('pending','applied','conflict','cancelled')),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_property_commands_due
        ON stugby_property_commands(stugby_id,status,next_attempt_at,created_at);
      CREATE TABLE IF NOT EXISTS stugby_property_entity_fields (
        stugby_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('property','area','equipment','note','maintenance')),
        entity_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY (stugby_id,entity_kind,entity_id,field_name),
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stugby_property_conflicts (
        command_id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        conflict_json TEXT NOT NULL CHECK (json_valid(conflict_json)),
        detected_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_property_conflicts_open
        ON stugby_property_conflicts(stugby_id,resolved_at,detected_at DESC);
      CREATE TABLE IF NOT EXISTS stugby_home_revisions (
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id,authority_node_id,publication_id),
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stugby_home_commands (
        id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        command_json TEXT NOT NULL CHECK (json_valid(command_json)),
        status TEXT NOT NULL CHECK (status IN ('pending','applied','conflict','cancelled')),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (stugby_id,authority_node_id,publication_id),
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_stugby_home_commands_due
        ON stugby_home_commands(stugby_id,status,next_attempt_at,created_at);
      CREATE TABLE IF NOT EXISTS stugby_projection_ids (
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('area','equipment','note','maintenance','home','floor','room','wall','plan-element','sensor','home-note','observation','asset')),
        remote_id TEXT NOT NULL,
        local_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id,authority_node_id,resource_type,remote_id),
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stugby_home_projections (
        stugby_id TEXT NOT NULL,
        authority_node_id TEXT NOT NULL,
        publication_id TEXT NOT NULL,
        local_house_id TEXT NOT NULL UNIQUE,
        edit_policy TEXT NOT NULL CHECK (edit_policy IN ('read-only','editable')),
        recovery_mode TEXT NOT NULL CHECK (recovery_mode IN ('none','full')),
        recovery_state TEXT NOT NULL CHECK (recovery_state IN ('not-enabled','syncing','ready','incomplete')),
        designated_successor_node_id TEXT,
        recovery_synced_through TEXT,
        authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 1),
        detached_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stugby_id,authority_node_id,publication_id),
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS stugby_authority_transfers (
        id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('property','home')),
        resource_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        from_epoch INTEGER NOT NULL CHECK (from_epoch >= 1),
        to_epoch INTEGER NOT NULL CHECK (to_epoch > from_epoch),
        status TEXT NOT NULL CHECK (status IN ('prepared','completed','cancelled')),
        snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
        requested_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (stugby_id) REFERENCES stugby_federations(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stugby_authority_transfer_epoch
        ON stugby_authority_transfers(stugby_id,scope,resource_id,to_epoch);
      CREATE TABLE IF NOT EXISTS stugby_migration_snapshots (
        id TEXT PRIMARY KEY,
        stugby_id TEXT NOT NULL,
        source_property_id TEXT NOT NULL,
        target_property_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
        created_at TEXT NOT NULL,
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
        media_type TEXT NOT NULL CHECK (media_type IN (
          'image/png','image/jpeg','image/webp','model/gltf+json','model/gltf-binary'
        )),
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
    const memberColumns = new Set((this.db.prepare("PRAGMA table_info(stugby_members)")
      .all() as unknown as Array<{ name: string }>).map((column) => column.name));
    if (!memberColumns.has("local_label")) {
      this.db.exec("ALTER TABLE stugby_members ADD COLUMN local_label TEXT");
    }
    const invitationColumns = new Set((this.db.prepare("PRAGMA table_info(stugby_invitations)")
      .all() as unknown as Array<{ name: string }>).map((column) => column.name));
    if (!invitationColumns.has("local_label")) {
      this.db.exec("ALTER TABLE stugby_invitations ADD COLUMN local_label TEXT");
    }
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

  createCoordinatedStuguby(input: { id?: string; name: string; description?: string | null; coordinatorUrl: string }, identity: StugubyNodeIdentity): StugubySummary {
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
      this.db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)`)
        .run(id, 1, JSON.stringify(property), now);
      this.audit(id, "stuguby.created", identity.nodeId, id, { role: "steward" }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getStuguby(id)!;
  }

  saveJoinedStuguby(summary: StugubySummary, members: StugubyMember[], localMember: StugubyMember): StugubySummary {
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
      this.audit(summary.id, "stuguby.joined", this.localNodeId, summary.id, { role: localMember.role }, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getStuguby(summary.id)!;
  }

  listStugubys(): StugubySummary[] {
    const rows = this.db.prepare("SELECT * FROM stugby_federations ORDER BY name,id").all() as unknown as StugubyRow[];
    return rows.map((row) => this.summaryFromRow(row));
  }

  getNodePublicOrigin(): string | null {
    const row = this.db.prepare("SELECT value FROM stugby_node_settings WHERE key='public-origin'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  setNodePublicOrigin(value: string, now = new Date().toISOString()): number {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO stugby_node_settings(key,value,updated_at) VALUES ('public-origin',?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .run(value, now);
      return this.reconcileUnjoinedCoordinatorOriginsInTransaction(value, now);
    });
  }

  getStuguby(id: string): StugubySummary | null {
    const row = this.db.prepare("SELECT * FROM stugby_federations WHERE id=?").get(id) as unknown as StugubyRow | undefined;
    return row ? this.summaryFromRow(row) : null;
  }

  deleteStuguby(stugubyId: string): string[] {
    return this.transaction(() => {
      const candidates = this.db.prepare(`SELECT digest FROM stugby_blob_references WHERE stugby_id=?
        UNION SELECT digest FROM stugby_blob_access WHERE stugby_id=?`)
        .all(stugubyId, stugubyId) as unknown as Array<{ digest: string }>;

      this.db.prepare("DELETE FROM stugby_join_admissions WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_publications WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_publication_ids WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_stream_sequences WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_live_telemetry_usage WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_outbox WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_event_log WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_blob_access WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_blob_references WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_deletion_receipts WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_pending_deletions WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_audit_events WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_share_grants WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_shared_properties WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_invitations WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_members WHERE stugby_id=?").run(stugubyId);
      const deleted = this.db.prepare("DELETE FROM stugby_federations WHERE id=?").run(stugubyId);
      if (Number(deleted.changes) !== 1) throw new Error("Stuguby was not found");

      const queuedAt = new Date().toISOString();
      const unreferenced = candidates.map((row) => row.digest).filter((digest) => !this.hasBlobReferences(digest));
      for (const digest of unreferenced) {
        this.db.prepare("INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)")
          .run(digest, queuedAt);
      }
      return unreferenced;
    });
  }

  isCoordinator(stugubyId: string): boolean {
    return Boolean((this.db.prepare("SELECT is_coordinator FROM stugby_federations WHERE id=?").get(stugubyId) as { is_coordinator?: number } | undefined)?.is_coordinator);
  }

  reconcileUnjoinedCoordinatorOrigins(coordinatorUrl: string, now = new Date().toISOString()): number {
    return this.transaction(() => this.reconcileUnjoinedCoordinatorOriginsInTransaction(coordinatorUrl, now));
  }

  private reconcileUnjoinedCoordinatorOriginsInTransaction(coordinatorUrl: string, now: string): number {
    const rows = this.db.prepare(`SELECT federation.id,federation.coordinator_url
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
      const invitations = this.db.prepare(`SELECT id FROM stugby_invitations
        WHERE stugby_id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`)
        .all(row.id, now) as unknown as Array<{ id: string }>;
      this.db.prepare("UPDATE stugby_federations SET coordinator_url=?,updated_at=? WHERE id=?")
        .run(coordinatorUrl, now, row.id);
      for (const invitation of invitations) {
        this.db.prepare("UPDATE stugby_invitations SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL")
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
  }

  private summaryFromRow(row: StugubyRow): StugubySummary {
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

  listMembers(stugubyId: string): StugubyMember[] {
    return (this.db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? ORDER BY display_name,node_id")
      .all(stugubyId) as unknown as MemberRow[]).map(memberFromRow);
  }

  listLocalMembers(stugubyId: string): StugubyLocalMember[] {
    return (this.db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? ORDER BY display_name,node_id")
      .all(stugubyId) as unknown as MemberRow[]).map(localMemberFromRow);
  }

  getMember(stugubyId: string, nodeId: string): StugubyMember | null {
    const row = this.db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? AND node_id=?")
      .get(stugubyId, nodeId) as unknown as MemberRow | undefined;
    return row ? memberFromRow(row) : null;
  }

  upsertMember(member: StugubyMember): void {
    this.db.prepare(`INSERT INTO stugby_members
      (stugby_id,node_id,display_name,role,state,public_key,key_fingerprint,joined_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(stugby_id,node_id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,
        state=excluded.state,public_key=excluded.public_key,key_fingerprint=excluded.key_fingerprint,
        joined_at=COALESCE(stugby_members.joined_at,excluded.joined_at),updated_at=excluded.updated_at`)
      .run(member.stugubyId, member.nodeId, member.displayName, member.role, member.state, member.publicKey,
        member.keyFingerprint, member.joinedAt, member.updatedAt);
    if (member.nodeId === this.localNodeId) {
      this.db.prepare(`UPDATE stugby_federations SET local_role=?,local_member_state=?,updated_at=? WHERE id=?`)
        .run(member.role, member.state, member.updatedAt, member.stugubyId);
    }
  }

  updateMember(stugubyId: string, nodeId: string, role: StugubyRole, state: StugubyMemberState): StugubyMember {
    const existing = this.getMember(stugubyId, nodeId);
    if (!existing) throw new Error("Stuguby member not found");
    if (existing.role === "steward" && (role !== "steward" || state !== "active")) throw new Error("The coordinator steward cannot be demoted or revoked");
    const updated = { ...existing, role, state, updatedAt: new Date().toISOString() };
    this.upsertMember(updated);
    this.audit(stugubyId, "member.updated", this.localNodeId, nodeId, { role, state }, updated.updatedAt);
    return updated;
  }

  updateMemberLocalLabel(stugubyId: string, nodeId: string, localLabel: string | null): StugubyLocalMember {
    const changed = this.db.prepare("UPDATE stugby_members SET local_label=? WHERE stugby_id=? AND node_id=?")
      .run(localLabel, stugubyId, nodeId);
    if (Number(changed.changes) !== 1) throw new Error("Stuguby member not found");
    const row = this.db.prepare("SELECT * FROM stugby_members WHERE stugby_id=? AND node_id=?")
      .get(stugubyId, nodeId) as unknown as MemberRow;
    return localMemberFromRow(row);
  }

  createInvitation(input: {
    stugubyId: string;
    localLabel?: string | null;
    role: Exclude<StugubyRole, "steward">;
    secretHash: string;
    expiresAt: string;
    coordinatorUrl: string;
  }): StugubyLocalInvitation {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO stugby_invitations
      (id,stugby_id,local_label,role,secret_hash,expires_at,created_at,coordinator_url) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, input.stugubyId, input.localLabel ?? null, input.role, input.secretHash, input.expiresAt, now, input.coordinatorUrl);
    this.audit(input.stugubyId, "invitation.created", this.localNodeId, id, { role: input.role, expiresAt: input.expiresAt }, now);
    return localInvitationFromRow(this.db.prepare("SELECT * FROM stugby_invitations WHERE id=?").get(id) as unknown as InvitationRow);
  }

  listInvitations(stugubyId: string): StugubyInvitation[] {
    return (this.db.prepare("SELECT * FROM stugby_invitations WHERE stugby_id=? ORDER BY created_at DESC")
      .all(stugubyId) as unknown as InvitationRow[]).map(invitationFromRow);
  }

  listLocalInvitations(stugubyId: string): StugubyLocalInvitation[] {
    return (this.db.prepare("SELECT * FROM stugby_invitations WHERE stugby_id=? ORDER BY created_at DESC")
      .all(stugubyId) as unknown as InvitationRow[]).map(localInvitationFromRow);
  }

  getInvitation(id: string): StugubyInvitation | null {
    const row = this.db.prepare("SELECT * FROM stugby_invitations WHERE id=?")
      .get(id) as unknown as InvitationRow | undefined;
    return row ? invitationFromRow(row) : null;
  }

  admitInvitation(id: string, secretHash: string, identity: StugubyNodeIdentity,
    now = new Date().toISOString()): StugubyInvitationAdmission {
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
      this.db.prepare(`INSERT INTO stugby_members
        (stugby_id,node_id,display_name,local_label,role,state,public_key,key_fingerprint,joined_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(member.stugubyId, member.nodeId, member.displayName, row.local_label, member.role, member.state,
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

  revokeInvitation(stugubyId: string, invitationId: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE stugby_invitations SET revoked_at=? WHERE id=? AND stugby_id=? AND used_at IS NULL")
      .run(now, invitationId, stugubyId);
    this.audit(stugubyId, "invitation.revoked", this.localNodeId, invitationId, {}, now);
  }

  upsertGrant(grant: StugubyShareGrant): void {
    this.db.prepare(`INSERT INTO stugby_share_grants
      (id,stugby_id,authority_node_id,publication_id,epoch,revision,expires_at,revoked_at,grant_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET publication_id=excluded.publication_id,epoch=excluded.epoch,
        revision=excluded.revision,expires_at=excluded.expires_at,revoked_at=excluded.revoked_at,
        grant_json=excluded.grant_json,updated_at=excluded.updated_at
      WHERE excluded.revision > stugby_share_grants.revision OR excluded.epoch > stugby_share_grants.epoch`)
      .run(grant.id, grant.stugubyId, grant.authorityNodeId, grant.publicationId, grant.epoch, grant.revision,
        grant.expiresAt, grant.revokedAt, JSON.stringify(grant), grant.updatedAt);
    this.db.prepare(`INSERT INTO stugby_publications
      (stugby_id,publication_id,authority_node_id,local_house_id,display_name,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(stugby_id,publication_id) DO UPDATE SET
        local_house_id=excluded.local_house_id,display_name=excluded.display_name,updated_at=excluded.updated_at`)
      .run(grant.stugubyId, grant.publicationId, grant.authorityNodeId, grant.localHouseId ?? null, grant.publicationId, grant.updatedAt);
  }

  publicationId(stugubyId: string, resourceType: PublicationResourceType, localId: string): string {
    const existing = this.db.prepare(`SELECT publication_id FROM stugby_publication_ids
      WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
      .get(stugubyId, this.localNodeId, resourceType, localId) as { publication_id: string } | undefined;
    if (existing) return existing.publication_id;
    const publicationId = randomUUID();
    this.db.prepare(`INSERT OR IGNORE INTO stugby_publication_ids
      (stugby_id,authority_node_id,resource_type,local_id,publication_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugubyId, this.localNodeId, resourceType, localId, publicationId, new Date().toISOString());
    return (this.db.prepare(`SELECT publication_id FROM stugby_publication_ids
      WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
      .get(stugubyId, this.localNodeId, resourceType, localId) as { publication_id: string }).publication_id;
  }

  getGrant(id: string): StugubyShareGrant | null {
    const row = this.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE id=?").get(id) as unknown as GrantRow | undefined;
    return row ? JSON.parse(row.grant_json) as StugubyShareGrant : null;
  }

  listGrants(stugubyId: string, authorityNodeId?: string): StugubyShareGrant[] {
    const rows = authorityNodeId
      ? this.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? AND authority_node_id=? ORDER BY updated_at DESC")
        .all(stugubyId, authorityNodeId) as unknown as GrantRow[]
      : this.db.prepare("SELECT grant_json FROM stugby_share_grants WHERE stugby_id=? ORDER BY updated_at DESC")
        .all(stugubyId) as unknown as GrantRow[];
    return rows.map((row) => JSON.parse(row.grant_json) as StugubyShareGrant);
  }

  revokeGrant(id: string): StugubyShareGrant {
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
  }

  getSharedProperty(stugubyId: string): StugubySharedProperty | null {
    const row = this.db.prepare("SELECT property_json FROM stugby_shared_properties WHERE stugby_id=?")
      .get(stugubyId) as unknown as SharedPropertyRow | undefined;
    return row ? JSON.parse(row.property_json) as StugubySharedProperty : null;
  }

  saveSharedProperty(property: StugubySharedProperty, expectedRevision?: number): StugubySharedProperty {
    const existing = this.getSharedProperty(property.stugubyId);
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) {
      throw new Error(`Stuguby shared property revision conflict; current revision is ${existing?.revision ?? 0}`);
    }
    this.db.prepare(`INSERT INTO stugby_shared_properties(stugby_id,revision,property_json,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(stugby_id) DO UPDATE SET revision=excluded.revision,property_json=excluded.property_json,updated_at=excluded.updated_at
      WHERE excluded.revision > stugby_shared_properties.revision`)
      .run(property.stugubyId, property.revision, JSON.stringify(property), property.updatedAt);
    return this.getSharedProperty(property.stugubyId)!;
  }

  getPropertyAdoption(stugubyId: string): StugubyPropertyAdoption | null {
    const row = this.db.prepare("SELECT * FROM stugby_property_adoptions WHERE stugby_id=?")
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
  }

  adoptProperty(stugubyId: string, localPropertyId: string, revision: number, now = new Date().toISOString()): StugubyPropertyAdoption {
    const existing = this.getPropertyAdoption(stugubyId);
    if (existing && existing.localPropertyId !== localPropertyId) {
      throw new Error("This Stuguby is already adopted by another local Property");
    }
    this.db.prepare(`INSERT INTO stugby_property_adoptions
      (stugby_id,local_property_id,state,adopted_at,detached_at,last_materialized_revision)
      VALUES (?,?,'adopted',?,NULL,?)
      ON CONFLICT(stugby_id) DO UPDATE SET state='adopted',detached_at=NULL,
        last_materialized_revision=MAX(stugby_property_adoptions.last_materialized_revision,excluded.last_materialized_revision)`)
      .run(stugubyId, localPropertyId, now, revision);
    return this.getPropertyAdoption(stugubyId)!;
  }

  releaseDetachedProperty(localPropertyId: string, exceptStugubyId: string): number {
    return Number(this.db.prepare(`DELETE FROM stugby_property_adoptions
      WHERE local_property_id=? AND stugby_id<>? AND state='detached'`)
      .run(localPropertyId, exceptStugubyId).changes);
  }

  markPropertyMaterialized(stugubyId: string, revision: number): void {
    this.db.prepare(`UPDATE stugby_property_adoptions
      SET last_materialized_revision=MAX(last_materialized_revision,?) WHERE stugby_id=? AND state='adopted'`)
      .run(revision, stugubyId);
  }

  detachProperty(stugubyId: string, now = new Date().toISOString()): StugubyPropertyAdoption {
    const changed = this.db.prepare(`UPDATE stugby_property_adoptions
      SET state='detached',detached_at=? WHERE stugby_id=? AND state='adopted'`).run(now, stugubyId);
    if (Number(changed.changes) !== 1) throw new Error("An adopted Stuguby Property was not found");
    return this.getPropertyAdoption(stugubyId)!;
  }

  projectionId(
    stugubyId: string,
    authorityNodeId: string,
    resourceType: ProjectionResourceType,
    remoteId: string,
    preferredLocalId?: string,
  ): string {
    const get = (): string | null => {
      const row = this.db.prepare(`SELECT local_id FROM stugby_projection_ids
        WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND remote_id=?`)
        .get(stugubyId, authorityNodeId, resourceType, remoteId) as { local_id: string } | undefined;
      return row?.local_id ?? null;
    };
    const existing = get();
    if (existing) return existing;
    const now = new Date().toISOString();
    const insert = (localId: string): boolean => {
      try {
        this.db.prepare(`INSERT INTO stugby_projection_ids
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
  }

  listProjectionIds(
    stugubyId: string,
    authorityNodeId: string,
    resourceType: ProjectionResourceType,
  ): Array<{ remoteId: string; localId: string }> {
    const rows = this.db.prepare(`SELECT remote_id,local_id FROM stugby_projection_ids
      WHERE stugby_id=? AND authority_node_id=? AND resource_type=? ORDER BY remote_id`)
      .all(stugubyId, authorityNodeId, resourceType) as Array<{ remote_id: string; local_id: string }>;
    return rows.map((row) => ({ remoteId: row.remote_id, localId: row.local_id }));
  }

  projectionRemoteId(
    stugubyId: string,
    authorityNodeId: string,
    resourceType: ProjectionResourceType,
    localId: string,
  ): string {
    const existing = this.db.prepare(`SELECT remote_id FROM stugby_projection_ids
      WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND local_id=?`)
      .get(stugubyId, authorityNodeId, resourceType, localId) as { remote_id: string } | undefined;
    if (existing) return existing.remote_id;
    const remoteId = randomUUID();
    const allocated = this.projectionId(stugubyId, authorityNodeId, resourceType, remoteId, localId);
    if (allocated !== localId) throw new Error("Could not bind the local Home item to its shared id");
    return remoteId;
  }

  publicationLocalId(
    stugubyId: string,
    authorityNodeId: string,
    resourceType: PublicationResourceType,
    publicationId: string,
    create = false,
  ): string | null {
    const existing = this.db.prepare(`SELECT local_id FROM stugby_publication_ids
      WHERE stugby_id=? AND authority_node_id=? AND resource_type=? AND publication_id=?`)
      .get(stugubyId, authorityNodeId, resourceType, publicationId) as { local_id: string } | undefined;
    if (existing) return existing.local_id;
    if (!create) return null;
    const localId = randomUUID();
    this.db.prepare(`INSERT INTO stugby_publication_ids
      (stugby_id,authority_node_id,resource_type,local_id,publication_id,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugubyId, authorityNodeId, resourceType, localId, publicationId, new Date().toISOString());
    return localId;
  }

  enqueuePropertyCommand(command: StugubyPropertyCommand): StugubyStoredPropertyCommand {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO stugby_property_commands
      (id,stugby_id,actor_node_id,command_json,status,result_json,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,'pending',NULL,0,?,?,?)
      ON CONFLICT(id) DO UPDATE SET command_json=excluded.command_json,
        attempts=0,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at
      WHERE stugby_property_commands.status='pending'`)
      .run(command.id, command.stugubyId, command.actorNodeId, JSON.stringify(command), now, command.createdAt, now);
    return this.getPropertyCommand(command.id)!;
  }

  pendingPropertyCommandFor(
    stugubyId: string,
    actorNodeId: string,
    entityKind: StugubyPropertyEntityKind,
    entityId: string,
  ): StugubyStoredPropertyCommand | null {
    const row = this.db.prepare(`SELECT id FROM stugby_property_commands
      WHERE stugby_id=? AND actor_node_id=? AND status='pending'
        AND json_extract(command_json,'$.entityKind')=?
        AND json_extract(command_json,'$.entityId')=?
      ORDER BY created_at DESC,id DESC LIMIT 1`)
      .get(stugubyId, actorNodeId, entityKind, entityId) as { id: string } | undefined;
    return row ? this.getPropertyCommand(row.id) : null;
  }

  getPropertyCommand(commandId: string): StugubyStoredPropertyCommand | null {
    const row = this.db.prepare("SELECT * FROM stugby_property_commands WHERE id=?").get(commandId) as {
      command_json: string;
      status: StugubyStoredPropertyCommand["status"];
      result_json: string | null;
      attempts: number;
      next_attempt_at: string;
      updated_at: string;
    } | undefined;
    return row ? {
      command: JSON.parse(row.command_json) as StugubyPropertyCommand,
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) as StugubyPropertyCommandResult : null,
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at,
      updatedAt: row.updated_at,
    } : null;
  }

  pendingPropertyCommands(stugubyId: string, limit = 100): StugubyStoredPropertyCommand[] {
    const rows = this.db.prepare(`SELECT id FROM stugby_property_commands
      WHERE stugby_id=? AND status='pending' AND next_attempt_at<=?
      ORDER BY created_at,id LIMIT ?`).all(stugubyId, new Date().toISOString(), boundedLimit(limit, 100, 250)) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const command = this.getPropertyCommand(row.id);
      return command ? [command] : [];
    });
  }

  propertyCommandCounts(stugubyId: string): { pending: number; conflicts: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='conflict' THEN 1 ELSE 0 END) AS conflicts
      FROM stugby_property_commands WHERE stugby_id=?`).get(stugubyId) as { pending: number | null; conflicts: number | null };
    return { pending: Number(row.pending ?? 0), conflicts: Number(row.conflicts ?? 0) };
  }

  deferPropertyCommand(commandId: string, attempts: number, nextAttemptAt: string): void {
    this.db.prepare(`UPDATE stugby_property_commands SET attempts=?,next_attempt_at=?,updated_at=?
      WHERE id=? AND status='pending'`).run(attempts, nextAttemptAt, new Date().toISOString(), commandId);
  }

  cancelPendingPropertyCommands(stugubyId: string, now = new Date().toISOString()): number {
    return Number(this.db.prepare(`UPDATE stugby_property_commands SET status='cancelled',updated_at=?
      WHERE stugby_id=? AND status='pending'`).run(now, stugubyId).changes);
  }

  completePropertyCommand(result: StugubyPropertyCommandResult): StugubyStoredPropertyCommand {
    const now = new Date().toISOString();
    const changed = this.db.prepare(`UPDATE stugby_property_commands
      SET status=?,result_json=?,updated_at=? WHERE id=?`)
      .run(result.status, JSON.stringify(result), now, result.commandId);
    if (Number(changed.changes) !== 1) throw new Error("Property command was not found");
    if (result.conflict) {
      this.db.prepare(`INSERT INTO stugby_property_conflicts
        (command_id,stugby_id,conflict_json,detected_at,resolved_at) VALUES (?,?,?,?,NULL)
        ON CONFLICT(command_id) DO UPDATE SET conflict_json=excluded.conflict_json,
          detected_at=excluded.detected_at,resolved_at=NULL`)
        .run(result.commandId, result.property.stugubyId, JSON.stringify(result.conflict), result.conflict.detectedAt);
    }
    return this.getPropertyCommand(result.commandId)!;
  }

  homeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO stugby_home_revisions
      (stugby_id,authority_node_id,publication_id,revision,updated_at) VALUES (?,?,?,1,?)`)
      .run(stugubyId, authorityNodeId, publicationId, now);
    return Number((this.db.prepare(`SELECT revision FROM stugby_home_revisions
      WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
      .get(stugubyId, authorityNodeId, publicationId) as { revision: number }).revision);
  }

  bumpHomeRevision(stugubyId: string, authorityNodeId: string, publicationId: string): number {
    this.homeRevision(stugubyId, authorityNodeId, publicationId);
    this.db.prepare(`UPDATE stugby_home_revisions SET revision=revision+1,updated_at=?
      WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
      .run(new Date().toISOString(), stugubyId, authorityNodeId, publicationId);
    return this.homeRevision(stugubyId, authorityNodeId, publicationId);
  }

  pendingHomeCommandFor(
    stugubyId: string,
    authorityNodeId: string,
    publicationId: string,
  ): StugubyStoredHomeCommand | null {
    const row = this.db.prepare(`SELECT id FROM stugby_home_commands
      WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND status='pending'`)
      .get(stugubyId, authorityNodeId, publicationId) as { id: string } | undefined;
    return row ? this.getHomeCommand(row.id) : null;
  }

  enqueueHomeCommand(command: StugubyHomeCommand): StugubyStoredHomeCommand {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO stugby_home_commands
      (id,stugby_id,authority_node_id,publication_id,command_json,status,result_json,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',NULL,0,?,?,?)
      ON CONFLICT(stugby_id,authority_node_id,publication_id) DO UPDATE SET
        id=excluded.id,command_json=excluded.command_json,status='pending',result_json=NULL,
        attempts=0,next_attempt_at=excluded.next_attempt_at,created_at=excluded.created_at,updated_at=excluded.updated_at`)
      .run(command.id, command.stugubyId, command.authorityNodeId, command.publicationId,
        JSON.stringify(command), now, command.createdAt, now);
    return this.getHomeCommand(command.id)!;
  }

  getHomeCommand(commandId: string): StugubyStoredHomeCommand | null {
    const row = this.db.prepare("SELECT * FROM stugby_home_commands WHERE id=?").get(commandId) as {
      command_json: string;
      status: StugubyStoredHomeCommand["status"];
      result_json: string | null;
      attempts: number;
      next_attempt_at: string;
      updated_at: string;
    } | undefined;
    return row ? {
      command: JSON.parse(row.command_json) as StugubyHomeCommand,
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) as StugubyHomeCommandResult : null,
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at,
      updatedAt: row.updated_at,
    } : null;
  }

  pendingHomeCommands(stugubyId: string, limit = 100): StugubyStoredHomeCommand[] {
    const rows = this.db.prepare(`SELECT id FROM stugby_home_commands
      WHERE stugby_id=? AND status='pending' AND next_attempt_at<=?
      ORDER BY created_at,id LIMIT ?`).all(stugubyId, new Date().toISOString(), boundedLimit(limit, 100, 250)) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const command = this.getHomeCommand(row.id);
      return command ? [command] : [];
    });
  }

  homeCommandCounts(stugubyId: string): { pending: number; conflicts: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='conflict' THEN 1 ELSE 0 END) AS conflicts
      FROM stugby_home_commands WHERE stugby_id=?`).get(stugubyId) as { pending: number | null; conflicts: number | null };
    return { pending: Number(row.pending ?? 0), conflicts: Number(row.conflicts ?? 0) };
  }

  homeCommandCountsFor(
    stugubyId: string,
    authorityNodeId: string,
    publicationId: string,
  ): { pending: number; conflicts: number } {
    const row = this.db.prepare(`SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='conflict' THEN 1 ELSE 0 END) AS conflicts
      FROM stugby_home_commands
      WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
      .get(stugubyId, authorityNodeId, publicationId) as { pending: number | null; conflicts: number | null };
    return { pending: Number(row.pending ?? 0), conflicts: Number(row.conflicts ?? 0) };
  }

  deferHomeCommand(commandId: string, attempts: number, nextAttemptAt: string): void {
    this.db.prepare(`UPDATE stugby_home_commands SET attempts=?,next_attempt_at=?,updated_at=?
      WHERE id=? AND status='pending'`).run(attempts, nextAttemptAt, new Date().toISOString(), commandId);
  }

  completeHomeCommand(result: StugubyHomeCommandResult): StugubyStoredHomeCommand {
    const changed = this.db.prepare(`UPDATE stugby_home_commands SET status=?,result_json=?,updated_at=?
      WHERE id=?`).run(result.status, JSON.stringify(result), new Date().toISOString(), result.commandId);
    if (Number(changed.changes) !== 1) throw new Error("Home command was not found");
    return this.getHomeCommand(result.commandId)!;
  }

  cancelPendingHomeCommands(stugubyId: string, now = new Date().toISOString()): number {
    return Number(this.db.prepare(`UPDATE stugby_home_commands SET status='cancelled',updated_at=?
      WHERE stugby_id=? AND status='pending'`).run(now, stugubyId).changes);
  }

  propertyFieldRevisions(stugubyId: string, entityKind: StugubyPropertyEntityKind, entityId: string): Record<string, number> {
    const rows = this.db.prepare(`SELECT field_name,revision FROM stugby_property_entity_fields
      WHERE stugby_id=? AND entity_kind=? AND entity_id=?`)
      .all(stugubyId, entityKind, entityId) as Array<{ field_name: string; revision: number }>;
    return Object.fromEntries(rows.map((row) => [row.field_name, Number(row.revision)]));
  }

  setPropertyFieldRevisions(
    stugubyId: string,
    entityKind: StugubyPropertyEntityKind,
    entityId: string,
    fields: readonly string[],
    revision: number,
  ): void {
    const statement = this.db.prepare(`INSERT INTO stugby_property_entity_fields
      (stugby_id,entity_kind,entity_id,field_name,revision) VALUES (?,?,?,?,?)
      ON CONFLICT(stugby_id,entity_kind,entity_id,field_name) DO UPDATE SET revision=excluded.revision`);
    for (const field of fields) statement.run(stugubyId, entityKind, entityId, field, revision);
  }

  listPropertyConflicts(stugubyId: string, includeResolved = false): StugubyPropertyConflict[] {
    const rows = this.db.prepare(`SELECT conflict_json,resolved_at FROM stugby_property_conflicts
      WHERE stugby_id=? ${includeResolved ? "" : "AND resolved_at IS NULL"}
      ORDER BY detected_at DESC`).all(stugubyId) as Array<{ conflict_json: string; resolved_at: string | null }>;
    return rows.map((row) => ({
      ...JSON.parse(row.conflict_json) as StugubyPropertyConflict,
      resolvedAt: row.resolved_at,
    }));
  }

  resolvePropertyConflict(stugubyId: string, commandId: string, now = new Date().toISOString()): boolean {
    return Number(this.db.prepare(`UPDATE stugby_property_conflicts SET resolved_at=?
      WHERE stugby_id=? AND command_id=? AND resolved_at IS NULL`).run(now, stugubyId, commandId).changes) === 1;
  }

  saveMigrationSnapshot(
    stugubyId: string,
    sourcePropertyId: string,
    targetPropertyId: string,
    snapshot: JsonValue,
    now = new Date().toISOString(),
  ): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO stugby_migration_snapshots
      (id,stugby_id,source_property_id,target_property_id,snapshot_json,created_at) VALUES (?,?,?,?,?,?)`)
      .run(id, stugubyId, sourcePropertyId, targetPropertyId, JSON.stringify(snapshot), now);
    return id;
  }

  upsertHomeProjection(projection: StugubyHomeProjection): StugubyHomeProjection {
    this.db.prepare(`INSERT INTO stugby_home_projections
      (stugby_id,authority_node_id,publication_id,local_house_id,edit_policy,recovery_mode,recovery_state,
       designated_successor_node_id,recovery_synced_through,authority_epoch,detached_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(stugby_id,authority_node_id,publication_id) DO UPDATE SET
        local_house_id=excluded.local_house_id,edit_policy=excluded.edit_policy,recovery_mode=excluded.recovery_mode,
        recovery_state=excluded.recovery_state,designated_successor_node_id=excluded.designated_successor_node_id,
        recovery_synced_through=excluded.recovery_synced_through,authority_epoch=excluded.authority_epoch,
        detached_at=excluded.detached_at,updated_at=excluded.updated_at`)
      .run(projection.stugubyId, projection.authorityNodeId, projection.publicationId, projection.localHouseId,
        projection.editPolicy, projection.recoveryMode, projection.recoveryState, projection.designatedSuccessorNodeId,
        projection.recoverySyncedThrough, projection.authorityEpoch, projection.detachedAt, projection.updatedAt);
    return this.getHomeProjection(projection.stugubyId, projection.authorityNodeId, projection.publicationId)!;
  }

  getHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null {
    const row = this.db.prepare(`SELECT * FROM stugby_home_projections
      WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
      .get(stugubyId, authorityNodeId, publicationId) as {
        stugby_id: string; authority_node_id: string; publication_id: string; local_house_id: string;
        edit_policy: StugubyHomeProjection["editPolicy"]; recovery_mode: StugubyHomeProjection["recoveryMode"];
        recovery_state: StugubyHomeProjection["recoveryState"]; designated_successor_node_id: string | null;
        recovery_synced_through: string | null; authority_epoch: number; detached_at: string | null; updated_at: string;
      } | undefined;
    return row ? {
      stugubyId: row.stugby_id,
      authorityNodeId: row.authority_node_id,
      publicationId: row.publication_id,
      localHouseId: row.local_house_id,
      editPolicy: row.edit_policy,
      recoveryMode: row.recovery_mode,
      recoveryState: row.recovery_state,
      designatedSuccessorNodeId: row.designated_successor_node_id,
      recoverySyncedThrough: row.recovery_synced_through,
      authorityEpoch: Number(row.authority_epoch),
      detachedAt: row.detached_at,
      updatedAt: row.updated_at,
    } : null;
  }

  listHomeProjections(stugubyId: string): StugubyHomeProjection[] {
    const rows = this.db.prepare(`SELECT authority_node_id,publication_id FROM stugby_home_projections
      WHERE stugby_id=? ORDER BY updated_at DESC`).all(stugubyId) as Array<{ authority_node_id: string; publication_id: string }>;
    return rows.flatMap((row) => {
      const projection = this.getHomeProjection(stugubyId, row.authority_node_id, row.publication_id);
      return projection ? [projection] : [];
    });
  }

  removeHomeProjection(stugubyId: string, authorityNodeId: string, publicationId: string): StugubyHomeProjection | null {
    const existing = this.getHomeProjection(stugubyId, authorityNodeId, publicationId);
    if (!existing) return null;
    this.db.prepare(`DELETE FROM stugby_home_projections
      WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
      .run(stugubyId, authorityNodeId, publicationId);
    return existing;
  }

  saveAuthorityTransfer(transfer: StugubyAuthorityTransfer): StugubyAuthorityTransfer {
    this.db.prepare(`INSERT INTO stugby_authority_transfers
      (id,stugby_id,scope,resource_id,from_node_id,to_node_id,from_epoch,to_epoch,status,snapshot_hash,requested_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,completed_at=excluded.completed_at`)
      .run(transfer.id, transfer.stugubyId, transfer.scope, transfer.resourceId, transfer.fromNodeId, transfer.toNodeId,
        transfer.fromEpoch, transfer.toEpoch, transfer.status, transfer.snapshotHash, transfer.requestedAt, transfer.completedAt);
    return transfer;
  }

  listAuthorityTransfers(stugubyId: string): StugubyAuthorityTransfer[] {
    const rows = this.db.prepare(`SELECT * FROM stugby_authority_transfers
      WHERE stugby_id=? ORDER BY requested_at DESC`).all(stugubyId) as Array<{
        id: string; stugby_id: string; scope: StugubyAuthorityTransfer["scope"]; resource_id: string;
        from_node_id: string; to_node_id: string; from_epoch: number; to_epoch: number;
        status: StugubyAuthorityTransfer["status"]; snapshot_hash: string; requested_at: string; completed_at: string | null;
      }>;
    return rows.map((row) => ({
      id: row.id, stugubyId: row.stugby_id, scope: row.scope, resourceId: row.resource_id,
      fromNodeId: row.from_node_id, toNodeId: row.to_node_id, fromEpoch: Number(row.from_epoch),
      toEpoch: Number(row.to_epoch), status: row.status, snapshotHash: row.snapshot_hash,
      requestedAt: row.requested_at, completedAt: row.completed_at,
    }));
  }

  nextSequence(stugubyId: string, streamId: string): number {
    this.db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
      VALUES (?,?,?,0) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO NOTHING`)
      .run(stugubyId, this.localNodeId, streamId);
    this.db.prepare(`UPDATE stugby_stream_sequences SET sequence=sequence+1
      WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`).run(stugubyId, this.localNodeId, streamId);
    return Number((this.db.prepare(`SELECT sequence FROM stugby_stream_sequences
      WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
      .get(stugubyId, this.localNodeId, streamId) as { sequence: number }).sequence);
  }

  reserveLiveTelemetrySample(stugubyId: string, grantId: string, utcHour: string, maximum: number): boolean {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO stugby_live_telemetry_usage
      (stugby_id,grant_id,utc_hour,sample_count,updated_at) VALUES (?,?,?,0,?)`)
      .run(stugubyId, grantId, utcHour, now);
    const result = this.db.prepare(`UPDATE stugby_live_telemetry_usage
      SET sample_count=sample_count+1,updated_at=?
      WHERE stugby_id=? AND grant_id=? AND utc_hour=? AND sample_count<?`)
      .run(now, stugubyId, grantId, utcHour, maximum);
    return Number(result.changes) === 1;
  }

  enqueueOutbox(stugubyId: string, destinationNodeId: string, event: StugubySignedEvent): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO stugby_outbox
      (stugby_id,destination_node_id,event_id,event_json,next_attempt_at,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugubyId, destinationNodeId, event.eventId, JSON.stringify(event), now, now);
  }

  dueOutbox(limit = 100): StugubyOutboxItem[] {
    const rows = this.db.prepare(`SELECT id,stugby_id,destination_node_id,event_json,attempts FROM stugby_outbox
      WHERE next_attempt_at<=? ORDER BY id LIMIT ?`).all(new Date().toISOString(), boundedLimit(limit, 100, 250)) as unknown as OutboxRow[];
    return rows.map((row) => ({
      id: row.id,
      stugubyId: row.stugby_id,
      destinationNodeId: row.destination_node_id,
      event: JSON.parse(row.event_json) as StugubySignedEvent,
      attempts: row.attempts,
    }));
  }

  acknowledgeOutbox(ids: number[]): void {
    const statement = this.db.prepare("DELETE FROM stugby_outbox WHERE id=?");
    for (const id of ids) statement.run(id);
  }

  discardOutboxGrantEpoch(stugubyId: string, grantId: string, throughEpoch: number): void {
    this.db.prepare(`DELETE FROM stugby_outbox WHERE stugby_id=?
      AND json_extract(event_json,'$.grantId')=?
      AND COALESCE(json_extract(event_json,'$.grantEpoch'),0)<=?`)
      .run(stugubyId, grantId, throughEpoch);
  }

  failOutbox(id: number, attempts: number): void {
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts, 8));
    this.db.prepare("UPDATE stugby_outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?")
      .run(new Date(Date.now() + delayMs).toISOString(), id);
  }

  inboxEventStatus(event: StugubySignedEvent): "new" | "duplicate" | "non-monotonic" {
    const duplicate = this.db.prepare("SELECT 1 AS present FROM stugby_inbox WHERE authority_node_id=? AND event_id=?")
      .get(event.authorityNodeId, event.eventId) as { present: number } | undefined;
    if (duplicate) return "duplicate";
    const current = this.db.prepare(`SELECT sequence FROM stugby_stream_sequences
      WHERE stugby_id=? AND authority_node_id=? AND stream_id=?`)
      .get(event.stugubyId, event.authorityNodeId, event.streamId) as { sequence: number } | undefined;
    return current && event.sequence <= current.sequence ? "non-monotonic" : "new";
  }

  recordInboxEvent(event: StugubySignedEvent): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("INSERT OR IGNORE INTO stugby_inbox(authority_node_id,event_id,received_at) VALUES (?,?,?)")
        .run(event.authorityNodeId, event.eventId, new Date().toISOString());
      if (Number(result.changes) === 1) {
        this.db.prepare(`INSERT INTO stugby_stream_sequences(stugby_id,authority_node_id,stream_id,sequence)
          VALUES (?,?,?,?) ON CONFLICT(stugby_id,authority_node_id,stream_id) DO UPDATE SET sequence=excluded.sequence
          WHERE excluded.sequence > stugby_stream_sequences.sequence`)
          .run(event.stugubyId, event.authorityNodeId, event.streamId, event.sequence);
      }
      this.db.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  appendEventForMember(stugubyId: string, targetNodeId: string, event: StugubySignedEvent): number | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO stugby_event_log
      (stugby_id,target_node_id,event_id,event_json,created_at) VALUES (?,?,?,?,?)`)
      .run(stugubyId, targetNodeId, event.eventId, JSON.stringify(event), now);
    if (Number(result.changes) === 0) return null;
    return Number((this.db.prepare("SELECT cursor FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND event_id=?")
      .get(stugubyId, targetNodeId, event.eventId) as { cursor: number }).cursor);
  }

  eventPage(stugubyId: string, targetNodeId: string, afterCursor: number, limit = 100): StugubyEventLogPage {
    const pageSize = boundedLimit(limit, 100, 250);
    const rows = this.db.prepare(`SELECT cursor,event_json FROM stugby_event_log
      WHERE stugby_id=? AND target_node_id=? AND cursor>? ORDER BY cursor LIMIT ?`)
      .iterate(stugubyId, targetNodeId, Math.max(0, afterCursor), pageSize + 1) as NodeJS.Iterator<{
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
      events: selected.map((row) => JSON.parse(row.event_json) as StugubySignedEvent),
      cursor: selected.at(-1)?.cursor ?? afterCursor,
      hasMore,
    };
  }

  applyDatasetEvent(event: StugubySignedEvent): { applied: boolean; deletionReceipt?: StugubyDeletionReceipt } {
    if (!event.grantId || event.grantEpoch === null) throw new Error("Dataset events require a grant and epoch");
    const grant = this.getGrant(event.grantId);
    if (!grant || grant.epoch !== event.grantEpoch || grant.revokedAt
      || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())) {
      throw new Error("Dataset event refers to an inactive or superseded grant epoch");
    }
    if (grant.stugubyId !== event.stugubyId || grant.authorityNodeId !== event.authorityNodeId) throw new Error("Dataset grant authority mismatch");
    const datasetGrant = grant.datasets.find((item) => item.dataset === event.schema && item.enabled);
    if (!datasetGrant) throw new Error("Dataset is not enabled by this grant");
    const existing = this.db.prepare(`SELECT revision FROM stugby_remote_resources
      WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?`)
      .get(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId) as { revision: number } | undefined;
    if (existing && existing.revision >= event.revision) return { applied: false };
    if (event.operation === "tombstone") {
      this.db.prepare(`DELETE FROM stugby_remote_resources WHERE stugby_id=? AND authority_node_id=? AND schema_name=? AND resource_id=?`)
        .run(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId);
      if (event.schema === "home.telemetry.v1") {
        this.db.prepare(`DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND authority_node_id=? AND grant_id=?`)
          .run(event.stugubyId, event.authorityNodeId, event.grantId);
      }
      return { applied: true };
    }
    // A zero retention or disabled replica-cache permission means the event may
    // wake live consumers but must not be written to the durable projection.
    if (!datasetGrant.allowReplicaCache || datasetGrant.retentionDays === 0) return { applied: true };
    const receivedAt = new Date().toISOString();
    if (event.schema === "home.telemetry.v1") {
      this.insertTelemetry(event, event.payload as unknown as StugubyTelemetryPayload, receivedAt);
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
      .run(event.stugubyId, event.authorityNodeId, event.schema, event.resourceId, publicationId, event.grantId,
        event.grantEpoch, event.revision, JSON.stringify(event.payload), receivedAt, event.occurredAt);
    return { applied: true };
  }

  private insertTelemetry(event: StugubySignedEvent, payload: StugubyTelemetryPayload, receivedAt: string): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM stugby_remote_telemetry
        WHERE stugby_id=? AND authority_node_id=? AND publication_id=? AND grant_id=? AND grant_epoch=? AND chunk_id=?`)
        .run(event.stugubyId, event.authorityNodeId, payload.publicationId, event.grantId, event.grantEpoch, payload.chunkId);
      const statement = this.db.prepare(`INSERT INTO stugby_remote_telemetry
        (stugby_id,authority_node_id,publication_id,grant_id,grant_epoch,chunk_id,sensor_publication_id,
         metric_id,timestamp,value,quality,correction_of,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const sample of payload.samples) {
        statement.run(event.stugubyId, event.authorityNodeId, payload.publicationId, event.grantId, event.grantEpoch,
          payload.chunkId, sample.sensorPublicationId, sample.metricId, sample.timestamp, sample.value, sample.quality,
          sample.correctionOf ?? null, receivedAt);
      }
    });
  }

  purgeGrantData(stugubyId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt {
    this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
      .run(stugubyId, grantId, grantEpoch);
    this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND grant_epoch<?")
      .run(stugubyId, grantId, grantEpoch);
    const receipt: StugubyDeletionReceipt = {
      stugubyId,
      nodeId: this.localNodeId,
      grantId,
      grantEpoch,
      deletedAt: new Date().toISOString(),
    };
    this.db.prepare(`INSERT OR REPLACE INTO stugby_deletion_receipts
      (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
      .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
    return receipt;
  }

  listRemoteResources(stugubyId: string): StugubyRemoteResource[] {
    const rows = this.db.prepare(`SELECT stugby_id,authority_node_id,schema_name,resource_id,publication_id,revision,
      payload_json,received_at,source_occurred_at,stale FROM stugby_remote_resources WHERE stugby_id=?
      ORDER BY authority_node_id,publication_id,schema_name`).all(stugubyId) as unknown as Array<{
        stugby_id: string; authority_node_id: string; schema_name: StugubyDataset; resource_id: string;
        publication_id: string; revision: number; payload_json: string; received_at: string;
        source_occurred_at: string; stale: number;
      }>;
    return rows.map((row) => ({
      stugubyId: row.stugby_id,
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
    const parameters: Array<string | number> = [query.stugubyId];
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

  remoteTelemetryCount(stugubyId: string, authorityNodeId: string, publicationId: string): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM stugby_remote_telemetry
      WHERE stugby_id=? AND authority_node_id=? AND publication_id=?`)
      .get(stugubyId, authorityNodeId, publicationId) as { count: number }).count);
  }

  promoteRecoveryTelemetry(stugubyId: string, authorityNodeId: string, publicationId: string): number {
    const result = this.db.prepare(`INSERT OR IGNORE INTO measurement_samples
      (sensor_id,metric,value,canonical_unit,timestamp,source,quality)
      SELECT projection.local_id,remote.metric_id,remote.value,definition.unit,remote.timestamp,'import',remote.quality
      FROM stugby_remote_telemetry remote
      JOIN stugby_projection_ids projection
        ON projection.stugby_id=remote.stugby_id
       AND projection.authority_node_id=remote.authority_node_id
       AND projection.resource_type='sensor'
       AND projection.remote_id=remote.sensor_publication_id
      JOIN measurement_definitions definition ON definition.id=remote.metric_id
      WHERE remote.stugby_id=? AND remote.authority_node_id=? AND remote.publication_id=?`)
      .run(stugubyId, authorityNodeId, publicationId);
    return Number(result.changes);
  }

  markRemoteStale(stugubyId: string): void {
    this.db.prepare("UPDATE stugby_remote_resources SET stale=1 WHERE stugby_id=?").run(stugubyId);
  }

  markRemoteCurrent(stugubyId: string): void {
    this.db.prepare("UPDATE stugby_remote_resources SET stale=0 WHERE stugby_id=?").run(stugubyId);
  }

  purgeDepartedReplicas(stugubyId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=?").run(stugubyId);
      this.db.prepare("DELETE FROM stugby_shared_properties WHERE stugby_id=?").run(stugubyId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enforceRetention(stugubyId: string): void {
    const now = Date.now();
    for (const grant of this.listGrants(stugubyId)) {
      if (grant.revokedAt || (grant.expiresAt && Date.parse(grant.expiresAt) <= now)) {
        this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
        this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
        continue;
      }
      // A designated full-recovery replica is ownership-transfer material.
      // Keep its complete archive for the lifetime of the active grant instead
      // of aging out the oldest history before a planned decommission.
      if (grant.housePolicy.recoveryMode === "full") continue;
      for (const dataset of grant.datasets) {
        if (!dataset.enabled || !dataset.allowReplicaCache || dataset.retentionDays === 0) {
          this.db.prepare("DELETE FROM stugby_remote_resources WHERE stugby_id=? AND grant_id=? AND schema_name=?")
            .run(stugubyId, grant.id, dataset.dataset);
          if (dataset.dataset === "home.telemetry.v1") {
            this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=?").run(stugubyId, grant.id);
          }
          continue;
        }
        const cutoff = new Date(now - dataset.retentionDays * 86_400_000).toISOString();
        this.db.prepare(`DELETE FROM stugby_remote_resources
          WHERE stugby_id=? AND grant_id=? AND schema_name=? AND received_at<?`)
          .run(stugubyId, grant.id, dataset.dataset, cutoff);
        if (dataset.dataset === "home.telemetry.v1") {
          this.db.prepare("DELETE FROM stugby_remote_telemetry WHERE stugby_id=? AND grant_id=? AND received_at<?")
            .run(stugubyId, grant.id, cutoff);
        }
      }
    }
  }

  pullCursor(stugubyId: string): number {
    return Number((this.db.prepare("SELECT pull_cursor FROM stugby_federations WHERE id=?").get(stugubyId) as { pull_cursor?: number } | undefined)?.pull_cursor ?? 0);
  }

  recordSync(stugubyId: string, cursor: number, error: string | null): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE stugby_federations SET pull_cursor=max(pull_cursor,?),
      last_sync_at=CASE WHEN ? IS NULL THEN ? ELSE last_sync_at END,last_sync_error=?,updated_at=? WHERE id=?`)
      .run(cursor, error, now, error, now, stugubyId);
    if (error) this.markRemoteStale(stugubyId);
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

  grantBlobAccess(stugubyId: string, digest: string, nodeId: string, grantId: string, grantEpoch: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_access
      (stugby_id,digest,node_id,grant_id,grant_epoch,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugubyId, digest, nodeId, grantId, grantEpoch, new Date().toISOString());
  }

  registerBlobReference(stugubyId: string, digest: string, grantId: string, grantEpoch: number, kind: "local" | "relay" | "replica"): void {
    this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_references
      (stugby_id,digest,grant_id,grant_epoch,kind,created_at) VALUES (?,?,?,?,?,?)`)
      .run(stugubyId, digest, grantId, grantEpoch, kind, new Date().toISOString());
  }

  canReadBlob(stugubyId: string, digest: string, nodeId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM stugby_blob_access access
      JOIN stugby_share_grants grant ON grant.id=access.grant_id
      WHERE access.stugby_id=? AND access.digest=? AND access.node_id=?
        AND ((grant.epoch=access.grant_epoch AND grant.revoked_at IS NULL
              AND (grant.expires_at IS NULL OR julianday(grant.expires_at)>julianday(?)))
          OR EXISTS (SELECT 1 FROM stugby_pending_deletions pending
            WHERE pending.stugby_id=access.stugby_id AND pending.node_id=access.node_id
              AND pending.grant_id=access.grant_id AND pending.grant_epoch>access.grant_epoch
              AND pending.acknowledged_at IS NULL)) LIMIT 1`)
      .get(stugubyId, digest, nodeId, new Date().toISOString()));
  }

  acknowledgeEventCursor(stugubyId: string, nodeId: string, cursor: number): string[] {
    if (cursor <= 0) return [];
    const rows = this.db.prepare(`SELECT event_json FROM stugby_event_log
      WHERE stugby_id=? AND target_node_id=? AND cursor<=?`).all(stugubyId, nodeId, cursor) as unknown as Array<{ event_json: string }>;
    const blobEvents = rows.map((row) => JSON.parse(row.event_json) as StugubySignedEvent)
      .filter((event) => eventBlobDigests(event).length > 0 && event.grantId && event.grantEpoch !== null);
    const released = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=? AND cursor<=?")
        .run(stugubyId, nodeId, cursor);
      for (const event of blobEvents) {
        for (const digest of eventBlobDigests(event)) {
          this.db.prepare(`DELETE FROM stugby_blob_access
            WHERE stugby_id=? AND digest=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
            .run(stugubyId, digest, nodeId, event.grantId, event.grantEpoch);
          released.add(digest);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    for (const event of blobEvents) this.releaseRelayReferencesWithoutAccess(stugubyId, event.grantId!, event.grantEpoch!);
    return [...released].filter((digest) => !this.hasBlobReferences(digest));
  }

  releaseRelayReferencesWithoutAccess(stugubyId: string, grantId: string, beforeOrAtEpoch: number): string[] {
    const rows = this.db.prepare(`SELECT digest,grant_epoch FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='relay' AND grant_epoch<=?`)
      .all(stugubyId, grantId, beforeOrAtEpoch) as unknown as Array<{ digest: string; grant_epoch: number }>;
    const released = new Set<string>();
    for (const row of rows) {
      const inUse = this.db.prepare(`SELECT 1 FROM stugby_blob_access
        WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? LIMIT 1`)
        .get(stugubyId, row.digest, grantId, row.grant_epoch);
      if (inUse) continue;
      this.db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='relay'`)
        .run(stugubyId, row.digest, grantId, row.grant_epoch);
      released.add(row.digest);
    }
    return [...released].filter((digest) => !this.hasBlobReferences(digest));
  }

  purgeReplicaBlobReferences(stugubyId: string, grantId: string, beforeEpoch: number): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
      .all(stugubyId, grantId, beforeEpoch) as unknown as Array<{ digest: string }>;
    this.db.prepare(`DELETE FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='replica' AND grant_epoch<?`)
      .run(stugubyId, grantId, beforeEpoch);
    return rows.map((row) => row.digest).filter((digest) => !this.hasBlobReferences(digest));
  }

  reconcileReplicaBlobReferences(stugubyId: string): string[] {
    const retained = new Set<string>();
    const resources = this.db.prepare(`SELECT grant_id,grant_epoch,schema_name,payload_json FROM stugby_remote_resources
      WHERE stugby_id=? AND schema_name IN ('home.floorplan.v1','home.recovery.v1')`).all(stugubyId) as unknown as Array<{
        grant_id: string; grant_epoch: number; schema_name: string; payload_json: string;
      }>;
    for (const resource of resources) {
      for (const digest of resourceBlobDigests(resource.schema_name, JSON.parse(resource.payload_json))) {
        retained.add(`${resource.grant_id}\n${resource.grant_epoch}\n${digest}`);
      }
    }
    const references = this.db.prepare(`SELECT digest,grant_id,grant_epoch FROM stugby_blob_references
      WHERE stugby_id=? AND kind='replica'`).all(stugubyId) as unknown as Array<{ digest: string; grant_id: string; grant_epoch: number }>;
    const released = new Set<string>();
    for (const reference of references) {
      if (retained.has(`${reference.grant_id}\n${reference.grant_epoch}\n${reference.digest}`)) continue;
      this.db.prepare(`DELETE FROM stugby_blob_references
        WHERE stugby_id=? AND digest=? AND grant_id=? AND grant_epoch=? AND kind='replica'`)
        .run(stugubyId, reference.digest, reference.grant_id, reference.grant_epoch);
      released.add(reference.digest);
    }
    return [...released].filter((digest) => !this.hasBlobReferences(digest));
  }

  retireLocalBlobReferences(stugubyId: string, grantId: string, throughEpoch: number): void {
    const rows = this.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
      .all(stugubyId, grantId, throughEpoch) as unknown as Array<{ digest: string }>;
    this.db.prepare(`DELETE FROM stugby_blob_references
      WHERE stugby_id=? AND grant_id=? AND kind='local' AND grant_epoch<=?`)
      .run(stugubyId, grantId, throughEpoch);
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

  listDeletionReceipts(stugubyId: string): StugubyDeletionReceipt[] {
    return this.db.prepare(`SELECT stugby_id AS stugubyId,node_id AS nodeId,grant_id AS grantId,
      grant_epoch AS grantEpoch,deleted_at AS deletedAt FROM stugby_deletion_receipts WHERE stugby_id=? ORDER BY deleted_at DESC`)
      .all(stugubyId) as unknown as StugubyDeletionReceipt[];
  }

  getDeletionReceipt(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): StugubyDeletionReceipt | null {
    return (this.db.prepare(`SELECT stugby_id AS stugubyId,node_id AS nodeId,grant_id AS grantId,
      grant_epoch AS grantEpoch,deleted_at AS deletedAt FROM stugby_deletion_receipts
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
      .get(stugubyId, nodeId, grantId, grantEpoch) as unknown as StugubyDeletionReceipt | undefined) ?? null;
  }

  expectDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO stugby_pending_deletions
      (stugby_id,node_id,grant_id,grant_epoch,created_at) VALUES (?,?,?,?,?)`)
      .run(stugubyId, nodeId, grantId, grantEpoch, new Date().toISOString());
  }

  hasPendingDeletion(stugubyId: string, nodeId: string, grantId: string, grantEpoch: number): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM stugby_pending_deletions
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=? AND acknowledged_at IS NULL`)
      .get(stugubyId, nodeId, grantId, grantEpoch));
  }

  releaseDeletionBlobAccess(receipt: StugubyDeletionReceipt): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT digest FROM stugby_blob_access
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
      .all(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as unknown as Array<{ digest: string }>;
    this.db.prepare(`DELETE FROM stugby_blob_access
      WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch<?`)
      .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
    const candidates = new Set(rows.map((row) => row.digest));
    for (const digest of this.releaseRelayReferencesWithoutAccess(receipt.stugubyId, receipt.grantId, receipt.grantEpoch - 1)) candidates.add(digest);
    return [...candidates].filter((digest) => !this.hasBlobReferences(digest));
  }

  processDeletionReceipt(receipt: StugubyDeletionReceipt): StugubyDeletionReceiptResult {
    return this.transaction(() => {
      const existing = this.getDeletionReceipt(
        receipt.stugubyId,
        receipt.nodeId,
        receipt.grantId,
        receipt.grantEpoch,
      );
      if (existing && existing.deletedAt !== receipt.deletedAt) return "conflict";

      const pending = this.db.prepare(`SELECT acknowledged_at FROM stugby_pending_deletions
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
        .get(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch) as {
          acknowledged_at: string | null;
        } | undefined;
      if (!existing && !pending) return "unexpected";
      if (!existing && pending?.acknowledged_at && pending.acknowledged_at !== receipt.deletedAt) return "conflict";

      const inserted = this.db.prepare(`INSERT OR IGNORE INTO stugby_deletion_receipts
        (stugby_id,node_id,grant_id,grant_epoch,deleted_at) VALUES (?,?,?,?,?)`)
        .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch, receipt.deletedAt);
      this.db.prepare(`UPDATE stugby_pending_deletions SET acknowledged_at=COALESCE(acknowledged_at,?)
        WHERE stugby_id=? AND node_id=? AND grant_id=? AND grant_epoch=?`)
        .run(receipt.deletedAt, receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
      this.db.prepare(`DELETE FROM stugby_event_log WHERE stugby_id=? AND target_node_id=?
        AND json_extract(event_json,'$.grantId')=?
        AND COALESCE(json_extract(event_json,'$.grantEpoch'),0)<?`)
        .run(receipt.stugubyId, receipt.nodeId, receipt.grantId, receipt.grantEpoch);
      if (Number(inserted.changes) === 1) {
        this.audit(receipt.stugubyId, "deletion.acknowledged", receipt.nodeId, receipt.grantId,
          { epoch: receipt.grantEpoch }, receipt.deletedAt);
      }
      for (const digest of this.releaseDeletionBlobAccess(receipt)) {
        this.db.prepare(`INSERT OR IGNORE INTO stugby_blob_deletion_queue(digest,queued_at) VALUES (?,?)`)
          .run(digest, new Date().toISOString());
      }
      return existing ? "retry" : "accepted";
    });
  }

  pendingDeletions(stugubyId: string, nodeId: string): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM stugby_pending_deletions
      WHERE stugby_id=? AND node_id=? AND acknowledged_at IS NULL`).get(stugubyId, nodeId) as { count: number }).count);
  }

  pendingDeletionsForStuguby(stugubyId: string): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM stugby_pending_deletions
      WHERE stugby_id=? AND acknowledged_at IS NULL`).get(stugubyId) as { count: number }).count);
  }

  audit(stugubyId: string | null, eventType: string, actorNodeId: string | null, subjectId: string | null,
    details: Record<string, string | number | boolean | null>, createdAt = new Date().toISOString()): void {
    this.db.prepare(`INSERT INTO stugby_audit_events(stugby_id,event_type,actor_node_id,subject_id,details_json,created_at)
      VALUES (?,?,?,?,?,?)`).run(stugubyId, eventType, actorNodeId, subjectId, JSON.stringify(details), createdAt);
  }

  listAudit(stugubyId: string, limit = 100): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT id,event_type,actor_node_id,subject_id,details_json,created_at
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
  }

  protocolVersion(): typeof STUGBY_PROTOCOL_VERSION {
    return STUGBY_PROTOCOL_VERSION;
  }
}
