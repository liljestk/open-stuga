import type { DatabaseSync } from "node:sqlite";

const adaptiveSettingsSchema = `CREATE TABLE IF NOT EXISTS adaptive_settings_revisions (
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
  reference_groups_json TEXT NOT NULL DEFAULT '[]',
  CHECK ((mode = 'shadow') = (baseline_id IS NOT NULL)),
  CHECK ((baseline_id IS NULL) = (baseline_started_at IS NULL)),
  PRIMARY KEY (house_id, data_mode, revision)
);`;

export function migrateAdaptiveSettings(database: DatabaseSync): void {
  database.exec(adaptiveSettingsSchema);
  const column = database.prepare(
    "SELECT name FROM pragma_table_info('adaptive_settings_revisions') WHERE name = 'reference_groups_json'",
  ).get();
  if (!column) {
    database.exec("ALTER TABLE adaptive_settings_revisions ADD COLUMN reference_groups_json TEXT NOT NULL DEFAULT '[]'");
  }
}
