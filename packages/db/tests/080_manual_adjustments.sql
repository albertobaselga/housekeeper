-- Conceptos apuntados a mano tras la migración 0022: importes sueltos que no
-- nacen de un hecho del sistema e imputados a la cuenta de un mes concreto.
--
-- Cubre las cuatro cosas que pueden salir mal de verdad:
--   1. Que el registro deje de ser append-only (borrar, reescribir el importe
--      bajo una anulación, «desanular», anular sin decir quién ni por qué).
--   2. Que una cuenta CERRADA se reescriba: ni apuntando un concepto nuevo en
--      su mes ni anulando uno que ya entró en ella. Es la promesa del
--      expediente y aquí se comprueba en la base, no en el servidor.
--   3. Que una línea de liquidación quede sin padre: 'adjustment' exige su
--      concepto y ninguna otra clase puede llevarlo.
--   4. Que la matriz de roles se afloje: escribe SOLO family_admin; leen quien
--      administra y la propia empleada. Familia, apoyo y visor, nada — son
--      importes, y el criterio es el de `settlements_read`.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- La fixture deja marzo de 2025 CERRADO en roble, que es el mes con el que se
-- comprueba todo lo del punto 2.
--
-- UUIDs con prefijos de* (roble) / df* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off): dos conceptos vigentes y uno anulado en
-- roble, más uno del olivo con el que las aserciones cruzadas tengan una fila
-- real que filtrar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.manual_adjustments
  (id, household_id, agreement_id, employee_membership_id, period_month,
   requested_period_month, label, reason, amount_cents, adds_to_pay,
   recorded_by_membership_id) VALUES
  ('de100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2025-06-01', '2025-06-01', 'Gratificación de verano',
   'Acordada en la conversación del 2 de junio', 15000, true,
   '11000000-0000-4000-8000-000000000001'),
  ('de100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2025-06-01', '2025-06-01', 'Anticipo devuelto en mano',
   'Devolvió 200 € en efectivo el 12 de junio', -20000, false,
   '11000000-0000-4000-8000-000000000001'),
  ('de100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
   '2025-07-01', '2025-07-01', 'Apuntado por error',
   'El importe era otro', 5000, true,
   '11000000-0000-4000-8000-000000000001'),
  ('df100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   '22000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000002',
   '2025-06-01', '2025-06-01', 'Gratificación del olivo',
   'Nada que ver con roble', 3000, true,
   '21000000-0000-4000-8000-000000000001');

UPDATE app.manual_adjustments
   SET status = 'voided',
       voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
       voided_at = '2025-07-04T09:00:00Z',
       void_reason = 'Se apuntó dos veces'
 WHERE id = 'de100000-0000-4000-8000-000000000003';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Lo que la tabla no admite: importes mudos, meses que no son meses,
