import type { DatabaseSync } from "node:sqlite";

/** Older rows retain unknown recording time, including rows projected during upgrade. */
export function migrateMeasurementRecordingTime(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(measurement_samples)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "recorded_at")) {
    database.exec("ALTER TABLE measurement_samples ADD COLUMN recorded_at TEXT");
  }
  database.exec(`CREATE TRIGGER IF NOT EXISTS measurement_samples_freeze_recording
    BEFORE UPDATE OF recorded_at, sensor_id, metric, timestamp, source, value, canonical_unit, quality ON measurement_samples
    WHEN NEW.recorded_at IS NOT OLD.recorded_at OR (OLD.recorded_at IS NOT NULL AND (
      NEW.sensor_id IS NOT OLD.sensor_id OR NEW.metric IS NOT OLD.metric OR NEW.timestamp IS NOT OLD.timestamp
      OR (OLD.data_mode IS NULL AND NEW.source IS NOT OLD.source)
      OR NEW.value IS NOT OLD.value OR NEW.canonical_unit IS NOT OLD.canonical_unit
      OR NEW.quality IS NOT OLD.quality
    ))
    BEGIN SELECT RAISE(ABORT, 'Recorded measurements are immutable'); END;`);
}
