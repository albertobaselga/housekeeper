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

-- La fixture 002 ya planta la única raíz de transferencia del roble, y el caso
-- (c) de abajo necesita una propia para sacarla del índice parcial. Se retira
-- aquí la de la fixture —no la referencia nadie: los movimientos y la regla
-- cuelgan de «Supermercado»— y el ROLLBACK final la devuelve intacta.
DELETE FROM app.finance_categories
 WHERE id = 'f1c00000-0000-4000-8000-000000000004';

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

-- La sonda necesita partir de un administrador SIN concesión, y la fixture 002
-- se la da al del roble. Se revoca aquí dentro; el ROLLBACK del final la
-- devuelve viva. Revocar no despierta la reja del disparador (mira solo las
-- filas que quedan vivas), y deja libre el índice parcial de concesiones vivas
-- para la que se concede más abajo.
UPDATE app.finance_module_grants
   SET revoked_at = statement_timestamp(),
       revoked_by_membership_id = '11000000-0000-4000-8000-000000000001'
 WHERE household_id = '10000000-0000-4000-8000-000000000001'
   AND revoked_at IS NULL;

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
  -- Primero, lo que NO debe cambiar nunca: la auditoría lo registró todo. Se
  -- cuentan por `entity_id` las DOS filas de la sonda, no todo el rastro
  -- financiero del hogar: desde la fixture 002 el roble llega aquí con
  -- movimientos ya auditados, y un `count` global mediría la fixture en vez de
  -- lo que esta sonda acaba de escribir.
  SELECT count(*)::integer INTO written
    FROM app.audit_events
   WHERE household_id = '10000000-0000-4000-8000-000000000001'
     AND entity_table IN ('finance_accounts', 'finance_transactions')
     AND entity_id IN ('fc200000-0000-4000-8000-000000000001',
                       'fc200000-0000-4000-8000-000000000002');
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Sembrado propio del fichero (prefijo fa9*, libre: 170_push_subscriptions.sql
-- ya ocupa fa1*/fa2*): una SEGUNDA administración del roble SIN concesión — la
-- fila que demuestra que el rol solo no abre nada — y una TERCERA ya revocada,
-- para probar que la reja del disparador tampoco admite membresías muertas.
-- Ambas se eliminan al final para no alterar los conteos de las suites
-- posteriores.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;
-- Reejecutable a propósito: si una ejecución anterior se cayó entre este
-- sembrado y la limpieza del final, las cuatro filas siguen ahí y los INSERT de
-- abajo morirían por clave duplicada, tapando el fallo de verdad. Primero las
-- membresías, que apuntan a los perfiles.
DELETE FROM app.household_memberships
 WHERE id IN ('fa900000-0000-4000-8000-000000000001',
              'fa900000-0000-4000-8000-000000000002');
DELETE FROM app.user_profiles
 WHERE user_id IN ('fixture:roble:admin2', 'fixture:roble:admin3');
INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('fixture:roble:admin2', 'Fixture Segunda Admin Roble'),
  ('fixture:roble:admin3', 'Fixture Admin Roble Revocada');
INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('fa900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'fixture:roble:admin2', 'family_admin'),
  ('fa900000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'fixture:roble:admin3', 'family_admin');
UPDATE app.household_memberships
   SET revoked_at = statement_timestamp()
 WHERE id = 'fa900000-0000-4000-8000-000000000002';
COMMIT;

BEGIN;

-- Control positivo, como propietario y antes de bajar de rol: que el olivo
-- TENGA finanzas. Toda la matriz del segundo hogar dice «su hogar tiene datos
-- sembrados y aun así ve cero», y hasta aquí nadie comprobaba la primera mitad
-- de esa frase: vaciando la fixture del olivo la matriz seguía entera en verde.
-- Es el único punto por donde esto puede volverse vacuo en silencio el día que
-- alguien «limpie» la fixture.
DO $assert_olivo_tiene_finanzas$
BEGIN
  IF (SELECT count(*) FROM app.finance_accounts
       WHERE household_id = '20000000-0000-4000-8000-000000000001') = 0
     OR (SELECT count(*) FROM app.finance_categories
       WHERE household_id = '20000000-0000-4000-8000-000000000001') = 0
     OR (SELECT count(*) FROM app.finance_transactions
       WHERE household_id = '20000000-0000-4000-8000-000000000001') = 0 THEN
    RAISE EXCEPTION 'la fixture dejó el olivo sin finanzas: el bloque del admin del olivo no probaría nada';
  END IF;
END
$assert_olivo_tiene_finanzas$;

SET LOCAL ROLE casa_clara_app;

-- Admin del roble CON concesión: ve lo suyo, nada del olivo, y las seis rejas
-- estructurales (cruce de hogar; segunda raíz de transferencia; concesión a
-- quien no administra; concesión a una administración revocada; raíz repetida
-- por nombre; tercer nivel del árbol) fallan con su SQLSTATE exacto.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_granted_admin$
DECLARE
  finance_tables text[] := ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ];
  probed_table text;
  expected record;
  visible integer;
BEGIN
  -- La fuga entre hogares va PRIMERO, y sobre las diez tablas. Cuando iba
  -- después de los conteos exactos era código muerto: cualquier fila del olivo
  -- que se colara subía uno de esos conteos y disparaba la genérica, de modo que
  -- esta comprobación no podía ejecutarse jamás. La reja más importante del
  -- módulo —«nadie ve el hogar de al lado»— existía, pero informaba con el
  -- mensaje equivocado y su aserción propia era decorativa.
  FOREACH probed_table IN ARRAY finance_tables LOOP
    EXECUTE format('SELECT count(*) FROM app.%I WHERE household_id = $1', probed_table)
       INTO visible USING '20000000-0000-4000-8000-000000000001'::uuid;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'fuga entre hogares: la administración del roble ve % filas del olivo en app.%',
        visible, probed_table;
    END IF;
  END LOOP;

  -- Y después los conteos exactos del hogar propio, tabla por tabla. Colapsar
  -- diez `count(*)` en un solo mensaje obligaba a bisecarlos a mano el día que
  -- la fase 2 amplíe la fixture y esto se ponga rojo.
  FOR expected IN
    SELECT * FROM (VALUES
      ('finance_module_grants', 1),
      ('finance_accounts', 2),
      ('finance_categories', 4),
      ('finance_rules', 1),
      ('finance_import_batches', 1),
      ('finance_transactions', 2),
      ('finance_provider_aliases', 1),
      ('finance_events', 1),
      ('finance_transaction_events', 1),
      ('finance_event_rules', 1)
    ) AS pairs(table_name, expected_rows)
  LOOP
    EXECUTE format('SELECT count(*) FROM app.%I', expected.table_name) INTO visible;
    IF visible <> expected.expected_rows THEN
      RAISE EXCEPTION 'la administración con concesión ve % filas en app.%, se esperaban %',
        visible, expected.table_name, expected.expected_rows;
    END IF;
  END LOOP;

  -- Suplantación de hogar: escribir en el olivo desde el roble → 42501.
  BEGIN
    INSERT INTO app.finance_events (household_id, name)
    VALUES ('20000000-0000-4000-8000-000000000001', 'Evento intruso');
    RAISE EXCEPTION 'cross-tenant finance insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Segunda raíz de transferencia: el índice parcial la mata (23505).
  BEGIN
    INSERT INTO app.finance_categories (household_id, name, kind)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Otra transferencia', 'transferencia');
    RAISE EXCEPTION 'second transfer-root category unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Conceder a la persona de apoyo: la reja del disparador (23514).
  BEGIN
    INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001',
            '11000000-0000-4000-8000-000000000004',
            '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'granting finance to a helper unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Conceder a una administración REVOCADA: la reja mira también la vigencia
  -- de la membresía, no solo su papel (23514).
  BEGIN
    INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001',
            'fa900000-0000-4000-8000-000000000002',
            '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'granting finance to a revoked admin unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Segunda raíz con el MISMO nombre: la mata UNIQUE NULLS NOT DISTINCT
  -- (23505); con el UNIQUE clásico esta fila entraría.
  BEGIN
    INSERT INTO app.finance_categories (household_id, name, kind)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Casa', 'gasto');
    RAISE EXCEPTION 'duplicate root category name unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Tercer nivel: «Supermercado» ya cuelga de «Casa» en la fixture, así que
  -- colgar de él sería el tercer piso — lo prohíbe la reja de profundidad
  -- (23514), porque la spec §5 fija un árbol de DOS niveles.
  BEGIN
    INSERT INTO app.finance_categories (household_id, parent_id, name, kind)
    VALUES ('10000000-0000-4000-8000-000000000001',
            'f1c00000-0000-4000-8000-000000000002', 'Fruta', 'gasto');
    RAISE EXCEPTION 'third-level finance category unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$assert_granted_admin$;

-- Admin del roble SIN concesión: cero filas de finanzas. Las concesiones sí
-- las ve (cualquier admin pinta Ajustes con ellas), pero no le abren nada.
SELECT set_config('app.user_id', 'fixture:roble:admin2', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  'fa900000-0000-4000-8000-000000000001'
);

DO $assert_ungranted_admin$
DECLARE
  -- Las nueve del módulo; las concesiones van aparte, porque de esas sí ve una.
  finance_tables text[] := ARRAY[
    'finance_accounts', 'finance_categories', 'finance_rules',
    'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events',
    'finance_transaction_events', 'finance_event_rules'
  ];
  probed_table text;
  visible integer;
BEGIN
  FOREACH probed_table IN ARRAY finance_tables LOOP
    EXECUTE format('SELECT count(*) FROM app.%I', probed_table) INTO visible;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'la administración sin concesión ve % filas en app.%',
        visible, probed_table;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM app.finance_module_grants) <> 1
     OR (SELECT app.finance_enabled()) THEN
    RAISE EXCEPTION 'grant visibility or lock state wrong for ungranted admin';
  END IF;
  BEGIN
    INSERT INTO app.finance_events (household_id, name)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Evento sin cerrojo');
    RAISE EXCEPTION 'ungranted admin wrote a finance row';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$assert_ungranted_admin$;

