/**
 * Counts arrivals of history older than two hours (imports, peer
 * publications, delayed uploads), so caches of closed time ranges can tell
 * when their inputs changed. Ordinary live ingestion never touches it.
 */
export const CORE_SCHEMA_10 = `
      CREATE TABLE IF NOT EXISTS telemetry_history_revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
      );
      INSERT OR IGNORE INTO telemetry_history_revision (id, revision) VALUES (1, 1);
      CREATE TRIGGER IF NOT EXISTS telemetry_history_late_measurement
        AFTER INSERT ON measurement_samples
        WHEN NEW.timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')
        BEGIN
          UPDATE telemetry_history_revision SET revision = revision + 1 WHERE id = 1;
        END;
      `;
