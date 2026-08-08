-- Vacaciones tras la migración 0020: derecho anual en la versión del acuerdo y
-- registro append-only de días disfrutados.
--
-- Cubre las tres cosas que pueden salir mal de verdad:
--   1. Que el registro deje de ser append-only (borrar, reescribir fechas,
--      «desanular», solapar periodos).
--   2. Que la matriz de roles se afloje: escribe SOLO family_admin; lo leen
--      quien administra, la familia y la propia empleada; apoyo y visor, nada.
--   3. Que un hogar vea o escriba en el expediente del otro.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- UUIDs con prefijos da* (roble) / db* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off): dos periodos vigentes y uno anulado en
-- roble, más un periodo del olivo con el que las asercciones cruzadas tengan
-- una fila real que filtrar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.vacation_periods
  (id, household_id, agreement_id, employee_membership_id, starts_on, ends_on, note,
   recorded_by_membership_id) VALUES
  ('da100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2026-08-01', '2026-08-15', 'Quincena de agosto',
   '11000000-0000-4000-8000-000000000001'),
  ('da100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2026-12-24', '2026-12-31', 'Navidad',
   '11000000-0000-4000-8000-000000000001'),
  ('da100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2026-03-02', '2026-03-06', 'Apuntado por error',
   '11000000-0000-4000-8000-000000000001'),
  ('db100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002',
   '2026-08-03', '2026-08-09', 'Semana del olivo',
   '21000000-0000-4000-8000-000000000001');

UPDATE app.vacation_periods
   SET status = 'voided',
       voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
       voided_at = '2026-03-07T09:00:00Z',
       void_reason = 'Las fechas no eran esas'
 WHERE id = 'da100000-0000-4000-8000-000000000003';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Derecho anual: las versiones ya existentes heredan el defecto de 30 días
-- naturales, la columna sigue siendo inmutable (la versión es append-only) y el
-- CHECK rechaza un derecho imposible.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_entitlement$
DECLARE
  defaulted integer;
