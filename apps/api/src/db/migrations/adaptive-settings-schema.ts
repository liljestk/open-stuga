export const adaptiveSettingsSchema = `CREATE TABLE IF NOT EXISTS adaptive_settings_revisions (
  house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  data_mode TEXT NOT NULL CHECK (data_mode IN ('demo', 'live')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow')),
  baseline_id TEXT,
  baseline_started_at TEXT,
  updated_at TEXT NOT NULL,
  actor_user_id TEXT,
  change_digest TEXT,
  reset_reason TEXT,
  CHECK ((mode = 'shadow') = (baseline_id IS NOT NULL)),
  CHECK ((baseline_id IS NULL) = (baseline_started_at IS NULL)),
  PRIMARY KEY (house_id, data_mode, revision)
);`;
