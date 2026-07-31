export const CORE_SCHEMA_06 = `
      CREATE TABLE IF NOT EXISTS external_source_gateways (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL CHECK (length(trim(adapter)) BETWEEN 1 AND 64),
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        receiver_identity TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (adapter, house_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_source_one_enabled_adapter
        ON external_source_gateways(adapter) WHERE enabled = 1;

      CREATE TABLE IF NOT EXISTS external_source_candidates (
        id TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL REFERENCES external_source_gateways(id) ON DELETE CASCADE,
        provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 64),
        sender_id TEXT NOT NULL CHECK (length(sender_id) BETWEEN 1 AND 32),
        channel INTEGER NOT NULL CHECK (channel BETWEEN 0 AND 255),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        sample_json TEXT NOT NULL CHECK (json_valid(sample_json) AND length(sample_json) <= 2048),
        UNIQUE (gateway_id, provider_key)
      );
      CREATE INDEX IF NOT EXISTS idx_external_source_candidates_expiry
        ON external_source_candidates(gateway_id, expires_at, last_seen_at);

      CREATE TABLE IF NOT EXISTS external_source_bindings (
        id TEXT PRIMARY KEY,
        gateway_id TEXT NOT NULL REFERENCES external_source_gateways(id) ON DELETE CASCADE,
        sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
        provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 1 AND 64),
        sender_id TEXT NOT NULL CHECK (length(sender_id) BETWEEN 1 AND 32),
        channel INTEGER NOT NULL CHECK (channel BETWEEN 0 AND 255),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        battery_state TEXT CHECK (battery_state IS NULL OR battery_state IN ('ok', 'low')),
        signal_quality INTEGER CHECK (signal_quality IS NULL OR signal_quality BETWEEN 0 AND 100),
        available INTEGER NOT NULL DEFAULT 0 CHECK (available IN (0, 1)),
        last_seen_at TEXT,
        last_accepted_at TEXT,
        last_temperature REAL,
        last_humidity REAL,
        pending_temperature REAL,
        pending_humidity REAL,
        pending_at TEXT,
        created_at TEXT NOT NULL,
        retired_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_source_active_provider
        ON external_source_bindings(gateway_id, provider_key) WHERE active = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_source_active_sensor
        ON external_source_bindings(gateway_id, sensor_id) WHERE active = 1;
      CREATE INDEX IF NOT EXISTS idx_external_source_binding_sensor
        ON external_source_bindings(sensor_id, active);

      CREATE TABLE IF NOT EXISTS external_observation_receipts (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES external_source_bindings(id) ON DELETE CASCADE,
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_external_observation_receipts_recent
        ON external_observation_receipts(binding_id, received_at DESC);
      `;
