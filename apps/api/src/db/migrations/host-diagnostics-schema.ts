export const HOST_DIAGNOSTICS_SCHEMA_SQL = `      CREATE TABLE IF NOT EXISTS host_storage_samples (
        sampled_at TEXT PRIMARY KEY,
        total_bytes INTEGER NOT NULL CHECK(total_bytes > 0),
        available_bytes INTEGER NOT NULL CHECK(available_bytes >= 0 AND available_bytes <= total_bytes)
      );
      CREATE INDEX IF NOT EXISTS idx_host_storage_samples_recent
        ON host_storage_samples(sampled_at DESC);

      CREATE TABLE IF NOT EXISTS system_error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('warning', 'error')),
        source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 80),
        code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 80),
        message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 1000)
      );
      CREATE INDEX IF NOT EXISTS idx_system_error_log_recent
        ON system_error_log(occurred_at DESC, id DESC);
      `;
