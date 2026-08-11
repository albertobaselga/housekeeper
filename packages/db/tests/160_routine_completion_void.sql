-- Desmarcar una rutina marcada por error (enmienda E5.1) desde la base.
--
-- Lo que aquí se prueba es lo que la interfaz NO puede garantizar por sí sola:
--
--   1. Que anular no borre. Un completado anulado sigue en la tabla, con quién
--      lo marcó y quién lo anuló; lo que cambia es que deja de contar.
--   2. Que sólo pueda anular quien marcó, o la administración. La empleada no
--      desmarca lo que marcó otra persona, y eso vive en la RLS —no en el
--      comando— por el mismo motivo que AC-25: una regla que sólo existe en
--      TypeScript se salta con la siguiente vía de escritura que se añada.
--   3. Que una anulación no pueda reescribir el hecho: ni cambiar de ocurrencia,
--      ni ponerse a nombre de otra persona.
--   4. Que volver a marcar de verdad una ocurrencia anulada sea posible. Sin
--      esto, deshacer sería una trampa: la clave primaria dejaría la ocurrencia
--      bloqueada para siempre.
--   5. Que el barrido de avisos deje de contar lo anulado, que es lo que hace
--      que la rutina vuelva a aparecer el día que le tocaba.
--
-- Requiere migraciones + fixtures/001_two_households.sql. UUIDs con prefijo ec*,
-- exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off): una rutina diaria de toda la casa y dos
-- finalizaciones, una de la empleada y otra de la administración, para tener
-- las dos autorías que la regla distingue.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.routines (
  id, household_id, title, details, audience, frequency, interval_count, next_due_on,
  pattern, anchor_on, repeat_every, overdue_policy, created_by_membership_id
) VALUES (
  'ec100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  'Riego de las jardineras', 'Sólo las de la terraza.', 'all',
  'daily', 1, '2026-08-12',
  'every_n_days', '2026-08-10', 1, 'skip',
  '11000000-0000-4000-8000-000000000001'
);

INSERT INTO app.routine_completions (household_id, routine_id, due_on, completed_by_membership_id) VALUES
  ('10000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000001', '2026-08-10',
   '11000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000001', 'ec100000-0000-4000-8000-000000000001', '2026-08-11',
   '11000000-0000-4000-8000-000000000001');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- La empleada: puede deshacer lo SUYO, y sólo lo suyo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_voids_only_her_own$
DECLARE
  touched integer;
BEGIN
  -- La que marcó la administración no es suya: la RLS no la deja tocar y el
  -- UPDATE no encuentra fila, que es como se ve una política desde fuera.
  UPDATE app.routine_completions
     SET voided_at = statement_timestamp(),
         voided_by_membership_id = '11000000-0000-4000-8000-000000000003'
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-11';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'la interna deshizo % marcados de otra persona', touched;
  END IF;

  -- Y ponerse el marcado ajeno a su nombre tampoco cuela: el WITH CHECK exige
  -- que una finalización viva esté a nombre de quien escribe.
  UPDATE app.routine_completions
     SET completed_by_membership_id = '11000000-0000-4000-8000-000000000003'
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-11';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'la interna se apropió de % marcados ajenos', touched;
  END IF;

  -- Lo suyo, sí.
  UPDATE app.routine_completions
     SET voided_at = statement_timestamp(),
         voided_by_membership_id = '11000000-0000-4000-8000-000000000003'
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-10';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la interna no pudo deshacer su propio marcado (% filas)', touched;
  END IF;

  -- Firmar la anulación con el nombre de otra persona, no.
  BEGIN
    UPDATE app.routine_completions
       SET voided_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-10';
    GET DIAGNOSTICS touched = ROW_COUNT;
    IF touched <> 0 THEN
      RAISE EXCEPTION 'una anulación quedó firmada por quien no la hizo';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Ni arrastrar la fila anulada a otra ocurrencia para borrar el rastro.
  BEGIN
    UPDATE app.routine_completions
       SET due_on = '2026-08-09'
     WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-10';
    RAISE EXCEPTION 'una finalización cambió de ocurrencia';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    NULL;
  END;
END
$assert_employee_voids_only_her_own$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Anular no borra: el hecho sigue ahí, con las dos autorías.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_void_keeps_the_fact$
DECLARE
  voided app.routine_completions%ROWTYPE;
  total integer;
