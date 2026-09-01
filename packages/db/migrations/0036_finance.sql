BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Módulo «Finanzas» (docs/superpowers/specs/2026-08-31-modulo-finanzas-design.md
-- §4-§5). Diez tablas en `app`, todas con doble cerrojo en RLS: rol
-- family_admin Y concesión viva por membresía. Un admin sin concesión ve CERO
-- filas aunque llame a la API a mano; los otros cuatro papeles, cero por rol.
--
-- Desviación deliberada del patrón append-only laboral: las transacciones de
-- finanzas son un conjunto de trabajo analítico (recategorizar, confirmar,
-- agrupar es el uso normal). Se permiten UPDATE y DELETE bajo RLS, con el
-- trigger de auditoría registrando cada mutación. El ledger laboral no se toca.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Concesiones por membresía ─────────────────────────────────────────────
-- Una concesión viva es una fila con revoked_at IS NULL; revocar escribe
-- revoked_at (histórico conservado, patrón push_subscriptions/0030).
CREATE TABLE app.finance_module_grants (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL,
  granted_by_membership_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  revoked_by_membership_id uuid,
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, granted_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, revoked_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CHECK ((revoked_at IS NULL) = (revoked_by_membership_id IS NULL))
);

CREATE UNIQUE INDEX finance_module_grants_live_idx
  ON app.finance_module_grants (household_id, membership_id)
  WHERE revoked_at IS NULL;

-- Reja: solo se concede a membresías family_admin VIVAS (patrón 0030). Vigila
-- INSERT *y* UPDATE: sin el UPDATE, re-apuntar `membership_id` a quien no
-- administra abriría Finanzas por la puerta de atrás. El filtro de vigencia es
-- el idioma del repo (0001/0032): ni revocada ni caducada. Si la membresía no
-- existe o no está viva, `target_role` queda NULL y el IS DISTINCT FROM
-- también dispara el 23514.
CREATE FUNCTION app.enforce_finance_grant_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  target_role app.household_role;
BEGIN
  -- Revocar NUNCA se bloquea: apagar Finanzas debe poder hacerse aunque la
  -- membresía de destino ya esté revocada o caducada. La reja solo mira las
  -- filas que quedan VIVAS (alta o reapuntado).
  IF TG_OP = 'UPDATE' AND NEW.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT membership.role INTO target_role
    FROM app.household_memberships AS membership
   WHERE membership.household_id = NEW.household_id
     AND membership.id = NEW.membership_id
     AND membership.revoked_at IS NULL
     AND (membership.expires_at IS NULL OR membership.expires_at > statement_timestamp());
  IF target_role IS DISTINCT FROM 'family_admin' THEN
    RAISE EXCEPTION 'finance access can only be granted to a live family_admin membership'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finance_module_grants_target_guard
BEFORE INSERT OR UPDATE ON app.finance_module_grants
FOR EACH ROW EXECUTE FUNCTION app.enforce_finance_grant_target();

-- ── 2. El cerrojo ────────────────────────────────────────────────────────────
CREATE FUNCTION app.finance_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() = 'family_admin'
     AND EXISTS (
       SELECT 1
         FROM app.finance_module_grants AS grant_row
        WHERE grant_row.household_id = app.current_household_id()
          AND grant_row.membership_id = app.current_membership_id()
          AND grant_row.revoked_at IS NULL
     )
$$;

REVOKE ALL ON FUNCTION app.finance_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.finance_enabled() TO casa_clara_app;

-- ── 3. Tablas del dominio ────────────────────────────────────────────────────
CREATE TABLE app.finance_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- NULL: cuenta sin banco (p. ej. Efectivo). Las refs de inversión viven en
  -- transfer_refs: datos, no código.
  bank text CHECK (bank IS NULL OR bank IN ('caixabank', 'deutsche_bank', 'openbank', 'amex')),
  kind text NOT NULL CHECK (kind IN ('comun', 'personal', 'inversion')),
  owner_label text NOT NULL DEFAULT '' CHECK (length(owner_label) <= 120),
  bank_ref text CHECK (bank_ref IS NULL OR length(btrim(bank_ref)) BETWEEN 1 AND 64),
  owner_aliases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(owner_aliases) = 'array'),
  transfer_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(transfer_refs) = 'array'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, bank_ref),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE TABLE app.finance_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  parent_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('gasto', 'ingreso', 'transferencia')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, parent_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT,
  -- NULLS NOT DISTINCT (PostgreSQL 15+, el clúster es 18.4) es la diferencia
  -- entre proteger el árbol y no protegerlo: con el UNIQUE clásico los
  -- `parent_id IS NULL` son distintos entre sí y el hogar podría acabar con
  -- dos raíces «Casa». Aquí, dos raíces con el mismo nombre chocan (23505).
  UNIQUE NULLS NOT DISTINCT (household_id, parent_id, name)
);

