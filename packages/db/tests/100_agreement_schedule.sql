-- El horario pactado tras la migración 0025: la jornada tipo y los días que se
-- salen de ella, colgando de la versión del contrato.
--
-- Cubre las cinco cosas que pueden salir mal de verdad:
--   1. Que el horario deje de estar congelado: reescribir una hora de salida en
--      sitio o borrar una libranza en vez de apilar una versión nueva.
--   2. Que una versión pueda acabar con dos horarios y nadie sepa cuál rige.
--   3. Que se cuele un día imposible: uno que termina antes de empezar contra la
--      jornada tipo, o con un descanso que no cabe. Los CHECK de la tabla no
--      pueden mirar la otra fila, así que esto lo sostiene un disparador y es
--      justo lo que hay que probar.
--   4. Que se cuelen filas que mienten o que sobran: un día libre con horas, o
--      un día que se declara excepción sin desviar nada ni explicar nada.
--   5. Que la frontera de visibilidad se afloje. Es LA prueba del encargo: lo
--      ven quien administra y la propia interesada; familia no administradora,
--      apoyo y visor NO, y ningún hogar alcanza el horario del otro. Se
--      comprueba por SELECT directo, que es la única defensa que no depende de
--      la plantilla.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- UUIDs con prefijos de* (roble) / df* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Lo que la fixture dice, dicho en SQL: el horario del roble suma exactamente
-- la jornada semanal contratada de su versión. Si alguien cambia una hora de la
-- fixture sin mirar, esta comprobación lo caza antes que ninguna pantalla.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_fixture_shape$
DECLARE
  weekly integer;
  contracted integer;
BEGIN
  -- Minutos efectivos de la semana, con la misma regla que el motor puro: cada
  -- día vale lo que dice su excepción y, si no tiene, lo que dice la jornada
  -- tipo; un día de libranza vale cero.
  SELECT sum(
           CASE
             WHEN day.id IS NOT NULL AND NOT day.works THEN 0
             ELSE (
               EXTRACT(EPOCH FROM (
                 COALESCE(day.ends_at, schedule.ends_at) - COALESCE(day.starts_at, schedule.starts_at)
               )) / 60
             )::integer - COALESCE(day.long_break_minutes, schedule.long_break_minutes)
           END
         )::integer
    INTO weekly
    FROM app.agreement_schedules AS schedule
    CROSS JOIN generate_series(1, 7) AS week(day_number)
    LEFT JOIN app.agreement_schedule_days AS day
      ON day.household_id = schedule.household_id
     AND day.schedule_id = schedule.id
     AND day.weekday = week.day_number
   WHERE schedule.id = '15000000-0000-4000-8000-000000000001';

  SELECT contracted_weekly_minutes INTO contracted
    FROM app.agreement_versions WHERE id = '12100000-0000-4000-8000-000000000002';

  IF weekly <> 2400 OR contracted <> 2400 THEN
    RAISE EXCEPTION 'the roble schedule sums % weekly minutes against % contracted', weekly, contracted;
  END IF;

  -- Y el del olivo NO cuadra a propósito: existe para que la comparación tenga
  -- algo que denunciar en pantalla.
  IF NOT EXISTS (
    SELECT 1 FROM app.agreement_schedules
     WHERE id = '25000000-0000-4000-8000-000000000001'
       AND starts_at = '08:00' AND ends_at = '20:00' AND long_break_minutes = 120
  ) THEN
    RAISE EXCEPTION 'the olivo schedule is no longer the deliberately incoherent one';
  END IF;
END
$assert_fixture_shape$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Congelación: el horario hereda la inmutabilidad de su versión. Ni siquiera el
-- propietario del esquema puede mover una hora de salida; la corrección es
-- apilar una versión nueva.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_frozen$
BEGIN
  BEGIN
    UPDATE app.agreement_schedules
       SET ends_at = '21:00'
     WHERE id = '15000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'rewriting a working day in place unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.agreement_schedule_days
     WHERE id = '16000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'deleting a rest day unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE app.agreement_schedule_days
       SET works = true
     WHERE id = '16000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'turning a rest day into a working day in place unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.agreement_schedules
     WHERE id = '15000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'deleting a schedule unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;