-- Los otros cuatro papeles del roble: cero en TODO, concesiones incluidas.
DO $assert_non_admin_roles$
DECLARE
  finance_tables text[] := ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ];
  probed_table text;
  visible integer;
  role_pair record;
BEGIN
  FOR role_pair IN
    SELECT * FROM (VALUES
      ('fixture:roble:family',   '11000000-0000-4000-8000-000000000002'::uuid),
      ('fixture:roble:employee', '11000000-0000-4000-8000-000000000003'::uuid),
      ('fixture:roble:helper',   '11000000-0000-4000-8000-000000000004'::uuid),
      ('fixture:roble:viewer',   '11000000-0000-4000-8000-000000000005'::uuid)
    ) AS pairs(user_id, membership_id)
  LOOP
    PERFORM set_config('app.user_id', role_pair.user_id, true);
    PERFORM set_config('app.household_id', '', true);
    PERFORM set_config('app.membership_id', '', true);
    PERFORM set_config('app.role', '', true);
    PERFORM app.set_household_context(
      '10000000-0000-4000-8000-000000000001', role_pair.membership_id);
    FOREACH probed_table IN ARRAY finance_tables LOOP
      EXECUTE format('SELECT count(*) FROM app.%I', probed_table) INTO visible;
      IF visible <> 0 THEN
        RAISE EXCEPTION '% ve % filas en app.%', role_pair.user_id, visible, probed_table;
      END IF;
    END LOOP;
  END LOOP;
END
$assert_non_admin_roles$;

-- Admin del OLIVO sin concesión: su hogar tiene datos de finanzas sembrados y
-- aun así ve cero. La concesión es por membresía, no por hogar.
SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

DO $assert_olivo_admin$
DECLARE
  -- Las diez, no las cuatro de antes: hoy el olivo solo tiene filas en tres, y
  -- las otras seis serían vacuas, pero costaba lo mismo cerrarlas todas que
  -- dejar el segundo hogar más fino de lo que promete el comentario de arriba.
  finance_tables text[] := ARRAY[
    'finance_module_grants', 'finance_accounts', 'finance_categories',
    'finance_rules', 'finance_import_batches', 'finance_transactions',
    'finance_provider_aliases', 'finance_events', 'finance_transaction_events',
    'finance_event_rules'
  ];
  probed_table text;
  visible integer;
BEGIN
  FOREACH probed_table IN ARRAY finance_tables LOOP
    EXECUTE format('SELECT count(*) FROM app.%I', probed_table) INTO visible;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'la administración del olivo, sin concesión, ve % filas en app.%',
        visible, probed_table;
    END IF;
  END LOOP;