-- Invariante del origen: COMO MUCHO una categoría raíz `transferencia` por
-- hogar. Que EXISTA no lo garantiza este índice, sino la semilla del §4 de este
-- mismo fichero, que corre al conceder Finanzas por primera vez en el hogar (y,
-- para un hogar migrado, el ETL de la fase 3). El pipeline post-import de la
-- fase 2 la necesita para vincular transferencias, efectivo e inversiones.
CREATE UNIQUE INDEX finance_categories_one_transfer_root_idx
  ON app.finance_categories (household_id)
  WHERE kind = 'transferencia' AND parent_id IS NULL;

-- Reja de profundidad: el árbol tiene DOS niveles (spec §5) y las fases 3
-- (ETL) y 5 (Ajustes) dan esa invariante por hecha. Un padre con padre queda
-- prohibido en la base, no solo en el código que escribe hoy.
CREATE FUNCTION app.enforce_finance_category_depth()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  grandparent_id uuid;
  parent_exists boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT true, parent.parent_id INTO parent_exists, grandparent_id
    FROM app.finance_categories AS parent
   WHERE parent.household_id = NEW.household_id AND parent.id = NEW.parent_id;
  IF NOT coalesce(parent_exists, false) THEN
    RAISE EXCEPTION 'finance category parent % does not exist in this household', NEW.parent_id
      USING ERRCODE = '23514';
  END IF;
  IF grandparent_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance categories are a two-level tree: % cannot hang from a subcategory', NEW.name
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER finance_categories_depth_guard
BEFORE INSERT OR UPDATE ON app.finance_categories
FOR EACH ROW EXECUTE FUNCTION app.enforce_finance_category_depth();

CREATE TABLE app.finance_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  rule_type text NOT NULL CHECK (rule_type IN ('proveedor_exacto', 'concepto_contiene', 'codigo_norma43')),
  pattern text NOT NULL CHECK (length(btrim(pattern)) BETWEEN 1 AND 200),
  category_id uuid NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'agente')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, category_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.finance_import_batches (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  filename text NOT NULL CHECK (length(btrim(filename)) BETWEEN 1 AND 255),
  -- Aquí SÍ entra 'manual' (doc de interfaces, resolución 6): un lote puede
  -- venir de un extracto de banco o de apuntes hechos a mano. En
  -- `finance_accounts.bank`, en cambio, solo caben los cuatro bancos reales o
  -- NULL.
  bank text NOT NULL CHECK (bank IN ('caixabank', 'deutsche_bank', 'openbank', 'amex', 'manual')),
  imported_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  new_count integer NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  dup_count integer NOT NULL DEFAULT 0 CHECK (dup_count >= 0),
  PRIMARY KEY (household_id, id)
);

CREATE TABLE app.finance_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  -- NULL: apunte manual. Borrar el lote deshace la importación (CASCADE, como el origen).
  batch_id uuid,
  op_date date NOT NULL,
  value_date date,
  concept text NOT NULL CHECK (length(concept) <= 500),
  provider text,
  provider_norm text,
  amount_cents bigint NOT NULL,
  balance_cents bigint,
  currency_code text NOT NULL DEFAULT 'EUR' CHECK (currency_code = 'EUR'),
  code_common text,
  code_own text,
  category_id uuid,
  status text NOT NULL DEFAULT 'pendiente'
    CHECK (status IN ('pendiente', 'sugerida_regla', 'sugerida_agente', 'confirmada')),
  transfer_group_id uuid,
  -- Prefijos semánticos conservados del origen: manual-, cashpair-, invmirror-.
  dedup_hash text NOT NULL CHECK (length(btrim(dedup_hash)) BETWEEN 1 AND 128),
  recurrence text CHECK (recurrence IS NULL OR recurrence IN ('recurrente', 'extraordinario')),
  recurrence_manual boolean NOT NULL DEFAULT false,
  bank_category text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw) = 'object'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, dedup_hash),
  FOREIGN KEY (household_id, account_id)
    REFERENCES app.finance_accounts(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, batch_id)
    REFERENCES app.finance_import_batches(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, category_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT
);

