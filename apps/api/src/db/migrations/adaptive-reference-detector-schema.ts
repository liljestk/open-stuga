export const adaptiveReferenceDetectorSchema = `
  CREATE TABLE IF NOT EXISTS adaptive_reference_artifacts (
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    algorithm_version TEXT NOT NULL,
    evaluated_through INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    input_digest TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    PRIMARY KEY (epoch_id, algorithm_version, evaluated_through)
  );
  CREATE TABLE IF NOT EXISTS adaptive_reference_decisions (
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    target_hour INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('normal', 'candidate', 'stale', 'resolved', 'collecting')),
    direction TEXT CHECK (direction IN ('higher', 'lower')),
    offset_change REAL,
    pair_offset REAL,
    pair_spread REAL,
    pair_available_at INTEGER,
    paired_hours INTEGER NOT NULL,
    reason TEXT NOT NULL,
    context_guard_json TEXT CHECK (context_guard_json IS NULL OR json_valid(context_guard_json)),
    PRIMARY KEY (epoch_id, target_hour)
  );
  CREATE INDEX IF NOT EXISTS idx_adaptive_reference_decisions_retention ON adaptive_reference_decisions(target_hour);
  CREATE TABLE IF NOT EXISTS adaptive_reference_episode_revisions (
    epoch_id TEXT NOT NULL REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('higher', 'lower')),
    revision INTEGER NOT NULL,
    target_hour INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('candidate', 'stale', 'resolved')),
    PRIMARY KEY (epoch_id, direction, revision)
  );
  CREATE TRIGGER IF NOT EXISTS adaptive_reference_artifacts_immutable BEFORE UPDATE ON adaptive_reference_artifacts
    BEGIN SELECT RAISE(ABORT, 'Adaptive reference artifacts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS adaptive_reference_decisions_immutable BEFORE UPDATE ON adaptive_reference_decisions
    BEGIN SELECT RAISE(ABORT, 'Adaptive reference decisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS adaptive_reference_episodes_immutable BEFORE UPDATE ON adaptive_reference_episode_revisions
    BEGIN SELECT RAISE(ABORT, 'Adaptive reference episode revisions are immutable'); END;
`;
