export const SENSOR_REPORTING_INTERVAL_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS sensor_reporting_intervals (
        sensor_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        interval_seconds REAL CHECK (interval_seconds IS NULL OR interval_seconds > 0),
        gap_count INTEGER NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (sensor_id, metric)
      );
      `;
