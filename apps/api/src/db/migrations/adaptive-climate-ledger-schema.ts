export const adaptiveClimateLedgerSchema = `
  CREATE TABLE IF NOT EXISTS adaptive_climate_predictions (
    epoch_id TEXT NOT NULL,
    target_hour INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    artifact_version TEXT NOT NULL,
    artifact_cutoff INTEGER NOT NULL,
    input_digest TEXT NOT NULL,
    prediction REAL NOT NULL,
    persistence REAL,
    seasonal REAL,
    PRIMARY KEY (epoch_id, target_hour),
    FOREIGN KEY (epoch_id, artifact_version, artifact_cutoff)
      REFERENCES adaptive_climate_artifacts(epoch_id, algorithm_version, evaluated_through) ON DELETE CASCADE,
    CHECK (target_hour % 3600000 = 0 AND issued_at <= recorded_at AND recorded_at < target_hour)
  );
  CREATE INDEX IF NOT EXISTS idx_adaptive_climate_prediction_retention ON adaptive_climate_predictions(target_hour);
  CREATE TABLE IF NOT EXISTS adaptive_climate_outcomes (
    epoch_id TEXT NOT NULL,
    target_hour INTEGER NOT NULL,
    scored_at INTEGER NOT NULL,
    observed_at INTEGER,
    observed REAL,
    gap_reason TEXT,
    PRIMARY KEY (epoch_id, target_hour),
    FOREIGN KEY (epoch_id, target_hour) REFERENCES adaptive_climate_predictions(epoch_id, target_hour) ON DELETE CASCADE,
    CHECK (scored_at >= target_hour + 3600000),
    CHECK ((observed IS NULL) = (gap_reason IS NOT NULL)),
    CHECK (observed IS NULL OR observed_at IS NOT NULL),
    CHECK (observed_at IS NULL OR (observed_at >= target_hour + 3600000 AND observed_at <= scored_at))
  );
  CREATE TRIGGER IF NOT EXISTS adaptive_climate_predictions_immutable BEFORE UPDATE ON adaptive_climate_predictions
    BEGIN SELECT RAISE(ABORT, 'Adaptive climate predictions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS adaptive_climate_outcomes_immutable BEFORE UPDATE ON adaptive_climate_outcomes
    BEGIN SELECT RAISE(ABORT, 'Adaptive climate outcomes are immutable'); END;
`;
