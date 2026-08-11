-- Schema invariants and append-only constraints over the two-household fixture.
-- Requires migrations plus fixtures/001_two_households.sql already applied.
BEGIN;
SET LOCAL row_security = off;

DO $assert_schema$
DECLARE
  missing_rls integer;
  wrong_force_rls integer;
  owner_can_bypass boolean;
  settlement_total bigint;
  permanent_minutes bigint;
  pending_events integer;
BEGIN
  -- RLS activada: invariante absoluta, no negociable en ningún despliegue.
  SELECT count(*)::integer INTO missing_rls
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relkind = 'r'
     AND namespace.nspname IN ('app', 'app_private')
     AND NOT relation.relrowsecurity;
  IF missing_rls <> 0 THEN
    RAISE EXCEPTION '% tenant tables are missing ENABLE ROW LEVEL SECURITY', missing_rls;
  END IF;

  -- FORCE sólo protege del propietario del esquema. Donde ese rol puede puentear
  -- RLS (superusuario local, CI) se exige puesto en todas las tablas; donde no
  -- (Supabase) la migración 0018 lo levanta y se exige quitado en TODAS, para que
  -- un estado a medias -- que dejaría migraciones futuras sin poder aplicarse --
  -- también sea rojo. El aislamiento de casa_clara_app/worker no depende de esto:
  -- lo fija tests/020_rls_matrix.sql.
  SELECT rolsuper OR rolbypassrls INTO owner_can_bypass
    FROM pg_catalog.pg_roles WHERE rolname = current_user;
  SELECT count(*)::integer INTO wrong_force_rls
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
   WHERE relation.relkind = 'r'
     AND namespace.nspname IN ('app', 'app_private')
     AND relation.relforcerowsecurity <> coalesce(owner_can_bypass, false);
  IF wrong_force_rls <> 0 THEN
    RAISE EXCEPTION '% tenant tables disagree with the expected FORCE RLS state (owner can bypass: %)',
      wrong_force_rls, coalesce(owner_can_bypass, false);
  END IF;

  SELECT transfer_total_cents INTO settlement_total
    FROM app.settlements
   WHERE id = '12b00000-0000-4000-8000-000000000001';
  IF settlement_total <> 145330 THEN
    RAISE EXCEPTION 'acceptance settlement expected 145330 cents, got %', settlement_total;
  END IF;

  SELECT balance_minutes INTO permanent_minutes
    FROM app.compensation_balances
   WHERE account_id = '12600000-0000-4000-8000-000000000001';
  IF permanent_minutes <> 1440 THEN
    RAISE EXCEPTION 'permanent compensation expected 1440 minutes, got %', permanent_minutes;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app'
       AND table_name IN ('agreement_versions', 'extra_work_events', 'compensation_ledger_entries')
       AND column_name IN ('compensation_expiry_days', 'balance_expires_on', 'expires_on')
  ) THEN
    RAISE EXCEPTION 'compensation expiry columns must not exist';
  END IF;

  SELECT count(*)::integer INTO pending_events
    FROM app.extra_work_events
   WHERE status = 'performed_pending_resolution' AND frozen_amount_cents IS NULL;
  IF pending_events <> 1 THEN
    RAISE EXCEPTION 'performed unapproved work must remain pending without a frozen rate';
  END IF;
END
$assert_schema$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Recurrencia de rutinas (0023), a nivel de catálogo. Aquí solo se comprueba la
-- FORMA del esquema; el comportamiento —qué estados rechaza cada CHECK, quién
-- ve qué— vive en tests/090_routine_recurrence.sql, que corre el último y
-- puede sembrar filas sin desbaratar los recuentos de los ficheros anteriores.
-- ─────────────────────────────────────────────────────────────────────────────
DO $assert_routine_recurrence_schema$
DECLARE
  missing text;
  ics_result text;
