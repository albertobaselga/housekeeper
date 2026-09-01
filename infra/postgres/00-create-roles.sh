#!/bin/sh
# Enganche de docker-entrypoint-initdb.d. La lógica vive en
# packages/db/scripts/sql/bootstrap.sql para que Postgres gestionado (Supabase),
# donde este punto de enganche no existe, aplique exactamente lo mismo con
# `pnpm --filter @housekeeper/db bootstrap`.
set -eu

: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD}"
: "${WORKER_DB_PASSWORD:?set WORKER_DB_PASSWORD}"
: "${AUTH_DB_PASSWORD:?set AUTH_DB_PASSWORD}"

if [ -n "${CASA_CLARA_BOOTSTRAP_SQL:-}" ]; then
  echo "CASA_CLARA_BOOTSTRAP_SQL ya no existe; renombrada a HOUSEKEEPER_BOOTSTRAP_SQL" >&2
  exit 1
fi

BOOTSTRAP_SQL="${HOUSEKEEPER_BOOTSTRAP_SQL:-/opt/housekeeper/bootstrap.sql}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" \
  --set=worker_password="$WORKER_DB_PASSWORD" \
  --set=auth_password="$AUTH_DB_PASSWORD" \
  --set=bootstrap_sql="$BOOTSTRAP_SQL" <<'SQL'
SET housekeeper.app_password    = :'app_password';
SET housekeeper.worker_password = :'worker_password';
SET housekeeper.auth_password   = :'auth_password';
\i :bootstrap_sql
SQL
