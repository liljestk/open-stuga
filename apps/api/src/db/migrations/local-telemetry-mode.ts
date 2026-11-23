import type { DatabaseSync } from "node:sqlite";
import { DEMO_TELEMETRY_SOURCES } from "../support/domain-limits.js";

/** Stage provenance without scanning retained history or changing live read predicates. */
export function migrateLocalTelemetryMode(database: DatabaseSync): void {
  const sensorDemoSources = [...DEMO_TELEMETRY_SOURCES].map((source) => `'${source}'`).join(", ");
  const families = [
    { table: "readings", demoSources: sensorDemoSources },
    { table: "measurement_samples", demoSources: sensorDemoSources },
    { table: "outdoor_temperature_samples", demoSources: "'mock'" },
  ] as const;

  for (const { table, demoSources } of families) {
    // An absent tag means unclassified. A metadata-only ADD COLUMN avoids a
    // validation scan of large existing SQLite telemetry tables.
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((column) => column.name === "data_mode")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN data_mode TEXT`);
    }
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_validate_data_mode
      BEFORE INSERT ON ${table}
      WHEN NEW.data_mode IS NOT NULL AND NEW.data_mode IS NOT (
        CASE
          WHEN NEW.source IN (${demoSources}) THEN 'demo'
          WHEN EXISTS (SELECT 1 FROM metadata WHERE key = 'data_mode' AND value = 'real') THEN 'live'
        END
      ) BEGIN
        SELECT RAISE(ABORT, 'Invalid local telemetry data mode');
      END;

      CREATE TRIGGER IF NOT EXISTS ${table}_freeze_data_mode
      BEFORE UPDATE OF source, data_mode ON ${table}
      WHEN NEW.data_mode IS NOT OLD.data_mode
        OR (OLD.data_mode IS NOT NULL AND NEW.source IS NOT OLD.source)
      BEGIN
        SELECT RAISE(ABORT, 'Local telemetry data mode is immutable');
      END;
    `);
  }
}
