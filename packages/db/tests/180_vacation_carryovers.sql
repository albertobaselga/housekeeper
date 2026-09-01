-- Arrastre de vacaciones tras la migración 0035: qué se decidió con los días
-- que no se disfrutaron al cerrar un año de CONTRATO.
--
-- Cubre las cinco cosas que pueden salir mal de verdad, que son las cinco que
-- acaban en dinero mal pagado:
--   1. Que la fila deje de ser append-only: borrar una decisión, saltarse una
--      transición ilegal o reescribir los días congelados al decidir.
--   2. Que se pague dos veces: dos filas del mismo año de contrato, o dos
--      arrastres cerrados con el mismo concepto.
--   3. Que un importe aparezca sin haberse pactado tarifa, o sin la frase que
--      lo explica.
--   4. Que la anulación de un concepto pueda cambiar de paso a qué arrastre
--      apunta — el olvido concreto que obligó a reescribir el disparador de
--      0022.
--   5. Que la matriz de roles se afloje: escribe SOLO family_admin; leen quien
--      administra y la propia empleada. La familia no administradora NO, porque
--      la fila lleva importe.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- El acuerdo de roble empezó el 3 de febrero de 2025, así que su primer año de
-- contrato va del 3-feb-2025 al 2-feb-2026 y el segundo del 3-feb-2026 al
-- 2-feb-2027. UUIDs con prefijos ca* (roble) / cb* (olivo), exclusivos de este
-- fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off): un arrastre decidido en roble y otro del
-- olivo con el que las aserciones cruzadas tengan una fila real que filtrar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.vacation_carryovers
  (id, household_id, agreement_id, employee_membership_id,
   source_year_index, source_year_starts_on, source_year_ends_on,
   entitled_days, taken_days, unused_days, agreement_version_id,
   compensation_cents, compensation_basis, deadline_on,
   status, decided_by_membership_id, decided_at, decision_reason) VALUES
  ('ca100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   1, '2025-02-03', '2026-02-02', 30, 12, 18,
   '12100000-0000-4000-8000-000000000002',
   83070, '18 días sin disfrutar × 46,15 € por día, pactados en las condiciones vigentes desde el 1 de abril de 2025 = 830,70 €',
   '2026-08-02', 'carried', '11000000-0000-4000-8000-000000000001',
   '2026-02-05T09:00:00Z', NULL),
  -- Sin tarifa pactada no hay importe, y por eso este va sin cifra y sin frase:
  -- el olivo no pactó el precio del día, así que sólo se podía arrastrar o
  -- rechazar. Aquí se rechazó, con su motivo.
  ('cb100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002',
   1, '2025-01-01', '2025-12-31', 30, 25, 5,
   '22100000-0000-4000-8000-000000000001',
   NULL, NULL, '2026-06-30',
   'rejected', '21000000-0000-4000-8000-000000000001', '2026-01-08T09:00:00Z',
   'Se acordó con ella que no se arrastraban');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Lo que la tabla no admite: cuentas que no cuadran, importes sin frase,
-- rechazos mudos, fechas límite anteriores al año que cierran y membresías de
-- otro hogar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_constraints$
BEGIN
  -- Los días tienen que cuadrar: `unused = entitled − taken`. Un arrastre que
  -- no cuadra es un arrastre inventado.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 12, 25, '12100000-0000-4000-8000-000000000002',
       'carried', '11000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'a carryover whose days do not add up unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Arrastrar cero días no es una decisión, es no tener nada que decidir.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 30, 0, '12100000-0000-4000-8000-000000000002',
       'carried', '11000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'a carryover of zero days unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Un importe sin la frase que lo explica es un número sin padre.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, compensation_cents,
       status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 12, 18, '12100000-0000-4000-8000-000000000002', 83070,
       'carried', '11000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'a compensation amount without its sentence unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Rechazar sin decir por qué es perder días en silencio, que es justo lo que
  -- esta tabla existe para impedir.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 12, 18, '12100000-0000-4000-8000-000000000002',
       'rejected', '11000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'a mute rejection unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Compensar es pagar: sin concepto que lo materialice, no hay compensación.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, compensation_cents, compensation_basis,
       status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 12, 18, '12100000-0000-4000-8000-000000000002', 83070, 'Dieciocho días',
       'compensated', '11000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'a compensation without its manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- La fecha límite es POSTERIOR al año que cierra: un margen que acaba antes
  -- de empezar no es un margen.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, deadline_on,
       status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 12, 18, '12100000-0000-4000-8000-000000000002', '2026-12-31',
       'carried', '11000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'a deadline before the closing year unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- La versión congelada tiene que ser del MISMO acuerdo, no de otro del hogar.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 12, 18, '12100000-0000-4000-8000-000000000003',
       'carried', '11000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'a carryover frozen against another agreement version unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  -- Un año de contrato se cierra UNA vez: es la mitad de la garantía contra el
  -- pago doble.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, status, decided_by_membership_id, decided_at,
       decision_reason)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 1, '2025-02-03', '2026-02-02',
       30, 12, 18, '12100000-0000-4000-8000-000000000002',
       'rejected', '11000000-0000-4000-8000-000000000001', now(),
       'Cambiando de idea sobre un año ya decidido');
    RAISE EXCEPTION 'a second decision for the same contract year unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$assert_constraints$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only: decidir no reescribe lo propuesto, y las transiciones están
