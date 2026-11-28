import type { DatabaseSync } from "node:sqlite";

export function migrateAdaptiveWeather(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(outdoor_temperature_samples)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "recorded_at")) {
    database.exec("ALTER TABLE outdoor_temperature_samples ADD COLUMN recorded_at TEXT");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS adaptive_weather_hours (
      epoch_id TEXT NOT NULL,
      hour INTEGER NOT NULL,
      temperature_c REAL NOT NULL,
      observed_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('fmi-observation', 'open-meteo-current')),
      station_id TEXT,
      PRIMARY KEY (epoch_id, hour),
      FOREIGN KEY (epoch_id, hour) REFERENCES adaptive_hourly_evidence(epoch_id, hour) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS adaptive_weather_hours_immutable BEFORE UPDATE ON adaptive_weather_hours
      BEGIN SELECT RAISE(ABORT, 'Adaptive weather evidence is immutable'); END;
  `);
}
