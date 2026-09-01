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
  --
  -- Se miran las DOS mitades. Mirar solo `qual` (el USING) dejaba pasar una
  -- política con el `WITH CHECK` vaciado, que es justo la mitad que autoriza
  -- las ESCRITURAS: el test daba verde mientras un admin sin concesión metía
  -- movimientos. Y se cuenta `count(*)` con `cmd = 'ALL'`, no
  -- `count(DISTINCT tablename)`: así se exige UNA política por tabla que cubra
  -- los cuatro verbos, en vez de conformarse con que exista alguna.
  SELECT count(*)::integer INTO locked_tables
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app'
     AND tablename = ANY (finance_tables)
     AND tablename <> 'finance_module_grants'
     AND cmd = 'ALL'
     AND qual       LIKE '%finance_enabled%'
     AND with_check LIKE '%finance_enabled%';
  IF locked_tables <> 9 THEN
    RAISE EXCEPTION 'only % of 9 finance tables enforce app.finance_enabled() on both halves', locked_tables;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app' AND tablename = 'finance_module_grants'
       AND qual LIKE '%finance_enabled%'
  ) THEN
    RAISE EXCEPTION 'finance_module_grants must not depend on its own lock';
  END IF;
  -- Y que esas tres políticas EXISTAN: la comprobación de arriba es negativa y
  -- una tabla sin ninguna política la pasaría igual. Falla cerrado (RLS forzada
  -- sin políticas deniega todo), pero dejaría la tarjeta de Ajustes sin red.
  -- `qual` es NULL en la política de INSERT y `with_check` lo es en la de
  -- SELECT, así que ambos lados van dentro de coalesce: sin eso la
  -- concatenación se anula y el conteo nunca llegaría a tres.
  IF (SELECT count(*) FROM pg_catalog.pg_policies
       WHERE schemaname = 'app' AND tablename = 'finance_module_grants'
         AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%family_admin%') <> 3 THEN
    RAISE EXCEPTION 'finance_module_grants needs its three admin policies';
  END IF;

  -- El cerrojo del rastro de auditoría (0035). `write_audit_event` vuelca la
  -- fila entera en after_data, y `audit_events_read` (0005) deja leer esa tabla
  -- a cualquier family_admin del hogar sin pasar por finance_enabled(): sin
  -- esta restrictiva, un admin sin concesión leía concepto, proveedor, importe
  -- y saldo de cada movimiento. Restrictiva y no permisiva porque las
  -- permisivas se combinan con OR y solo podrían ampliar el acceso.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'app'
       AND tablename = 'audit_events'
       AND policyname = 'audit_events_finance_lock'
       AND permissive = 'RESTRICTIVE'
       AND cmd = 'SELECT'
       AND qual LIKE '%finance_enabled%'
  ) THEN
    RAISE EXCEPTION 'app.audit_events needs the restrictive finance lock from 0035';
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