-- tasadas.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_append_only$
BEGIN
  BEGIN
    DELETE FROM app.vacation_carryovers WHERE id = 'ca100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'deleting a vacation carryover unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Reescribir los días congelados es exactamente el fallo que esta tabla
  -- existe para impedir: la propuesta que alguien vio y decidió no puede
  -- cambiar debajo.
  BEGIN
    UPDATE app.vacation_carryovers
       SET unused_days = 25, taken_days = 5
     WHERE id = 'ca100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'rewriting the frozen days unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Y hacerlo AL DECIDIR tampoco: la transición cambia el estado y nada más.
  BEGIN
    UPDATE app.vacation_carryovers
       SET status = 'expired',
           expired_at = now(),
           compensation_cents = 99000
     WHERE id = 'ca100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'expiring while rewriting the amount unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Un arrastre ya decidido no puede cambiar de autor.
  BEGIN
    UPDATE app.vacation_carryovers
       SET status = 'expired',
           expired_at = now(),
           decided_by_membership_id = '11000000-0000-4000-8000-000000000002'
     WHERE id = 'ca100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'rewriting who decided unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Volver a 'proposed' es deshacer una decisión que ya se comunicó.
  BEGIN
    UPDATE app.vacation_carryovers
       SET status = 'proposed', decided_by_membership_id = NULL, decided_at = NULL
     WHERE id = 'ca100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'un-deciding a vacation carryover unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Lo rechazado no se reabre por la puerta de atrás.
  BEGIN
    UPDATE app.vacation_carryovers
       SET status = 'carried'
     WHERE id = 'cb100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'reopening a rejected carryover unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- La transición legítima sí pasa, y deja lo congelado intacto.
  UPDATE app.vacation_carryovers
     SET status = 'expired', expired_at = '2026-08-03T00:00:00Z'
   WHERE id = 'ca100000-0000-4000-8000-000000000001';

  IF (SELECT unused_days FROM app.vacation_carryovers
       WHERE id = 'ca100000-0000-4000-8000-000000000001') <> 18 THEN
    RAISE EXCEPTION 'expiring must not touch what the carryover froze';
  END IF;
  IF (SELECT decided_by_membership_id FROM app.vacation_carryovers
       WHERE id = 'ca100000-0000-4000-8000-000000000001')
     <> '11000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'expiring must keep the author of the carry decision';
  END IF;
END
$assert_append_only$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La cadena con el dinero: un concepto por arrastre, un arrastre por concepto,
-- y la anulación sin poder mover la columna nueva.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_money_chain$
DECLARE
  otro uuid;
BEGIN
  -- El par se escribe entero en la misma transacción: el concepto nombra su
  -- arrastre y el arrastre nombra su concepto. La clave ajena aplazada es lo
  -- que lo hace posible sin que ninguna de las dos filas mienta al COMMIT.
  INSERT INTO app.manual_adjustments
    (id, household_id, agreement_id, employee_membership_id, period_month,
     requested_period_month, label, reason, amount_cents, adds_to_pay,
     vacation_carryover_id, recorded_by_membership_id)
  VALUES
    ('ca200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
     '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
     '2025-09-01', '2025-09-01', 'Vacaciones del segundo año no disfrutadas',
     '18 días sin disfrutar × 46,15 € por día = 830,70 €', 83070, true,
     'ca300000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001');

  INSERT INTO app.vacation_carryovers
    (id, household_id, agreement_id, employee_membership_id, source_year_index,
     source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
     unused_days, agreement_version_id, compensation_cents, compensation_basis,
     deadline_on, status, decided_by_membership_id, decided_at, manual_adjustment_id)
  VALUES
    ('ca300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
     '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
     2, '2026-02-03', '2027-02-02', 30, 12, 18,
     '12100000-0000-4000-8000-000000000002', 83070,
     '18 días sin disfrutar × 46,15 € por día = 830,70 €', '2027-08-02',
     'compensated', '11000000-0000-4000-8000-000000000001', now(),
     'ca200000-0000-4000-8000-000000000001');

  -- Un mismo concepto no puede cerrar dos arrastres: sería pagar dos veces con
  -- un solo apunte, y la cuenta cuadraría igual.
  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, compensation_cents, compensation_basis,
       status, decided_by_membership_id, decided_at, manual_adjustment_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 3, '2027-02-03', '2028-02-02',
       30, 10, 20, '12100000-0000-4000-8000-000000000002', 83070, 'El mismo apunte',
       'compensated', '11000000-0000-4000-8000-000000000001', now(),
       'ca200000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'one manual adjustment closing two carryovers unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- EL OLVIDO QUE OBLIGÓ A REESCRIBIR EL DISPARADOR DE 0022: anular el concepto
  -- no puede cambiar de paso a qué arrastre apunta. Sin la columna en la lista
  -- del disparador, esto pasaría y movería un pago de un año a otro sin rastro.
  BEGIN
    UPDATE app.manual_adjustments
       SET status = 'voided',
           vacation_carryover_id = NULL,
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
           voided_at = now(),
           void_reason = 'Soltando el arrastre de paso'
     WHERE id = 'ca200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'voiding while dropping the carryover link unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Ni fuera de una anulación.
  BEGIN
    UPDATE app.manual_adjustments
       SET vacation_carryover_id = NULL
     WHERE id = 'ca200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'rewriting the carryover link unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- La clave ajena está aplazada, no relajada: un concepto que nombra un
  -- arrastre inexistente sigue siendo un huérfano y se rechaza.
  otro := gen_random_uuid();
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       vacation_carryover_id, recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-09-01', '2025-09-01',
       'Huérfano', 'Apunta a un arrastre que no existe', 1000, true,
       otro, '11000000-0000-4000-8000-000000000001');
    SET CONSTRAINTS app.manual_adjustments_vacation_carryover_fkey IMMEDIATE;
    RAISE EXCEPTION 'an orphan manual adjustment unexpectedly survived';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$assert_money_chain$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- family_admin de roble: lo ve todo lo suyo, decide, y no cruza de hogar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin$
