#!/bin/sh
set -eu

admin_password="$(tr -d '\r\n' < /run/stuga-admin/password)"
app_password="$(tr -d '\r\n' < /run/stuga-app/password)"
admin_role="${POSTGRES_USER:-stuga_admin}"
database="${POSTGRES_DB:-stuga}"

if [ "${#admin_password}" -lt 32 ] || [ "${#app_password}" -lt 32 ]; then
  echo "The generated Timescale credentials are invalid" >&2
  exit 1
fi

# The official PostgreSQL image permits local socket administration during
# initialization. Sharing only the socket (not a network) gives this recovery
# job a narrow way to reconcile durable database roles with regenerated secret
# volumes without exposing PostgreSQL or embedding a fallback password.
psql --host=/var/run/postgresql \
  --username="$admin_role" \
  --dbname="$database" \
  --set=ON_ERROR_STOP=1 \
  --set=admin_role="$admin_role" \
  --set=admin_password="$admin_password" \
  --set=app_password="$app_password" <<'SQL'
ALTER ROLE :"admin_role" WITH LOGIN PASSWORD :'admin_password';
SELECT 'CREATE ROLE stuga_app LOGIN'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stuga_app') \gexec
ALTER ROLE stuga_app
  WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  PASSWORD :'app_password';
SELECT format('GRANT CONNECT ON DATABASE %I TO stuga_app', current_database()) \gexec
CREATE SCHEMA IF NOT EXISTS telemetry AUTHORIZATION stuga_app;
ALTER SCHEMA telemetry OWNER TO stuga_app;
GRANT USAGE, CREATE ON SCHEMA telemetry TO stuga_app;
SQL

unset admin_password app_password
