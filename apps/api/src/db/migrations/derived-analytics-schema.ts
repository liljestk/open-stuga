export const DERIVED_ANALYTICS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS derived_analytics_evidence_revisions (
    house_id TEXT PRIMARY KEY REFERENCES houses(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO derived_analytics_evidence_revisions (house_id, revision, updated_at)
    SELECT id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM houses;
  CREATE TABLE IF NOT EXISTS derived_analytics_global_revision (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
  );
  INSERT OR IGNORE INTO derived_analytics_global_revision (id, revision) VALUES (1, 1);

  CREATE TRIGGER IF NOT EXISTS derived_analytics_house_insert
    AFTER INSERT ON houses BEGIN
      INSERT OR IGNORE INTO derived_analytics_evidence_revisions (house_id, revision, updated_at)
      VALUES (NEW.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    END;
  CREATE TRIGGER IF NOT EXISTS derived_analytics_house_update
    AFTER UPDATE ON houses BEGIN
      INSERT INTO derived_analytics_evidence_revisions (house_id, revision, updated_at)
      VALUES (NEW.id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(house_id) DO UPDATE SET
        revision = revision + 1,
        updated_at = excluded.updated_at;
    END;
  CREATE TRIGGER IF NOT EXISTS derived_analytics_sensor_insert
    AFTER INSERT ON sensors BEGIN
      INSERT INTO derived_analytics_evidence_revisions (house_id, revision, updated_at)
      VALUES (NEW.house_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(house_id) DO UPDATE SET
        revision = revision + 1,
        updated_at = excluded.updated_at;
    END;
  CREATE TRIGGER IF NOT EXISTS derived_analytics_sensor_update
    AFTER UPDATE ON sensors BEGIN
      INSERT INTO derived_analytics_evidence_revisions (house_id, revision, updated_at)
      VALUES (NEW.house_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(house_id) DO UPDATE SET
        revision = revision + 1,
        updated_at = excluded.updated_at;
      UPDATE derived_analytics_evidence_revisions
      SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE house_id = OLD.house_id AND OLD.house_id <> NEW.house_id;
    END;
  CREATE TRIGGER IF NOT EXISTS derived_analytics_sensor_delete
    AFTER DELETE ON sensors BEGIN
      UPDATE derived_analytics_evidence_revisions
      SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE house_id = OLD.house_id;
    END;
  CREATE TRIGGER IF NOT EXISTS derived_analytics_measurement_definition_insert
    AFTER INSERT ON measurement_definitions BEGIN
      UPDATE derived_analytics_global_revision SET revision = revision + 1 WHERE id = 1;
    END;
  CREATE TRIGGER IF NOT EXISTS derived_analytics_measurement_definition_update
    AFTER UPDATE ON measurement_definitions BEGIN
      UPDATE derived_analytics_global_revision SET revision = revision + 1 WHERE id = 1;
    END;
  CREATE TRIGGER IF NOT EXISTS derived_analytics_measurement_definition_delete
    AFTER DELETE ON measurement_definitions BEGIN
      UPDATE derived_analytics_global_revision SET revision = revision + 1 WHERE id = 1;
    END;

  CREATE TABLE IF NOT EXISTS derived_analytics_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('thermal-isolation', 'moisture-response', 'home-performance')),
    house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    data_mode TEXT NOT NULL CHECK (data_mode IN ('live', 'demo')),
    window_days INTEGER NOT NULL CHECK (window_days BETWEEN 1 AND 30),
    cutoff TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    evidence_version TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    result_json TEXT NOT NULL CHECK (json_valid(result_json))
  );
  CREATE INDEX IF NOT EXISTS derived_analytics_artifact_latest
    ON derived_analytics_artifacts (house_id, kind, data_mode, window_days, id DESC);
  CREATE INDEX IF NOT EXISTS derived_analytics_artifact_identity
    ON derived_analytics_artifacts (identity_key, id DESC);

  CREATE TABLE IF NOT EXISTS derived_analytics_jobs (
    identity_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('thermal-isolation', 'moisture-response', 'home-performance')),
    house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    data_mode TEXT NOT NULL CHECK (data_mode IN ('live', 'demo')),
    window_days INTEGER NOT NULL CHECK (window_days BETWEEN 1 AND 30),
    cutoff TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    evidence_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    next_attempt_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    error_code TEXT,
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS derived_analytics_job_claim
    ON derived_analytics_jobs (status, next_attempt_at, requested_at);
`;