END
$assert_frozen$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Una versión, un horario. Dos horarios vigentes a la vez no serían «lo
-- pactado»: serían una pregunta sin respuesta.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_single_schedule$
BEGIN
  BEGIN
    INSERT INTO app.agreement_schedules (
      household_id, agreement_id, agreement_version_id, starts_at, ends_at,
      long_break_minutes, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '12100000-0000-4000-8000-000000000002', '07:00', '15:00', 30,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a second schedule on the same version unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$assert_single_schedule$;

-- Una versión que aún no tiene horario sí lo admite: la v1 del roble no declara
-- ninguno, y ese hueco se puede llenar (no reescribir) sin tocar nada más.
INSERT INTO app.agreement_schedules (
  id, household_id, agreement_id, agreement_version_id, starts_at, ends_at,
  long_break_minutes, created_by_membership_id
) VALUES (
  'de100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000001',
  '09:00', '18:00', 60, '11000000-0000-4000-8000-000000000001'
);

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La jornada tipo tiene que ser una jornada, y el descanso tiene que caber
-- dentro. Estas dos las sostienen CHECK de la propia fila.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_schedule_shape$
BEGIN
  BEGIN
    INSERT INTO app.agreement_schedules (
      household_id, agreement_id, agreement_version_id, starts_at, ends_at,
      long_break_minutes, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '12100000-0000-4000-8000-000000000001', '22:00', '06:00', 0,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a schedule crossing midnight unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.agreement_schedules (
      household_id, agreement_id, agreement_version_id, starts_at, ends_at,
      long_break_minutes, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '12100000-0000-4000-8000-000000000001', '09:00', '13:00', 240,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a break that swallows the whole day unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$assert_schedule_shape$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Los días: lo que dice cada fila y lo que dice contra su jornada tipo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_day_rules$
BEGIN
  -- Un día libre con horas sería una contradicción: «libre» dejaría de
  -- significar nada y la semana tendría dos lecturas posibles.
  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works, ends_at,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001', 3, false, '15:00',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a rest day carrying working hours unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Un día que se trabaja exactamente como el resto y no explica nada es ruido:
  -- la fila no aporta y el resumen tendría que repetirla sin decir nada nuevo.
  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001', 3, true,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'an exception day that changes nothing unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- El mismo día dos veces en el mismo horario: no puede decir dos cosas.
  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001', 7, false,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a duplicated weekday unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  /*
   * Y la comprobación que ningún CHECK puede hacer, porque necesita las dos
   * filas: la excepción se resuelve CONTRA la jornada tipo. «Solo termino a las
   * 07:00» es coherente por sí sola y absurda si se entra a las 08:00.
   */
  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works, ends_at,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001', 3, true, '07:00',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a day ending before the standard start unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- El descanso heredado (90 min) tampoco cabe en una jornada de una hora.
  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works, ends_at,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001', 3, true, '09:00',
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'an inherited break that does not fit unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Un día que cambia SOLO la salida —el caso que motivó todo esto— entra sin
  -- repetir la hora de entrada ni el descanso.
  INSERT INTO app.agreement_schedule_days (
    id, household_id, agreement_id, schedule_id, weekday, works, ends_at,
    created_by_membership_id
  ) VALUES (
    'de200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001',
    4, true, '15:00', '11000000-0000-4000-8000-000000000001'
  );

  IF NOT EXISTS (
    SELECT 1 FROM app.agreement_schedule_days
     WHERE id = 'de200000-0000-4000-8000-000000000001'
       AND starts_at IS NULL AND long_break_minutes IS NULL AND ends_at = '15:00'
  ) THEN
    RAISE EXCEPTION 'the early-finish day did not keep its inherited fields empty';
  END IF;

  -- Y una fila que solo trae nota también vale: hay días que no cambian de hora
  -- pero sí de contenido, y poder decirlo es parte de lo pactado.
  INSERT INTO app.agreement_schedule_days (
    id, household_id, agreement_id, schedule_id, weekday, works, note,
    created_by_membership_id
  ) VALUES (
    'de200000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
    '12000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001',
    2, true, 'Ese día lleva la compra', '11000000-0000-4000-8000-000000000001'
  );
END
$assert_day_rules$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Un día no puede colgar de un horario de otro contrato: la clave ajena
-- compuesta lo impide sin fiarse de que el servidor lo compruebe.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_day_belongs$
BEGIN
  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      -- El horario del OLIVO, con el contrato del roble.
      '25000000-0000-4000-8000-000000000001', 3, false,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a day hanging from another household schedule unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$assert_day_belongs$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Quien administra ve el horario entero de su hogar y puede escribirlo, pero no
-- reescribirlo: el rol de la aplicación no tiene UPDATE ni DELETE.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin$
DECLARE
  schedules integer;
  days integer;
BEGIN
  SELECT count(*)::integer INTO schedules FROM app.agreement_schedules;
  IF schedules <> 1 THEN
    RAISE EXCEPTION 'family_admin should read the single roble schedule, saw %', schedules;
  END IF;

  SELECT count(*)::integer INTO days FROM app.agreement_schedule_days;
  IF days <> 2 THEN
    RAISE EXCEPTION 'family_admin should read the two roble schedule days, saw %', days;
  END IF;

  BEGIN
    UPDATE app.agreement_schedules SET ends_at = '21:00';
    RAISE EXCEPTION 'the application role unexpectedly holds UPDATE on schedules';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.agreement_schedule_days;
    RAISE EXCEPTION 'the application role unexpectedly holds DELETE on schedule days';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin$;

-- Escribir sí: es quien pacta. Va sobre la v1, que no tenía horario.
INSERT INTO app.agreement_schedules (
  id, household_id, agreement_id, agreement_version_id, starts_at, ends_at,
  long_break_minutes, created_by_membership_id
) VALUES (
  'de300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
  '12000000-0000-4000-8000-000000000001', '12100000-0000-4000-8000-000000000001',
  '09:00', '18:00', 60, '11000000-0000-4000-8000-000000000001'
);

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- LA prueba del encargo: la empleada ve SU horario y no puede tocarlo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee$
DECLARE
  schedules integer;
  free_days integer;
BEGIN
  SELECT count(*)::integer INTO schedules FROM app.agreement_schedules;
  IF schedules <> 1 THEN
    RAISE EXCEPTION 'the employee should read her own schedule, saw %', schedules;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.agreement_schedules
     WHERE starts_at = '08:00' AND ends_at = '16:30' AND long_break_minutes = 90
  ) THEN
    RAISE EXCEPTION 'the employee cannot read the hours of her own standard working day';
  END IF;

  -- La libranza es suya y tiene que verla: es el día que organiza su vida.
  SELECT count(*)::integer INTO free_days
    FROM app.agreement_schedule_days WHERE NOT works;
  IF free_days <> 1 THEN
    RAISE EXCEPTION 'the employee should see her single rest day, saw %', free_days;
  END IF;

  -- Pero el horario lo pacta quien administra: ella no se lo escribe.
  BEGIN
    INSERT INTO app.agreement_schedules (
      household_id, agreement_id, agreement_version_id, starts_at, ends_at,
      long_break_minutes, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '12100000-0000-4000-8000-000000000001', '10:00', '14:00', 0,
      '11000000-0000-4000-8000-000000000003'
    );
    RAISE EXCEPTION 'the employee unexpectedly wrote her own working hours';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001', 5, false,
      '11000000-0000-4000-8000-000000000003'
    );
    RAISE EXCEPTION 'the employee unexpectedly granted herself a rest day';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_employee$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Nadie más. El horario dice a qué hora entra y sale una persona concreta cada
-- día de la semana: eso no es información doméstica, es su vida. La frontera es
-- la misma que la de `agreement_versions_read`.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_family_member_blind$
BEGIN
  IF (SELECT count(*) FROM app.agreement_schedules) <> 0 THEN
    RAISE EXCEPTION 'family_member should not read the working hours of the employee';
  END IF;
  IF (SELECT count(*) FROM app.agreement_schedule_days) <> 0 THEN
    RAISE EXCEPTION 'family_member should not read which days the employee is off';
  END IF;
END
$assert_family_member_blind$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_blind$
BEGIN
  IF (SELECT count(*) FROM app.agreement_schedules) <> 0 THEN
    RAISE EXCEPTION 'helper should not read the schedule';
  END IF;
  IF (SELECT count(*) FROM app.agreement_schedule_days) <> 0 THEN
    RAISE EXCEPTION 'helper should not read the schedule days';
  END IF;
END
$assert_helper_blind$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer_blind$
BEGIN
  IF (SELECT count(*) FROM app.agreement_schedules) <> 0 THEN
    RAISE EXCEPTION 'viewer should not read the schedule';
  END IF;
  IF (SELECT count(*) FROM app.agreement_schedule_days) <> 0 THEN
    RAISE EXCEPTION 'viewer should not read the schedule days';
  END IF;
END
$assert_viewer_blind$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Aislamiento entre hogares: quien administra el olivo ve SU horario y ni una
-- fila del roble, y tampoco puede escribir en el del vecino.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

DO $assert_cross_household$
DECLARE
  own integer;
BEGIN
  SELECT count(*)::integer INTO own FROM app.agreement_schedules;
  IF own <> 1 THEN
    RAISE EXCEPTION 'the olivo administrator should read only its own schedule, saw %', own;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.agreement_schedules
     WHERE household_id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'the olivo administrator reached the roble schedule';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.agreement_schedule_days
     WHERE household_id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'the olivo administrator reached the roble rest days';
  END IF;

  BEGIN
    INSERT INTO app.agreement_schedules (
      household_id, agreement_id, agreement_version_id, starts_at, ends_at,
      long_break_minutes, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '12100000-0000-4000-8000-000000000001', '06:00', '23:00', 0,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a cross-tenant schedule insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.agreement_schedule_days (
      household_id, agreement_id, schedule_id, weekday, works,
      created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001', 5, false,
      '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'a cross-tenant schedule day insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_cross_household$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:olivo:employee', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000002'
);

DO $assert_olivo_employee$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.agreement_schedules
     WHERE starts_at = '08:00' AND ends_at = '20:00' AND long_break_minutes = 120
  ) THEN
    RAISE EXCEPTION 'the olivo employee cannot read her own working hours';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.agreement_schedule_days
     WHERE household_id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'the olivo employee reached the roble schedule days';
  END IF;
END
$assert_olivo_employee$;

ROLLBACK;
