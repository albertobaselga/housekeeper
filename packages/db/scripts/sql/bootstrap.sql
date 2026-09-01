-- Bootstrap de la base de datos de Housekeeper: roles de ejecución, esquema de
-- Better Auth y compatibilidad de extensiones. Se ejecuta UNA VEZ por base y
-- SIEMPRE ANTES de las migraciones (0001 ya concede a casa_clara_app y
-- casa_clara_worker, así que esos roles tienen que existir).
--
-- Es idempotente y no necesita superusuario: basta CREATEROLE, que es lo que
-- trae el rol `postgres` de un proyecto Supabase. Sustituye al antiguo
-- infra/postgres/00-create-roles.sh, que sólo corría dentro de
-- docker-entrypoint-initdb.d y por tanto no existía en Postgres gestionado.
--
-- Las contraseñas llegan por parámetro de sesión para que el mismo fichero
-- sirva a psql y al runner de Node:
--
--   SET housekeeper.app_password    = '…';
--   SET housekeeper.worker_password = '…';
--   SET housekeeper.auth_password   = '…';
--
-- Si un parámetro falta o va vacío, el rol de login se crea (o se conserva) sin
-- tocarle la contraseña: útil para volver a pasar el bootstrap sin tener los
-- secretos a mano.

BEGIN;

DO $bootstrap$
DECLARE
  login_role text;
  group_role text;
  secret text;
  extensions_schema text;
  dictionary_options text;