CREATE INDEX finance_transactions_op_date_idx
  ON app.finance_transactions (household_id, op_date);
CREATE INDEX finance_transactions_status_idx
  ON app.finance_transactions (household_id, status);

CREATE TABLE app.finance_provider_aliases (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  provider_norm text NOT NULL CHECK (length(btrim(provider_norm)) BETWEEN 1 AND 200),
  display text NOT NULL CHECK (length(btrim(display)) BETWEEN 1 AND 200),
  PRIMARY KEY (household_id, id),
  -- Un alias por proveedor normalizado y hogar. NO es cosmético: las lecturas
  -- de la fase 4 hacen `left join` a esta tabla para pintar el nombre bonito;
  -- con dos alias del mismo `provider_norm` el join multiplicaría filas e
  -- inflaría los `count(*)` y los `sum(amount_cents)` de los totales.
  UNIQUE (household_id, provider_norm)
);

CREATE TABLE app.finance_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, name)
);

CREATE TABLE app.finance_transaction_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, transaction_id, event_id),
  FOREIGN KEY (household_id, transaction_id)
    REFERENCES app.finance_transactions(household_id, id) ON DELETE CASCADE,
  -- Borrar un evento desvincula, no borra transacciones.
  FOREIGN KEY (household_id, event_id)
    REFERENCES app.finance_events(household_id, id) ON DELETE CASCADE
);

CREATE TABLE app.finance_event_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  provider_norm text,
  concept_norm text,
  category_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, event_id)
    REFERENCES app.finance_events(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, category_id)
    REFERENCES app.finance_categories(household_id, id) ON DELETE RESTRICT,
  -- O por (proveedor[, concepto]) o por categoría: nunca una regla vacía.
  CHECK (provider_norm IS NOT NULL OR category_id IS NOT NULL)
);

