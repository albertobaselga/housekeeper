#!/bin/sh
set -eu

: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD}"
: "${WORKER_DB_PASSWORD:?set WORKER_DB_PASSWORD}"
: "${AUTH_DB_PASSWORD:?set AUTH_DB_PASSWORD}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" \
  --set=worker_password="$WORKER_DB_PASSWORD" \
  --set=auth_password="$AUTH_DB_PASSWORD" <<'SQL'
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'casa_clara_app') THEN
    CREATE ROLE casa_clara_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'casa_clara_worker') THEN
    CREATE ROLE casa_clara_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

SELECT format(
  'CREATE ROLE casa_clara_app_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'app_password'
) WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'casa_clara_app_login') \gexec
SELECT format('ALTER ROLE casa_clara_app_login PASSWORD %L', :'app_password') \gexec
GRANT casa_clara_app TO casa_clara_app_login;

SELECT format(
  'CREATE ROLE casa_clara_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'worker_password'
) WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'casa_clara_worker_login') \gexec
SELECT format('ALTER ROLE casa_clara_worker_login PASSWORD %L', :'worker_password') \gexec
GRANT casa_clara_worker TO casa_clara_worker_login;

SELECT format(
  'CREATE ROLE casa_clara_auth_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
  :'auth_password'
) WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'casa_clara_auth_login') \gexec
SELECT format('ALTER ROLE casa_clara_auth_login PASSWORD %L', :'auth_password') \gexec

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION casa_clara_auth_login;
GRANT ALL ON SCHEMA auth TO casa_clara_auth_login;
ALTER ROLE casa_clara_auth_login SET search_path TO auth;
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO casa_clara_app_login, casa_clara_worker_login, casa_clara_auth_login',
  current_database()
) \gexec
SQL