END
$assert_olivo_admin$;

COMMIT;

-- Revocar apaga el módulo EN EL ACTO. Se prueba dentro de una transacción que
-- se revierte, para no alterar la fixture compartida por las demás suites.
BEGIN;
SET LOCAL row_security = off;
UPDATE app.finance_module_grants
   SET revoked_at = statement_timestamp(),
       revoked_by_membership_id = '11000000-0000-4000-8000-000000000001'
 WHERE id = 'f1900000-0000-4000-8000-000000000001';
SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);
DO $assert_revocation_is_immediate$
BEGIN
  IF (SELECT app.finance_enabled())
     OR (SELECT count(*) FROM app.finance_transactions) <> 0 THEN
    RAISE EXCEPTION 'a revoked grant still opened finance';
  END IF;
END
$assert_revocation_is_immediate$;
ROLLBACK;

-- La semilla del árbol de categorías (spec §5, portada de seed.py): siembra
-- 50 filas la primera vez y 0 la segunda. Se prueba sobre el OLIVO —cuyo admin
-- NO tiene concesión, que es justo el caso real: se siembra al conceder, antes
-- de que el cerrojo se abra— dentro de una transacción que se revierte.
BEGIN;
SET LOCAL row_security = off;
DELETE FROM app.finance_categories
 WHERE household_id = '20000000-0000-4000-8000-000000000001';
SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);
DO $assert_category_seed$
DECLARE
  first_run integer;
  second_run integer;
BEGIN
  first_run := app.seed_finance_categories();
  second_run := app.seed_finance_categories();
  IF first_run <> 50 OR second_run <> 0 THEN
    RAISE EXCEPTION 'category seed inserted % rows and % on the second run (expected 50 and 0)',
      first_run, second_run;
  END IF;
END
$assert_category_seed$;
RESET ROLE;
DO $assert_seeded_tree$
BEGIN
  -- Se leen como propietario (superusuario del clúster de pruebas): el admin
  -- del olivo sigue sin concesión y la RLS no le enseñaría ni una fila.
  IF (SELECT count(*) FROM app.finance_categories
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 50
     OR (SELECT count(*) FROM app.finance_categories
          WHERE household_id = '20000000-0000-4000-8000-000000000001'
            AND parent_id IS NOT NULL) <> 29 THEN
    RAISE EXCEPTION 'seeded category tree has the wrong shape';
  END IF;
  IF (SELECT count(*) FROM app.finance_categories
       WHERE household_id = '20000000-0000-4000-8000-000000000001'
         AND kind = 'transferencia' AND parent_id IS NULL) <> 1 THEN
    RAISE EXCEPTION 'the seed must leave exactly one transferencia root';
  END IF;
END
$assert_seeded_tree$;
ROLLBACK;

-- El emisor de trabajos no tiene GRANT sobre finanzas: ni una fila.
BEGIN;
SET LOCAL ROLE casa_clara_worker;
DO $assert_worker_no_finance$
BEGIN
  BEGIN
    PERFORM 1 FROM app.finance_transactions;
    RAISE EXCEPTION 'worker unexpectedly read finance data';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$assert_worker_no_finance$;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- El rastro de auditoría, papel por papel, sobre datos de finanzas REALES.
--
-- La sonda de la 0035 (más arriba) prueba la restrictiva con filas que ella
-- misma inserta y revirtiendo la concesión de la fixture. Esto es el caso de
-- verdad y el que pidió el encargo: una administración a la que NADIE ha
-- concedido Finanzas, con todas las filas financieras que la fixture 002 dejó
-- auditadas en el hogar del roble, ahí delante y sin poder leer ni una.
--
-- Cuántas son se cuenta como propietario antes de bajar de rol, no se escribe a
-- mano: así la aserción positiva conserva la igualdad exacta —que es lo que la
-- hace morder: una restrictiva demasiado ancha da 0, y 0 no es el total— y a la
-- vez se autoajusta cuando la fase 2 amplíe la fixture. El suelo de diez filas
-- impide que la comparación se vuelva vacua si alguien adelgaza la fixture hasta
-- dejar el rastro casi vacío.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;
SELECT set_config(
  'casaclara.finance_audit_esperado',
  (SELECT count(*)::text FROM app.audit_events
    WHERE household_id = '10000000-0000-4000-8000-000000000001'
      AND entity_table LIKE 'finance\_%'),
  true);
SET LOCAL row_security = on;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:admin2', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  'fa900000-0000-4000-8000-000000000001'
);

