export const ANALYTICS_VIEWS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS saved_analytics_views (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES local_workspace_members(user_id) ON DELETE CASCADE,
    house_id TEXT NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
    data_mode TEXT NOT NULL CHECK (data_mode IN ('live', 'demo')),
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_saved_analytics_views_owner
    ON saved_analytics_views(user_id, house_id, data_mode);
`;
