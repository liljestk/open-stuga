#!/bin/sh
set -eu

app_password="$(tr -d '\r\n' < /run/stuga-app/password)"
if [ "${#app_password}" -lt 32 ]; then
  echo "The generated Timescale application credential is invalid" >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$app_password" <<'SQL'
CREATE EXTENSION IF NOT EXISTS timescaledb;
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

unset app_password