DO $assert_audit_matrix_ungranted$
DECLARE
  finance_rows integer;
  other_rows integer;
BEGIN
  IF app.finance_enabled() THEN
    RAISE EXCEPTION 'la segunda administración del roble no debería tener concesión';
  END IF;
  SELECT count(*)::integer INTO finance_rows
    FROM app.audit_events WHERE entity_table LIKE 'finance\_%';
  IF finance_rows <> 0 THEN
    RAISE EXCEPTION 'un admin sin concesión lee % filas del rastro financiero', finance_rows;
  END IF;
  -- Y no por estar el rastro vacío: el resto del hogar se sigue viendo.
  SELECT count(*)::integer INTO other_rows
    FROM app.audit_events WHERE entity_table NOT LIKE 'finance\_%';
  IF other_rows = 0 THEN
    RAISE EXCEPTION 'la restrictiva se llevó por delante la auditoría no financiera';
  END IF;
END
$assert_audit_matrix_ungranted$;

-- Los otros cuatro papeles tampoco lo alcanzan. `audit_events_read` (0005) ya
-- los deja fuera por no administrar, así que aquí la restrictiva es la segunda
-- reja: si alguien relajara la de 0005, esta aserción seguiría en pie.
DO $assert_audit_matrix_other_roles$
DECLARE
  role_pair record;
  finance_rows integer;
BEGIN
  FOR role_pair IN
    SELECT * FROM (VALUES
      ('fixture:roble:family',   '11000000-0000-4000-8000-000000000002'::uuid),
      ('fixture:roble:employee', '11000000-0000-4000-8000-000000000003'::uuid),
      ('fixture:roble:helper',   '11000000-0000-4000-8000-000000000004'::uuid),
      ('fixture:roble:viewer',   '11000000-0000-4000-8000-000000000005'::uuid)
    ) AS pairs(user_id, membership_id)
  LOOP
    PERFORM set_config('app.user_id', role_pair.user_id, true);
    PERFORM set_config('app.household_id', '', true);
    PERFORM set_config('app.membership_id', '', true);
    PERFORM set_config('app.role', '', true);
    PERFORM app.set_household_context(
      '10000000-0000-4000-8000-000000000001', role_pair.membership_id);
    SELECT count(*)::integer INTO finance_rows
      FROM app.audit_events WHERE entity_table LIKE 'finance\_%';
    IF finance_rows <> 0 THEN
      RAISE EXCEPTION '% lee % filas del rastro financiero', role_pair.user_id, finance_rows;
    END IF;
  END LOOP;
END
$assert_audit_matrix_other_roles$;

-- Y el control positivo, sin el cual todo lo anterior lo cumpliría también una
-- restrictiva que tapara la tabla entera: CON concesión, están todas.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_audit_matrix_granted$
DECLARE
  finance_rows integer;
  expected_rows integer;
BEGIN
  IF NOT app.finance_enabled() THEN
    RAISE EXCEPTION 'la concesión de la fixture no encendió el módulo';
  END IF;
  expected_rows := current_setting('casaclara.finance_audit_esperado')::integer;
  IF expected_rows < 10 THEN
    RAISE EXCEPTION 'la fixture solo dejó % filas auditadas: la aserción perdería mordida', expected_rows;
  END IF;
  SELECT count(*)::integer INTO finance_rows
    FROM app.audit_events WHERE entity_table LIKE 'finance\_%';
  IF finance_rows <> expected_rows THEN
    RAISE EXCEPTION 'con concesión el rastro financiero tiene % filas, se esperaban %',
      finance_rows, expected_rows;
  END IF;
END
$assert_audit_matrix_granted$;

COMMIT;

-- Limpieza del sembrado propio: las suites posteriores comparten esta base.
BEGIN;
SET LOCAL row_security = off;
DELETE FROM app.household_memberships
 WHERE id IN ('fa900000-0000-4000-8000-000000000001',
              'fa900000-0000-4000-8000-000000000002');
DELETE FROM app.user_profiles
 WHERE user_id IN ('fixture:roble:admin2', 'fixture:roble:admin3');
COMMIT;