BEGIN
  SELECT count(*)::integer INTO total
    FROM app.routine_completions
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001';
  IF total <> 2 THEN
    RAISE EXCEPTION 'deshacer borró filas: quedan % de 2', total;
  END IF;

  SELECT * INTO voided
    FROM app.routine_completions
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-10';
  IF voided.voided_at IS NULL
     OR voided.voided_by_membership_id <> '11000000-0000-4000-8000-000000000003'
     OR voided.completed_by_membership_id <> '11000000-0000-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'la anulación perdió su autoría o la de quien marcó';
  END IF;
END
$assert_void_keeps_the_fact$;

-- Las dos columnas van juntas o no van.
DO $assert_void_shape$
BEGIN
  BEGIN
    UPDATE app.routine_completions SET voided_at = statement_timestamp()
     WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-11';
    RAISE EXCEPTION 'se aceptó una anulación sin autor';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE app.routine_completions
       SET voided_by_membership_id = '11000000-0000-4000-8000-000000000001'
     WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-11';
    RAISE EXCEPTION 'se aceptó un autor de anulación sin anulación';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$assert_void_shape$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Revivir: volver a marcar de verdad una ocurrencia anulada. Sin esta rama la
-- clave primaria dejaría la ocurrencia bloqueada para siempre.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee2', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000006'
);

DO $assert_revive$
DECLARE
  touched integer;
BEGIN
  -- La segunda empleada no marcó ni anuló nada, pero SÍ puede hacer la tarea:
  -- revivir una ocurrencia anulada es una finalización nueva y se rige por la
  -- regla de las finalizaciones nuevas (a nombre de quien la hace).
  UPDATE app.routine_completions
     SET voided_at = NULL,
         voided_by_membership_id = NULL,
         completed_at = statement_timestamp(),
         completed_by_membership_id = '11000000-0000-4000-8000-000000000006'
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-10';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'no se pudo volver a marcar una ocurrencia anulada (% filas)', touched;
  END IF;

  -- Pero pasarle el marcado a otra persona sigue sin poder ser: el WITH CHECK
  -- exige que una finalización viva esté a nombre de quien escribe.
  BEGIN
    UPDATE app.routine_completions
       SET completed_by_membership_id = '11000000-0000-4000-8000-000000000003'
     WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-10';
    RAISE EXCEPTION 'una finalización viva quedó a nombre de quien no la hizo';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_revive$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- La administración deshace lo de cualquiera; el apoyo y el visor, nada.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_cannot_void$
DECLARE
  touched integer;
BEGIN
  UPDATE app.routine_completions
     SET voided_at = statement_timestamp(),
         voided_by_membership_id = '11000000-0000-4000-8000-000000000004'
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'el apoyo deshizo % marcados ajenos', touched;
  END IF;
END
$assert_helper_cannot_void$;

COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_voids_anything$
DECLARE
  touched integer;
BEGIN
  UPDATE app.routine_completions
     SET voided_at = statement_timestamp(),
         voided_by_membership_id = '11000000-0000-4000-8000-000000000001'
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001' AND due_on = '2026-08-10';
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 1 THEN
    RAISE EXCEPTION 'la administración no pudo deshacer un marcado ajeno (% filas)', touched;
  END IF;
END
$assert_admin_voids_anything$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- El barrido de avisos deja de contar lo anulado: es lo que hace que la rutina
-- vuelva a aparecer el día que le tocaba en vez de quedarse muda.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_digest_ignores_voided$
DECLARE
  digest record;
BEGIN
  SELECT * INTO digest
    FROM app_private.routine_digest_inputs(date '2026-08-12')
   WHERE routine_id = 'ec100000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el barrido perdió la rutina';
  END IF;
  IF digest.completed_due_ons && ARRAY[date '2026-08-10'] THEN
    RAISE EXCEPTION 'el barrido siguió contando una finalización anulada';
  END IF;
  IF NOT (digest.completed_due_ons @> ARRAY[date '2026-08-11']) THEN
    RAISE EXCEPTION 'el barrido perdió la finalización viva: %', digest.completed_due_ons;
  END IF;
END
$assert_digest_ignores_voided$;

COMMIT;