BEGIN
  IF (SELECT count(*) FROM app.vacation_carryovers) <> 1 THEN
    RAISE EXCEPTION 'family_admin should read the roble carryover';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.vacation_carryovers
     WHERE household_id = '20000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'family_admin leaked a carryover from the olivo household';
  END IF;

  INSERT INTO app.vacation_carryovers
    (household_id, agreement_id, employee_membership_id, source_year_index,
     source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
     unused_days, agreement_version_id, status, decided_by_membership_id,
     decided_at, decision_reason)
  VALUES
    ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
     '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
     30, 12, 18, '12100000-0000-4000-8000-000000000002',
     'rejected', '11000000-0000-4000-8000-000000000001', now(),
     'Se acordó con ella en la conversación de febrero');

  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, status, decided_by_membership_id, decided_at)
    VALUES
      ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
       '21000000-0000-4000-8000-000000000002', 2, '2026-01-01', '2026-12-31',
       30, 10, 20, '22100000-0000-4000-8000-000000000001',
       'carried', '21000000-0000-4000-8000-000000000001', now());
    RAISE EXCEPTION 'cross-tenant carryover insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La empleada: lo VE (son sus días y su dinero) y no lo decide.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee$
BEGIN
  IF (SELECT count(*) FROM app.vacation_carryovers) <> 1 THEN
    RAISE EXCEPTION 'the employee should read her own carryover';
  END IF;

  BEGIN
    INSERT INTO app.vacation_carryovers
      (household_id, agreement_id, employee_membership_id, source_year_index,
       source_year_starts_on, source_year_ends_on, entitled_days, taken_days,
       unused_days, agreement_version_id, status, decided_by_membership_id, decided_at)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', 2, '2026-02-03', '2027-02-02',
       30, 12, 18, '12100000-0000-4000-8000-000000000002',
       'carried', '11000000-0000-4000-8000-000000000003', now());
    RAISE EXCEPTION 'the employee unexpectedly decided a carryover';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Tampoco cambia el estado de la suya. Aquí NO salta ningún error y eso es lo
  -- que hay que comprobar: para escribir, la fila sencillamente no existe (la
  -- política de lectura es FOR SELECT y no alcanza al UPDATE).
  UPDATE app.vacation_carryovers
     SET status = 'compensated'
   WHERE id = 'ca100000-0000-4000-8000-000000000001';
  IF FOUND THEN
    RAISE EXCEPTION 'the employee unexpectedly changed her carryover';
  END IF;
END
$assert_employee$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La familia no administradora, el apoyo y el visor: ni una fila. La fila lleva
-- importe, y los importes de esta casa no salen de quien administra y la
-- interesada — el mismo criterio de `manual_adjustments_read`, no el de
-- `vacation_periods_read`.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_family$
BEGIN
  IF (SELECT count(*) FROM app.vacation_carryovers) <> 0 THEN
    RAISE EXCEPTION 'family_member unexpectedly read a carryover with money in it';
  END IF;
END
$assert_family$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper$
BEGIN
  IF (SELECT count(*) FROM app.vacation_carryovers) <> 0 THEN
    RAISE EXCEPTION 'the helper unexpectedly read a carryover';
  END IF;
END
$assert_helper$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- El rol de la aplicación no puede borrar, aunque alguien escribiera una
-- política permisiva por error.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_grants$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'app' AND table_name = 'vacation_carryovers'
       AND grantee = 'casa_clara_app' AND privilege_type = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'casa_clara_app has DELETE on app.vacation_carryovers';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'app' AND table_name = 'vacation_carryovers'
       AND grantee = 'casa_clara_app' AND privilege_type = 'INSERT'
  ) THEN
    RAISE EXCEPTION 'casa_clara_app cannot insert into app.vacation_carryovers';
  END IF;
END
$assert_grants$;

ROLLBACK;
