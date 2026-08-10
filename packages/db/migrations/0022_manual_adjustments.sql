BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Conceptos apuntados a mano, imputados al mes que toque.
--
-- El propietario lo pidió con estas palabras: «o apuntar conceptos a mano para
-- que se contabilicen el mes que toque». Son importes que NO nacen de un hecho
-- del sistema —una gratificación, un descuento acordado, la parte proporcional
-- de algo, un anticipo ya devuelto en mano— y que tienen que entrar en la
-- cuenta de un mes concreto, elegido por quien administra.
--
-- Lo que ya existía y lo que faltaba de verdad:
--
--   · `app.ledger_entry_kind` y `app.settlement_line_kind` contemplan
--     'adjustment' desde 0003, y el motor puro (`packages/domain/settlement.ts`)
--     ya sabía convertir `input.adjustments` en líneas con etiqueta, motivo e
--     importe con signo.
--   · No existía NINGUNA tabla donde vivieran, ningún comando para crearlos y
--     el cierre del mes los pasaba siempre como lista vacía. Es decir: el hueco
--     era entero, del contrato a la persistencia.
--
-- Esta migración crea `app.manual_adjustments` y engancha su procedencia a
-- `app.settlement_lines`. Cuatro decisiones que merecen explicación:
--
-- 1. EL MES SE ELIGE Y SE CONGELA. La fila lleva `period_month` (el mes al que
--    de verdad se imputa) y `requested_period_month` (el que pidió quien lo
--    apuntó). Normalmente coinciden. Cuando el mes pedido ya está CERRADO no se
--    coinciden: la cuenta cerrada no se reescribe —es la promesa del
--    expediente— y el concepto cae al primer mes posterior que siga abierto,
--    con `deferral_note` diciéndolo con todas las letras. El disparador impide
--    que `period_month` apunte a un mes cerrado, venga la escritura de donde
--    venga.
--
-- 2. `adds_to_pay` ES LA MISMA COLUMNA QUE EN LOS COMPLEMENTOS. No se
--    reinventa la distinción de 0021: `true` = el importe entra en la
--    transferencia del mes (con su signo); `false` = consta en el expediente
--    pero NO la toca, porque ese dinero no se transfiere. El caso que lo
--    justifica es literal del propietario: un anticipo ya devuelto en mano se
--    apunta para que quede constancia, y descontarlo otra vez de la
--    transferencia sería cobrárselo dos veces.
--
-- 3. APPEND-ONLY CON ANULACIÓN, calcando `app.payments` y `app.vacation_periods`:
--    un concepto mal apuntado no se borra ni se reescribe; se anula con autoría,
--    instante y motivo, y se queda a la vista. Y no se puede anular lo que ya
--    entró en una cuenta cerrada: eso también sería reescribirla. Para
--    corregirlo se apunta el contrario en un mes abierto.
--
-- 4. LA LÍNEA DE LA LIQUIDACIÓN NOMBRA SU ORIGEN. `settlement_lines` estrena
--    `manual_adjustment_id`, igual que 0021 estrenó `recurring_supplement_id`:
--    una línea 'adjustment' sin fila que la justifique sería un importe sin
--    padre en un documento que promete que cada número dice de dónde sale.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE app.manual_adjustment_status AS ENUM ('recorded', 'voided');

