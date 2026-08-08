-- Catálogo de condiciones tras la migración 0021: tipos de trabajo extra y
-- complementos recurrentes congelados en la versión del acuerdo.
--
-- Cubre las cuatro cosas que pueden salir mal de verdad:
--   1. Que el catálogo deje de estar congelado (reescribir una tarifa, borrar
--      un concepto, o resolver un hecho con un importe que no es el pactado).
--   2. Que la regla de visibilidad se afloje: la empleada NO puede ver un tipo
--      desactivado ni uno sin tarifa, ni por SELECT directo. Es el requisito
--      literal del propietario y la única defensa que no depende de la
--      plantilla.
--   3. Que la matriz de roles se afloje: escribe SOLO family_admin; leen quien
--      administra (todo) y la propia empleada (lo que le aplica). Familia,
--      apoyo y visor, nada.
--   4. Que un hogar vea o escriba en el catálogo del otro.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- UUIDs con prefijos dc* (roble) / dd* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Migración del modelo de 0002: cada versión existente estrena su par
-- equivalente y ninguna tarifa se movió. La fixture escribe el catálogo a mano
-- (para poder montar el caso «jornadas sí, horas no»), así que lo que se
-- comprueba aquí es la EQUIVALENCIA: las columnas reliquia y el catálogo dicen
-- lo mismo allí donde ambos hablan.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_compat$
DECLARE
  divergent integer;
  orphan_events integer;
BEGIN
  SELECT count(*)::integer INTO divergent
    FROM app.agreement_versions AS version
    JOIN app.extra_work_types AS hourly
      ON hourly.household_id = version.household_id
     AND hourly.agreement_version_id = version.id
     AND hourly.code = 'overtime'
    JOIN app.extra_work_types AS shift
      ON shift.household_id = version.household_id
     AND shift.agreement_version_id = version.id
     AND shift.code = 'worked_rest_day'
   WHERE hourly.rate_cents IS DISTINCT FROM version.overtime_hourly_rate_cents
      OR shift.rate_cents IS DISTINCT FROM version.worked_rest_day_rate_cents
      OR hourly.unit <> 'per_hour'
      OR shift.unit <> 'per_shift';
  IF divergent <> 0 THEN
    RAISE EXCEPTION '% agreement versions disagree with their catalogued equivalents', divergent;
  END IF;

  -- Todo hecho de la fixture nombra su concepto, y el concepto es de la versión
  -- que congeló su importe.
  SELECT count(*)::integer INTO orphan_events
    FROM app.extra_work_events AS event
    JOIN app.extra_work_types AS catalogued
      ON catalogued.household_id = event.household_id
     AND catalogued.id = event.extra_work_type_id
   WHERE event.status = 'resolved'
     AND (catalogued.agreement_version_id IS DISTINCT FROM event.resolved_agreement_version_id
          OR catalogued.rate_cents IS DISTINCT FROM event.frozen_unit_rate_cents);
  IF orphan_events <> 0 THEN
    RAISE EXCEPTION '% resolved events diverge from the rate catalogued in their frozen version', orphan_events;
  END IF;
