// Assistant connections: OAuth clients that registered themselves, the grants an
// Owner or Admin approved, and the hashed bearer tokens issued under each grant.
// Deleting a grant (revocation) cascades to every token it issued.
export const ASSISTANT_CONNECTOR_SCHEMA_SQL = `
      CREATE TABLE IF NOT EXISTS assistant_oauth_clients (
        client_id TEXT PRIMARY KEY CHECK (length(client_id) BETWEEN 1 AND 128),
        client_secret_hash TEXT CHECK (client_secret_hash IS NULL OR length(client_secret_hash) = 64),
        assistant TEXT NOT NULL CHECK (assistant IN ('claude', 'chatgpt', 'local')),
        metadata_json TEXT NOT NULL CHECK (length(metadata_json) <= 16384),
        registered_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_oauth_clients_registered
        ON assistant_oauth_clients(registered_at);
      CREATE TABLE IF NOT EXISTS assistant_connector_grants (
        id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
        client_id TEXT NOT NULL REFERENCES assistant_oauth_clients(client_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES local_auth_users(id) ON DELETE CASCADE,
        resource TEXT NOT NULL CHECK (length(resource) BETWEEN 1 AND 2048),
        scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_connector_grants_client
        ON assistant_connector_grants(client_id);
      CREATE TABLE IF NOT EXISTS assistant_connector_tokens (
        token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        grant_id TEXT NOT NULL REFERENCES assistant_connector_grants(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        expires_at TEXT NOT NULL,
        rotated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assistant_connector_tokens_grant
        ON assistant_connector_tokens(grant_id);
      CREATE INDEX IF NOT EXISTS idx_assistant_connector_tokens_expiry
        ON assistant_connector_tokens(expires_at);
      `;
