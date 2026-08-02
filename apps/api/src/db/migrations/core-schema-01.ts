export const CORE_SCHEMA_01 = `
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS integration_mapping_sets (
        kind TEXT PRIMARY KEY CHECK (length(trim(kind)) > 0),
        content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        mappings_json TEXT NOT NULL CHECK (json_valid(mappings_json) AND json_type(mappings_json) = 'array'),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retired_telemetry_resource_ids (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('property', 'house', 'sensor')),
        resource_id TEXT NOT NULL,
        retired_at TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id)
      );
      CREATE TABLE IF NOT EXISTS telemetry_archive_row_ids (
        archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL CHECK (table_name IN (
          'outdoor_temperature_samples', 'electricity_price_samples', 'opening_state_samples'
        )),
        natural_key TEXT NOT NULL,
        UNIQUE (table_name, natural_key)
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_archive_row_ids_page
        ON telemetry_archive_row_ids(table_name, archive_id);
      CREATE TABLE IF NOT EXISTS telemetry_archive_dirty_rows (
        dirty_id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL CHECK (table_name IN ('legacy_readings', 'outdoor_temperature_samples', 'electricity_price_samples')),
        natural_key TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        UNIQUE (table_name, natural_key)
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_archive_dirty_rows_page
        ON telemetry_archive_dirty_rows(table_name, dirty_id);
      CREATE TABLE IF NOT EXISTS local_auth_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_n INTEGER NOT NULL CHECK (password_n >= 16384),
        password_r INTEGER NOT NULL CHECK (password_r >= 8),
        password_p INTEGER NOT NULL CHECK (password_p >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_workspace_members (
        user_id TEXT PRIMARY KEY REFERENCES local_auth_users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
        joined_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_workspace_invitations (
        email TEXT PRIMARY KEY COLLATE NOCASE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
        invited_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        invited_by_user_id TEXT REFERENCES local_auth_users(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS local_guest_access_grants (
        subject_type TEXT NOT NULL CHECK (subject_type IN ('member', 'invitation')),
        subject_key TEXT NOT NULL COLLATE NOCASE,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('property', 'house', 'area')),
        scope_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (subject_type, subject_key, scope_type, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_local_guest_access_subject
        ON local_guest_access_grants(subject_type, subject_key);
      CREATE TABLE IF NOT EXISTS local_auth_sessions (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        user_id TEXT NOT NULL REFERENCES local_auth_users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_auth_sessions_user
        ON local_auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_local_auth_sessions_expiry
        ON local_auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS properties (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        description TEXT,
        default_house_id TEXT REFERENCES houses(id) ON DELETE SET NULL,
        location_json TEXT,
        stugby_json TEXT CHECK (stugby_json IS NULL OR json_valid(stugby_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS property_electricity_configs (
        property_id TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('porssisahko', 'custom')),
        endpoint_url TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        margin_cents_per_kwh REAL NOT NULL DEFAULT 0,
        contract_type TEXT NOT NULL CHECK (contract_type IN ('spot', 'fixed', 'other')),
        contract_name TEXT,
        retailer TEXT,
        monthly_fee_eur REAL CHECK (monthly_fee_eur IS NULL OR monthly_fee_eur >= 0),
        last_fetched_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS electricity_price_points (
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        raw_price_cents_per_kwh REAL NOT NULL,
        margin_cents_per_kwh REAL NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (property_id, start_at)
      );
      CREATE INDEX IF NOT EXISTS idx_electricity_price_property_end
        ON electricity_price_points(property_id, end_at);
      CREATE TABLE IF NOT EXISTS houses (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        location_json TEXT,
        map_placement_json TEXT,
        orientation_degrees REAL CHECK (orientation_degrees >= 0 AND orientation_degrees < 360),
        floors_json TEXT NOT NULL,
        stugby_json TEXT CHECK (stugby_json IS NULL OR json_valid(stugby_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ios_notification_registrations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES local_auth_users(id) ON DELETE CASCADE,
        device_token TEXT NOT NULL CHECK(length(device_token) BETWEEN 64 AND 200),
        environment TEXT NOT NULL CHECK(environment IN ('sandbox', 'production')),
        minimum_severity TEXT NOT NULL CHECK(minimum_severity IN ('info', 'warning', 'critical')),
        include_details INTEGER NOT NULL CHECK(include_details IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(environment, device_token)
      );
      CREATE TABLE IF NOT EXISTS ios_notification_subscriptions (
        registration_id TEXT NOT NULL REFERENCES ios_notification_registrations(id) ON DELETE CASCADE,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        PRIMARY KEY(registration_id, house_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ios_notification_subscriptions_house
        ON ios_notification_subscriptions(house_id, registration_id);
      CREATE TABLE IF NOT EXISTS opening_state_observations (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'unknown')),
        open_fraction REAL CHECK (open_fraction IS NULL OR (open_fraction >= 0 AND open_fraction <= 1)),
        source TEXT NOT NULL CHECK (source IN ('manual', 'home-assistant', 'tapo', 'api')),
        observed_at TEXT NOT NULL,
        valid_until TEXT,
        external_id TEXT,
        connection_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opening_state_house_element_time
        ON opening_state_observations(house_id, floor_id, element_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_opening_state_external_time
        ON opening_state_observations(source, external_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS analytics_daily_findings (
        house_id TEXT PRIMARY KEY REFERENCES houses(id) ON DELETE CASCADE,
        data_mode TEXT NOT NULL CHECK (data_mode IN ('live', 'demo')),
        evaluated_through TEXT,
        generated_at TEXT,
        algorithm_version TEXT,
        snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
        last_attempt_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS property_areas (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        kind TEXT NOT NULL CHECK (kind IN (
          'well', 'beach', 'garage', 'plantation', 'garden', 'field', 'forest', 'shoreline', 'dock', 'road',
          'yard', 'building', 'other'
        )),
        description TEXT,
        location_json TEXT,
        polygon_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(property_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_property_areas_property_name
        ON property_areas(property_id, name, id);
      CREATE TRIGGER IF NOT EXISTS delete_property_guest_grants
        AFTER DELETE ON properties BEGIN
          DELETE FROM local_guest_access_grants WHERE scope_type = 'property' AND scope_id = OLD.id;
        END;
      CREATE TRIGGER IF NOT EXISTS delete_house_guest_grants
        AFTER DELETE ON houses BEGIN
          DELETE FROM local_guest_access_grants WHERE scope_type = 'house' AND scope_id = OLD.id;
        END;
      CREATE TRIGGER IF NOT EXISTS delete_area_guest_grants
        AFTER DELETE ON property_areas BEGIN
          DELETE FROM local_guest_access_grants WHERE scope_type = 'area' AND scope_id = OLD.id;
        END;
      CREATE TABLE IF NOT EXISTS area_equipment (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
        house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
        location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
        name TEXT NOT NULL CHECK (length(trim(name)) > 0),
        kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
        manufacturer TEXT,
        model TEXT,
        serial_number TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'out-of-service', 'retired')),
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((area_id IS NOT NULL) + (house_id IS NOT NULL) <= 1)
      );
      CREATE INDEX IF NOT EXISTS idx_area_equipment_property_area_name
        ON area_equipment(property_id, area_id, name, id);
      CREATE INDEX IF NOT EXISTS idx_area_equipment_area_name
        ON area_equipment(area_id, name, id);
      CREATE INDEX IF NOT EXISTS idx_area_equipment_house_name
        ON area_equipment(house_id, name, id) WHERE house_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS equipment_attachments (
        id TEXT PRIMARY KEY,
        equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('photo', 'document')),
        name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 255),
        mime_type TEXT NOT NULL CHECK (length(trim(mime_type)) BETWEEN 1 AND 200),
        data BLOB NOT NULL,
        size INTEGER NOT NULL CHECK (size > 0 AND size <= 10485760),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equipment_attachments_equipment_created
        ON equipment_attachments(equipment_id, created_at DESC, id);
      CREATE TABLE IF NOT EXISTS equipment_links (
        id TEXT PRIMARY KEY,
        equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
        url TEXT NOT NULL CHECK (length(trim(url)) BETWEEN 1 AND 2048),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equipment_links_equipment_label
        ON equipment_links(equipment_id, label, id);
      CREATE TABLE IF NOT EXISTS property_notes (
        id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
        house_id TEXT REFERENCES houses(id) ON DELETE RESTRICT,
        area_id TEXT REFERENCES property_areas(id) ON DELETE RESTRICT,
        equipment_id TEXT REFERENCES area_equipment(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('note', 'inspection', 'maintenance')),
        text TEXT NOT NULL CHECK (length(trim(text)) > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_property_notes_property_updated
        ON property_notes(property_id, updated_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_property_notes_house_updated
        ON property_notes(house_id, updated_at DESC, id) WHERE house_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_property_notes_area_updated
        ON property_notes(area_id, updated_at DESC, id) WHERE area_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_property_notes_equipment_updated
        ON property_notes(equipment_id, updated_at DESC, id) WHERE equipment_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS sensors (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        name TEXT NOT NULL,
        room_id TEXT,
        room TEXT NOT NULL,
        model TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        z REAL NOT NULL,
        temperature_entity_id TEXT,
        humidity_entity_id TEXT,
        battery_entity_id TEXT,
        tp_link_device_id TEXT,
        tp_link_connection_id TEXT,
        measurement_entity_ids_json TEXT,
        energy_meter_role TEXT NOT NULL DEFAULT 'standalone'
          CHECK (energy_meter_role IN ('whole_home', 'submeter', 'standalone')),
        tags_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        temperature REAL NOT NULL,
        humidity REAL NOT NULL,
        battery REAL,
        source TEXT NOT NULL,
        quality TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_readings_sensor_time_id
        ON readings(sensor_id, timestamp DESC, id DESC);
      DROP INDEX IF EXISTS idx_readings_sensor_time;
      CREATE INDEX IF NOT EXISTS idx_readings_time
        ON readings(timestamp, id);
      CREATE TABLE IF NOT EXISTS measurement_definitions (
        id TEXT PRIMARY KEY,
        labels_json TEXT NOT NULL,
        unit TEXT NOT NULL,
        dimension TEXT NOT NULL DEFAULT 'finite_scalar',
        allowed_units_json TEXT NOT NULL DEFAULT '[]',
        kind TEXT NOT NULL DEFAULT 'gauge',
        default_aggregation TEXT NOT NULL DEFAULT 'mean',
        generic_history_enabled INTEGER NOT NULL DEFAULT 1 CHECK (generic_history_enabled IN (0, 1)),
        generic_stats_enabled INTEGER NOT NULL DEFAULT 1 CHECK (generic_stats_enabled IN (0, 1)),
        precision INTEGER NOT NULL,
        valid_min REAL,
        valid_max REAL,
        display_min REAL,
        display_max REAL,
        interpolation_delta REAL NOT NULL,
        color_scale TEXT NOT NULL,
        builtin INTEGER NOT NULL CHECK (builtin IN (0, 1)),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        spatial_interpolation INTEGER NOT NULL CHECK (spatial_interpolation IN (0, 1)),
        forecast_supported INTEGER NOT NULL CHECK (forecast_supported IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS measurement_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id),
        value REAL NOT NULL,
        canonical_unit TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        quality TEXT NOT NULL,
        UNIQUE(sensor_id, metric, timestamp, source)
      );
      CREATE INDEX IF NOT EXISTS idx_measurement_samples_sensor_metric_time
        ON measurement_samples(sensor_id, metric, timestamp DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_measurement_samples_time
        ON measurement_samples(timestamp, id);
      CREATE TABLE IF NOT EXISTS sensor_measurement_bindings (
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL REFERENCES measurement_definitions(id),
        entity_id TEXT NOT NULL,
        PRIMARY KEY(sensor_id, metric)
      );
      CREATE INDEX IF NOT EXISTS idx_sensor_measurement_bindings_entity
        ON sensor_measurement_bindings(entity_id);
      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sensor_id TEXT REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        severity TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        webhook_enabled INTEGER NOT NULL,
        telegram_enabled INTEGER NOT NULL DEFAULT 0,
        delivery_policy_json TEXT NOT NULL DEFAULT '{}',
        retired_at TEXT
      );
      CREATE TABLE IF NOT EXISTS alert_events (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        value REAL NOT NULL,
        threshold REAL NOT NULL,
        severity TEXT NOT NULL,
        started_at TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alert_events_started ON alert_events(started_at DESC);
      CREATE TABLE IF NOT EXISTS alert_evaluation_state (
        rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        latest_timestamp TEXT NOT NULL,
        condition_since TEXT,
        PRIMARY KEY(rule_id, sensor_id)
      );
      CREATE TABLE IF NOT EXISTS alert_evaluation_queue (
        measurement_sample_id INTEGER PRIMARY KEY
          REFERENCES measurement_samples(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL DEFAULT 'alert' CHECK(subject_kind IN ('alert', 'maintenance', 'action-run', 'system')),
        subject_id TEXT NOT NULL,
        event_id TEXT REFERENCES alert_events(id) ON DELETE RESTRICT,
        stage TEXT NOT NULL DEFAULT 'initial' CHECK(stage IN ('initial', 'escalation', 'reminder', 'due', 'verification', 'resolved')),
        sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0),
        channel TEXT NOT NULL CHECK(channel IN ('webhook', 'telegram', 'apns')),
        destination_id TEXT NOT NULL DEFAULT 'primary',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 8 CHECK(max_attempts BETWEEN 1 AND 100),
        available_at TEXT NOT NULL,
        locked_at TEXT,
        lock_token TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        payload_json TEXT NOT NULL,
        destination_ref TEXT NOT NULL,
        policy_json TEXT NOT NULL DEFAULT '{}',
        dead_lettered_at TEXT,
        abandoned_at TEXT,
        UNIQUE(subject_kind, subject_id, stage, sequence, channel, destination_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT NOT NULL,
        sensor_id TEXT REFERENCES sensors(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        note TEXT NOT NULL,
        x REAL,
        y REAL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        time_precision TEXT NOT NULL DEFAULT 'exact'
          CHECK (time_precision IN ('exact', 'approximate', 'date-only', 'date-range', 'unknown')),
        valid_from TEXT,
        valid_to TEXT,
        source TEXT NOT NULL DEFAULT 'unknown'
          CHECK (source IN ('owner', 'caretaker', 'contractor', 'sensor', 'imported-document', 'automated-analysis', 'unknown')),
        source_detail TEXT,
        confidence TEXT NOT NULL DEFAULT 'uncertain'
          CHECK (confidence IN ('confirmed', 'probable', 'uncertain', 'awaiting-inspection')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        resolution_note TEXT,
        resolved_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'open' AND resolution_note IS NULL AND resolved_at IS NULL)
          OR
          (status = 'resolved' AND resolution_note IS NOT NULL AND length(trim(resolution_note)) > 0 AND resolved_at IS NOT NULL)
        )
      );
      CREATE TRIGGER IF NOT EXISTS validate_observation_floor_insert
        BEFORE INSERT ON observations
        WHEN NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS validate_observation_floor_update
        BEFORE UPDATE OF house_id, floor_id ON observations
        WHEN NOT EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_FLOOR_NOT_FOUND'); END;
      CREATE TRIGGER IF NOT EXISTS validate_observation_bounds_insert
        BEFORE INSERT ON observations
        WHEN NEW.x IS NOT NULL AND NEW.y IS NOT NULL AND EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
            AND (NEW.x < 0 OR NEW.x > CAST(json_extract(floor.value, '$.width') AS REAL)
              OR NEW.y < 0 OR NEW.y > CAST(json_extract(floor.value, '$.height') AS REAL))
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_OUT_OF_BOUNDS'); END;
      CREATE TRIGGER IF NOT EXISTS validate_observation_bounds_update
        BEFORE UPDATE OF house_id, floor_id, x, y ON observations
        WHEN NEW.x IS NOT NULL AND NEW.y IS NOT NULL AND EXISTS (
          SELECT 1 FROM houses AS house, json_each(house.floors_json) AS floor
          WHERE house.id = NEW.house_id
            AND json_extract(floor.value, '$.id') = NEW.floor_id
            AND (NEW.x < 0 OR NEW.x > CAST(json_extract(floor.value, '$.width') AS REAL)
              OR NEW.y < 0 OR NEW.y > CAST(json_extract(floor.value, '$.height') AS REAL))
        )
        BEGIN SELECT RAISE(ABORT, 'OBSERVATION_OUT_OF_BOUNDS'); END;
      CREATE TRIGGER IF NOT EXISTS prevent_house_floor_orphaned_observation
        BEFORE UPDATE OF floors_json ON houses
        WHEN NEW.floors_json <> OLD.floors_json AND EXISTS (
`;
