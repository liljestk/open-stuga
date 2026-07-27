export const CORE_SCHEMA_02 = `          SELECT 1 FROM observations AS observation
          WHERE observation.house_id = OLD.id
            AND NOT EXISTS (
              SELECT 1 FROM json_each(NEW.floors_json) AS floor
              WHERE json_extract(floor.value, '$.id') = observation.floor_id
            )
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_OBSERVATION'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_house_floor_excluded_observation
        BEFORE UPDATE OF floors_json ON houses
        WHEN NEW.floors_json <> OLD.floors_json AND EXISTS (
          SELECT 1 FROM observations AS observation
          JOIN json_each(NEW.floors_json) AS floor
            ON json_extract(floor.value, '$.id') = observation.floor_id
          WHERE observation.house_id = OLD.id
            AND observation.x IS NOT NULL AND observation.y IS NOT NULL
            AND (observation.x < 0 OR observation.x > CAST(json_extract(floor.value, '$.width') AS REAL)
              OR observation.y < 0 OR observation.y > CAST(json_extract(floor.value, '$.height') AS REAL))
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_EXCLUDES_OBSERVATION'); END;
      CREATE TABLE IF NOT EXISTS observation_revisions (
        observation_id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        changed_at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service')),
        changed_fields_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (observation_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_observation_revisions_changed
        ON observation_revisions(observation_id, changed_at, revision);
      CREATE TRIGGER IF NOT EXISTS prevent_observation_revision_insert_collision
        BEFORE INSERT ON observation_revisions
        WHEN EXISTS (
          SELECT 1 FROM observation_revisions
          WHERE observation_id = NEW.observation_id AND revision = NEW.revision
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_observation_revision_update
        BEFORE UPDATE ON observation_revisions
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_observation_revision_delete
        BEFORE DELETE ON observation_revisions
        WHEN EXISTS (SELECT 1 FROM observations WHERE id = OLD.observation_id)
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TABLE IF NOT EXISTS maintenance_tasks (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
        floor_id TEXT,
        area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
        equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT,
        basis TEXT NOT NULL CHECK (basis IN ('required', 'scheduled', 'condition-based', 'predictive', 'optional-improvement')),
        basis_detail TEXT,
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        planned_for TEXT,
        due_by TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'in-progress', 'completed', 'verified', 'cancelled')),
        completion_note TEXT,
        completed_at TEXT,
        verification_note TEXT,
        verified_at TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (planned_for IS NULL OR due_by IS NULL OR planned_for <= due_by),
        CHECK (basis <> 'predictive' OR due_by IS NULL),
        CHECK (
          (status IN ('planned', 'in-progress', 'cancelled')
            AND completion_note IS NULL AND completed_at IS NULL
            AND verification_note IS NULL AND verified_at IS NULL)
          OR
          (status = 'completed'
            AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
            AND verification_note IS NULL AND verified_at IS NULL)
          OR
          (status = 'verified'
            AND completion_note IS NOT NULL AND length(trim(completion_note)) > 0 AND completed_at IS NOT NULL
            AND verification_note IS NOT NULL AND length(trim(verification_note)) > 0 AND verified_at IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_house_schedule
        ON maintenance_tasks(house_id, status, planned_for, due_by, updated_at DESC);
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_insert
        BEFORE INSERT ON maintenance_tasks
        WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_task_floor_update
        BEFORE UPDATE OF floor_id, house_id ON maintenance_tasks
        WHEN NEW.floor_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_house_floor_orphaned_maintenance
        BEFORE UPDATE OF floors_json ON houses
        WHEN EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          WHERE task.house_id = OLD.id AND task.floor_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM json_each(NEW.floors_json) AS floor
              WHERE json_extract(floor.value, '$.id') = task.floor_id
            )
        )
        BEGIN SELECT RAISE(ABORT, 'LAYOUT_ORPHANS_MAINTENANCE_TASK'); END;
      CREATE TABLE IF NOT EXISTS maintenance_task_observations (
        maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
        observation_id TEXT NOT NULL,
        PRIMARY KEY (maintenance_task_id, observation_id),
        FOREIGN KEY (observation_id) REFERENCES observations(id)
          ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_task_observations_observation
        ON maintenance_task_observations(observation_id, maintenance_task_id);
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_insert
        BEFORE INSERT ON maintenance_task_observations
        WHEN NOT EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          JOIN observations AS observation ON observation.id = NEW.observation_id
          WHERE task.id = NEW.maintenance_task_id
            AND task.house_id = observation.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_maintenance_observation_scope_update
        BEFORE UPDATE OF maintenance_task_id, observation_id ON maintenance_task_observations
        WHEN NOT EXISTS (
          SELECT 1 FROM maintenance_tasks AS task
          JOIN observations AS observation ON observation.id = NEW.observation_id
          WHERE task.id = NEW.maintenance_task_id
            AND task.house_id = observation.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_linked_maintenance_task_house_update
        BEFORE UPDATE OF house_id ON maintenance_tasks
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_observations AS link
          JOIN observations AS observation ON observation.id = link.observation_id
          WHERE link.maintenance_task_id = OLD.id
            AND observation.house_id <> NEW.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TRIGGER IF NOT EXISTS validate_linked_observation_house_update
        BEFORE UPDATE OF house_id ON observations
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_observations AS link
          JOIN maintenance_tasks AS task ON task.id = link.maintenance_task_id
          WHERE link.observation_id = OLD.id
            AND task.house_id <> NEW.house_id
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_OBSERVATION_SCOPE_MISMATCH'); END;
      CREATE TABLE IF NOT EXISTS maintenance_task_revisions (
        maintenance_task_id TEXT NOT NULL REFERENCES maintenance_tasks(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        changed_at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN ('local-rest', 'local-mcp', 'local-migration', 'workspace-user', 'system-service')),
        changed_fields_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (maintenance_task_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_maintenance_task_revisions_changed
        ON maintenance_task_revisions(maintenance_task_id, changed_at, revision);
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_insert_collision
        BEFORE INSERT ON maintenance_task_revisions
        WHEN EXISTS (
          SELECT 1 FROM maintenance_task_revisions
          WHERE maintenance_task_id = NEW.maintenance_task_id AND revision = NEW.revision
        )
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_update
        BEFORE UPDATE ON maintenance_task_revisions
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_maintenance_task_revision_delete
        BEFORE DELETE ON maintenance_task_revisions
        WHEN EXISTS (SELECT 1 FROM maintenance_tasks WHERE id = OLD.maintenance_task_id)
        BEGIN SELECT RAISE(ABORT, 'MAINTENANCE_TASK_REVISIONS_ARE_APPEND_ONLY'); END;
      CREATE TABLE IF NOT EXISTS static_parameters (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        unit TEXT,
        label TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_parameters_scope_key
        ON static_parameters(house_id, scope_type, scope_id, key);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        data BLOB NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outdoor_temperature_samples (
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        location_key TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        temperature_c REAL NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        station_id TEXT,
        station_name TEXT,
        conditions_json TEXT,
        PRIMARY KEY(house_id, location_key, timestamp, source)
      );
      CREATE INDEX IF NOT EXISTS idx_outdoor_temperature_house_location_time
        ON outdoor_temperature_samples(house_id, location_key, timestamp);
      CREATE TABLE IF NOT EXISTS weather_outages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        location_key TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('fmi', 'open-meteo')),
        component TEXT NOT NULL CHECK (component IN ('service', 'observation', 'forecast', 'short-range', 'warnings')),
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at TEXT,
        last_error TEXT NOT NULL,
        backfill_state TEXT NOT NULL CHECK (backfill_state IN (
          'not-needed', 'pending', 'running', 'complete', 'partial', 'failed', 'not-supported'
        )),
        backfill_from TEXT,
        backfill_to TEXT,
        recovered_points INTEGER NOT NULL DEFAULT 0 CHECK (recovered_points >= 0),
        last_attempt_at TEXT,
        backfill_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_weather_outages_one_open_component
        ON weather_outages(house_id, location_key, provider, component) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_weather_outages_house_location_started
        ON weather_outages(house_id, location_key, started_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS sensor_data_gaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE CASCADE,
        source TEXT NOT NULL CHECK (source IN ('home-assistant', 'tp-link')),
        started_at TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        ended_at TEXT,
        recovery_state TEXT NOT NULL CHECK (recovery_state IN (
          'open', 'pending', 'running', 'complete', 'partial', 'failed', 'not-supported'
        )),
        recovered_points INTEGER NOT NULL DEFAULT 0 CHECK (recovered_points >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        recovery_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sensor_data_gaps_one_open_metric
        ON sensor_data_gaps(sensor_id, metric, source) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_sensor_data_gaps_recovery_queue
        ON sensor_data_gaps(recovery_state, next_attempt_at, id);
      CREATE INDEX IF NOT EXISTS idx_sensor_data_gaps_sensor_started
        ON sensor_data_gaps(sensor_id, started_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS tapo_history_export_jobs (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE CHECK (length(trim(dedupe_key)) BETWEEN 1 AND 500),
        provider TEXT NOT NULL CHECK (provider IN ('appium', 'private-cloud')),
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        expected_device_id TEXT NOT NULL CHECK (length(trim(expected_device_id)) BETWEEN 1 AND 500),
        device_name TEXT NOT NULL CHECK (length(trim(device_name)) BETWEEN 1 AND 500),
        time_zone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(trim(time_zone)) BETWEEN 1 AND 100),
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
        expected_recipient TEXT COLLATE NOCASE CHECK (
          expected_recipient IS NULL OR length(trim(expected_recipient)) BETWEEN 3 AND 320
        ),
        range_start TEXT NOT NULL,
        range_end TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 1 AND 525600),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'claimed', 'running', 'waiting-email', 'needs-attention', 'completed', 'failed', 'cancelled'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 100),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        submitted_at TEXT,
        deployment_fingerprint TEXT CHECK (
          deployment_fingerprint IS NULL OR length(deployment_fingerprint) = 64
        ),
        acceptance_revision TEXT CHECK (
          acceptance_revision IS NULL OR length(acceptance_revision) = 64
        ),
        mailbox_message_id TEXT,
        source_artifact_sha256 TEXT CHECK (
          source_artifact_sha256 IS NULL OR length(source_artifact_sha256) = 64
        ),
        source_artifact_bytes INTEGER CHECK (source_artifact_bytes IS NULL OR source_artifact_bytes >= 0),
        parser_version TEXT CHECK (parser_version IS NULL OR length(trim(parser_version)) BETWEEN 1 AND 100),
        source_schema_signature TEXT CHECK (
          source_schema_signature IS NULL OR length(source_schema_signature) = 64
        ),
        expected_schema_signature TEXT CHECK (
          expected_schema_signature IS NULL OR length(expected_schema_signature) = 64
        ),
        staged_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (staged_sample_count >= 0),
        consumed_sample_count INTEGER NOT NULL DEFAULT 0 CHECK (consumed_sample_count >= 0),
        last_error TEXT,
        attention_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (range_start < range_end),
        CHECK ((lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
          OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
        CHECK (consumed_sample_count <= staged_sample_count)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tapo_history_export_mailbox_message
        ON tapo_history_export_jobs(mailbox_message_id) WHERE mailbox_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_queue
        ON tapo_history_export_jobs(status, available_at, lease_expires_at, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_sensor_range
        ON tapo_history_export_jobs(sensor_id, range_start, range_end, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_retention
        ON tapo_history_export_jobs(status, completed_at, updated_at, dedupe_key);
      CREATE TABLE IF NOT EXISTS tapo_history_canary_approvals (
        deployment_fingerprint TEXT NOT NULL CHECK (length(deployment_fingerprint) = 64),
        canary_job_id TEXT NOT NULL REFERENCES tapo_history_export_jobs(id) ON DELETE CASCADE,
        acceptance_revision TEXT NOT NULL CHECK (length(acceptance_revision) = 64),
        schema_signature TEXT NOT NULL CHECK (length(schema_signature) = 64),
        approved_at TEXT NOT NULL,
        PRIMARY KEY (deployment_fingerprint, canary_job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tapo_history_canary_approvals_approved
        ON tapo_history_canary_approvals(approved_at, deployment_fingerprint);
      CREATE TABLE IF NOT EXISTS tapo_history_export_staged_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES tapo_history_export_jobs(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
        value REAL NOT NULL,
        canonical_unit TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'tp-link' CHECK (source = 'tp-link'),
        quality TEXT NOT NULL CHECK (quality IN ('good', 'estimated', 'stale')),
        source_identity TEXT NOT NULL CHECK (length(trim(source_identity)) BETWEEN 1 AND 1000),
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        UNIQUE(job_id, metric, source_identity)
      );
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_staged_lookup
        ON tapo_history_export_staged_samples(sensor_id, metric, timestamp, consumed_at, id);
      CREATE INDEX IF NOT EXISTS idx_tapo_history_export_staged_job
        ON tapo_history_export_staged_samples(job_id, consumed_at, id);
      INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
        SELECT 'outdoor_temperature_samples', json_array(house_id, location_key, timestamp, source)
        FROM outdoor_temperature_samples ORDER BY timestamp, house_id, location_key, source;
      INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
        SELECT 'electricity_price_samples', json_array(property_id, start_at)
        FROM electricity_price_points ORDER BY start_at, property_id;
      -- Outdoor/electricity paging originally used SQLite's implicit rowid.
      -- Rewind only those local cursors once when adopting explicit monotonic
      -- IDs so every existing natural key is replayed idempotently.
      DELETE FROM metadata
      WHERE key IN (
        'telemetry_archive_checkpoint:outdoor_temperature_samples',
        'telemetry_archive_checkpoint:electricity_price_samples'
      )
        AND COALESCE((SELECT value FROM metadata
          WHERE key = 'telemetry_archive_cursor_format'), '') <> 'explicit-archive-id-v1';
      INSERT INTO metadata(key, value)
        VALUES ('telemetry_archive_cursor_format', 'explicit-archive-id-v1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_insert
        AFTER INSERT ON outdoor_temperature_samples BEGIN
          INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
          VALUES ('outdoor_temperature_samples', json_array(NEW.house_id, NEW.location_key, NEW.timestamp, NEW.source));
        END;
      CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_delete
        AFTER DELETE ON outdoor_temperature_samples BEGIN
          DELETE FROM telemetry_archive_row_ids
          WHERE table_name = 'outdoor_temperature_samples'
            AND natural_key = json_array(OLD.house_id, OLD.location_key, OLD.timestamp, OLD.source);
          DELETE FROM telemetry_archive_dirty_rows
          WHERE table_name = 'outdoor_temperature_samples'
            AND natural_key = json_array(OLD.house_id, OLD.location_key, OLD.timestamp, OLD.source);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_electricity_price_insert
        AFTER INSERT ON electricity_price_points BEGIN
          INSERT OR IGNORE INTO telemetry_archive_row_ids(table_name, natural_key)
          VALUES ('electricity_price_samples', json_array(NEW.property_id, NEW.start_at));
        END;
      CREATE TRIGGER IF NOT EXISTS archive_electricity_price_delete
        AFTER DELETE ON electricity_price_points BEGIN
          DELETE FROM telemetry_archive_row_ids
          WHERE table_name = 'electricity_price_samples'
            AND natural_key = json_array(OLD.property_id, OLD.start_at);
          DELETE FROM telemetry_archive_dirty_rows
          WHERE table_name = 'electricity_price_samples'
            AND natural_key = json_array(OLD.property_id, OLD.start_at);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_legacy_reading_delete
        AFTER DELETE ON readings BEGIN
          DELETE FROM telemetry_archive_dirty_rows
          WHERE table_name = 'legacy_readings'
            AND natural_key = json_array(OLD.sensor_id, OLD.timestamp, OLD.source);
        END;
      CREATE TRIGGER IF NOT EXISTS archive_legacy_reading_update
        AFTER UPDATE ON readings BEGIN
          INSERT INTO telemetry_archive_dirty_rows(table_name, natural_key, changed_at)
          VALUES ('legacy_readings', json_array(NEW.sensor_id, NEW.timestamp, NEW.source),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(table_name, natural_key) DO UPDATE SET
            changed_at = excluded.changed_at, version = telemetry_archive_dirty_rows.version + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS archive_outdoor_temperature_update
        AFTER UPDATE ON outdoor_temperature_samples BEGIN
          INSERT INTO telemetry_archive_dirty_rows(table_name, natural_key, changed_at)
          VALUES ('outdoor_temperature_samples',
            json_array(NEW.house_id, NEW.location_key, NEW.timestamp, NEW.source),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(table_name, natural_key) DO UPDATE SET
            changed_at = excluded.changed_at, version = telemetry_archive_dirty_rows.version + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS archive_electricity_price_update
        AFTER UPDATE ON electricity_price_points BEGIN
          INSERT INTO telemetry_archive_dirty_rows(table_name, natural_key, changed_at)
          VALUES ('electricity_price_samples', json_array(NEW.property_id, NEW.start_at),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(table_name, natural_key) DO UPDATE SET
            changed_at = excluded.changed_at, version = telemetry_archive_dirty_rows.version + 1;
        END;
      CREATE TRIGGER IF NOT EXISTS retire_property_telemetry_id
        AFTER DELETE ON properties BEGIN
          INSERT OR IGNORE INTO retired_telemetry_resource_ids(resource_type, resource_id, retired_at)
          VALUES ('property', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        END;
      CREATE TRIGGER IF NOT EXISTS retire_house_telemetry_id
        AFTER DELETE ON houses BEGIN
          INSERT OR IGNORE INTO retired_telemetry_resource_ids(resource_type, resource_id, retired_at)
          VALUES ('house', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        END;
      CREATE TRIGGER IF NOT EXISTS retire_sensor_telemetry_id
        AFTER DELETE ON sensors BEGIN
          INSERT OR IGNORE INTO retired_telemetry_resource_ids(resource_type, resource_id, retired_at)
          VALUES ('sensor', OLD.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        END;
      CREATE TRIGGER IF NOT EXISTS prevent_retired_property_telemetry_id
        BEFORE INSERT ON properties
        WHEN EXISTS (SELECT 1 FROM retired_telemetry_resource_ids WHERE resource_type = 'property' AND resource_id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'RETIRED_PROPERTY_ID'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_retired_house_telemetry_id
        BEFORE INSERT ON houses
        WHEN EXISTS (SELECT 1 FROM retired_telemetry_resource_ids WHERE resource_type = 'house' AND resource_id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'RETIRED_HOUSE_ID'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_retired_sensor_telemetry_id
        BEFORE INSERT ON sensors
        WHEN EXISTS (SELECT 1 FROM retired_telemetry_resource_ids WHERE resource_type = 'sensor' AND resource_id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'RETIRED_SENSOR_ID'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_insert_in_real_mode
        BEFORE INSERT ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_reading_update_in_real_mode
        BEFORE UPDATE OF source ON readings
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_insert_in_real_mode
        BEFORE INSERT ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
          AND EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real')
        BEGIN SELECT RAISE(ABORT, 'DEMO_DATA_DISABLED'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_demo_measurement_update_in_real_mode
        BEFORE UPDATE OF source ON measurement_samples
        WHEN NEW.source IN ('mock', 'replay')
`;