-- ── 4. Semilla del árbol de categorías por hogar ─────────────────────────────
-- La spec §5 exige que la semilla del origen «se replique como datos por hogar
-- al activar el módulo o migrar». El ETL (fase 3) cubre «o migrar»; esto cubre
-- «al activar»: la llama el comando `finance.grant.write` la PRIMERA vez que se
-- concede Finanzas en un hogar. Portada literalmente de la ONTOLOGY de
-- `home-finance/backend/app/seed.py`: 21 raíces (16 de gasto, 4 de ingreso y la
-- ÚNICA raíz de transferencia) y 29 subcategorías = 50 filas.
--
-- Idempotente: si el hogar ya tiene una sola categoría, devuelve 0 sin tocar
-- nada (así el hogar migrado por el ETL conserva su árbol y las fixtures no se
-- descuadran). SECURITY DEFINER con row_security off, patrón de
-- `app.mark_vacations_seen` (0028): quien concede puede no tener concesión
-- propia todavía, y sin ella las políticas `finance_*` no le dejarían escribir
-- ni la primera categoría. Nunca acepta un hogar por parámetro: siembra el del
-- contexto de la transacción, y solo si quien llama administra ese hogar.
-- (En Postgres gestionado, `SET row_security = off` dentro de un CREATE
-- FUNCTION exige que el propietario no esté sometido a FORCE: de eso ya se
-- encarga `0018_rls_force_compat.sql`, que el runner reaplica antes de cada
-- migración pendiente — es el mismo camino de las diez SECURITY DEFINER
-- anteriores, `app.mark_vacations_seen` incluida.)
CREATE FUNCTION app.seed_finance_categories()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  target_household uuid;
  ontology_row record;
  parent_key uuid;
  inserted integer := 0;
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;
  IF app.current_household_role() <> 'family_admin' THEN
    RAISE EXCEPTION 'solo la familia administradora siembra categorías de finanzas'
      USING ERRCODE = '42501';
  END IF;
  target_household := app.current_household_id();

  IF EXISTS (
    SELECT 1 FROM app.finance_categories WHERE household_id = target_household
  ) THEN
    RETURN 0;
  END IF;

  FOR ontology_row IN
    SELECT * FROM (VALUES
      ('Vivienda'::text, 'gasto'::text, ARRAY['Hipoteca/préstamo', 'Suministros', 'Comunidad', 'Seguridad/alarma', 'Mantenimiento']::text[]),
      ('Alimentación', 'gasto', ARRAY['Supermercado', 'Restaurantes y bares', 'Comida a domicilio', 'Comidas de trabajo']),
      ('Transporte', 'gasto', ARRAY['Combustible', 'Transporte público', 'Parking y peajes', 'Mantenimiento vehículo']),
      ('Salud', 'gasto', ARRAY['Médicos', 'Farmacia']),
      ('Hijos y educación', 'gasto', ARRAY['Colegio', 'Actividades', 'Cuidado']),
      ('Ocio y cultura', 'gasto', ARRAY[]::text[]),
      ('Ropa y cuidado personal', 'gasto', ARRAY[]::text[]),
      ('Telecomunicaciones y suscripciones', 'gasto', ARRAY['Telefonía e internet', 'Streaming y medios', 'Software y servicios digitales']),
      ('Seguros', 'gasto', ARRAY['Auto', 'Hogar', 'Vida', 'Salud', 'Otros seguros']),
      ('Impuestos y tasas', 'gasto', ARRAY[]::text[]),
      ('Regalos y donaciones', 'gasto', ARRAY[]::text[]),
      ('Viajes', 'gasto', ARRAY[]::text[]),
      ('Bancario', 'gasto', ARRAY['Comisiones', 'Intereses', 'Financiación y aplazados']),
      ('Compras', 'gasto', ARRAY[]::text[]),
      ('Otros gastos', 'gasto', ARRAY[]::text[]),
      ('Efectivo', 'gasto', ARRAY[]::text[]),
      ('Nómina', 'ingreso', ARRAY[]::text[]),
      ('Ingresos de alquiler', 'ingreso', ARRAY[]::text[]),
      ('Aportaciones a Cuenta Común', 'ingreso', ARRAY[]::text[]),
      ('Otros ingresos', 'ingreso', ARRAY[]::text[]),
      ('Transferencia interna', 'transferencia', ARRAY[]::text[])
    ) AS ontology(name, kind, children)
  LOOP
    INSERT INTO app.finance_categories (household_id, parent_id, name, kind)
    VALUES (target_household, NULL, ontology_row.name, ontology_row.kind)
    RETURNING id INTO parent_key;
    inserted := inserted + 1;

    INSERT INTO app.finance_categories (household_id, parent_id, name, kind)
    SELECT target_household, parent_key, child, ontology_row.kind
      FROM unnest(ontology_row.children) AS child;
    inserted := inserted + coalesce(array_length(ontology_row.children, 1), 0);
  END LOOP;

  RETURN inserted;
END
$$;

REVOKE ALL ON FUNCTION app.seed_finance_categories() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.seed_finance_categories() TO casa_clara_app;

-- ── 5. RLS: doble cerrojo en todo, salvo las concesiones ────────────────────
DO $enable_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$enable_rls$;

-- Las concesiones: las lee cualquier administración del hogar (para pintar la
-- tarjeta de Ajustes) y las muta la administración vía comandos. Sin DELETE:
-- revocar escribe revoked_at y el histórico se conserva.
CREATE POLICY finance_grants_admin_read ON app.finance_module_grants
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY finance_grants_admin_insert ON app.finance_module_grants
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY finance_grants_admin_update ON app.finance_module_grants
  FOR UPDATE USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'family_admin'
  );

-- El resto: TODA operación exige hogar en contexto Y cerrojo de finanzas.
DO $finance_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_accounts', 'finance_categories', 'finance_rules',
    'finance_import_batches', 'finance_transactions', 'finance_provider_aliases',
    'finance_events', 'finance_transaction_events', 'finance_event_rules'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I_finance_admin_all ON app.%I FOR ALL '
      'USING (app.tenant_context_matches(household_id) AND app.finance_enabled()) '
      'WITH CHECK (app.tenant_context_matches(household_id) AND app.finance_enabled())',
      table_name, table_name
    );
  END LOOP;
END
$finance_policies$;

-- ── 6. Grants y auditoría ────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON app.finance_module_grants TO casa_clara_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.finance_accounts, app.finance_categories, app.finance_rules,
  app.finance_import_batches, app.finance_transactions,
  app.finance_provider_aliases, app.finance_events,
  app.finance_transaction_events, app.finance_event_rules
  TO casa_clara_app;

DO $audit_triggers$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON app.%I '
      'FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event()',
      table_name, table_name
    );
  END LOOP;
END
$audit_triggers$;

COMMIT;
