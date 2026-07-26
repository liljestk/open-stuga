import type { DatabaseSync } from "node:sqlite";

export function initializeTrackingSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tracking_property_settings (
      property_id TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      property_boundary_json TEXT NOT NULL CHECK (json_valid(property_boundary_json)),
      live_nearby_seconds INTEGER NOT NULL CHECK (live_nearby_seconds BETWEEN 1 AND 300),
      recently_seen_seconds INTEGER NOT NULL CHECK (recently_seen_seconds BETWEEN 10 AND 3600),
      stale_seconds INTEGER NOT NULL CHECK (stale_seconds BETWEEN 60 AND 86400),
      unknown_seconds INTEGER NOT NULL CHECK (unknown_seconds BETWEEN 300 AND 2592000),
      movement_threshold_meters REAL NOT NULL CHECK (movement_threshold_meters BETWEEN 1 AND 1000),
      movement_maximum_interval_seconds INTEGER NOT NULL CHECK (movement_maximum_interval_seconds BETWEEN 5 AND 3600),
      minimum_movement_confidence REAL NOT NULL CHECK (minimum_movement_confidence BETWEEN 0 AND 1),
      exit_alert_debounce_seconds INTEGER NOT NULL CHECK (exit_alert_debounce_seconds BETWEEN 5 AND 3600),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracking_tags (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      serial_number TEXT NOT NULL,
      hardware_model TEXT NOT NULL,
      firmware_version TEXT,
      protocol_version INTEGER NOT NULL CHECK (protocol_version BETWEEN 0 AND 3),
      rotation_window_minutes INTEGER NOT NULL CHECK (rotation_window_minutes BETWEEN 5 AND 60),
      secret_envelope TEXT NOT NULL,
      battery_type TEXT,
      battery_percent INTEGER CHECK (battery_percent IS NULL OR battery_percent BETWEEN 0 AND 100),
      capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
      status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'disabled', 'retired')),
      paired_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, serial_number)
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_tags_property_status
      ON tracking_tags(property_id, status, id);

    CREATE TABLE IF NOT EXISTS tracking_asset_tag_assignments (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE RESTRICT,
      tag_id TEXT NOT NULL REFERENCES tracking_tags(id) ON DELETE RESTRICT,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      assigned_by TEXT NOT NULL,
      CHECK (valid_to IS NULL OR valid_to >= valid_from)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_assignment_active_tag
      ON tracking_asset_tag_assignments(tag_id) WHERE valid_to IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_assignment_active_equipment
      ON tracking_asset_tag_assignments(equipment_id) WHERE valid_to IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tracking_assignment_equipment_history
      ON tracking_asset_tag_assignments(equipment_id, valid_from DESC);

    CREATE TABLE IF NOT EXISTS tracking_observers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      type TEXT NOT NULL CHECK (type IN (
        'esp32-gateway', 'linux-gateway', 'android-gateway', 'android-phone', 'ios-phone'
      )),
      name TEXT NOT NULL,
      trust_level REAL NOT NULL CHECK (trust_level BETWEEN 0 AND 1),
      fixed_position_json TEXT CHECK (fixed_position_json IS NULL OR json_valid(fixed_position_json)),
      fixed_position_accuracy_meters REAL CHECK (
        fixed_position_accuracy_meters IS NULL OR fixed_position_accuracy_meters BETWEEN 0.1 AND 10000
      ),
      zone_id TEXT REFERENCES property_areas(id) ON DELETE SET NULL,
      app_installation_id TEXT,
      created_by_user_id TEXT,
      hardware_metadata_json TEXT NOT NULL CHECK (json_valid(hardware_metadata_json)),
      last_heartbeat_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('online', 'offline', 'degraded', 'disabled')),
      credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(property_id, app_installation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_observers_property_status
      ON tracking_observers(property_id, status, type, id);

    CREATE TABLE IF NOT EXISTS tracking_observations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      tag_id TEXT REFERENCES tracking_tags(id) ON DELETE RESTRICT,
      observer_id TEXT NOT NULL REFERENCES tracking_observers(id) ON DELETE RESTRICT,
      observer_type TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      rotating_tag_id TEXT NOT NULL,
      protocol_version INTEGER NOT NULL,
      epoch_counter INTEGER NOT NULL,
      event_counter INTEGER NOT NULL,
      rssi INTEGER NOT NULL,
      tx_power INTEGER,
      motion INTEGER NOT NULL CHECK (motion IN (0, 1)),
      battery_percent INTEGER CHECK (battery_percent IS NULL OR battery_percent BETWEEN 0 AND 100),
      observer_position_json TEXT CHECK (observer_position_json IS NULL OR json_valid(observer_position_json)),
      scan_mode TEXT NOT NULL CHECK (scan_mode IN (
        'passive', 'property', 'active-property', 'find-nearby', 'gateway'
      )),
      app_state TEXT CHECK (app_state IS NULL OR app_state IN ('foreground', 'background', 'suspended')),
      device_time_offset_ms INTEGER,
      quality_flags_json TEXT NOT NULL CHECK (json_valid(quality_flags_json)),
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      raw_payload TEXT,
      dedup_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_observations_tag_time
      ON tracking_observations(tag_id, observed_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_tracking_observations_property_time
      ON tracking_observations(property_id, observed_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_tracking_observations_observer_time
      ON tracking_observations(observer_id, observed_at DESC, id);

    CREATE TABLE IF NOT EXISTS asset_position_estimates (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE RESTRICT,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      calculated_at TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      position_type TEXT NOT NULL CHECK (position_type IN (
        'confirmed-zone', 'estimated-coordinate', 'nearby-live', 'last-known', 'unknown'
      )),
      coordinate_json TEXT CHECK (coordinate_json IS NULL OR json_valid(coordinate_json)),
      accuracy_radius_meters REAL CHECK (accuracy_radius_meters IS NULL OR accuracy_radius_meters >= 0),
      zone_id TEXT REFERENCES property_areas(id) ON DELETE SET NULL,
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low')),
      movement_state TEXT NOT NULL CHECK (movement_state IN ('moving', 'stationary', 'unknown')),
      freshness_state TEXT NOT NULL CHECK (freshness_state IN ('live', 'recent', 'last-known', 'stale', 'unknown')),
      last_observed_at TEXT,
      observer_count INTEGER NOT NULL CHECK (observer_count >= 0),
      algorithm_version TEXT NOT NULL,
      evidence_observation_ids_json TEXT NOT NULL CHECK (json_valid(evidence_observation_ids_json)),
      explanation_json TEXT NOT NULL CHECK (json_valid(explanation_json)),
      version INTEGER NOT NULL CHECK (version > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_asset_position_estimates_asset_time
      ON asset_position_estimates(equipment_id, effective_at DESC, version DESC);

    CREATE TABLE IF NOT EXISTS asset_current_positions (
      equipment_id TEXT PRIMARY KEY REFERENCES area_equipment(id) ON DELETE RESTRICT,
      latest_estimate_id TEXT NOT NULL REFERENCES asset_position_estimates(id) ON DELETE RESTRICT,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_asset_current_positions_property
      ON asset_current_positions(property_id, updated_at DESC, equipment_id);

    CREATE TABLE IF NOT EXISTS tracking_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      entity_id TEXT NOT NULL,
      event_at TEXT NOT NULL,
      state_version INTEGER NOT NULL,
      evidence_observation_ids_json TEXT NOT NULL CHECK (json_valid(evidence_observation_ids_json)),
      state_json TEXT NOT NULL CHECK (json_valid(state_json))
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_events_property_sequence
      ON tracking_events(property_id, sequence);

    CREATE TABLE IF NOT EXISTS tracking_boundary_states (
      equipment_id TEXT PRIMARY KEY REFERENCES area_equipment(id) ON DELETE CASCADE,
      confirmed_inside INTEGER CHECK (confirmed_inside IS NULL OR confirmed_inside IN (0, 1)),
      candidate_inside INTEGER CHECK (candidate_inside IS NULL OR candidate_inside IN (0, 1)),
      candidate_since TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment_loans (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE CASCADE,
      borrower_user_id TEXT NOT NULL,
      borrower_label TEXT NOT NULL,
      borrowed_at TEXT NOT NULL,
      expected_return_at TEXT,
      note TEXT,
      returned_at TEXT,
      returned_by_user_id TEXT,
      returned_by_label TEXT,
      return_note TEXT,
      CHECK (expected_return_at IS NULL OR expected_return_at > borrowed_at),
      CHECK (returned_at IS NULL OR returned_at >= borrowed_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_loans_active_equipment
      ON equipment_loans(equipment_id) WHERE returned_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_equipment_loans_property_time
      ON equipment_loans(property_id, borrowed_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_equipment_loans_equipment_time
      ON equipment_loans(equipment_id, borrowed_at DESC, id);

    CREATE TABLE IF NOT EXISTS property_member_locations (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      member_label TEXT NOT NULL,
      coordinate_json TEXT NOT NULL CHECK (json_valid(coordinate_json)),
      horizontal_accuracy_meters REAL NOT NULL CHECK (
        horizontal_accuracy_meters BETWEEN 0 AND 10000
      ),
      reduced_accuracy INTEGER NOT NULL CHECK (reduced_accuracy IN (0, 1)),
      captured_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sharing_until TEXT NOT NULL,
      UNIQUE(property_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_property_member_locations_expiry
      ON property_member_locations(property_id, sharing_until, updated_at);

    CREATE TRIGGER IF NOT EXISTS validate_equipment_loan_scope_insert
      BEFORE INSERT ON equipment_loans
      WHEN NOT EXISTS (
        SELECT 1 FROM area_equipment equipment
        WHERE equipment.id = NEW.equipment_id
          AND equipment.property_id = NEW.property_id
      )
      BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_LOAN_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS validate_equipment_loan_scope_update
      BEFORE UPDATE OF property_id, equipment_id ON equipment_loans
      WHEN NOT EXISTS (
        SELECT 1 FROM area_equipment equipment
        WHERE equipment.id = NEW.equipment_id
          AND equipment.property_id = NEW.property_id
      )
      BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_LOAN_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS cascade_equipment_loan_scope_move
      AFTER UPDATE OF property_id ON area_equipment
      WHEN OLD.property_id <> NEW.property_id
      BEGIN
        UPDATE equipment_loans SET property_id = NEW.property_id
          WHERE equipment_id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS validate_tracking_assignment_scope_insert
      BEFORE INSERT ON tracking_asset_tag_assignments
      WHEN NOT EXISTS (
        SELECT 1
        FROM area_equipment equipment
        JOIN tracking_tags tag ON tag.id = NEW.tag_id
        WHERE equipment.id = NEW.equipment_id
          AND equipment.property_id = tag.property_id
      )
      BEGIN SELECT RAISE(ABORT, 'TRACKING_ASSIGNMENT_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS validate_tracking_assignment_scope_update
      BEFORE UPDATE OF equipment_id, tag_id, valid_to ON tracking_asset_tag_assignments
      WHEN NOT EXISTS (
        SELECT 1
        FROM area_equipment equipment
        JOIN tracking_tags tag ON tag.id = NEW.tag_id
        WHERE equipment.id = NEW.equipment_id
          AND equipment.property_id = tag.property_id
      )
      BEGIN SELECT RAISE(ABORT, 'TRACKING_ASSIGNMENT_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS prevent_tracked_equipment_property_move
      BEFORE UPDATE OF property_id ON area_equipment
      WHEN NEW.property_id <> OLD.property_id AND EXISTS (
        SELECT 1 FROM tracking_asset_tag_assignments assignment
        WHERE assignment.equipment_id = OLD.id AND assignment.valid_to IS NULL
      )
      BEGIN SELECT RAISE(ABORT, 'TRACKING_ASSIGNMENT_PROPERTY_MOVE'); END;
  `);
  const tagColumns = database.prepare("PRAGMA table_info(tracking_tags)").all() as unknown as Array<{ name: string }>;
  if (!tagColumns.some((column) => column.name === "battery_percent")) {
    database.exec("ALTER TABLE tracking_tags ADD COLUMN battery_percent INTEGER CHECK (battery_percent IS NULL OR battery_percent BETWEEN 0 AND 100)");
  }
}
