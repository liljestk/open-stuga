export const adaptiveCollectionSchema = `
  CREATE TABLE IF NOT EXISTS adaptive_collection_cursors (
    data_mode TEXT PRIMARY KEY CHECK (data_mode IN ('demo', 'live')),
    house_id TEXT NOT NULL,
    sensor_id TEXT NOT NULL,
    metric TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adaptive_collection_progress (
    epoch_id TEXT PRIMARY KEY REFERENCES adaptive_evidence_epochs(id) ON DELETE CASCADE,
    next_hour INTEGER NOT NULL,
    unavailable_hours INTEGER NOT NULL DEFAULT 0,
    last_unavailable_hour INTEGER,
    CHECK (next_hour % 3600000 = 0)
  );
`;