BEGIN
  -- ───────────────────────────────────────────────────────────────────────────
  -- 1. Roles de grupo. Sin login y sin BYPASSRLS: son los que quedan sometidos
  --    a las políticas RLS de app/app_private en tiempo de ejecución.
  -- ───────────────────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'casa_clara_app') THEN
    CREATE ROLE casa_clara_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'casa_clara_worker') THEN
    CREATE ROLE casa_clara_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  -- ───────────────────────────────────────────────────────────────────────────
  -- 2. Roles de login, uno por consumidor. casa_clara_auth_login no pertenece a
  --    ningún grupo: Better Auth vive en su propio esquema y no toca `app`.
  -- ───────────────────────────────────────────────────────────────────────────
  FOR login_role, group_role, secret IN
    SELECT *
      FROM (VALUES
        ('casa_clara_app_login',    'casa_clara_app',    current_setting('housekeeper.app_password', true)),
        ('casa_clara_worker_login', 'casa_clara_worker', current_setting('housekeeper.worker_password', true)),
        ('casa_clara_auth_login',   NULL,                current_setting('housekeeper.auth_password', true))
      ) AS wanted(login_role, group_role, secret)
  LOOP
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = login_role) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
        login_role
      );
    END IF;
    IF secret IS NOT NULL AND secret <> '' THEN
      EXECUTE format('ALTER ROLE %I PASSWORD %L', login_role, secret);
    END IF;
    IF group_role IS NOT NULL THEN
      EXECUTE format('GRANT %I TO %I', group_role, login_role);
    END IF;
  END LOOP;

  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO casa_clara_app_login, casa_clara_worker_login, casa_clara_auth_login',
    current_database()
  );

  -- ───────────────────────────────────────────────────────────────────────────
  -- 3. El rol que migra necesita PERTENENCIA (no sólo ADMIN OPTION) a los dos
  --    grupos para que `SET ROLE` funcione en la matriz RLS y en los importadores.
  --    En PG16+ quien crea un rol la obtiene; si los grupos ya existían y venían
  --    de otro administrador, esto puede no ser concedible y se avisa.
  -- ───────────────────────────────────────────────────────────────────────────
  BEGIN
    EXECUTE format('GRANT casa_clara_app, casa_clara_worker TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'sin ADMIN OPTION sobre los roles de grupo: % no podrá hacer SET ROLE casa_clara_app/worker', current_user;
  END;

  -- ───────────────────────────────────────────────────────────────────────────
  -- 4. Better Auth. El esquema se llama `casa_auth`, no `auth`: en Supabase
  --    `auth` es de GoTrue y pertenece a supabase_auth_admin. El aislamiento
  --    sigue viniendo del search_path del rol, que es propio y no reservado.
  -- ───────────────────────────────────────────────────────────────────────────
  --    Desde PG16 el creador de un rol se queda con ADMIN OPTION pero sin SET
  --    (createrole_self_grant viene vacío), y sin SET no se puede crear un
  --    esquema AUTHORIZATION de ese rol. INHERIT FALSE para que el rol de
  --    migraciones no adquiera de paso los privilegios de Better Auth.
  --    La separación INHERIT/SET es de PG16; antes la pertenencia implicaba
  --    ambas y la cláusula ni siquiera se analiza.
  BEGIN
    IF current_setting('server_version_num')::integer >= 160000 THEN
      EXECUTE format('GRANT casa_clara_auth_login TO %I WITH INHERIT FALSE, SET TRUE', current_user);
    ELSE
      EXECUTE format('GRANT casa_clara_auth_login TO %I', current_user);
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'sin ADMIN OPTION sobre casa_clara_auth_login; el esquema casa_auth tendrá que crearse a mano';
  END;

  --    Los despliegues anteriores a este cambio tienen las tablas de Better Auth
  --    en un esquema llamado `auth`. Se renombra, y sólo si ese esquema es
  --    nuestro: en Supabase `auth` es de GoTrue y pertenece a
  --    supabase_auth_admin, así que la condición de propiedad impide tocarlo.
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'casa_auth')
     AND EXISTS (
       SELECT FROM pg_catalog.pg_namespace
        WHERE nspname = 'auth' AND nspowner = 'casa_clara_auth_login'::regrole
     ) THEN
    ALTER SCHEMA auth RENAME TO casa_auth;
    RAISE NOTICE 'esquema auth renombrado a casa_auth (Better Auth)';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'casa_auth') THEN
    CREATE SCHEMA casa_auth AUTHORIZATION casa_clara_auth_login;
  END IF;
  -- Si el esquema ya era suyo no hay nada que conceder (y quien no lo posee
  -- tampoco puede conceder sobre él).
  IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname = 'casa_auth')
     <> 'casa_clara_auth_login'::regrole THEN
    GRANT ALL ON SCHEMA casa_auth TO casa_clara_auth_login;
  END IF;
  ALTER ROLE casa_clara_auth_login SET search_path TO casa_auth;

  -- ───────────────────────────────────────────────────────────────────────────
  -- 5. unaccent fuera de `public`. Supabase preinstala unaccent y pg_trgm en el
  --    esquema `extensions`, así que el `CREATE EXTENSION IF NOT EXISTS` de la
  --    migración 0007 no hace nada y su `app.unaccent_es` -- que invoca
  --    `public.unaccent('public.unaccent'::regdictionary, …)` -- no resuelve.
  --
  --    0007 ya está aplicada en los despliegues existentes y su checksum es
  --    inmutable, así que el arreglo no puede vivir en una migración nueva
  --    (tendría que correr ANTES de 0007) ni editando 0007. Se resuelve aquí,
  --    creando en `public` el par diccionario + función que 0007 espera y
  --    delegando en el esquema real de la extensión.
  --
  --    app.unaccent_es sigue siendo IMMUTABLE y sigue devolviendo exactamente lo
  --    mismo, así que las columnas generadas y los índices de expresión de 0007
  --    no necesitan reconstruirse.
  -- ───────────────────────────────────────────────────────────────────────────
  SELECT namespace.nspname
    INTO extensions_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'unaccent';

  IF extensions_schema IS NOT NULL AND extensions_schema <> 'public' THEN
    IF NOT EXISTS (
      SELECT
        FROM pg_catalog.pg_ts_dict AS dictionary
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
       WHERE namespace.nspname = 'public' AND dictionary.dictname = 'unaccent'
    ) THEN
      -- Se clonan las opciones del diccionario de la extensión (RULES, y lo que
      -- traiga) en vez de asumir valores por omisión: app.unaccent_es es
      -- IMMUTABLE y alimenta columnas generadas e índices, así que el resultado
      -- tiene que ser byte a byte el mismo que en un despliegue autogestionado.
      SELECT dictionary.dictinitoption
        INTO dictionary_options
        FROM pg_catalog.pg_ts_dict AS dictionary
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
       WHERE namespace.nspname = extensions_schema AND dictionary.dictname = 'unaccent';
      EXECUTE format(
        'CREATE TEXT SEARCH DICTIONARY public.unaccent (TEMPLATE = %I.unaccent, %s)',
        extensions_schema,
        coalesce(dictionary_options, 'RULES = ''unaccent''')
      );
    END IF;
    IF to_regprocedure('public.unaccent(pg_catalog.regdictionary, pg_catalog.text)') IS NULL THEN
      EXECUTE format(
        $wrapper$
          CREATE FUNCTION public.unaccent(pg_catalog.regdictionary, pg_catalog.text)
          RETURNS pg_catalog.text
          LANGUAGE sql
          STABLE
          PARALLEL SAFE
          STRICT
          AS $delegate$ SELECT %I.unaccent($1, $2) $delegate$
        $wrapper$,
        extensions_schema
      );
    END IF;
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.unaccent(pg_catalog.regdictionary, pg_catalog.text) TO PUBLIC';
  END IF;

  -- ───────────────────────────────────────────────────────────────────────────
  -- 6. pg_trgm fuera de `public`. El índice trigram de 0007 nombra la clase de
  --    operadores `gin_trgm_ops` sin cualificar, y wiki-search.ts usa
  --    `similarity()` / `word_similarity()` igual de desnudos: ambos se
  --    resuelven por search_path. Se añade el esquema de la extensión al
  --    search_path de los roles que administramos.
  -- ───────────────────────────────────────────────────────────────────────────
  SELECT namespace.nspname
    INTO extensions_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'pg_trgm';

  IF extensions_schema IS NOT NULL AND extensions_schema <> 'public' THEN
    BEGIN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO PUBLIC', extensions_schema);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'no se pudo conceder USAGE sobre el esquema %; Supabase ya lo concede de fábrica', extensions_schema;
    END;
    EXECUTE format(
      'ALTER ROLE %I IN DATABASE %I SET search_path TO "$user", public, %I',
      current_user, current_database(), extensions_schema
    );
    EXECUTE format(
      'ALTER ROLE casa_clara_app_login IN DATABASE %I SET search_path TO "$user", public, %I',
      current_database(), extensions_schema
    );
    EXECUTE format(
      'ALTER ROLE casa_clara_worker_login IN DATABASE %I SET search_path TO "$user", public, %I',
      current_database(), extensions_schema
    );
  END IF;
END
$bootstrap$;

COMMIT;
