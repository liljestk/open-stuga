export const adaptiveClimateArtifactsSchema = `
  CREATE TABLE IF NOT EXISTS adaptive_climate_artifacts (
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    algorithm_version TEXT NOT NULL,
    evaluated_through INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    input_digest TEXT NOT NULL,
    report_json TEXT NOT NULL CHECK (json_valid(report_json)),
    PRIMARY KEY (epoch_id, algorithm_version, evaluated_through)
  );
  CREATE TRIGGER IF NOT EXISTS adaptive_climate_artifacts_immutable BEFORE UPDATE ON adaptive_climate_artifacts
    BEGIN SELECT RAISE(ABORT, 'Adaptive climate qualification reports are immutable'); END;
`;
