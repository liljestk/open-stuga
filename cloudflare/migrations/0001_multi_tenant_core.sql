PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  identity_kind TEXT NOT NULL,
  subject_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_user
  ON tenant_members(user_id, created_at, tenant_id);

CREATE TABLE IF NOT EXISTS tenant_invitations (
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  invited_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, email),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_tokens (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  created_by TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_tenant
  ON api_tokens(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS houses (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sensors (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  house_id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, house_id) REFERENCES houses(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sensors_house
  ON sensors(tenant_id, house_id, id);

-- One row contains every metric for one sensor/time bucket. This avoids the
-- legacy API's duplicate readings + per-metric row write amplification.
CREATE TABLE IF NOT EXISTS telemetry_samples (
  tenant_id TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  quality TEXT NOT NULL,
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  units_json TEXT NOT NULL CHECK (json_valid(units_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, sensor_id, timestamp),
  FOREIGN KEY (tenant_id, sensor_id) REFERENCES sensors(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS measurement_definitions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_rules (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sensor_id TEXT,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sensor_id) REFERENCES sensors(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  sensor_id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES alert_rules(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, sensor_id) REFERENCES sensors(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alert_events_started
  ON alert_events(tenant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS observations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  house_id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, house_id) REFERENCES houses(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_observations_house
  ON observations(tenant_id, house_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS static_parameters (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  house_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  parameter_key TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, house_id, scope_type, scope_id, parameter_key),
  FOREIGN KEY (tenant_id, house_id) REFERENCES houses(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assets (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  house_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, house_id) REFERENCES houses(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_assets_house
  ON assets(tenant_id, house_id, created_at DESC);