END
$assert_compat$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Congelación: el catálogo hereda la inmutabilidad de su versión. Ni siquiera
-- el propietario del esquema puede reescribir una tarifa o retirar un concepto;
-- la corrección es apilar una versión nueva.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_frozen$
BEGIN
  BEGIN
    UPDATE app.extra_work_types
       SET rate_cents = 9900
     WHERE id = '13000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'rewriting a catalogued rate in place unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE app.extra_work_types
       SET active = true
     WHERE id = '13000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 're-enabling a catalogued type in place unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.extra_work_types WHERE id = '13000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'deleting a catalogued type unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE app.recurring_supplements
       SET adds_to_pay = true
     WHERE id = '14000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'flipping adds_to_pay in place unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.recurring_supplements WHERE id = '14000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'deleting a supplement unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Un código repetido dentro de la misma versión sería dos verdades para el
  -- mismo concepto.
  BEGIN
    INSERT INTO app.extra_work_types
      (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
       reference_minutes, created_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '12100000-0000-4000-8000-000000000002', 'jornada_extra', 'Duplicado', 'per_shift', 5000,
       600, '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a duplicated code within one version unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- «Jornada» sin duración de referencia no dice nada; «por hora» con duración
  -- de referencia miente sobre quién pone las horas.
  BEGIN
    INSERT INTO app.extra_work_types
      (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
       reference_minutes, created_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '12100000-0000-4000-8000-000000000002', 'jornada_sin_horas', 'Jornada sin horas',
       'per_shift', 5000, NULL, '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a per_shift type without reference minutes unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.extra_work_types
      (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
       reference_minutes, created_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '12100000-0000-4000-8000-000000000002', 'hora_con_jornada', 'Hora con jornada',
       'per_hour', 1000, 600, '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a per_hour type carrying reference minutes unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Un concepto de un acuerdo colgado de la versión de otro acuerdo no existe.
  BEGIN
    INSERT INTO app.extra_work_types
      (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
       created_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '22100000-0000-4000-8000-000000000001', 'cruzado', 'Cruzado', 'fixed_amount', 1000,
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a type hanging from another agreement version unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$assert_frozen$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Congelación del hecho: `extra_work_events_type_freeze`. Un hecho no puede
-- nombrar un tipo desactivado, ni uno sin tarifa, ni uno de una versión que no
-- regía el día trabajado, ni resolverse por un importe distinto del pactado.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_event_freeze$
BEGIN
  -- Tipo desactivado en la versión vigente (las horas de esta empleada): ni
  -- fabricando la petición a mano se registra trabajo de un tipo que no aplica.
  BEGIN
    INSERT INTO app.extra_work_events
      (id, household_id, agreement_id, employee_membership_id, extra_work_type_id, kind,
       worked_on, duration_minutes, origin, status, requested_by_membership_id)
    VALUES
      ('dc100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
       '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
       '13000000-0000-4000-8000-000000000003', 'overtime', '2026-05-04', 120,
       'employee_report', 'requested', '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'registering work of a deactivated type unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Tipo sin tarifa: pactado, pero nadie le ha puesto precio todavía.
  BEGIN
    INSERT INTO app.extra_work_events
      (id, household_id, agreement_id, employee_membership_id, extra_work_type_id, kind,
       worked_on, duration_minutes, origin, status, requested_by_membership_id)
    VALUES
      ('dc100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
       '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
       '13000000-0000-4000-8000-000000000007', 'worked_rest_day', '2026-05-04', 120,
       'employee_report', 'requested', '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'registering work of a type without a rate unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Tipo de la v1 para un día que rige la v2: sería valorar 2026 con la tarifa
  -- de 2025.
  BEGIN
    INSERT INTO app.extra_work_events
      (id, household_id, agreement_id, employee_membership_id, extra_work_type_id, kind,
       worked_on, duration_minutes, origin, status, requested_by_membership_id)
    VALUES
      ('dc100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
       '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
       '13000000-0000-4000-8000-000000000002', 'worked_rest_day', '2026-05-04', 480,
       'employee_report', 'requested', '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'naming a type from a version not in force unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Un tipo del olivo en un hecho del roble.
  BEGIN
    INSERT INTO app.extra_work_events
      (id, household_id, agreement_id, employee_membership_id, extra_work_type_id, kind,
       worked_on, duration_minutes, origin, status, requested_by_membership_id)
    VALUES
      ('dc100000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
       '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
       '23000000-0000-4000-8000-000000000002', 'worked_rest_day', '2026-05-04', 480,
       'employee_report', 'requested', '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'naming another household''s type unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '23503' THEN
    NULL;
  END;
END
$assert_event_freeze$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Valoración de un importe fijo, extremo a extremo en la base: «Noche de
-- guardia, 50 €» se registra, se acepta, se realiza y se resuelve congelando
-- exactamente los 5000 céntimos del catálogo. Un céntimo distinto se rechaza.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.extra_work_events
  (id, household_id, agreement_id, employee_membership_id, extra_work_type_id, kind,
   worked_on, duration_minutes, note, origin, status, requested_by_membership_id)
VALUES
  ('dc200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '13000000-0000-4000-8000-000000000006', 'worked_rest_day', '2026-05-04', 720,
   'Guardia de prueba', 'employee_report', 'requested', '11000000-0000-4000-8000-000000000003');

INSERT INTO app.extra_work_transitions
  (household_id, extra_work_event_id, sequence_number, from_status, to_status,
   actor_membership_id, reason)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000001', 1, NULL,
   'requested', '11000000-0000-4000-8000-000000000003', 'Registrada');

-- Como en el servidor: la comprobación diferida pasa a inmediata solo después
-- de que el estado inicial tenga su transición, y cada paso siguiente firma la
-- transición ANTES del UPDATE.
SET CONSTRAINTS app.extra_work_requires_transition_history IMMEDIATE;

INSERT INTO app.extra_work_transitions
  (household_id, extra_work_event_id, sequence_number, from_status, to_status,
   actor_membership_id, reason)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000001', 2, 'requested',
   'performed_pending_resolution', '11000000-0000-4000-8000-000000000003', 'Realizada');

UPDATE app.extra_work_events
   SET status = 'performed_pending_resolution',
       performed_by_membership_id = '11000000-0000-4000-8000-000000000003',
       performed_at = '2026-05-05T07:00:00Z'
 WHERE id = 'dc200000-0000-4000-8000-000000000001';

DO $assert_fixed_amount$
DECLARE
  frozen bigint;
BEGIN
  -- Congelar un importe unitario que no es el del catálogo: el disparador lo
  -- rechaza aunque la transición sea legal.
  BEGIN
    INSERT INTO app.extra_work_transitions
      (household_id, extra_work_event_id, sequence_number, from_status, to_status,
       actor_membership_id, reason)
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000001', 3,
       'performed_pending_resolution', 'resolved', '11000000-0000-4000-8000-000000000001',
       'Resuelta con tarifa inventada');
    UPDATE app.extra_work_events
       SET status = 'resolved', resolution = 'money',
           resolved_agreement_version_id = '12100000-0000-4000-8000-000000000002',
           frozen_unit_rate_cents = 9900, frozen_amount_cents = 9900, balance_minutes = 0,
           approved_by_membership_id = '11000000-0000-4000-8000-000000000001',
           approved_at = '2026-05-05T09:00:00Z',
           resolved_by_membership_id = '11000000-0000-4000-8000-000000000001',
           resolved_at = '2026-05-05T09:00:00Z',
           resolution_reason = 'Tarifa inventada'
     WHERE id = 'dc200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'freezing a rate that is not the catalogued one unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$assert_fixed_amount$;

ROLLBACK;

-- La resolución legítima, en su propia transacción porque la anterior quedó
-- abortada por la aserción negativa.
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.extra_work_events
  (id, household_id, agreement_id, employee_membership_id, extra_work_type_id, kind,
   worked_on, duration_minutes, note, origin, status, requested_by_membership_id,
   performed_by_membership_id, performed_at)
VALUES
  ('dc200000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '13000000-0000-4000-8000-000000000006', 'worked_rest_day', '2026-05-04', 720,
   'Guardia de prueba', 'employee_report', 'requested', '11000000-0000-4000-8000-000000000003',
   NULL, NULL);

INSERT INTO app.extra_work_transitions
  (household_id, extra_work_event_id, sequence_number, from_status, to_status,
   actor_membership_id, reason)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000002', 1, NULL,
   'requested', '11000000-0000-4000-8000-000000000003', 'Registrada');

SET CONSTRAINTS app.extra_work_requires_transition_history IMMEDIATE;

INSERT INTO app.extra_work_transitions
  (household_id, extra_work_event_id, sequence_number, from_status, to_status,
   actor_membership_id, reason)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000002', 2, 'requested',
   'performed_pending_resolution', '11000000-0000-4000-8000-000000000003', 'Realizada');

UPDATE app.extra_work_events
   SET status = 'performed_pending_resolution',
       performed_by_membership_id = '11000000-0000-4000-8000-000000000003',
       performed_at = '2026-05-05T07:00:00Z'
 WHERE id = 'dc200000-0000-4000-8000-000000000002';

INSERT INTO app.extra_work_transitions
  (household_id, extra_work_event_id, sequence_number, from_status, to_status,
   actor_membership_id, reason)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000002', 3,
   'performed_pending_resolution', 'resolved', '11000000-0000-4000-8000-000000000001',
   'Guardia pagada');

UPDATE app.extra_work_events
   SET status = 'resolved', resolution = 'money',
       resolved_agreement_version_id = '12100000-0000-4000-8000-000000000002',
       frozen_unit_rate_cents = 5000, frozen_amount_cents = 5000, balance_minutes = 0,
       approved_by_membership_id = '11000000-0000-4000-8000-000000000001',
       approved_at = '2026-05-05T09:00:00Z',
       resolved_by_membership_id = '11000000-0000-4000-8000-000000000001',
       resolved_at = '2026-05-05T09:00:00Z',
       resolution_reason = 'Guardia pagada'
 WHERE id = 'dc200000-0000-4000-8000-000000000002';

DO $assert_fixed_amount_ok$
DECLARE
  frozen bigint;
BEGIN
  SELECT frozen_amount_cents INTO frozen
    FROM app.extra_work_events WHERE id = 'dc200000-0000-4000-8000-000000000002';
  IF frozen <> 5000 THEN
    RAISE EXCEPTION 'a fixed-amount concept froze % cents instead of its catalogued 5000', frozen;
  END IF;
END
$assert_fixed_amount_ok$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Visibilidad: quien administra ve el catálogo entero porque tiene que
-- editarlo, incluidos el tipo desactivado, el que no tiene tarifa y el
-- complemento retirado.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_sees_all$
DECLARE
  types integer;
  supplements integer;
BEGIN
  SELECT count(*)::integer INTO types FROM app.extra_work_types;
  IF types <> 6 THEN
    RAISE EXCEPTION 'family_admin should read the six roble catalogued types, saw %', types;
  END IF;

  SELECT count(*)::integer INTO supplements FROM app.recurring_supplements;
  IF supplements <> 3 THEN
    RAISE EXCEPTION 'family_admin should read the three roble supplements, saw %', supplements;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.extra_work_types
     WHERE id = '13000000-0000-4000-8000-000000000003' AND NOT active
  ) THEN
    RAISE EXCEPTION 'family_admin cannot see the deactivated type it must be able to re-enable';
  END IF;

  -- Ni siquiera quien administra puede reescribir: el rol de la aplicación no
  -- tiene el privilegio UPDATE sobre estas tablas.
  BEGIN
    UPDATE app.extra_work_types SET rate_cents = 1 WHERE id = '13000000-0000-4000-8000-000000000004';
    RAISE EXCEPTION 'the application role unexpectedly holds UPDATE on the catalogue';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.recurring_supplements WHERE id = '14000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'the application role unexpectedly holds DELETE on the catalogue';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin_sees_all$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La regla del propietario, en la base de datos: la empleada ve SOLO lo activo
-- y con tarifa. En la versión VIGENTE de este acuerdo las horas están
-- desactivadas, así que no hay una sola fila con tarifa horaria que enseñarle,
-- ni por la vista de condiciones ni por el formulario de registro ni por el
-- JSON que viaja al navegador: la fila no sale de Postgres.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_visibility$
DECLARE
  in_force uuid;
  hourly_in_force integer;
  visible_in_force integer;
  hidden integer;
  supplements integer;
BEGIN
  in_force := app.agreement_version_in_force(
    '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001', '2026-08-08'
  );
  IF in_force <> '12100000-0000-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'the version in force resolved to % instead of the second one', in_force;
  END IF;

  -- Esta es LA aserción del encargo, y va a por todas: cero tarifas horarias
  -- en el catálogo ENTERO que esta empleada puede leer, no solo en la versión
  -- vigente. En su acuerdo las horas no se le permiten, y el historial tampoco
  -- se las puede enseñar.
  SELECT count(*)::integer INTO hourly_in_force
    FROM app.extra_work_types WHERE unit = 'per_hour';
  IF hourly_in_force <> 0 THEN
    RAISE EXCEPTION 'the employee can still reach % hourly rate(s)', hourly_in_force;
  END IF;

  -- Lo que sí le aplica: jornada de descanso, jornada extra y noche de guardia.
  SELECT count(*)::integer INTO visible_in_force
    FROM app.extra_work_types WHERE agreement_version_id = in_force;
  IF visible_in_force <> 3 THEN
    RAISE EXCEPTION 'the employee should see three concepts in force, saw %', visible_in_force;
  END IF;

  -- El desactivado y el que no tiene tarifa no existen para ella ni pidiéndolos
  -- por su identificador.
  SELECT count(*)::integer INTO hidden
    FROM app.extra_work_types
   WHERE id IN ('13000000-0000-4000-8000-000000000003', '13000000-0000-4000-8000-000000000007');
  IF hidden <> 0 THEN
    RAISE EXCEPTION 'the employee reached % concept(s) that do not apply to her', hidden;
  END IF;

  -- Complementos: ve los dos vivos —sumen o no—, no el retirado. Ocultarle el
  -- seguro médico sería mentirle por omisión sobre lo que la casa paga por ella.
  SELECT count(*)::integer INTO supplements FROM app.recurring_supplements;
  IF supplements <> 2 THEN
    RAISE EXCEPTION 'the employee should see her two live supplements, saw %', supplements;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.recurring_supplements WHERE code = 'seguro_medico' AND NOT adds_to_pay
  ) THEN
    RAISE EXCEPTION 'the employee cannot see the supplement the household pays on her behalf';
  END IF;
  IF EXISTS (SELECT 1 FROM app.recurring_supplements WHERE code = 'plus_transporte') THEN
    RAISE EXCEPTION 'the employee reached a withdrawn supplement';
  END IF;

  -- Y no escribe el catálogo: las condiciones las pacta quien administra.
  BEGIN
    INSERT INTO app.extra_work_types
      (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
       created_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '12100000-0000-4000-8000-000000000002', 'autoconcedido', 'Autoconcedido', 'fixed_amount',
       9900, '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'the employee unexpectedly wrote her own rate into the catalogue';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_employee_visibility$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Familia no administradora, apoyo y visor: el catálogo lleva dinero y se queda
-- en quien administra y la interesada, igual que `app.agreement_versions`.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);

