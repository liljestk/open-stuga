export const CORE_SCHEMA_08 = `
      CREATE TABLE IF NOT EXISTS forecast_evaluations (
        sensor_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        evaluated_on TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL CHECK (status IN ('ready', 'no-skill', 'insufficient-history')),
        skill_6h REAL,
        skill_24h REAL,
        coverage_90 REAL,
        computed_at TEXT NOT NULL,
        evaluation_json TEXT NOT NULL CHECK (json_valid(evaluation_json)),
        PRIMARY KEY (sensor_id, metric, evaluated_on)
      );
      CREATE INDEX IF NOT EXISTS idx_forecast_evaluations_recent
        ON forecast_evaluations(evaluated_on DESC);
      `;
