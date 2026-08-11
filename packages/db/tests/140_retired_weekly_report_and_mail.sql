-- El parte semanal y los avisos por correo, retirados (migración 0029).
--
-- Lo que puede volver a romperse, y por eso se comprueba aquí:
--
--   1. Que el histórico deje de leerse. Las filas se conservaron a propósito
--      —son historia laboral y el expediente es append-only—, así que la
--      empleada tiene que seguir viendo SUS partes y SUS días trabajados: son
--      lo que viaja en `partes-semanales.csv` dentro del ZIP del expediente.
--      Si esta parte falla, conservar las filas habría sido guardar basura.
--
--   2. Que vuelva a poder escribirse desde la aplicación. Un parte nuevo hoy no
--      significa nada: no hay pantalla que lo envíe, ni comando que lo confirme,
--      ni plazo que lo auto-confirme. La base lo impide por dos caminos a la
--      vez (privilegio revocado y política de escritura retirada) y los dos se
--      comprueban.
--
--   3. Que reaparezca la auto-confirmación o la función que sacaba direcciones
--      de correo de la base. Las dos eran SECURITY DEFINER con
--      `row_security = off`: mientras existan, existe la superficie.
--
--   4. Que el aislamiento entre hogares se relaje al quitar políticas. Quitar
--      las de escritura no puede ampliar lo que se lee: la empleada del roble
--      sigue sin ver nada del olivo.
--
-- Requiere migraciones aplicadas y fixtures/001_two_households.sql cargada, con
-- una conexión que pueda SET ROLE casa_clara_app.

-- ─────────────────────────────────────────────────────────────────────────────
-- Las dos funciones definer de la 0006 ya no existen.
-- ─────────────────────────────────────────────────────────────────────────────
DO $assert_definers_are_gone$
DECLARE
  survivor text;
BEGIN
  SELECT string_agg(format('%s.%s', namespace.nspname, routine.proname), ', ')
    INTO survivor
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
   WHERE namespace.nspname = 'app_private'
     AND routine.proname IN ('autoconfirm_weekly_report', 'settlement_reminder_state');
  IF survivor IS NOT NULL THEN
    RAISE EXCEPTION 'la 0029 debía retirar estas funciones y siguen ahí: %', survivor;
  END IF;
END
$assert_definers_are_gone$;

-- ─────────────────────────────────────────────────────────────────────────────
-- El privilegio de escritura de la aplicación sobre las dos tablas históricas.
-- Se mira el catálogo y no un INSERT fallido porque un INSERT puede fallar por
-- muchas razones (una RLS, un CHECK, una clave ajena) y aquí interesa la razón
-- exacta: que el GRANT ya no está.
-- ─────────────────────────────────────────────────────────────────────────────
DO $assert_app_cannot_write$
DECLARE
  historical_table text;
  write_privilege text;
BEGIN
  FOREACH historical_table IN ARRAY ARRAY['weekly_time_reports', 'time_entries'] LOOP
    IF NOT has_table_privilege('casa_clara_app', format('app.%I', historical_table), 'SELECT') THEN
      RAISE EXCEPTION 'app.% dejó de ser legible; el histórico se conservó para leerse', historical_table;
    END IF;
    FOREACH write_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege('casa_clara_app', format('app.%I', historical_table), write_privilege) THEN
        RAISE EXCEPTION 'casa_clara_app conserva % sobre app.%', write_privilege, historical_table;
      END IF;
    END LOOP;
  END LOOP;
END
$assert_app_cannot_write$;

-- Y ninguna política de escritura sobrevive sobre esas tablas: si alguien
-- devolviera el GRANT, tampoco encontraría por dónde escribir.
DO $assert_no_write_policies$
DECLARE
  writable text;
BEGIN
  SELECT string_agg(format('%s (%s)', policyname, tablename), ', ')
    INTO writable
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app'
     AND tablename IN ('weekly_time_reports', 'time_entries')
     AND cmd <> 'SELECT';
  IF writable IS NOT NULL THEN
    RAISE EXCEPTION 'quedan políticas de escritura sobre el histórico del parte: %', writable;
  END IF;
END
$assert_no_write_policies$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Efecto observable con el rol de la aplicación puesto: la empleada lee su
-- propio histórico, no el del otro hogar, y no puede escribir.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_still_reads_history$
DECLARE
  own_reports integer;
  own_entries integer;
  leaked integer;
BEGIN
  SELECT count(*)::integer INTO own_reports FROM app.weekly_time_reports;
  SELECT count(*)::integer INTO own_entries FROM app.time_entries;
  SELECT count(*)::integer INTO leaked
    FROM app.weekly_time_reports
   WHERE household_id <> '10000000-0000-4000-8000-000000000001';
  IF own_reports <> 1 OR own_entries <> 1 THEN
    RAISE EXCEPTION 'la empleada debía seguir viendo su histórico (1 parte, 1 día), vio % y %',
      own_reports, own_entries;
  END IF;
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'se filtraron % partes de otro hogar', leaked;
  END IF;
END
$assert_employee_still_reads_history$;

DO $assert_employee_cannot_submit$
BEGIN
  BEGIN
    INSERT INTO app.weekly_time_reports
      (household_id, agreement_id, employee_membership_id, week_starts_on,
       status, submitted_at, submitted_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001',
            '12000000-0000-4000-8000-000000000001',
            '11000000-0000-4000-8000-000000000003',
            DATE '2026-08-10', 'submitted', statement_timestamp(),
            '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'la aplicación ha podido enviar un parte semanal nuevo';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$assert_employee_cannot_submit$;

ROLLBACK;

-- La administración tampoco: el parte no se retiró solo para la empleada.
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_cannot_confirm$
BEGIN
  BEGIN
    UPDATE app.weekly_time_reports
       SET dispute_reason = 'la administración ya no interviene aquí'
     WHERE household_id = '10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'la administración ha podido tocar un parte semanal histórico';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$assert_admin_cannot_confirm$;

ROLLBACK;