BEGIN
  SELECT count(*)::integer INTO defaulted
    FROM app.agreement_versions
   WHERE annual_vacation_days <> 30;
  IF defaulted <> 0 THEN
    RAISE EXCEPTION '% agreement versions did not inherit the 30-day default', defaulted;
  END IF;

  -- Cambiar el derecho es cambiar lo pactado: exige una versión nueva, igual
  -- que el salario. El disparador de 0002 lo impone.
  BEGIN
    UPDATE app.agreement_versions
       SET annual_vacation_days = 22
     WHERE id = '12100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'rewriting the vacation entitlement in place unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.agreement_versions (
      household_id, agreement_id, version_number, effective_from,
      monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
      contracted_weekly_minutes, annual_vacation_days, reason, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
      3, '2026-01-01', 150000, 1400, 8000, 2400, 400,
      'Derecho imposible', '11000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'an out-of-range vacation entitlement unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$assert_entitlement$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only con corrección por anulación (superusuario: lo que se comprueba
-- son los disparadores, no la RLS).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_append_only$
BEGIN
  BEGIN
    DELETE FROM app.vacation_periods WHERE id = 'da100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'deleting a vacation period unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Reescribir las fechas de un periodo ya apuntado es reescribir el pasado.
  BEGIN
    UPDATE app.vacation_periods
       SET ends_on = '2026-08-20'
     WHERE id = 'da100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'rewriting a recorded vacation period unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Anular no puede aprovecharse para cambiar lo que la fila decía.
  BEGIN
    UPDATE app.vacation_periods
       SET status = 'voided',
           starts_on = '2026-08-05',
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
           voided_at = '2026-08-16T09:00:00Z',
           void_reason = 'Corrijo las fechas de tapadillo'
     WHERE id = 'da100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'voiding while rewriting the dates unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Una anulación no se deshace: el rastro se queda.
  BEGIN
    UPDATE app.vacation_periods
       SET status = 'recorded',
           voided_by_membership_id = NULL,
           voided_at = NULL,
           void_reason = NULL
     WHERE id = 'da100000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'un-voiding a vacation period unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Anular exige motivo: el CHECK de la tabla no admite una anulación muda.
  BEGIN
    UPDATE app.vacation_periods
       SET status = 'voided'
     WHERE id = 'da100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'voiding without author or reason unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Dos periodos vigentes del mismo acuerdo no pueden solaparse…
  BEGIN
    INSERT INTO app.vacation_periods
      (household_id, agreement_id, employee_membership_id, starts_on, ends_on,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2026-08-15', '2026-08-20',
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'an overlapping vacation period unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- …pero uno anulado deja libre su hueco: para eso sirve anular.
  INSERT INTO app.vacation_periods
    (household_id, agreement_id, employee_membership_id, starts_on, ends_on, note,
     recorded_by_membership_id)
  VALUES
    ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
     '11000000-0000-4000-8000-000000000003', '2026-03-02', '2026-03-04', 'Fechas corregidas',
     '11000000-0000-4000-8000-000000000001');

  BEGIN
    INSERT INTO app.vacation_periods
      (household_id, agreement_id, employee_membership_id, starts_on, ends_on,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2026-09-10', '2026-09-01',
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a period ending before it starts unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- La membresía apuntada tiene que ser del mismo hogar que la fila.
  BEGIN
    INSERT INTO app.vacation_periods
      (household_id, agreement_id, employee_membership_id, starts_on, ends_on,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '21000000-0000-4000-8000-000000000002', '2026-10-01', '2026-10-05',
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a cross-household vacation period unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$assert_append_only$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Días naturales: extremos incluidos, y el saldo solo cuenta lo vigente.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_calendar_days$
DECLARE
  quincena integer;
  taken_2026 integer;
BEGIN
  SELECT calendar_days INTO quincena
    FROM app.vacation_periods WHERE id = 'da100000-0000-4000-8000-000000000001';
  IF quincena <> 15 THEN
    RAISE EXCEPTION 'del 1 al 15 de agosto son 15 días naturales, no %', quincena;
  END IF;

  -- 15 (agosto) + 8 (Navidad); los 5 días anulados NO cuentan.
  SELECT COALESCE(sum(calendar_days), 0)::integer INTO taken_2026
    FROM app.vacation_periods
   WHERE household_id = '10000000-0000-4000-8000-000000000001'
     AND status = 'recorded'
     AND starts_on >= '2026-01-01' AND starts_on <= '2026-12-31';
  IF taken_2026 <> 23 THEN
    RAISE EXCEPTION '2026 vacation days taken expected 23, got %', taken_2026;
  END IF;
END
$assert_calendar_days$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- family_admin de roble: lo ve todo lo suyo, escribe, y no cruza de hogar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_vacations$
BEGIN
  IF (SELECT count(*) FROM app.vacation_periods) <> 3 THEN
    RAISE EXCEPTION 'family_admin should read the three roble vacation periods';
  END IF;
  IF (SELECT count(*) FROM app.vacation_periods
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_admin leaked vacation periods from the olivo household';
  END IF;

  INSERT INTO app.vacation_periods
    (household_id, agreement_id, employee_membership_id, starts_on, ends_on,
     recorded_by_membership_id)
  VALUES
    ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
     '11000000-0000-4000-8000-000000000003', '2026-05-04', '2026-05-08',
     '11000000-0000-4000-8000-000000000001');

  -- Escribir en el hogar ajeno no es «no ver la fila»: es que la política lo
  -- prohíbe con el contexto de roble puesto.
  BEGIN
    INSERT INTO app.vacation_periods
      (household_id, agreement_id, employee_membership_id, starts_on, ends_on,
       recorded_by_membership_id)
    VALUES
      ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
       '21000000-0000-4000-8000-000000000002', '2026-11-02', '2026-11-06',
       '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'cross-tenant vacation insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin_vacations$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- family_member de roble: lo ve (son días de casa, no importes) pero no escribe.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_family_member_vacations$
BEGIN
  IF (SELECT count(*) FROM app.vacation_periods) <> 3 THEN
    RAISE EXCEPTION 'family_member should read the roble vacation periods';
  END IF;
  IF (SELECT count(*) FROM app.vacation_periods
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_member leaked vacation periods from the olivo household';
  END IF;

  BEGIN
    INSERT INTO app.vacation_periods
      (household_id, agreement_id, employee_membership_id, starts_on, ends_on,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2026-06-01', '2026-06-05',
       '11000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'family_member vacation insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Anular tampoco: la corrección la firma quien administra.
  IF (SELECT count(*) FROM app.vacation_periods
       WHERE id = 'da100000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'family_member should still see the period it cannot void';
  END IF;
  UPDATE app.vacation_periods
     SET status = 'voided',
         voided_by_membership_id = '11000000-0000-4000-8000-000000000002',
         voided_at = now(),
         void_reason = 'No me toca a mí'
   WHERE id = 'da100000-0000-4000-8000-000000000001';
  IF FOUND THEN
    RAISE EXCEPTION 'family_member voided a vacation period';
  END IF;
END
$assert_family_member_vacations$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La empleada: ve SUS periodos (es su expediente) y no escribe ni uno.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_vacations$
BEGIN
  IF (SELECT count(*) FROM app.vacation_periods) <> 3 THEN
    RAISE EXCEPTION 'the employee must read her own three vacation periods';
  END IF;
  IF (SELECT count(*) FROM app.vacation_periods
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'the employee leaked vacation periods from the olivo household';
  END IF;

  -- El propietario decidió que los días los apunta la familia: la empleada los
  -- consulta, no los escribe.
  BEGIN
    INSERT INTO app.vacation_periods
      (household_id, agreement_id, employee_membership_id, starts_on, ends_on,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2026-07-01', '2026-07-05',
       '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'the employee recorded her own vacation period';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  UPDATE app.vacation_periods
     SET status = 'voided',
         voided_by_membership_id = '11000000-0000-4000-8000-000000000003',
         voided_at = now(),
         void_reason = 'Me lo quito yo'
   WHERE id = 'da100000-0000-4000-8000-000000000002';
  IF FOUND THEN
    RAISE EXCEPTION 'the employee voided a vacation period';
  END IF;
END
$assert_employee_vacations$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Apoyo y visor: cero filas. Las vacaciones son expediente laboral.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_vacations$
BEGIN
  IF (SELECT count(*) FROM app.vacation_periods) <> 0 THEN
    RAISE EXCEPTION 'the helper read employment vacation periods';
  END IF;
END
$assert_helper_vacations$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer_vacations$
BEGIN
  IF (SELECT count(*) FROM app.vacation_periods) <> 0 THEN
    RAISE EXCEPTION 'the viewer read employment vacation periods';
  END IF;
END
$assert_viewer_vacations$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- El otro hogar solo ve el suyo: la simetría también hay que comprobarla.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

DO $assert_olivo_vacations$
BEGIN
  IF (SELECT count(*) FROM app.vacation_periods) <> 1 THEN
    RAISE EXCEPTION 'the olivo admin should read exactly its own vacation period';
  END IF;
  IF (SELECT count(*) FROM app.vacation_periods
       WHERE household_id = '10000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'the olivo admin leaked vacation periods from the roble household';
  END IF;
END
$assert_olivo_vacations$;

ROLLBACK;
