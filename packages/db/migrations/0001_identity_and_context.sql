BEGIN;

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

CREATE SCHEMA app;
CREATE SCHEMA app_private;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO casa_clara_app, casa_clara_worker;
GRANT USAGE ON SCHEMA app_private TO casa_clara_worker;

CREATE TYPE app.household_role AS ENUM (
  'family_admin',
  'family_member',
  'employee_live_in',
  'helper',
  'viewer'
);

CREATE TABLE app.households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (id, slug),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

-- Better Auth owns authentication. This table stores only the stable external id
-- and a minimal application profile; no password or authentication secret belongs here.
CREATE TABLE app.user_profiles (
  user_id text PRIMARY KEY CHECK (length(btrim(user_id)) BETWEEN 1 AND 255),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK (updated_at >= created_at)
);

CREATE TABLE app.household_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES app.user_profiles(user_id) ON DELETE RESTRICT,
  role app.household_role NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, user_id),
  UNIQUE (household_id, id),
  CHECK (expires_at IS NULL OR expires_at > starts_at),
  CHECK (revoked_at IS NULL OR revoked_at >= starts_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX household_memberships_user_active_idx
  ON app.household_memberships (user_id, starts_at, expires_at)
  WHERE revoked_at IS NULL;

CREATE FUNCTION app.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$;

CREATE FUNCTION app.current_household_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN pg_input_is_valid(nullif(current_setting('app.household_id', true), ''), 'uuid')
    THEN nullif(current_setting('app.household_id', true), '')::uuid
    ELSE NULL
  END
$$;

CREATE FUNCTION app.current_membership_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN pg_input_is_valid(nullif(current_setting('app.membership_id', true), ''), 'uuid')
    THEN nullif(current_setting('app.membership_id', true), '')::uuid
    ELSE NULL
  END
$$;

CREATE FUNCTION app.current_household_role()
RETURNS app.household_role
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT CASE nullif(current_setting('app.role', true), '')
    WHEN 'family_admin' THEN 'family_admin'::app.household_role
    WHEN 'family_member' THEN 'family_member'::app.household_role
    WHEN 'employee_live_in' THEN 'employee_live_in'::app.household_role
    WHEN 'helper' THEN 'helper'::app.household_role
    WHEN 'viewer' THEN 'viewer'::app.household_role
    ELSE NULL
  END
$$;

CREATE FUNCTION app.context_is_complete()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_user_id() IS NOT NULL
    AND app.current_household_id() IS NOT NULL
    AND app.current_membership_id() IS NOT NULL
    AND app.current_household_role() IS NOT NULL
$$;

-- Call only after the trusted BFF has set LOCAL app.user_id from Better Auth.
-- The lookup intentionally needs no household context so users can discover their
-- own active memberships before selecting a household.
CREATE FUNCTION app.set_household_context(
  selected_household_id uuid,
  selected_membership_id uuid
)
RETURNS app.household_role
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
DECLARE
  selected_role app.household_role;
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'app.user_id must be set from an authenticated identity first'
      USING ERRCODE = '28000';
  END IF;

  SELECT membership.role
    INTO selected_role
    FROM app.household_memberships AS membership
   WHERE membership.id = selected_membership_id
     AND membership.household_id = selected_household_id
     AND membership.user_id = app.current_user_id()
     AND membership.starts_at <= statement_timestamp()
     AND (membership.expires_at IS NULL OR membership.expires_at > statement_timestamp())
     AND membership.revoked_at IS NULL;

  IF selected_role IS NULL THEN
    RAISE EXCEPTION 'active membership not found for authenticated identity'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.household_id', selected_household_id::text, true);
  PERFORM set_config('app.membership_id', selected_membership_id::text, true);
  PERFORM set_config('app.role', selected_role::text, true);
  RETURN selected_role;
END
$$;

REVOKE ALL ON FUNCTION app.set_household_context(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_household_context(uuid, uuid) TO casa_clara_app;

COMMIT;