-- aplazamientos que no se explican y membresías de otro hogar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_constraints$
BEGIN
  -- Cero no es un concepto, es un apunte a medio escribir.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-08-01', '2025-08-01',
       'Nada', 'Nada', 0, true, '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a zero-amount manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Un importe suelto sin explicación es lo que convierte una cuenta en una
  -- discusión: el motivo no es opcional ni puede ser espacios.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-08-01', '2025-08-01',
       'Sin explicar', '   ', 1000, true, '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a manual adjustment without a reason unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- El mes se guarda normalizado al día 1: la unidad de la cuenta es el mes.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-08-14', '2025-08-14',
       'Un día suelto', 'No debería entrar', 1000, true,
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a mid-month manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Se aplaza hacia adelante o no se aplaza: imputar a un mes ANTERIOR al
  -- pedido sería colar el importe en una cuenta que ya pudo enseñarse.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       deferral_note, recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-08-01', '2025-09-01',
       'Hacia atrás', 'No debería entrar', 1000, true, 'Hacia atrás',
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a backwards-deferred manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- La nota del aplazamiento existe exactamente cuando hay aplazamiento: ni
  -- una fila que cambia de mes sin decir por qué…
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-09-01', '2025-08-01',
       'Aplazado y mudo', 'No debería entrar', 1000, true,
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a silent deferral unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- …ni una que se explica sin haberse movido.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       deferral_note, recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-08-01', '2025-08-01',
       'Sin aplazar', 'No debería entrar', 1000, true, 'Se aplazó (mentira)',
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a deferral note without a deferral unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- La membresía apuntada tiene que ser del mismo hogar que la fila.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '21000000-0000-4000-8000-000000000002', '2025-08-01', '2025-08-01',
       'Cruzado', 'No debería entrar', 1000, true,
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a cross-household manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END
$assert_constraints$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only con una única corrección posible: la anulación.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_append_only$
BEGIN
  BEGIN
    DELETE FROM app.manual_adjustments WHERE id = 'de100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'deleting a manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Corregir el importe en su sitio es reescribir el pasado.
  BEGIN
    UPDATE app.manual_adjustments
       SET amount_cents = 99000
     WHERE id = 'de100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'rewriting a manual adjustment amount unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Y hacerlo AL ANULAR tampoco vale: la anulación cambia el estado y nada más.
  BEGIN
    UPDATE app.manual_adjustments
       SET status = 'voided',
           amount_cents = 99000,
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
           voided_at = now(),
           void_reason = 'Cambiando el importe de paso'
     WHERE id = 'de100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'voiding while rewriting the amount unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Anular exige autoría, instante y motivo: nada de anulaciones mudas.
  BEGIN
    UPDATE app.manual_adjustments
       SET status = 'voided'
     WHERE id = 'de100000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'voiding without author or reason unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Desanular es rehacer la historia.
  BEGIN
    UPDATE app.manual_adjustments
       SET status = 'recorded',
           voided_by_membership_id = NULL,
           voided_at = NULL,
           void_reason = NULL
     WHERE id = 'de100000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'un-voiding a manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- La corrección legítima sí pasa, y deja la fila entera a la vista.
  UPDATE app.manual_adjustments
     SET status = 'voided',
         voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
         voided_at = now(),
         void_reason = 'El importe era otro'
   WHERE id = 'de100000-0000-4000-8000-000000000001';

  IF (SELECT amount_cents FROM app.manual_adjustments
       WHERE id = 'de100000-0000-4000-8000-000000000001') <> 15000 THEN
    RAISE EXCEPTION 'voiding must not touch what the adjustment recorded';
  END IF;
END
$assert_append_only$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Una cuenta cerrada no se reescribe. La fixture cierra marzo de 2025 en roble.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_closed_month$
DECLARE
  mayo uuid;
BEGIN
  -- Apuntar un concepto en el mes ya cerrado: rechazado por el disparador,
  -- venga la escritura de donde venga.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-03-01', '2025-03-01',
       'Tarde', 'La cuenta de marzo ya se cerró', 1000, true,
       '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'writing into a closed month unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;

  -- Un mes SIN liquidación cerrada sí admite apuntes: lo que cierra la puerta
  -- es el cierre, no el calendario.
  INSERT INTO app.manual_adjustments
    (id, household_id, agreement_id, employee_membership_id, period_month,
     requested_period_month, label, reason, amount_cents, adds_to_pay,
     recorded_by_membership_id)
  VALUES
    ('de200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
     '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
     '2025-05-01', '2025-05-01', 'Parte proporcional de mayo',
     'Media mensualidad del arranque', 7000, true,
     '11000000-0000-4000-8000-000000000001');

  -- Y cuando ESE mes se cierra, el concepto que entró en él deja de poder
  -- anularse: quitarlo cambiaría un total ya congelado y firmado.
  INSERT INTO app.settlements
    (id, household_id, agreement_id, employee_membership_id, period_start,
     period_end, due_on, status, salary_total_cents, transfer_total_cents,
     created_by_membership_id, closed_by_membership_id, closed_at, snapshot_hash)
  VALUES
    ('de300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
     '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
     '2025-05-01', '2025-05-31', '2025-05-31', 'closed', 157000, 157000,
     '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
     '2025-06-02T10:00:00Z', repeat('b', 64))
  RETURNING id INTO mayo;

  BEGIN
    UPDATE app.manual_adjustments
       SET status = 'voided',
           voided_by_membership_id = '11000000-0000-4000-8000-000000000001',
           voided_at = now(),
           void_reason = 'Ya no queremos darla'
     WHERE id = 'de200000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'voiding an adjustment inside a closed month unexpectedly succeeded';
  EXCEPTION WHEN sqlstate '55000' THEN
    NULL;
  END;
