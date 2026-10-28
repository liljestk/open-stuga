export const HEAT_PUMP_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS heat_pump_state_current (
        connection_id TEXT PRIMARY KEY CHECK (length(trim(connection_id)) BETWEEN 1 AND 200),
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      );
      CREATE INDEX IF NOT EXISTS idx_heat_pump_state_current_house
        ON heat_pump_state_current(house_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS heat_pump_state_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL CHECK (length(trim(connection_id)) BETWEEN 1 AND 200),
        house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        UNIQUE (connection_id, observed_at)
      );
      CREATE INDEX IF NOT EXISTS idx_heat_pump_state_history_connection_time
        ON heat_pump_state_history(connection_id, observed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_heat_pump_state_history_house_time
        ON heat_pump_state_history(house_id, observed_at DESC);
      `;