-- ─────────────────────────────────────────────────────────────────────────────
-- La reja del árbol mira también hacia ABAJO y hacia SÍ MISMA (0035).
--
-- La versión de la 0034 solo comprobaba el padre del padre que se asigna, así
-- que por UPDATE se podía (a) colgar bajo otra raíz una categoría que YA tiene
-- hijas —dejándolas en un tercer nivel— y (b) apuntar `parent_id` a la propia
-- fila: en un BEFORE UPDATE la tabla aún contiene la fila vieja, el abuelo leído
-- es el de antes (NULL) y el cambio pasaba. Lo segundo era peor de lo que
-- parece: una raíz de transferencia que se apunta a sí misma sale del índice
-- parcial `... WHERE kind = 'transferencia' AND parent_id IS NULL` y deja sitio
-- a una segunda, que es la invariante de la que depende el pipeline de la fase 2.
--
-- Todo dentro de una transacción revertida: este fichero no deja filas.
-- UUIDs con prefijo fc*, exclusivos de aquí.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.finance_categories (id, household_id, parent_id, name, kind) VALUES
  ('fc100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   NULL, 'Raíz con hijas', 'gasto'),
  ('fc100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   NULL, 'Raíz de acogida', 'gasto'),
  ('fc100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'fc100000-0000-4000-8000-000000000001', 'Hija que quedaría en tercer nivel', 'gasto'),
  ('fc100000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   'fc100000-0000-4000-8000-000000000001', 'Hoja sin descendencia', 'gasto'),
  ('fc100000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
   NULL, 'Transferencia interna', 'transferencia');

DO $assert_category_depth_guard$
DECLARE
  transfer_roots integer;
BEGIN
  -- (a) Mover una madre bajo otra raíz dejaría a sus hijas en el tercer nivel.
  BEGIN
    UPDATE app.finance_categories
       SET parent_id = 'fc100000-0000-4000-8000-000000000002'
     WHERE id = 'fc100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'una categoría con hijas se pudo colgar de otra raíz';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (b) Autopadre: ciclo de longitud 1.
  BEGIN
    UPDATE app.finance_categories
       SET parent_id = id
     WHERE id = 'fc100000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'una categoría se pudo apuntar a sí misma como madre';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- (c) Y el caso que además rompía la unicidad de la raíz de transferencia.
  BEGIN
    UPDATE app.finance_categories
       SET parent_id = id
     WHERE id = 'fc100000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'la raíz de transferencia se pudo sacar del índice parcial';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  SELECT count(*)::integer INTO transfer_roots
    FROM app.finance_categories
   WHERE household_id = '10000000-0000-4000-8000-000000000001'
     AND kind = 'transferencia' AND parent_id IS NULL;
  IF transfer_roots <> 1 THEN
    RAISE EXCEPTION 'el hogar tiene % raíces de transferencia', transfer_roots;
  END IF;

  -- Y lo LEGÍTIMO sigue pasando: mover una hoja sin descendencia de una raíz a
  -- otra es reorganizar el árbol, no romperlo. Sin esta comprobación las dos
  -- guardas de arriba podrían estar cerrando de más y nadie se enteraría.
  UPDATE app.finance_categories
     SET parent_id = 'fc100000-0000-4000-8000-000000000002'
   WHERE id = 'fc100000-0000-4000-8000-000000000004';
  IF (SELECT parent_id FROM app.finance_categories
       WHERE id = 'fc100000-0000-4000-8000-000000000004')
     <> 'fc100000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'mover una hoja sin hijas debería estar permitido';
  END IF;

  -- El tercer nivel por INSERT seguía cerrado desde la 0034; que siga.
  BEGIN
    INSERT INTO app.finance_categories (household_id, parent_id, name, kind)
    VALUES ('10000000-0000-4000-8000-000000000001',
            'fc100000-0000-4000-8000-000000000003', 'Nieta', 'gasto');
    RAISE EXCEPTION 'entró un tercer nivel por INSERT';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$assert_category_depth_guard$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La fuga por `app.audit_events` (0035).
--
-- Un family_admin sin concesión ve cero movimientos por la vía normal, pero el
-- trigger de auditoría guarda la fila entera y `audit_events_read` no pasa por
-- el cerrojo. Aquí se comprueba lo que la restrictiva promete: el rastro se
-- SIGUE ESCRIBIENDO siempre —nunca se recorta lo que el trigger registra—, y lo
-- que se controla es quién puede leerlo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.finance_accounts (id, household_id, name, kind, bank_ref) VALUES
  ('fc200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Cuenta de la sonda', 'comun', 'fc-sonda-0001');

INSERT INTO app.finance_transactions (
  id, household_id, account_id, op_date, concept, provider, provider_norm,
  amount_cents, balance_cents, dedup_hash
) VALUES (
  'fc200000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
  'fc200000-0000-4000-8000-000000000001', '2026-08-25',
  'NOMINA AGOSTO EMPRESA SINTETICA SL', 'EMPRESA SINTETICA SL', 'empresa sintetica sl',
  328550, 1204399, 'fc-sonda-dedup-0001'
);

DO $assert_audit_trail_written$
DECLARE
  written integer;
BEGIN
  -- Primero, lo que NO debe cambiar nunca: la auditoría lo registró todo.
  SELECT count(*)::integer INTO written
    FROM app.audit_events
   WHERE household_id = '10000000-0000-4000-8000-000000000001'
     AND entity_table IN ('finance_accounts', 'finance_transactions');
  IF written <> 2 THEN
    RAISE EXCEPTION 'la auditoría financiera registró % filas, se esperaban 2', written;
  END IF;
END
$assert_audit_trail_written$;

SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001');

DO $assert_audit_leak_closed$
DECLARE
  finance_rows integer;
  other_rows integer;
BEGIN
  IF app.finance_enabled() THEN
    RAISE EXCEPTION 'la sonda parte de un admin que ya tiene concesión';
  END IF;
  SELECT count(*)::integer INTO finance_rows
    FROM app.audit_events WHERE entity_table LIKE 'finance\_%';
  IF finance_rows <> 0 THEN
    RAISE EXCEPTION 'un admin sin concesión lee % filas de auditoría financiera', finance_rows;
  END IF;
  -- Sin daño colateral: el resto del rastro del hogar se sigue viendo. Sin esto,
  -- una restrictiva demasiado ancha —que ocultara toda la auditoría— pasaría por
  -- buena.
  SELECT count(*)::integer INTO other_rows
    FROM app.audit_events WHERE entity_table NOT LIKE 'finance\_%';
  IF other_rows = 0 THEN
    RAISE EXCEPTION 'la restrictiva se llevó por delante la auditoría no financiera';
  END IF;
END
$assert_audit_leak_closed$;

RESET ROLE;
SET LOCAL row_security = off;

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
VALUES ('10000000-0000-4000-8000-000000000001',
        '11000000-0000-4000-8000-000000000001',
        '11000000-0000-4000-8000-000000000001');

SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;

DO $assert_audit_access_kept$
DECLARE
  finance_rows integer;
BEGIN
  IF NOT app.finance_enabled() THEN
    RAISE EXCEPTION 'la concesión no encendió el módulo';
  END IF;
  SELECT count(*)::integer INTO finance_rows
    FROM app.audit_events WHERE entity_table LIKE 'finance\_%';
  IF finance_rows < 2 THEN
    RAISE EXCEPTION 'con concesión el admin solo lee % filas de auditoría financiera', finance_rows;
  END IF;
END
$assert_audit_access_kept$;

RESET ROLE;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Y la restrictiva no puede romper al worker.
--
-- Va en su propia transacción a propósito: `app.set_household_context` deja el
-- hogar y el rol en variables LOCALES de la transacción, así que reutilizar la
-- de arriba le habría prestado al worker un contexto que en producción no tiene
-- jamás y la prueba habría medido otra cosa.
--
-- La restrictiva está acotada `TO casa_clara_app` por necesidad, no por
-- descuido: `finance_enabled()` es SECURITY INVOKER y su cuerpo lee
-- `finance_module_grants`, tabla sobre la que el worker no tiene privilegio
-- ninguno. Sin esa cláusula, TODA lectura del worker sobre `audit_events` moría
-- con «permission denied for function finance_enabled» —también las filas que
-- nada tienen que ver con finanzas—, y abrirle las concesiones para evitarlo
-- habría sido peor que el problema.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.finance_accounts (id, household_id, name, kind) VALUES
  ('fc300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Cuenta que deja rastro', 'comun');

SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_worker;

DO $assert_worker_not_broken$
DECLARE
  total integer;
BEGIN
  SELECT count(*)::integer INTO total FROM app.audit_events;
  IF total <> 0 THEN
    RAISE EXCEPTION 'el worker ve % filas de auditoría sin contexto de hogar', total;
  END IF;
END
$assert_worker_not_broken$;

RESET ROLE;
ROLLBACK;