END
$assert_closed_month$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La línea de la liquidación nombra su origen: 'adjustment' exige su concepto
-- y ninguna otra clase puede llevarlo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_provenance$
DECLARE
  abierta uuid := 'de300000-0000-4000-8000-000000000002';
BEGIN
  INSERT INTO app.settlements
    (id, household_id, agreement_id, employee_membership_id, period_start,
     period_end, due_on, created_by_membership_id)
  VALUES
    (abierta, '10000000-0000-4000-8000-000000000001',
     '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
     '2025-06-01', '2025-06-30', '2025-06-30', '11000000-0000-4000-8000-000000000001');

  -- Un importe sin padre en un documento que promete que cada número dice de
  -- dónde sale.
  BEGIN
    INSERT INTO app.settlement_lines
      (household_id, settlement_id, agreement_id, employee_membership_id, line_number,
       section, kind, occurred_on, concept, amount_cents)
    VALUES
      ('10000000-0000-4000-8000-000000000001', abierta,
       '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
       1, 'salary', 'adjustment', '2025-06-01', 'Ajuste huérfano', 1000);
    RAISE EXCEPTION 'an adjustment line without its concept unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Y un ajuste no puede disfrazarse de otra cosa ni al revés.
  BEGIN
    INSERT INTO app.settlement_lines
      (household_id, settlement_id, agreement_id, employee_membership_id, line_number,
       section, kind, occurred_on, concept, amount_cents,
       agreement_version_id, manual_adjustment_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', abierta,
       '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
       1, 'salary', 'base_salary', '2025-06-01', 'Salario disfrazado', 150000,
       '12100000-0000-4000-8000-000000000001', 'de100000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'a base salary line carrying a manual adjustment unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- La línea bien formada sí entra.
  INSERT INTO app.settlement_lines
    (household_id, settlement_id, agreement_id, employee_membership_id, line_number,
     section, kind, occurred_on, concept, amount_cents, manual_adjustment_id)
  VALUES
    ('10000000-0000-4000-8000-000000000001', abierta,
     '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
     1, 'salary', 'adjustment', '2025-06-01',
     'Gratificación de verano · Acordada en la conversación del 2 de junio', 15000,
     'de100000-0000-4000-8000-000000000001');
END
$assert_provenance$;

ROLLBACK;

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

DO $assert_admin$
BEGIN
  IF (SELECT count(*) FROM app.manual_adjustments) <> 3 THEN
    RAISE EXCEPTION 'family_admin should read the three roble manual adjustments';
  END IF;
  IF (SELECT count(*) FROM app.manual_adjustments
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_admin leaked manual adjustments from the olivo household';
  END IF;

  INSERT INTO app.manual_adjustments
    (household_id, agreement_id, employee_membership_id, period_month,
     requested_period_month, label, reason, amount_cents, adds_to_pay,
     recorded_by_membership_id)
  VALUES
    ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
     '11000000-0000-4000-8000-000000000003', '2025-08-01', '2025-08-01',
     'Descuento acordado', 'Rotura de la vitrocerámica, a medias', -5000, true,
     '11000000-0000-4000-8000-000000000001');

  -- Escribir en el hogar ajeno no es «no ver la fila»: la política lo prohíbe
  -- con el contexto de roble puesto.
  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001',
       '21000000-0000-4000-8000-000000000002', '2025-08-01', '2025-08-01',
       'Intruso', 'No debería entrar', 1000, true,
       '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'cross-tenant manual adjustment insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- La empleada: los VE todos (es dinero suyo, o dinero decidido sobre su
-- cuenta) y no escribe ninguno. Ocultárselos sería la opacidad que esta
-- aplicación existe para evitar.
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
  IF (SELECT count(*) FROM app.manual_adjustments) <> 3 THEN
    RAISE EXCEPTION 'the employee should read her three manual adjustments';
  END IF;

  -- Incluido el que consta sin transferirse: enterarse de que un anticipo se
  -- dio por devuelto es exactamente lo que le importa.
  IF NOT EXISTS (
    SELECT 1 FROM app.manual_adjustments
     WHERE id = 'de100000-0000-4000-8000-000000000002' AND adds_to_pay = false
  ) THEN
    RAISE EXCEPTION 'the employee cannot see the adjustment that only gets noted';
  END IF;

  BEGIN
    INSERT INTO app.manual_adjustments
      (household_id, agreement_id, employee_membership_id, period_month,
       requested_period_month, label, reason, amount_cents, adds_to_pay,
       recorded_by_membership_id)
    VALUES
      ('10000000-0000-4000-8000-000000000001', '12000000-0000-4000-8000-000000000001',
       '11000000-0000-4000-8000-000000000003', '2025-08-01', '2025-08-01',
       'Gratificación propia', 'No debería entrar', 10000, true,
       '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'the employee unexpectedly recorded a manual adjustment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Tampoco anula. Aquí no salta ningún error y ESO es lo que hay que
  -- comprobar: para escribir, la fila sencillamente no existe (la política de
  -- lectura es FOR SELECT y no alcanza al UPDATE), así que la orden se queda
  -- en cero filas. Un test que esperase una excepción pasaría por el motivo
  -- equivocado el día que alguien aflojase la política.
  UPDATE app.manual_adjustments
     SET status = 'voided',
         voided_by_membership_id = '11000000-0000-4000-8000-000000000003',
         voided_at = now(),
         void_reason = 'No estoy de acuerdo'
   WHERE id = 'de100000-0000-4000-8000-000000000001';
  IF FOUND THEN
    RAISE EXCEPTION 'the employee unexpectedly voided a manual adjustment';
  END IF;

  IF (SELECT status FROM app.manual_adjustments
       WHERE id = 'de100000-0000-4000-8000-000000000001') <> 'recorded' THEN
    RAISE EXCEPTION 'the adjustment changed state under the employee session';
  END IF;
END
$assert_employee$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Familia no administradora, apoyo y visor: nada. Son importes, y el criterio
-- es el mismo que en `settlements_read` (0005).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_family_member$
BEGIN
  IF (SELECT count(*) FROM app.manual_adjustments) <> 0 THEN
    RAISE EXCEPTION 'family_member should not read any manual adjustment';
  END IF;
END
$assert_family_member$;

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
  IF (SELECT count(*) FROM app.manual_adjustments) <> 0 THEN
    RAISE EXCEPTION 'helper should not read any manual adjustment';
  END IF;
END
$assert_helper$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer$
BEGIN
  IF (SELECT count(*) FROM app.manual_adjustments) <> 0 THEN
    RAISE EXCEPTION 'viewer should not read any manual adjustment';
  END IF;
END
$assert_viewer$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- El otro hogar ve el suyo y solo el suyo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:olivo:admin', true);
SELECT app.set_household_context(
  '20000000-0000-4000-8000-000000000001',
  '21000000-0000-4000-8000-000000000001'
);

DO $assert_olivo$
BEGIN
  IF (SELECT count(*) FROM app.manual_adjustments) <> 1 THEN
    RAISE EXCEPTION 'the olivo admin should read exactly its own manual adjustment';
  END IF;
  IF (SELECT count(*) FROM app.manual_adjustments
       WHERE household_id = '10000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'the olivo admin leaked roble manual adjustments';
  END IF;
END
$assert_olivo$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- El rol de la aplicación no tiene DELETE: aunque alguien escribiera una
-- política permisiva por error, borrar no está entre sus privilegios.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_no_delete_grant$
BEGIN
  IF has_table_privilege('casa_clara_app', 'app.manual_adjustments', 'DELETE') THEN
    RAISE EXCEPTION 'casa_clara_app unexpectedly holds DELETE on app.manual_adjustments';
  END IF;
  IF NOT has_table_privilege('casa_clara_app', 'app.manual_adjustments', 'INSERT') THEN
    RAISE EXCEPTION 'casa_clara_app should be able to record manual adjustments';
  END IF;
END
$assert_no_delete_grant$;

COMMIT;

-- La siembra se queda: como en 060 y 070, el corredor arranca cada pasada
-- tirando el esquema y volviendo a migrar, así que no hay nada que limpiar. Y
-- borrarla exigiría desactivar el disparador append-only, que es justo la
-- costumbre que este fichero existe para que nadie coja.