CREATE TABLE app.manual_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  -- Mes al que se imputa DE VERDAD, normalizado al día 1. Un mes y no una fecha
  -- porque la unidad de la cuenta es el mes: «que se contabilice en abril» no
  -- dice nada de un día concreto de abril.
  period_month date NOT NULL CHECK (date_part('day', period_month) = 1),
  -- Mes que se pidió. Igual al anterior salvo cuando aquel ya estaba cerrado.
  requested_period_month date NOT NULL CHECK (date_part('day', requested_period_month) = 1),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  -- El motivo NO es opcional: un importe suelto sin explicación es exactamente
  -- lo que convierte una cuenta en una discusión.
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  -- Con signo: positivo suma (gratificación), negativo resta (descuento
  -- acordado). Cero no es un concepto, es un olvido.
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  -- Misma semántica que `app.recurring_supplements.adds_to_pay`.
  adds_to_pay boolean NOT NULL,
  deferral_note text NOT NULL DEFAULT '' CHECK (length(deferral_note) <= 300),
  status app.manual_adjustment_status NOT NULL DEFAULT 'recorded',
  recorded_by_membership_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  voided_by_membership_id uuid,
  voided_at timestamptz,
  void_reason text,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, recorded_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, voided_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  -- Un concepto se aplaza hacia adelante o no se aplaza. Nunca hacia atrás:
  -- imputar a un mes anterior al pedido sería colarlo en una cuenta que ya
  -- pudo haberse enseñado.
  CHECK (period_month >= requested_period_month),
  -- La nota del aplazamiento existe exactamente cuando hay aplazamiento.
  CHECK (
    (period_month = requested_period_month AND deferral_note = '')
    OR (period_month > requested_period_month AND length(btrim(deferral_note)) > 0)
  ),
  -- Misma pareja de estados que `app.payments`: anular exige autoría, instante
  -- y motivo no vacío; una fila 'recorded' no puede llevar rastro de anulación.
  CHECK (
    (status = 'recorded' AND voided_by_membership_id IS NULL AND voided_at IS NULL
      AND void_reason IS NULL)
    OR (status = 'voided' AND voided_by_membership_id IS NOT NULL AND voided_at IS NOT NULL
      AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
  )
);

COMMENT ON TABLE app.manual_adjustments IS
  'Conceptos apuntados a mano e imputados a un mes concreto. Append-only: se corrige anulando, nunca borrando ni reescribiendo.';
COMMENT ON COLUMN app.manual_adjustments.period_month IS
  'Mes al que se imputa de verdad (día 1). Nunca puede ser un mes con la liquidación ya cerrada.';
COMMENT ON COLUMN app.manual_adjustments.requested_period_month IS
  'Mes que pidió quien lo apuntó. Distinto de period_month solo cuando aquel ya estaba cerrado.';
COMMENT ON COLUMN app.manual_adjustments.adds_to_pay IS
  'true: el importe (con su signo) entra en la transferencia del mes. false: consta en el expediente y no la toca — el dinero se movió por otro sitio.';
COMMENT ON COLUMN app.manual_adjustments.deferral_note IS
  'Frase congelada que explica por qué el concepto no cayó en el mes pedido. Vacía cuando no hubo aplazamiento.';

CREATE INDEX manual_adjustments_period_idx
  ON app.manual_adjustments (household_id, agreement_id, period_month)
  WHERE status = 'recorded';

-- ── Una cuenta cerrada no se reescribe ──────────────────────────────────────
/*
 * Cierre de mes y apunte a mano se serializan con un cerrojo consultivo por
 * (acuerdo, mes). Espacio de nombres 5, nuevo: 0 versiones del acuerdo y
 * recibos, 1 libro de compensación, 2 libro de anticipos, 3 transiciones de
 * jornada extra, 4 vacaciones, 7 revisiones de la guía.
 *
 * Sin él quedaría una carrera pequeña pero real: dos transacciones simultáneas
 * —una que cierra marzo, otra que apunta un concepto a marzo— pueden leer cada
 * una el estado anterior de la otra y confirmar las dos. El resultado sería una
 * fila que dice «imputado a marzo» y una cuenta de marzo cerrada sin ella: el
 * expediente mintiendo. El cerrojo lo toman AMBOS lados desde la base de datos,
 * no desde el servidor, para que la garantía no dependa de que quien escriba el
 * comando se acuerde.
 */