DO $assert_family_member_blind$
BEGIN
  IF (SELECT count(*) FROM app.extra_work_types) <> 0 THEN
    RAISE EXCEPTION 'family_member should not read the rate catalogue';
  END IF;
  IF (SELECT count(*) FROM app.recurring_supplements) <> 0 THEN
    RAISE EXCEPTION 'family_member should not read the supplements';
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
  IF (SELECT count(*) FROM app.extra_work_types) <> 0 THEN
    RAISE EXCEPTION 'helper should not read the rate catalogue';
  END IF;
  IF (SELECT count(*) FROM app.recurring_supplements) <> 0 THEN
    RAISE EXCEPTION 'helper should not read the supplements';
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
  IF (SELECT count(*) FROM app.extra_work_types) <> 0 THEN
    RAISE EXCEPTION 'viewer should not read the rate catalogue';
  END IF;
  IF (SELECT count(*) FROM app.recurring_supplements) <> 0 THEN
    RAISE EXCEPTION 'viewer should not read the supplements';
  END IF;
END
$assert_viewer_blind$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Aislamiento entre hogares: quien administra el olivo no ve ni escribe el
-- catálogo del roble, y la empleada del roble no ve el del olivo.
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
  SELECT count(*)::integer INTO own FROM app.extra_work_types;
  IF own <> 2 THEN
    RAISE EXCEPTION 'the olivo administrator should read only its own two types, saw %', own;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.extra_work_types
     WHERE household_id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'the olivo administrator reached the roble catalogue';
  END IF;
  IF (SELECT count(*) FROM app.recurring_supplements) <> 0 THEN
    RAISE EXCEPTION 'the olivo administrator reached the roble supplements';
  END IF;

  -- Escribir en el catálogo del vecino: la política de INSERT exige que el
  -- hogar de la fila sea el del contexto.
  BEGIN
    INSERT INTO app.extra_work_types
      (household_id, agreement_id, agreement_version_id, code, name, unit, rate_cents,
       created_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '12100000-0000-4000-8000-000000000002', 'intruso', 'Intruso', 'fixed_amount', 100,
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a cross-tenant catalogue insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.recurring_supplements
      (household_id, agreement_id, agreement_version_id, code, name, amount_cents,
       adds_to_pay, created_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '12100000-0000-4000-8000-000000000002', 'intruso', 'Intruso', 100, true,
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a cross-tenant supplement insert unexpectedly succeeded';
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
DECLARE
  own integer;
BEGIN
  -- En el olivo las horas SÍ están permitidas: la empleada ve su tarifa
  -- horaria. La invisibilidad del roble es una decisión del acuerdo, no un
  -- efecto colateral del modelo.
  SELECT count(*)::integer INTO own FROM app.extra_work_types WHERE unit = 'per_hour';
  IF own <> 1 THEN
    RAISE EXCEPTION 'the olivo employee should see her single hourly rate, saw %', own;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.extra_work_types
     WHERE household_id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'the olivo employee reached the roble catalogue';
  END IF;
END
$assert_olivo_employee$;

ROLLBACK;
