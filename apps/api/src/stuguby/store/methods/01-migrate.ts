import { registerStugubyStoreMethods, stugubyStoreState, type StugubyStoreInternals } from "../core.js";

registerStugubyStoreMethods({
  migrate(this: StugubyStoreInternals): void {
      this[stugubyStoreState].db.exec(`
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
        CREATE TABLE IF NOT EXISTS stugby_remote_telemetry_staging (
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
          stream_kind TEXT NOT NULL CHECK (stream_kind IN ('snapshot','live')),
          PRIMARY KEY (
            stugby_id, authority_node_id, publication_id, grant_id, grant_epoch,
            chunk_id, sensor_publication_id, metric_id, timestamp
          )
        );
        CREATE INDEX IF NOT EXISTS idx_stugby_remote_telemetry_staging_scope
          ON stugby_remote_telemetry_staging(
            stugby_id, authority_node_id, publication_id, grant_id, grant_epoch, chunk_id
          );
        CREATE TABLE IF NOT EXISTS stugby_remote_telemetry_epochs (
          stugby_id TEXT NOT NULL,
          authority_node_id TEXT NOT NULL,
          publication_id TEXT NOT NULL,
          grant_id TEXT NOT NULL,
          grant_epoch INTEGER NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('awaiting-terminal','complete','refreshing')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          terminal_event_id TEXT,
          PRIMARY KEY (stugby_id, authority_node_id, publication_id, grant_id, grant_epoch)
        );
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
      const memberColumns = new Set((this[stugubyStoreState].db.prepare("PRAGMA table_info(stugby_members)")
        .all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!memberColumns.has("local_label")) {
        this[stugubyStoreState].db.exec("ALTER TABLE stugby_members ADD COLUMN local_label TEXT");
      }
      const invitationColumns = new Set((this[stugubyStoreState].db.prepare("PRAGMA table_info(stugby_invitations)")
        .all() as unknown as Array<{ name: string }>).map((column) => column.name));
      if (!invitationColumns.has("local_label")) {
        this[stugubyStoreState].db.exec("ALTER TABLE stugby_invitations ADD COLUMN local_label TEXT");
      }
      // A short-lived protocol build persisted `stugbyId`. Normalize mutable
      // state snapshots before service methods bind the corrected field to SQL.
      // Signed event/outbox JSON is deliberately immutable.
      this[stugubyStoreState].db.exec(`
        UPDATE stugby_share_grants
        SET grant_json = json_remove(
          json_set(grant_json, '$.stugubyId', json_extract(grant_json, '$.stugbyId')),
          '$.stugbyId'
        )
        WHERE json_type(grant_json, '$.stugubyId') IS NULL
          AND json_type(grant_json, '$.stugbyId') = 'text';
        UPDATE stugby_shared_properties
        SET property_json = json_remove(
          json_set(property_json, '$.stugubyId', json_extract(property_json, '$.stugbyId')),
          '$.stugbyId'
        )
        WHERE json_type(property_json, '$.stugubyId') IS NULL
          AND json_type(property_json, '$.stugbyId') = 'text';
        UPDATE stugby_property_commands
        SET command_json = json_remove(
          json_set(command_json, '$.stugubyId', json_extract(command_json, '$.stugbyId')),
          '$.stugbyId'
        )
        WHERE json_type(command_json, '$.stugubyId') IS NULL
          AND json_type(command_json, '$.stugbyId') = 'text';
        UPDATE stugby_property_commands
        SET result_json = json_remove(
          json_set(result_json, '$.property.stugubyId', json_extract(result_json, '$.property.stugbyId')),
          '$.property.stugbyId'
        )
        WHERE result_json IS NOT NULL
          AND json_type(result_json, '$.property.stugubyId') IS NULL
          AND json_type(result_json, '$.property.stugbyId') = 'text';
        UPDATE stugby_home_commands
        SET command_json = json_remove(
          json_set(command_json, '$.stugubyId', json_extract(command_json, '$.stugbyId')),
          '$.stugbyId'
        )
        WHERE json_type(command_json, '$.stugubyId') IS NULL
          AND json_type(command_json, '$.stugbyId') = 'text';
      `);
      // Raw telemetry has its own indexed projection. Keeping every chunk a
      // second time as a generic JSON resource makes the owner detail endpoint
      // grow without bound and doubles sensitive storage.
      this[stugubyStoreState].db.prepare("DELETE FROM stugby_remote_resources WHERE schema_name='home.telemetry.v1'").run();
    },
});
