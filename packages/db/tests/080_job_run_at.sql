-- La hora de los avisos programados por fecha (migración 0027).
--
-- Lo que puede volver a romperse:
--   1. Que el instante dependa de la zona de la SESIÓN. Ese fue el fallo: el
--      servidor de producción va en UTC y `::date::timestamptz` dejaba los
--      avisos a las 02:00 de la madrugada de Madrid.
--   2. Que se fije el desfase en lugar de la hora civil, y en invierno el aviso
--      se corra una hora.
--   3. Que la función deje de ser ejecutable por el rol de la aplicación, que
--      es quien la llama dentro de `app.enqueue_job`.
--
-- Requiere migraciones aplicadas y una conexión que pueda SET ROLE.

-- ─────────────────────────────────────────────────────────────────────────────
-- El resultado es el mismo mire quien lo mire: la hora civil del hogar no
-- cambia porque la sesión esté en UTC, en Madrid o en Tokio.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

DO $assert_session_independence$
DECLARE
  session_zone text;
  observed timestamptz;
  expected timestamptz;
BEGIN
  SET LOCAL TIME ZONE 'UTC';
  expected := app.job_run_at(DATE '2026-08-15');

  FOREACH session_zone IN ARRAY ARRAY['UTC', 'Europe/Madrid', 'Asia/Tokyo', 'America/Lima'] LOOP
    EXECUTE format('SET LOCAL TIME ZONE %L', session_zone);
    observed := app.job_run_at(DATE '2026-08-15');
    IF observed <> expected THEN
      RAISE EXCEPTION 'app.job_run_at depends on the session time zone (% gave %, expected %)',
        session_zone, observed, expected;
    END IF;
  END LOOP;
END
$assert_session_independence$;

-- Hora civil del hogar en verano y en invierno: las 08:00 de Madrid las dos
-- veces, aunque el desfase con UTC sea +2 y +1 respectivamente.
DO $assert_wall_clock$
DECLARE
  summer text;
  winter text;
BEGIN
  SET LOCAL TIME ZONE 'UTC';
  summer := to_char(app.job_run_at(DATE '2026-08-15') AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD HH24:MI');
  winter := to_char(app.job_run_at(DATE '2026-01-15') AT TIME ZONE 'Europe/Madrid', 'YYYY-MM-DD HH24:MI');
  IF summer <> '2026-08-15 08:00' THEN
    RAISE EXCEPTION 'summer reminder should fire at 08:00 local time, got %', summer;
  END IF;
  IF winter <> '2026-01-15 08:00' THEN
    RAISE EXCEPTION 'winter reminder should fire at 08:00 local time, got %', winter;
  END IF;
  -- Y en UTC son instantes distintos: 06:00Z y 07:00Z.
  IF to_char(app.job_run_at(DATE '2026-08-15'), 'HH24:MI') <> '06:00'
     OR to_char(app.job_run_at(DATE '2026-01-15'), 'HH24:MI') <> '07:00' THEN
    RAISE EXCEPTION 'the daylight saving offset is being frozen instead of the wall clock';
  END IF;
  -- La hora explícita manda sobre el valor por omisión.
  IF to_char(app.job_run_at(DATE '2026-08-15', TIME '19:30') AT TIME ZONE 'Europe/Madrid', 'HH24:MI') <> '19:30' THEN
    RAISE EXCEPTION 'the explicit wall clock argument is ignored';
  END IF;
END
$assert_wall_clock$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Quién puede llamarla: la aplicación (la usa dentro de `app.enqueue_job` al
-- cerrar una liquidación o al programar una rutina) y el worker. Nadie más.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

DO $assert_app_can_call$
BEGIN
  PERFORM app.job_run_at(DATE '2026-08-15');
END
$assert_app_can_call$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE casa_clara_worker;

DO $assert_worker_can_call$
BEGIN
  PERFORM app.job_run_at(DATE '2026-08-15');
END
$assert_worker_can_call$;

ROLLBACK;
