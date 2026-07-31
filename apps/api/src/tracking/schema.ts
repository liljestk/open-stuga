import type { DatabaseSync } from "node:sqlite";
import { migrateEmptyLegacyTrackingSchema } from "./schema-migration.js";

export function initializeTrackingSchema(database: DatabaseSync): void {
  migrateEmptyLegacyTrackingSchema(database);
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
      observation_retention_days INTEGER NOT NULL CHECK (observation_retention_days BETWEEN 1 AND 365),
      rollup_retention_days INTEGER NOT NULL CHECK (rollup_retention_days BETWEEN 1 AND 1825),
      estimate_retention_days INTEGER NOT NULL CHECK (estimate_retention_days BETWEEN 1 AND 3650),
      updated_at TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS tracking_endpoints (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      profile_id TEXT NOT NULL,
      profile_version TEXT NOT NULL,
      identity_namespace_version INTEGER NOT NULL CHECK (identity_namespace_version > 0),
      identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
      identity_envelope TEXT NOT NULL,
      identity_reference TEXT NOT NULL,
      identity_scope TEXT NOT NULL CHECK (identity_scope IN ('NONE','OBSERVER','PROPERTY','TENANT','GLOBAL')),
      identity_strength TEXT NOT NULL CHECK (
        identity_strength IN ('HEURISTIC','STATIC_CLEAR','PAIRED_RESOLVABLE','CRYPTOGRAPHIC')
      ),
      observer_scope_id TEXT REFERENCES tracking_observers(id) ON DELETE RESTRICT,
      observer_scope_key TEXT NOT NULL,
      trackability_tier TEXT NOT NULL CHECK (
        trackability_tier IN ('DISCOVERED_ONLY','OBSERVER_LOCAL','PROPERTY_BEACON','VERIFIED_TRACKER','EXTERNAL_PROVIDER')
      ),
      display_name TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      firmware_version TEXT,
      claim_status TEXT NOT NULL CHECK (claim_status IN ('PENDING','CLAIMED','DEGRADED','REVOKED','RETIRED')),
      proof_kind TEXT CHECK (proof_kind IS NULL OR proof_kind IN (
        'PHYSICAL_ACCESS','GATT_CHALLENGE','VENDOR_ATTESTATION','CRYPTOGRAPHIC_CHALLENGE','EXTERNAL_ACCOUNT'
      )),
      proof_verified_at TEXT,
      last_seen_at TEXT,
      telemetry_json TEXT NOT NULL CHECK (json_valid(telemetry_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (identity_scope = 'OBSERVER' AND observer_scope_id IS NOT NULL AND observer_scope_key = observer_scope_id)
        OR (identity_scope <> 'OBSERVER' AND observer_scope_id IS NULL AND observer_scope_key = '')
      ),
      UNIQUE(tenant_id, profile_id, profile_version, identity_namespace_version, identity_hash, observer_scope_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_endpoints_property_status
      ON tracking_endpoints(property_id, claim_status, id);

    CREATE TABLE IF NOT EXISTS equipment_tracking_bindings (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE RESTRICT,
      endpoint_id TEXT NOT NULL REFERENCES tracking_endpoints(id) ON DELETE RESTRICT,
      observer_id TEXT REFERENCES tracking_observers(id) ON DELETE RESTRICT,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      bound_by TEXT NOT NULL,
      CHECK (valid_to IS NULL OR valid_to >= valid_from)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_binding_active_endpoint
      ON equipment_tracking_bindings(endpoint_id) WHERE valid_to IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_binding_active_equipment
      ON equipment_tracking_bindings(equipment_id) WHERE valid_to IS NULL;
    CREATE INDEX IF NOT EXISTS idx_tracking_binding_equipment_history
      ON equipment_tracking_bindings(equipment_id, valid_from DESC);

    CREATE TABLE IF NOT EXISTS tracking_observations (
      id TEXT PRIMARY KEY,
      data_mode TEXT NOT NULL CHECK (data_mode IN ('live','demo')),
      tenant_id TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      endpoint_id TEXT NOT NULL REFERENCES tracking_endpoints(id) ON DELETE RESTRICT,
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE RESTRICT,
      binding_id TEXT NOT NULL REFERENCES equipment_tracking_bindings(id) ON DELETE RESTRICT,
      observer_id TEXT NOT NULL REFERENCES tracking_observers(id) ON DELETE RESTRICT,
      observer_type TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_version TEXT NOT NULL,
      rssi INTEGER NOT NULL CHECK (rssi BETWEEN -127 AND 20),
      tx_power INTEGER CHECK (tx_power IS NULL OR tx_power BETWEEN -127 AND 20),
      battery_percent INTEGER CHECK (battery_percent IS NULL OR battery_percent BETWEEN 0 AND 100),
      motion INTEGER CHECK (motion IS NULL OR motion IN (0, 1)),
      counter INTEGER CHECK (counter IS NULL OR counter >= 0),
      observer_position_json TEXT CHECK (observer_position_json IS NULL OR json_valid(observer_position_json)),
      scan_context TEXT NOT NULL CHECK (scan_context IN (
        'foreground','background','foreground-find','fixed-gateway','dedicated-android-gateway'
      )),
      quality_flags_json TEXT NOT NULL CHECK (json_valid(quality_flags_json)),
      trust REAL NOT NULL CHECK (trust BETWEEN 0 AND 1),
      telemetry_json TEXT NOT NULL CHECK (json_valid(telemetry_json)),
      idempotency_key TEXT NOT NULL,
      UNIQUE(observer_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_observations_equipment_time
      ON tracking_observations(equipment_id, data_mode, observed_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_tracking_observations_property_time
      ON tracking_observations(property_id, data_mode, observed_at DESC, id);

    CREATE TABLE IF NOT EXISTS tracking_gateway_rollups (
      id TEXT PRIMARY KEY,
      data_mode TEXT NOT NULL CHECK (data_mode IN ('live','demo')),
      tenant_id TEXT NOT NULL,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      endpoint_id TEXT NOT NULL REFERENCES tracking_endpoints(id) ON DELETE RESTRICT,
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE RESTRICT,
      binding_id TEXT NOT NULL REFERENCES equipment_tracking_bindings(id) ON DELETE RESTRICT,
      observer_id TEXT NOT NULL REFERENCES tracking_observers(id) ON DELETE RESTRICT,
      profile_id TEXT NOT NULL,
      profile_version TEXT NOT NULL,
      window_started_at TEXT NOT NULL,
      window_ended_at TEXT NOT NULL,
      packet_count INTEGER NOT NULL CHECK (packet_count > 0),
      rssi_minimum INTEGER NOT NULL,
      rssi_maximum INTEGER NOT NULL,
      rssi_mean REAL NOT NULL,
      rssi_variance REAL NOT NULL CHECK (rssi_variance >= 0),
      last_battery_percent INTEGER CHECK (last_battery_percent IS NULL OR last_battery_percent BETWEEN 0 AND 100),
      motion_observed INTEGER CHECK (motion_observed IS NULL OR motion_observed IN (0, 1)),
      first_counter INTEGER CHECK (first_counter IS NULL OR first_counter >= 0),
      last_counter INTEGER CHECK (last_counter IS NULL OR last_counter >= 0),
      telemetry_json TEXT NOT NULL CHECK (json_valid(telemetry_json)),
      received_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      UNIQUE(observer_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_rollups_equipment_time
      ON tracking_gateway_rollups(equipment_id, data_mode, window_ended_at DESC, id);

    CREATE TABLE IF NOT EXISTS equipment_location_estimates (
      id TEXT PRIMARY KEY,
      data_mode TEXT NOT NULL CHECK (data_mode IN ('live','demo')),
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE RESTRICT,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      endpoint_id TEXT NOT NULL REFERENCES tracking_endpoints(id) ON DELETE RESTRICT,
      calculated_at TEXT NOT NULL,
      effective_at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('coordinate','zone','area','nearby','unknown')),
      coordinate_json TEXT CHECK (coordinate_json IS NULL OR json_valid(coordinate_json)),
      uncertainty_radius_meters REAL CHECK (uncertainty_radius_meters IS NULL OR uncertainty_radius_meters >= 0),
      zone_id TEXT REFERENCES property_areas(id) ON DELETE SET NULL,
      confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
      truth_class TEXT NOT NULL CHECK (truth_class IN ('observed','derived','estimated','inferred','forecast','simulated')),
      source TEXT NOT NULL CHECK (source IN (
        'fixed-gateway','mobile-observer','multi-observer','manual','external-provider','none'
      )),
      freshness TEXT NOT NULL CHECK (freshness IN ('live','recent','aging','stale','unknown')),
      movement_state TEXT NOT NULL CHECK (movement_state IN ('moving','stationary','unknown')),
      last_observed_at TEXT,
      observer_count INTEGER NOT NULL CHECK (observer_count >= 0),
      provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
      version INTEGER NOT NULL CHECK (version > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_location_estimates_time
      ON equipment_location_estimates(equipment_id, data_mode, effective_at DESC, version DESC);

    CREATE TABLE IF NOT EXISTS equipment_current_locations (
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE RESTRICT,
      data_mode TEXT NOT NULL CHECK (data_mode IN ('live','demo')),
      latest_estimate_id TEXT NOT NULL REFERENCES equipment_location_estimates(id) ON DELETE RESTRICT,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL CHECK (version > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(equipment_id, data_mode)
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_current_locations_property
      ON equipment_current_locations(property_id, data_mode, updated_at DESC, equipment_id);

    CREATE TABLE IF NOT EXISTS tracking_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      data_mode TEXT NOT NULL CHECK (data_mode IN ('live','demo')),
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
      ON tracking_events(property_id, data_mode, sequence);

    CREATE TABLE IF NOT EXISTS tracking_boundary_states (
      equipment_id TEXT NOT NULL REFERENCES area_equipment(id) ON DELETE CASCADE,
      data_mode TEXT NOT NULL CHECK (data_mode IN ('live','demo')),
      confirmed_inside INTEGER CHECK (confirmed_inside IS NULL OR confirmed_inside IN (0, 1)),
      candidate_inside INTEGER CHECK (candidate_inside IS NULL OR candidate_inside IN (0, 1)),
      candidate_since TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(equipment_id, data_mode)
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

    CREATE TABLE IF NOT EXISTS property_member_locations (
      id TEXT PRIMARY KEY,
      property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      member_label TEXT NOT NULL,
      coordinate_json TEXT NOT NULL CHECK (json_valid(coordinate_json)),
      horizontal_accuracy_meters REAL NOT NULL CHECK (horizontal_accuracy_meters BETWEEN 0 AND 10000),
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
        WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
      )
      BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_LOAN_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS validate_equipment_loan_scope_update
      BEFORE UPDATE OF property_id, equipment_id ON equipment_loans
      WHEN NOT EXISTS (
        SELECT 1 FROM area_equipment equipment
        WHERE equipment.id = NEW.equipment_id AND equipment.property_id = NEW.property_id
      )
      BEGIN SELECT RAISE(ABORT, 'EQUIPMENT_LOAN_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS cascade_equipment_loan_scope_move
      AFTER UPDATE OF property_id ON area_equipment
      WHEN OLD.property_id <> NEW.property_id
      BEGIN
        UPDATE equipment_loans SET property_id = NEW.property_id WHERE equipment_id = NEW.id;
      END;

    CREATE TRIGGER IF NOT EXISTS validate_tracking_binding_scope_insert
      BEFORE INSERT ON equipment_tracking_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM area_equipment equipment
        JOIN tracking_endpoints endpoint ON endpoint.id = NEW.endpoint_id
        WHERE equipment.id = NEW.equipment_id
          AND equipment.property_id = NEW.property_id
          AND endpoint.property_id = NEW.property_id
          AND endpoint.claim_status IN ('CLAIMED','DEGRADED')
          AND (
            (endpoint.identity_scope = 'OBSERVER' AND endpoint.observer_scope_id = NEW.observer_id)
            OR (endpoint.identity_scope <> 'OBSERVER' AND NEW.observer_id IS NULL)
          )
      )
      BEGIN SELECT RAISE(ABORT, 'TRACKING_BINDING_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS validate_tracking_binding_scope_update
      BEFORE UPDATE OF property_id, equipment_id, endpoint_id, observer_id, valid_to ON equipment_tracking_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM area_equipment equipment
        JOIN tracking_endpoints endpoint ON endpoint.id = NEW.endpoint_id
        WHERE equipment.id = NEW.equipment_id
          AND equipment.property_id = NEW.property_id
          AND endpoint.property_id = NEW.property_id
          AND (
            (endpoint.identity_scope = 'OBSERVER' AND endpoint.observer_scope_id = NEW.observer_id)
            OR (endpoint.identity_scope <> 'OBSERVER' AND NEW.observer_id IS NULL)
          )
      )
      BEGIN SELECT RAISE(ABORT, 'TRACKING_BINDING_SCOPE'); END;

    CREATE TRIGGER IF NOT EXISTS prevent_bound_equipment_property_move
      BEFORE UPDATE OF property_id ON area_equipment
      WHEN NEW.property_id <> OLD.property_id AND EXISTS (
        SELECT 1 FROM equipment_tracking_bindings binding
        WHERE binding.equipment_id = OLD.id AND binding.valid_to IS NULL
      )
      BEGIN SELECT RAISE(ABORT, 'TRACKING_BINDING_PROPERTY_MOVE'); END;

  `);
}