CREATE FUNCTION app.lock_settlement_month(
  row_agreement_id uuid,
  month_start date
)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, app
AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended(row_agreement_id::text || ':' || to_char(month_start, 'YYYY-MM'), 5)
  )
$$;

/*
 * Append-only con una única corrección posible: la anulación.
 *
 * · DELETE: siempre rechazado.
 * · UPDATE: solo 'recorded' → 'voided', con TODO lo demás idéntico. Reescribir
 *   el importe, el mes o el motivo bajo una anulación sería reescribir el
 *   pasado.
 * · INSERT y anulación: el mes imputado no puede estar cerrado. Anular un
 *   concepto que ya entró en una cuenta cerrada cambiaría el total de esa
 *   cuenta, que es justo lo que el expediente promete no hacer.
 *
 * La lectura de liquidaciones corre bajo la RLS de quien escribe. Es completa
 * porque escribir está reservado a family_admin (política
 * `manual_adjustments_admin_write`), y esa membresía ve todas las
 * liquidaciones de su hogar: no hay una cuenta cerrada oculta con la que
 * chocar.
 */
CREATE FUNCTION app.enforce_manual_adjustment_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  closed_period record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'manual adjustments are append-only; void them instead of deleting'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'recorded' OR NEW.status <> 'voided' THEN
      RAISE EXCEPTION 'a manual adjustment can only change from recorded to voided'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.household_id IS DISTINCT FROM OLD.household_id
      OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
      OR NEW.employee_membership_id IS DISTINCT FROM OLD.employee_membership_id
      OR NEW.period_month IS DISTINCT FROM OLD.period_month
      OR NEW.requested_period_month IS DISTINCT FROM OLD.requested_period_month
      OR NEW.label IS DISTINCT FROM OLD.label
      OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
      OR NEW.adds_to_pay IS DISTINCT FROM OLD.adds_to_pay
      OR NEW.deferral_note IS DISTINCT FROM OLD.deferral_note
      OR NEW.recorded_by_membership_id IS DISTINCT FROM OLD.recorded_by_membership_id
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
      RAISE EXCEPTION 'voiding a manual adjustment cannot rewrite what it recorded'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM app.lock_settlement_month(NEW.agreement_id, NEW.period_month);

  SELECT settlement.period_start, settlement.period_end
    INTO closed_period
    FROM app.settlements AS settlement
   WHERE settlement.household_id = NEW.household_id
     AND settlement.agreement_id = NEW.agreement_id
     AND settlement.status = 'closed'
     AND settlement.period_start <= (NEW.period_month + interval '1 month - 1 day')::date
     AND settlement.period_end >= NEW.period_month
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'the settlement covering % is already closed', NEW.period_month
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER manual_adjustments_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.manual_adjustments
FOR EACH ROW EXECUTE FUNCTION app.enforce_manual_adjustment_append();

CREATE TRIGGER manual_adjustments_audit
AFTER INSERT OR UPDATE OR DELETE ON app.manual_adjustments
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

/*
 * El otro extremo del cerrojo. Se toma al cerrar, ANTES de que el cierre lea
 * los conceptos del mes, para que un apunte simultáneo espere y encuentre la
 * cuenta ya cerrada (y sea rechazado) en vez de colarse en una lista que el
 * cierre acaba de leer.
 *
 * Va en su propio disparador y no dentro de `enforce_settlement_transition`
 * para no reescribir una función de 0003 que hoy hace otra cosa; el orden entre
 * los dos es indiferente porque el cerrojo dura toda la transacción.
 */
CREATE FUNCTION app.lock_month_on_settlement_close()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    PERFORM app.lock_settlement_month(
      NEW.agreement_id,
      date_trunc('month', NEW.period_start)::date
    );
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER settlements_lock_month_on_close
BEFORE UPDATE ON app.settlements
FOR EACH ROW EXECUTE FUNCTION app.lock_month_on_settlement_close();