BEGIN
  -- Las ocho columnas del patrón, con su tipo. `pattern` y `anchor_on` NULLABLES
  -- a propósito: son el estado «se hace, falta decidir cuándo» (§2.3).
  SELECT string_agg(expected.column_name, ', ' ORDER BY expected.column_name) INTO missing
    FROM (VALUES
      ('pattern', 'routine_pattern', 'YES'),
      ('anchor_on', 'date', 'YES'),
      ('repeat_every', 'int4', 'YES'),
      ('weekdays', '_int2', 'YES'),
      ('month_day', 'int2', 'YES'),
      ('months', '_int2', 'YES'),
      ('overdue_policy', 'routine_overdue_policy', 'NO'),
      ('ends_on', 'date', 'YES')
    ) AS expected(column_name, udt_name, is_nullable)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns AS actual
      WHERE actual.table_schema = 'app' AND actual.table_name = 'routines'
        AND actual.column_name = expected.column_name
        AND actual.udt_name = expected.udt_name
        AND actual.is_nullable = expected.is_nullable
   );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'app.routines lacks the expected recurrence columns: %', missing;
  END IF;

  -- `next_due_on` dejó de ser estado y pasó a ser caché con la 0023, y con la
  -- 0033 dejó también de llamarse como si fuera estado: es `next_due_hint`.
  -- Sin cadencia confirmada no hay fecha, así que admite NULL.
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'routines' AND column_name = 'next_due_hint') <> 'YES' THEN
    RAISE EXCEPTION 'app.routines.next_due_hint must exist and be nullable after 0033';
  END IF;

  -- Y ya está contraído: la 0033 retiró el vocabulario viejo. Que la columna
  -- ANTIGUA no exista se comprueba aparte del nombre nuevo, porque un renombrado
  -- a medias —las dos a la vez— dejaría dos verdades para la misma cosa.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'routines'
       AND column_name IN ('frequency', 'interval_count', 'next_due_on')
  ) THEN
    RAISE EXCEPTION 'frequency/interval_count/next_due_on must be gone after 0033';
  END IF;

  -- El ENUM que solo sostenía `frequency`, y la definer que avanzaba la fecha
  -- con un CASE sobre él. La sustituyó `app.set_routine_due_hint`, que no
  -- calcula: recibe la fecha del motor puro y refresca la caché.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'routine_frequency') THEN
    RAISE EXCEPTION 'app.routine_frequency must be gone after 0033';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'advance_routine_after_completion'
  ) THEN
    RAISE EXCEPTION 'app.advance_routine_after_completion must be gone after 0033';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'set_routine_due_hint'
  ) THEN
    RAISE EXCEPTION 'app.set_routine_due_hint must survive 0033';
  END IF;

  -- Y ni un cuerpo de función se quedó citando el nombre viejo. Es el fallo que
  -- un RENAME no puede evitar por sí solo: los cuerpos se guardan como texto y
  -- no se comprueban al renombrar, así que la base quedaría «bien» y la primera
  -- llamada en caliente moriría.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('app', 'app_private')
      AND (p.prosrc LIKE '%next_due_on%' OR p.prosrc LIKE '%interval_count%')
  ) THEN
    RAISE EXCEPTION 'a function body still names a column retired by 0033';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'app.routines'::regclass AND conname = 'routines_pattern_shape'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'app.routines'::regclass AND conname = 'routines_ends_after_anchor'
  ) THEN
    RAISE EXCEPTION 'the routine pattern shape constraints are missing';
  END IF;

  -- El feed ICS dejó de exponer la recurrencia vieja. Se mira el TIPO DE
  -- RETORNO y no el cuerpo: es lo que consume el emisor.
  SELECT pg_catalog.pg_get_function_result(oid) INTO ics_result
    FROM pg_catalog.pg_proc
   WHERE oid = 'app_private.ics_feed_events(text)'::regprocedure;
  IF ics_result IS NULL OR ics_result LIKE '%frequency%' OR ics_result LIKE '%interval_count%'
     OR ics_result LIKE '%next_due_on%' OR ics_result NOT LIKE '%next_due_hint%'
     OR ics_result NOT LIKE '%pattern%' OR ics_result NOT LIKE '%weekdays%' THEN
    RAISE EXCEPTION 'app_private.ics_feed_events still returns the pre-0023 recurrence: %', ics_result;
  END IF;
END
$assert_routine_recurrence_schema$;

DO $assert_constraints$
BEGIN
  BEGIN
    UPDATE app.compensation_ledger_entries
       SET delta_minutes = 720
     WHERE id = '12700000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'append-only compensation update unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE app.extra_work_events
       SET frozen_amount_cents = 7100
     WHERE id = '12400000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'terminal extra-work mutation unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE app.extra_work_transitions
       SET reason = 'rewritten'
     WHERE id = '12500000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'transition-history mutation unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.command_receipts (
      household_id, operation_id, command_type, payload_hash, result, actor_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001',
      '12f00000-0000-4000-8000-000000000004',
      'fixture.duplicate', repeat('d', 64), '{}'::jsonb,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'duplicate operation id unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.employment_agreements (
      household_id, employee_membership_id, starts_on, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001',
      '21000000-0000-4000-8000-000000000002',
      '2026-01-01',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'cross-household foreign key unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$assert_constraints$;

COMMIT;
