export const CORE_SCHEMA_05 = `
      CREATE TABLE IF NOT EXISTS connected_device_state_current (
        connection_id TEXT PRIMARY KEY CHECK (length(trim(connection_id)) BETWEEN 1 AND 200),
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        observed_at TEXT,
        received_at TEXT,
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      );
      CREATE INDEX IF NOT EXISTS idx_connected_device_state_house
        ON connected_device_state_current(house_id, received_at DESC);

      CREATE TABLE IF NOT EXISTS connected_device_placements (
        connection_id TEXT PRIMARY KEY CHECK (length(trim(connection_id)) BETWEEN 1 AND 200),
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        floor_id TEXT,
        room_id TEXT,
        x REAL,
        y REAL,
        z REAL,
        updated_at TEXT NOT NULL,
        CHECK (
          (floor_id IS NULL AND room_id IS NULL AND x IS NULL AND y IS NULL AND z IS NULL)
          OR
          (floor_id IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND z IS NOT NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_connected_device_placement_floor
        ON connected_device_placements(house_id, floor_id);

      CREATE TABLE IF NOT EXISTS connected_device_commands (
        connection_id TEXT NOT NULL CHECK (length(trim(connection_id)) BETWEEN 1 AND 200),
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) BETWEEN 1 AND 100),
        request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
        result_state_json TEXT CHECK (result_state_json IS NULL OR json_valid(result_state_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (connection_id, operation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_connected_device_commands_updated
        ON connected_device_commands(updated_at);
      `;