-- ── La línea de la liquidación nombra su origen ─────────────────────────────
ALTER TABLE app.settlement_lines
  ADD COLUMN manual_adjustment_id uuid;

ALTER TABLE app.settlement_lines
  ADD CONSTRAINT settlement_lines_manual_adjustment_fkey
  FOREIGN KEY (household_id, manual_adjustment_id)
  REFERENCES app.manual_adjustments(household_id, id) ON DELETE RESTRICT;

COMMENT ON COLUMN app.settlement_lines.manual_adjustment_id IS
  'Concepto apuntado a mano que justifica una línea de ajuste, como recurring_supplement_id justifica la de complemento.';

/*
 * Se reescribe la comprobación de procedencia que 0021 dejó con nombre. La
 * novedad es que 'adjustment' EXIGE su concepto: una línea de ajuste sin fila
 * detrás es un importe sin padre, y hasta ahora era posible porque nadie
 * emitía líneas de ese tipo. Las demás clases exigen que la columna nueva vaya
 * vacía, para que un ajuste no pueda disfrazarse de complemento ni al revés.
 */
ALTER TABLE app.settlement_lines DROP CONSTRAINT settlement_lines_provenance_by_kind;
ALTER TABLE app.settlement_lines ADD CONSTRAINT settlement_lines_provenance_by_kind CHECK (
  (kind = 'base_salary' AND agreement_version_id IS NOT NULL
    AND extra_work_event_id IS NULL AND advance_ledger_entry_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL AND manual_adjustment_id IS NULL)
  OR (kind IN ('extra_work', 'time_off_compensation') AND extra_work_event_id IS NOT NULL
    AND advance_ledger_entry_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL AND manual_adjustment_id IS NULL)
  OR (kind = 'advance_deduction' AND advance_ledger_entry_id IS NOT NULL
    AND agreement_version_id IS NULL AND extra_work_event_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL AND manual_adjustment_id IS NULL)
  OR (kind = 'expense_reimbursement' AND expense_id IS NOT NULL
    AND agreement_version_id IS NULL AND extra_work_event_id IS NULL
    AND advance_ledger_entry_id IS NULL AND recurring_supplement_id IS NULL
    AND manual_adjustment_id IS NULL)
  OR (kind = 'adjustment' AND manual_adjustment_id IS NOT NULL
    AND agreement_version_id IS NULL AND extra_work_event_id IS NULL
    AND advance_ledger_entry_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL)
  OR (kind NOT IN ('base_salary', 'extra_work', 'time_off_compensation', 'advance_deduction',
                   'expense_reimbursement', 'adjustment')
    AND recurring_supplement_id IS NOT NULL
    AND agreement_version_id IS NULL AND extra_work_event_id IS NULL
    AND advance_ledger_entry_id IS NULL AND expense_id IS NULL
    AND manual_adjustment_id IS NULL)
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE app.manual_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.manual_adjustments FORCE ROW LEVEL SECURITY;

/*
 * Lo ve quien administra y LA PROPIA EMPLEADA. Es dinero suyo (o dinero que
 * alguien ha decidido sobre su cuenta), así que ocultárselo sería exactamente
 * el tipo de opacidad que esta aplicación existe para evitar.
 *
 * `family_member` NO entra, igual que en `settlements_read` de 0005: los
 * importes se quedan en quien administra y la interesada.
 */
CREATE POLICY manual_adjustments_read ON app.manual_adjustments
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, false));

-- Escribe (apunta y anula) solo la familia administradora, la misma que cierra
-- liquidaciones y resuelve gastos.
CREATE POLICY manual_adjustments_admin_write ON app.manual_adjustments
  FOR ALL USING (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );

-- Sin DELETE en el GRANT: aunque alguien escribiera una política permisiva por
-- error, el rol de la aplicación no tiene el privilegio de borrar.
GRANT SELECT, INSERT, UPDATE ON app.manual_adjustments TO casa_clara_app;

COMMIT;
