/**
 * One bounded, canonical forecast snapshot per Home. Provider failures update
 * the status columns without replacing a last-good snapshot for the same
 * location.
 */
export const WEATHER_SNAPSHOT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS weather_snapshots (
    house_id TEXT PRIMARY KEY REFERENCES houses(id) ON DELETE CASCADE,
    location_key TEXT NOT NULL CHECK (length(location_key) BETWEEN 1 AND 64),
    horizon_hours INTEGER NOT NULL DEFAULT 48 CHECK (horizon_hours = 48),
    weather_json TEXT CHECK (
      weather_json IS NULL OR (
        json_valid(weather_json)
        AND length(weather_json) <= 2097152
      )
    ),
    last_attempt_at TEXT NOT NULL,
    last_success_at TEXT,
    last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
    updated_at TEXT NOT NULL
  );
`;
