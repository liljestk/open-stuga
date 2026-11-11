export const ADAPTIVE_MONITORING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS adaptive_settings (
  house_id TEXT PRIMARY KEY REFERENCES houses(id) ON DELETE CASCADE,
  data_mode TEXT NOT NULL CHECK(data_mode IN ('live','demo')),
  revision INTEGER NOT NULL,
  settings_json TEXT NOT NULL CHECK(json_valid(settings_json))
);
CREATE TABLE IF NOT EXISTS adaptive_streams (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  data_mode TEXT NOT NULL CHECK(data_mode IN ('live','demo')),
  epoch TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  started_at TEXT NOT NULL,
  processed_at TEXT,
  stream_json TEXT NOT NULL CHECK(json_valid(stream_json)),
  runtime_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(runtime_json))
);
CREATE INDEX IF NOT EXISTS idx_adaptive_stream_house ON adaptive_streams(house_id, data_mode, id);
CREATE TABLE IF NOT EXISTS adaptive_hours (
  stream_id TEXT NOT NULL REFERENCES adaptive_streams(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(stream_id, epoch, observed_at)
);
CREATE TABLE IF NOT EXISTS adaptive_jobs (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES adaptive_streams(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  settings_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS adaptive_models (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES adaptive_streams(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  model_json TEXT NOT NULL CHECK(json_valid(model_json))
);
CREATE TABLE IF NOT EXISTS adaptive_findings (
  id TEXT PRIMARY KEY,
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL REFERENCES adaptive_streams(id) ON DELETE CASCADE,
  data_mode TEXT NOT NULL,
  epoch TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finding_json TEXT NOT NULL CHECK(json_valid(finding_json))
);
CREATE INDEX IF NOT EXISTS idx_adaptive_findings_house ON adaptive_findings(house_id, data_mode, id);
CREATE TABLE IF NOT EXISTS adaptive_finding_revisions (
  finding_id TEXT NOT NULL REFERENCES adaptive_findings(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  finding_json TEXT NOT NULL CHECK(json_valid(finding_json)),
  PRIMARY KEY(finding_id, revision)
);
CREATE TABLE IF NOT EXISTS adaptive_reviews (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES adaptive_findings(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  UNIQUE(finding_id, actor_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS adaptive_audit (
  id INTEGER PRIMARY KEY,
  house_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
);
CREATE TABLE IF NOT EXISTS adaptive_promotion_receipts (
  id TEXT PRIMARY KEY,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
`;
