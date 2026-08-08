BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Vacaciones: derecho anual en el acuerdo + registro de días disfrutados.
--
-- Hasta aquí la app nombraba las vacaciones (`app.compensation_balance_type`
-- incluye 'vacation' desde 0003, y la interfaz tiene la etiqueta «Vacaciones»)
-- pero nadie las guardaba: ni el derecho anual ni un solo día disfrutado. Esta
-- migración cierra ese hueco con las dos piezas mínimas que el hogar necesita:
--
-- 1. `app.agreement_versions.annual_vacation_days` — el derecho pactado, en
--    DÍAS NATURALES por año. Vive en la versión del acuerdo, no en el acuerdo,
--    porque cambiarlo es cambiar lo pactado: igual que el salario, exige una
--    versión nueva (el disparador `agreement_versions_append_only` de 0002 ya
--    rechaza cualquier UPDATE sobre una versión existente). El defecto 30 es el
--    mínimo legal español para el empleo del hogar; las filas ya existentes lo
--    heredan porque es lo que de hecho se les aplicaba.
--
-- 2. `app.vacation_periods` — los días disfrutados, que la familia apunta a
--    mano. Append-only con corrección por ANULACIÓN, igual que `app.payments`
--    de 0003: una fila mal apuntada no se borra ni se reescribe; se anula con
--    autoría, instante y motivo, y sigue en el expediente. El saldo solo cuenta
--    las filas 'recorded'.
--
-- Lo que esta migración NO hace, a propósito: no crea cuenta ni asientos en
-- `app.compensation_ledger_entries` para las vacaciones. Ese libro mide MINUTOS
-- de tiempo compensable con caducidad y origen (jornada extra resuelta como
-- descanso); las vacaciones son días naturales de derecho anual que se
-- reinician cada 1 de enero. Meterlas ahí obligaría a inventar una conversión
-- día→minutos que no significa nada. El saldo de vacaciones se calcula en
-- lectura desde el derecho de la versión vigente y los periodos apuntados.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Derecho anual en la versión del acuerdo ──────────────────────────────
ALTER TABLE app.agreement_versions
  ADD COLUMN annual_vacation_days integer NOT NULL DEFAULT 30
    CHECK (annual_vacation_days BETWEEN 0 AND 365);

COMMENT ON COLUMN app.agreement_versions.annual_vacation_days IS
  'Días naturales de vacaciones por año natural pactados en esta versión del acuerdo.';

-- ── 2. Registro de días disfrutados ─────────────────────────────────────────
CREATE TYPE app.vacation_period_status AS ENUM ('recorded', 'voided');

CREATE TABLE app.vacation_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  -- Días NATURALES, extremos incluidos: del 1 al 15 de agosto son 15 días, no
  -- 14. Se almacena calculado para que el saldo no dependa de que cada lector
  -- recuerde el «+ 1».
  calendar_days integer NOT NULL GENERATED ALWAYS AS ((ends_on - starts_on) + 1) STORED,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  status app.vacation_period_status NOT NULL DEFAULT 'recorded',
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
  CHECK (ends_on >= starts_on),
  -- Un periodo de más de un año no es un periodo de vacaciones: es un error de
  -- tecleo que envenenaría el saldo de varios años a la vez.
  CHECK (ends_on - starts_on <= 365),
  -- Misma pareja de estados que `app.payments`: anular exige autoría, instante
  -- y motivo no vacío; una fila 'recorded' no puede llevar rastro de anulación.
  CHECK (
    (status = 'recorded' AND voided_by_membership_id IS NULL AND voided_at IS NULL
      AND void_reason IS NULL)
    OR (status = 'voided' AND voided_by_membership_id IS NOT NULL AND voided_at IS NOT NULL
      AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
  )
);

COMMENT ON TABLE app.vacation_periods IS
  'Periodos de vacaciones disfrutados, apuntados a mano por la familia. Append-only: se corrige anulando, nunca borrando ni reescribiendo.';

CREATE INDEX vacation_periods_agreement_idx
  ON app.vacation_periods (household_id, agreement_id, starts_on);

/*
 * Append-only con una única corrección posible: la anulación.
 *
 * · DELETE: siempre rechazado. El expediente no pierde filas.
 * · UPDATE: solo el paso 'recorded' → 'voided'; cualquier otra columna debe
 *   llegar idéntica. Reescribir las fechas de un periodo ya apuntado sería
 *   reescribir el pasado; para corregirlo se anula y se apunta otro.
 * · INSERT: dos periodos vigentes del mismo acuerdo no pueden solaparse. El
 *   cerrojo consultivo serializa las altas concurrentes del mismo acuerdo para
 *   que dos peticiones simultáneas no se cuelen entre la comprobación y la
 *   inserción.
 *
 * La comprobación de solape lee bajo la RLS de quien inserta. Es completa
 * porque escribir está reservado a family_admin (política
 * `vacation_periods_admin_write`), y esa membresía ve TODOS los periodos de su
 * hogar; no hay una fila oculta con la que solapar.
 */
CREATE FUNCTION app.enforce_vacation_period_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vacation periods are append-only; void them instead of deleting'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'recorded' OR NEW.status <> 'voided' THEN
      RAISE EXCEPTION 'a vacation period can only change from recorded to voided'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.household_id IS DISTINCT FROM OLD.household_id
      OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
      OR NEW.employee_membership_id IS DISTINCT FROM OLD.employee_membership_id
      OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
      OR NEW.ends_on IS DISTINCT FROM OLD.ends_on
      OR NEW.note IS DISTINCT FROM OLD.note
      OR NEW.recorded_by_membership_id IS DISTINCT FROM OLD.recorded_by_membership_id
      OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
      RAISE EXCEPTION 'voiding a vacation period cannot rewrite what it recorded'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Espacio de nombres 4 del cerrojo consultivo: 0 versiones del acuerdo y
  -- recibos, 1 libro de compensación, 2 libro de anticipos, 3 transiciones de
  -- jornada extra, 7 revisiones de la guía.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.agreement_id::text, 4));
  IF EXISTS (
    SELECT 1
      FROM app.vacation_periods AS existing
     WHERE existing.household_id = NEW.household_id
       AND existing.agreement_id = NEW.agreement_id
       AND existing.status = 'recorded'
       AND existing.starts_on <= NEW.ends_on
       AND existing.ends_on >= NEW.starts_on
  ) THEN
    RAISE EXCEPTION 'vacation period overlaps another period already recorded'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER vacation_periods_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.vacation_periods
FOR EACH ROW EXECUTE FUNCTION app.enforce_vacation_period_append();

CREATE TRIGGER vacation_periods_audit
AFTER INSERT OR UPDATE OR DELETE ON app.vacation_periods
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

-- ── 3. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE app.vacation_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vacation_periods FORCE ROW LEVEL SECURITY;

-- Lo ve quien administra, la familia y la propia empleada: son SUS vacaciones y
-- el saldo tiene que poder comprobarlo sin pedir permiso. Apoyo y visor, no.
CREATE POLICY vacation_periods_read ON app.vacation_periods
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, true));

-- Escribe (apunta y anula) solo la familia administradora, la misma que
-- resuelve gastos y cierra liquidaciones. La empleada NO escribe: el propietario
-- decidió que los días los apunta la familia, sin flujo de solicitud.
CREATE POLICY vacation_periods_admin_write ON app.vacation_periods
  FOR ALL USING (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );

GRANT SELECT, INSERT, UPDATE ON app.vacation_periods TO casa_clara_app;

COMMIT;
