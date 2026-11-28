import type { DatabaseSync } from "node:sqlite";

const adaptiveClimateDetectionSchema = `
  CREATE TABLE IF NOT EXISTS adaptive_climate_detector_state (
    epoch_id TEXT PRIMARY KEY REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    through_hour INTEGER NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json))
  );
  CREATE TABLE IF NOT EXISTS adaptive_climate_detector_hours (
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    target_hour INTEGER NOT NULL,
    decided_at INTEGER NOT NULL,
    error REAL,
    calibration_json TEXT CHECK (calibration_json IS NULL OR json_valid(calibration_json)),
    admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)),
    reason TEXT NOT NULL,
    PRIMARY KEY (epoch_id, target_hour)
  );
  CREATE INDEX IF NOT EXISTS idx_adaptive_detector_hours_retention ON adaptive_climate_detector_hours(target_hour);
  CREATE TABLE IF NOT EXISTS adaptive_climate_episode_revisions (
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('higher', 'lower')),
    revision INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('candidate', 'stale', 'resolved', 'expired')),
    target_hour INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (epoch_id, direction, revision)
  );
  CREATE TRIGGER IF NOT EXISTS adaptive_climate_detector_hours_immutable BEFORE UPDATE ON adaptive_climate_detector_hours
    BEGIN SELECT RAISE(ABORT, 'Adaptive climate decisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS adaptive_climate_episode_immutable BEFORE UPDATE ON adaptive_climate_episode_revisions
    BEGIN SELECT RAISE(ABORT, 'Adaptive climate episode revisions are immutable'); END;
`;

export function migrateAdaptiveClimateDetection(database: DatabaseSync): void {
  database.exec(adaptiveClimateDetectionSchema);
  if (!database.prepare("SELECT 1 FROM pragma_table_info('adaptive_climate_predictions') WHERE name = 'frozen_at'").get()) {
    database.exec("ALTER TABLE adaptive_climate_predictions ADD COLUMN frozen_at INTEGER");
  }
}
