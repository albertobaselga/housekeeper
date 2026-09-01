-- Matriz negativa del módulo Finanzas (spec §4). Requiere migraciones +
-- fixtures aplicadas por el runner. Este primer bloque convierte el esquema
-- del doble cerrojo en aserciones; la matriz de filas viene después.
DO $assert_finance_schema$
DECLARE
  finance_tables text[] := ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ];
  table_name text;
  locked_tables integer;
  audit_triggers integer;
BEGIN
  FOREACH table_name IN ARRAY finance_tables LOOP
    IF to_regclass('app.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'missing finance table app.%', table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = to_regclass('app.' || table_name)
         AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'app.% lacks ENABLE ROW LEVEL SECURITY', table_name;
    END IF;
    IF NOT has_table_privilege('casa_clara_app', 'app.' || table_name, 'SELECT') THEN
      RAISE EXCEPTION 'casa_clara_app cannot read app.%', table_name;
    END IF;
  END LOOP;

  IF to_regprocedure('app.finance_enabled()') IS NULL THEN
    RAISE EXCEPTION 'app.finance_enabled() is missing';
  END IF;
  IF to_regprocedure('app.seed_finance_categories()') IS NULL THEN
    RAISE EXCEPTION 'app.seed_finance_categories() is missing';
  END IF;

  -- Árbol de categorías blindado (spec §5), y la migración es append-only: si
  -- estas dos rejas no entran en 0034, corregirlas cuesta un 0035.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
     WHERE index_relation.relname = 'finance_categories_household_id_parent_id_name_key'
       AND index_row.indnullsnotdistinct
  ) THEN
    RAISE EXCEPTION 'finance_categories needs UNIQUE NULLS NOT DISTINCT (household_id, parent_id, name)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.finance_categories')
       AND tgname = 'finance_categories_depth_guard'
  ) THEN
    RAISE EXCEPTION 'missing finance_categories_depth_guard trigger';
  END IF;

  -- La reja de concesiones vigila también los UPDATE (bit 16 de tgtype): sin
  -- eso, re-apuntar membership_id a quien no administra pasaría desapercibido.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = to_regclass('app.finance_module_grants')
       AND tgname = 'finance_module_grants_target_guard'
       AND (tgtype & 16) <> 0
  ) THEN
    RAISE EXCEPTION 'finance_module_grants_target_guard must also fire BEFORE UPDATE';
  END IF;

  -- Doble cerrojo: TODAS las políticas de finance_* exigen finance_enabled(),
  -- con la única excepción de la tabla de concesiones.
  SELECT count(DISTINCT tablename)::integer INTO locked_tables
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app'
     AND tablename = ANY (finance_tables)
     AND tablename <> 'finance_module_grants'
     AND qual LIKE '%finance_enabled%';
  IF locked_tables <> 9 THEN
    RAISE EXCEPTION 'only % of 9 finance tables enforce app.finance_enabled()', locked_tables;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'finance_module_grants'
       AND qual LIKE '%finance_enabled%'
  ) THEN
    RAISE EXCEPTION 'finance_module_grants must not depend on its own lock';
  END IF;

  IF to_regclass('app.finance_module_grants_live_idx') IS NULL THEN
    RAISE EXCEPTION 'missing partial unique index for live grants';
  END IF;
  IF to_regclass('app.finance_categories_one_transfer_root_idx') IS NULL THEN
    RAISE EXCEPTION 'missing single-transfer-root partial unique index';
  END IF;

  SELECT count(*)::integer INTO audit_triggers
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'app'
     AND relation.relname = ANY (finance_tables)
     AND trigger_row.tgname LIKE '%\_audit';
  IF audit_triggers <> 10 THEN
    RAISE EXCEPTION 'expected 10 finance audit triggers, found %', audit_triggers;
  END IF;
END
$assert_finance_schema$;
