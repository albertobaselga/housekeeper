-- Vacaciones: hasta dónde se le ha contado a cada persona (migración 0028).
--
-- La marca de agua es minúscula, y justamente por eso hay que fijar sus cuatro
-- propiedades antes de que alguien «la mejore»:
--
--   1. Es de quien la pone. Nadie más la lee —tampoco quien administra— y nadie
--      puede ponerla por otro: la función no acepta membresía, así que marcar
--      por otra persona no es algo que se rechace, es algo que no se puede
--      expresar.
--   2. No se escribe a mano. `casa_clara_app` solo tiene SELECT sobre la tabla:
--      cualquier INSERT/UPDATE/DELETE directo se estrella contra el permiso.
--   3. No viaja al futuro. Un cliente con la hora adelantada no puede dar por
--      vistas las vacaciones que le apunten mañana.
--   4. No vuelve atrás. Una pestaña vieja que se despierta no resucita avisos
--      ya vistos.
--
-- Y una estructural: la tabla NO lleva disparador de auditoría. `audit_events`
-- es append-only con actor e instante, y volcar ahí cada «ya lo he visto»
-- reconstruiría por la puerta de atrás el rastro de cuándo abre la aplicación,
-- que es exactamente lo que esta tabla evita. Esta prueba falla si alguien se
-- lo añade.
--
-- Requiere migraciones + fixtures/001_two_households.sql, y una conexión que
-- pueda SET ROLE casa_clara_app.
--
-- Prefijos de UUID exclusivos de este fichero: ae… (roble).

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra: dos periodos del roble con sellos de tiempo conocidos, uno de ellos
-- anulado, para que «lo nuevo» tenga contra qué compararse.
--
-- Las FECHAS de las vacaciones son de 2027 (aún no disfrutadas) pero los SELLOS
-- de cuándo se apuntaron son de 2025: son dos relojes distintos y esta prueba
-- solo mide el segundo. Un sello en el futuro no existe en producción, y aquí
-- lo acotaría la propia función.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.vacation_periods
  (id, household_id, agreement_id, employee_membership_id, starts_on, ends_on, note,
   recorded_by_membership_id, recorded_at) VALUES
  ('ae100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2027-04-05', '2027-04-11', 'Semana Santa',
   '11000000-0000-4000-8000-000000000001', '2025-11-10T09:00:00Z'),
  ('ae100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2027-07-01', '2027-07-10', 'Apuntado por error',
   '11000000-0000-4000-8000-000000000001', '2025-11-11T09:00:00Z');

UPDATE app.vacation_periods
   SET status = 'voided',
       voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
       voided_at = '2025-11-12T10:00:00Z',
       void_reason = 'Las fechas no eran esas'
 WHERE id = 'ae100000-0000-4000-8000-000000000002';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Forma: sin auditoría y con una firma que no admite marcar por otro.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_shape$
DECLARE
  triggers integer;
  signature text;
  policies integer;
BEGIN
  SELECT count(*)::integer INTO triggers
    FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'app.vacation_notice_marks'::regclass
     AND NOT tgisinternal;
  IF triggers <> 0 THEN
    RAISE EXCEPTION 'app.vacation_notice_marks tiene % disparador(es): un rastro auditado de cuándo mira la aplicación es justo lo que esta tabla evita', triggers;
  END IF;

  SELECT pg_catalog.pg_get_function_identity_arguments(oid) INTO signature
    FROM pg_catalog.pg_proc
   WHERE proname = 'mark_vacations_seen'
     AND pronamespace = 'app'::regnamespace;
  IF signature <> 'seen_through timestamp with time zone' THEN
    RAISE EXCEPTION 'app.mark_vacations_seen cambió de firma («%»): admitir una membresía permitiría marcar por otro', signature;
  END IF;

  -- Una sola política, y de SELECT: escribir es solo por la función.
  SELECT count(*)::integer INTO policies
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'app' AND tablename = 'vacation_notice_marks';
  IF policies <> 1 THEN
    RAISE EXCEPTION 'app.vacation_notice_marks tiene % políticas; se esperaba una sola de lectura propia', policies;
  END IF;
END
$assert_shape$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · La empleada marca lo suyo, y solo lo suyo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_marks$
DECLARE
  stored timestamptz;
  visible integer;
BEGIN
  -- Marca con el sello que la pantalla acababa de enseñar.
  stored := app.mark_vacations_seen('2025-11-11T09:00:00Z');
  IF stored <> '2025-11-11T09:00:00Z' THEN
    RAISE EXCEPTION 'la marca guardada fue % en vez del instante enseñado', stored;
  END IF;

  SELECT count(*)::integer INTO visible FROM app.vacation_notice_marks;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'la empleada ve % marcas; debería ver exactamente la suya', visible;
  END IF;

  -- No vuelve atrás: una pestaña vieja no resucita avisos ya vistos.
  stored := app.mark_vacations_seen('2025-11-01T00:00:00Z');
  IF stored <> '2025-11-11T09:00:00Z' THEN
    RAISE EXCEPTION 'una marca más antigua movió la marca de agua hacia atrás (quedó en %)', stored;
  END IF;

  -- No viaja al futuro: pedir el año que viene deja el reloj del servidor.
  stored := app.mark_vacations_seen(statement_timestamp() + interval '400 days');
  IF stored > statement_timestamp() THEN
    RAISE EXCEPTION 'la marca quedó en el futuro (%): se podrían dar por vistas vacaciones que aún no existen', stored;
  END IF;

  -- Escribir a mano no se puede: sobre la tabla solo hay SELECT.
  BEGIN
    UPDATE app.vacation_notice_marks SET seen_through = statement_timestamp() + interval '1 day';
    RAISE EXCEPTION 'un UPDATE directo sobre la marca funcionó';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.vacation_notice_marks;
    RAISE EXCEPTION 'un DELETE directo sobre la marca funcionó';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.vacation_notice_marks (household_id, membership_id, seen_through)
    VALUES ('10000000-0000-4000-8000-000000000001',
            '11000000-0000-4000-8000-000000000006', statement_timestamp());
    RAISE EXCEPTION 'un INSERT directo a nombre de otra persona funcionó';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_employee_marks$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Ni la administración ni el otro hogar ven la marca ajena.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.vacation_notice_marks (household_id, membership_id, seen_through)
VALUES ('10000000-0000-4000-8000-000000000001',
        '11000000-0000-4000-8000-000000000003', '2025-11-11T09:00:00Z');
COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_blind$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible FROM app.vacation_notice_marks;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'quien administra ve % marcas ajenas; saber si la empleada ha mirado no es asunto de la casa', visible;
  END IF;
END
$assert_admin_blind$;

SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001'
);

DO $assert_other_household_blind$
DECLARE
  visible integer;
BEGIN
  SELECT count(*)::integer INTO visible FROM app.vacation_notice_marks;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'el segundo hogar ve % marcas del primero', visible;
  END IF;
END
$assert_other_household_blind$;

ROLLBACK;

-- Limpieza de la marca sembrada para el bloque 3: el fichero no deja rastro.
BEGIN;
SET LOCAL row_security = off;
DELETE FROM app.vacation_notice_marks
 WHERE household_id = '10000000-0000-4000-8000-000000000001'
   AND membership_id = '11000000-0000-4000-8000-000000000003';
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Sin contexto de hogar la función no marca nada.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);

DO $assert_context_required$
BEGIN
  BEGIN
    PERFORM app.mark_vacations_seen(statement_timestamp());
    RAISE EXCEPTION 'la marca entró sin contexto de hogar';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_context_required$;

ROLLBACK;
