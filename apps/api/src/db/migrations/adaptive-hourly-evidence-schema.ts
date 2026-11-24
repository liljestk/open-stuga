export const adaptiveHourlyEvidenceSchema = `
  CREATE TABLE IF NOT EXISTS adaptive_epoch_observation_sources (
    epoch_id TEXT PRIMARY KEY REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    observation_source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adaptive_hourly_evidence (
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    hour INTEGER NOT NULL,
    captured_at INTEGER NOT NULL,
    value REAL,
    coverage REAL NOT NULL CHECK (coverage >= 0 AND coverage <= 1),
    observation_source TEXT,
    gap_reason TEXT,
    PRIMARY KEY (epoch_id, hour),
    CHECK (hour % 3600000 = 0 AND captured_at >= hour + 3600000),
    CHECK ((value IS NULL) = (gap_reason IS NOT NULL)),
    CHECK ((value IS NULL) = (observation_source IS NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_adaptive_hourly_evidence_retention ON adaptive_hourly_evidence(hour);
  CREATE TRIGGER IF NOT EXISTS adaptive_hourly_evidence_immutable BEFORE UPDATE ON adaptive_hourly_evidence
    BEGIN SELECT RAISE(ABORT, 'Adaptive hourly evidence is immutable'); END;
`;
