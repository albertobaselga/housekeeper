BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- El salto de año de vacaciones: qué se hace con los días que no se
-- disfrutaron.
--
-- Apartado 4.3 de docs/ux/contrato-feedback-v2.md. Hasta hoy el derecho se
-- reiniciaba por aritmética (`remainingDays = entitledDays − takenDays` sobre
-- un año) y no había NINGUNA fila donde constara qué se decidió: la casa no
-- podía distinguir «se acordó que se perdían» de «a nadie se le ocurrió
-- mirarlo». En una aplicación cuyo argumento entero es que el expediente no
-- miente, eso era el hueco más caro que quedaba.
--
-- TABLA NUEVA, NO COLUMNAS EN LAS QUE YA HAY. Un arrastre no es un periodo
-- disfrutado (`app.vacation_periods` guarda días que se cogieron) ni es lo
-- pactado (`app.agreement_versions`, que además es inmutable). Es un HECHO con
-- decisión, autoría, motivo y consecuencia económica, y por eso se construye
-- con el mismo patrón append-only que los periodos (0020) y los conceptos
-- (0022): disparador que prohíbe el DELETE, transiciones de estado tasadas,
-- auditoría y cerrojo consultivo.
--
-- TAMPOCO se reutiliza la marca de agua de vacaciones (0028). Aquella guarda un
-- instante que se pisa a sí mismo, sin auditoría, y el ADR prohíbe leerla como
-- conformidad. Colar aquí una decisión sobre dinero insinuaría una aprobación
-- que el propio ADR dice que no existe.
--
-- Cinco decisiones que merecen explicación:
--
-- 1. LOS DÍAS VAN CONGELADOS. `entitled_days`, `taken_days`, `unused_days`, el
--    año de contrato con sus fechas y la versión del acuerdo se escriben al
--    decidir y no se recalculan NUNCA al leer. Si en marzo se anula un periodo
--    del año anterior, la propuesta que alguien vio y decidió no puede cambiar
--    debajo. Es el mismo criterio que `deferral_note` en 0022 y que las tarifas
--    congeladas de la jornada extra.
--
-- 2. EL IMPORTE PUEDE NO EXISTIR, Y ESO SE DICE. `compensation_cents` es
--    NULLABLE porque el precio del día de vacaciones no disfrutado se PACTA
--    (columna `unused_vacation_day_rate_cents` de la 0034) y los contratos
--    firmados antes no lo pactaron. Sin tarifa se puede arrastrar o rechazar,
--    pero no compensar: un cero diría que se acordó pagar cero euros, que es
--    falso. El importe viaja siempre con la frase que lo explica.
--
-- 3. LA FILA SE ESCRIBE AL DECIDIR. La propuesta se calcula en LECTURA desde
--    los periodos, que sí son append-only, así que no hace falta ni un trabajo
--    periódico ni un disparador por calendario —ninguno de los dos existe hoy—.
--    El estado 'proposed' y los pasos automáticos ('expired') quedan definidos y
--    guardados por el disparador para el día que se materialicen desde la cola:
--    la puerta se cierra ahora, no cuando alguien la abra con prisa.
--
-- 4. EL CERROJO CONSULTIVO VA EN EL ESPACIO DE NOMBRES 6. Verificado libre: 0
--    versiones del acuerdo y recibos, 1 libro de compensación, 2 anticipos, 3
--    jornada extra, 4 vacaciones, 5 cierre de mes, 7 revisiones de la guía. No
--    se reutiliza el 4 ni el 5 para no serializar de más. Sin él, dos
--    administradores aceptando a la vez generarían dos conceptos por los mismos
--    días.
--
-- 5. LA CADENA DE PROCEDENCIA SE CIERRA POR LOS DOS EXTREMOS.
--    `app.manual_adjustments` estrena `vacation_carryover_id`, y con ella hay
--    que REESCRIBIR `app.enforce_manual_adjustment_append`, que enumera columna
--    a columna lo que no se puede cambiar al anular: sin tocarlo, la anulación
--    podría colar un cambio en la columna nueva.
--
-- POR QUÉ `FORCE ROW LEVEL SECURITY` VA AL FINAL DEL FICHERO. Sobre una tabla
-- forzada, un propietario sin BYPASSRLS (Supabase, y el rol con el que se ha
-- ensayado esta migración) queda sometido a sus propias políticas, y entonces
-- cualquier función `SECURITY DEFINER` que nombre la tabla falla ya en el
-- CREATE. Una migración de este repositorio fue imposible de aplicar en
-- producción por ponerlo antes, y fallaba en silencio. Aquí va al final, después
-- de todo lo demás.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE app.vacation_carryover_status AS ENUM
  ('proposed', 'carried', 'compensated', 'rejected', 'expired');

CREATE TABLE app.vacation_carryovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  employee_membership_id uuid NOT NULL,

  -- El año de CONTRATO que se cierra, no un año natural: desde la segunda
  -- vuelta del diseño el año de vacaciones son los doce meses contados desde el
  -- día en que empezó el acuerdo. Se guardan el ordinal Y sus fechas porque el
  -- ordinal a secas no identifica nada para quien lo lea dentro de dos años, y
  -- porque las fechas son lo que hace la fila comprobable sin recalcular el
  -- calendario del contrato.
  source_year_index integer NOT NULL CHECK (source_year_index BETWEEN 1 AND 200),
  source_year_starts_on date NOT NULL,
  source_year_ends_on date NOT NULL,

  -- ── Congelados al decidir. Ver la nota 1 de la cabecera. ──────────────────
  entitled_days integer NOT NULL CHECK (entitled_days >= 0),
  taken_days integer NOT NULL CHECK (taken_days >= 0),
  unused_days integer NOT NULL CHECK (unused_days > 0),
  -- La versión de la que salió el DERECHO de ese año.
  agreement_version_id uuid NOT NULL,
  -- Importe de la compensación, en céntimos. NULL = la versión vigente al
  -- decidir no pacta tarifa, así que no hay compensación que ofrecer.
  compensation_cents bigint CHECK (compensation_cents >= 0),
  -- Frase congelada que explica el importe y nombra la versión de la que salió
  -- el precio: «18 días sin disfrutar × 46,15 € por día, pactados en las
  -- condiciones vigentes desde el 5 de marzo de 2026 = 830,70 €». Es lo que
  -- hace la cifra verificable cuando la tarifa haya cambiado tres veces.
  compensation_basis text CHECK (length(btrim(compensation_basis)) BETWEEN 1 AND 300),
  -- Hasta cuándo se pueden disfrutar los días arrastrados. NULL cuando la
  -- política pactada dice que nunca expiran, y ese NULL es una respuesta, no un
  -- hueco por rellenar.
  deadline_on date,

  status app.vacation_carryover_status NOT NULL DEFAULT 'proposed',
  proposed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  decided_by_membership_id uuid,
  decided_at timestamptz,
  -- Obligatorio al rechazar, como todo motivo de este repositorio: perder días
  -- sin decir por qué es exactamente lo que esta tabla existe para impedir.
  decision_reason text CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 500),
  -- El vencimiento no lo decide nadie, así que no cabe en `decided_*`.
  expired_at timestamptz,
  -- El concepto que materializó el pago. Cierra la cadena de procedencia.
  manual_adjustment_id uuid,

  UNIQUE (household_id, id),
  -- Un año de contrato se cierra UNA vez. Es la mitad de la garantía contra el
  -- pago doble; la otra mitad es el cerrojo consultivo del disparador.
  UNIQUE (household_id, agreement_id, source_year_index),
  FOREIGN KEY (household_id, agreement_id)
    REFERENCES app.employment_agreements(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, employee_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, decided_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  -- Tres columnas y no dos: así la versión congelada no puede ser la de OTRO
  -- acuerdo del mismo hogar.
  FOREIGN KEY (household_id, agreement_version_id, agreement_id)
    REFERENCES app.agreement_versions(household_id, id, agreement_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, manual_adjustment_id)
    REFERENCES app.manual_adjustments(household_id, id) ON DELETE RESTRICT,

  CHECK (source_year_ends_on > source_year_starts_on),
  CHECK (unused_days = entitled_days - taken_days),
  CHECK (deadline_on IS NULL OR deadline_on > source_year_ends_on),
  -- El importe y su explicación viajan juntos o no viajan: una cifra sin frase
  -- es un número sin padre, y una frase sin cifra no explica nada.
  CHECK ((compensation_cents IS NULL) = (compensation_basis IS NULL)),
  CHECK ((status = 'proposed') = (decided_at IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by_membership_id IS NULL)),
  -- Una propuesta todavía no tiene motivo; un rechazo no puede no tenerlo.
  CHECK (status <> 'proposed' OR decision_reason IS NULL),
  CHECK (status <> 'rejected' OR decision_reason IS NOT NULL),
  -- Compensar es pagar: exige el concepto y exige el importe. Y ningún otro
  -- estado puede llevar concepto, para que un arrastre rechazado no arrastre
  -- dinero detrás.
  CHECK ((status = 'compensated') = (manual_adjustment_id IS NOT NULL)),
  CHECK (status <> 'compensated' OR compensation_cents IS NOT NULL),
  CHECK ((status = 'expired') = (expired_at IS NOT NULL))
);

COMMENT ON TABLE app.vacation_carryovers IS
  'Qué se decidió con los días de vacaciones sin disfrutar al cerrar un año de CONTRATO: arrastrarlos, compensarlos en dinero o perderlos con su motivo. Append-only: los días, el año y el importe van congelados y no se recalculan al leer.';
COMMENT ON COLUMN app.vacation_carryovers.source_year_index IS
  'Año de contrato que se cierra: 1 el primero, 2 el segundo. No es un año natural.';
COMMENT ON COLUMN app.vacation_carryovers.compensation_cents IS
  'Importe congelado de la compensación, en céntimos. NULL cuando la versión vigente al decidir no pacta el precio del día: sin tarifa no se estima nada.';
COMMENT ON COLUMN app.vacation_carryovers.deadline_on IS
  'Último día para disfrutar los días arrastrados. NULL = la política pactada dice que nunca expiran.';
COMMENT ON COLUMN app.vacation_carryovers.manual_adjustment_id IS
  'Concepto a mano que materializó el pago de la compensación. Es la mitad de la cadena; la otra es manual_adjustments.vacation_carryover_id.';

-- Un mismo concepto no puede cerrar dos arrastres: sería pagar dos veces con un
-- solo apunte, y la cuenta cuadraría igual.
CREATE UNIQUE INDEX vacation_carryovers_adjustment_idx
  ON app.vacation_carryovers (household_id, manual_adjustment_id)
  WHERE manual_adjustment_id IS NOT NULL;

-- Los arrastres vivos de un acuerdo, que es lo que preguntan la pestaña de
-- Vacaciones y la línea de decisión de Hoy.
CREATE INDEX vacation_carryovers_agreement_idx
  ON app.vacation_carryovers (household_id, agreement_id, source_year_index);

/*
 * Append-only con las transiciones tasadas del apartado 4.3:
 *
 *   proposed → carried | compensated | rejected      (lo decide quien administra)
 *   carried  → compensated | expired                 (pagar más tarde, o vencer)
 *
 * · DELETE: siempre rechazado. Una decisión sobre días y dinero no se borra.
 * · UPDATE: sólo esas transiciones, y DECIDIR NO REESCRIBE LO PROPUESTO: todas
 *   las columnas congeladas tienen que llegar idénticas, enumeradas una a una.
 *   Es la misma lista exhaustiva que usan 0020 y 0022, y por el mismo motivo:
 *   una columna que se olvide es una columna editable dentro de una fila que se
 *   declara inmutable.
 * · INSERT y UPDATE: cerrojo consultivo por (acuerdo, año de contrato) en el
 *   espacio de nombres 6, para que dos decisiones simultáneas sobre los mismos
 *   días no generen dos pagos.
 */
CREATE FUNCTION app.enforce_vacation_carryover_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vacation carryovers are append-only; decide them instead of deleting'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      (OLD.status = 'proposed' AND NEW.status IN ('carried', 'compensated', 'rejected'))
      OR (OLD.status = 'carried' AND NEW.status IN ('compensated', 'expired'))
    ) THEN
      RAISE EXCEPTION 'a vacation carryover cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = '55000';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.household_id IS DISTINCT FROM OLD.household_id
      OR NEW.agreement_id IS DISTINCT FROM OLD.agreement_id
      OR NEW.employee_membership_id IS DISTINCT FROM OLD.employee_membership_id
      OR NEW.source_year_index IS DISTINCT FROM OLD.source_year_index
      OR NEW.source_year_starts_on IS DISTINCT FROM OLD.source_year_starts_on
      OR NEW.source_year_ends_on IS DISTINCT FROM OLD.source_year_ends_on
      OR NEW.entitled_days IS DISTINCT FROM OLD.entitled_days
      OR NEW.taken_days IS DISTINCT FROM OLD.taken_days
      OR NEW.unused_days IS DISTINCT FROM OLD.unused_days
      OR NEW.agreement_version_id IS DISTINCT FROM OLD.agreement_version_id
      OR NEW.compensation_cents IS DISTINCT FROM OLD.compensation_cents
      OR NEW.compensation_basis IS DISTINCT FROM OLD.compensation_basis
      OR NEW.deadline_on IS DISTINCT FROM OLD.deadline_on
      OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
      RAISE EXCEPTION 'deciding a vacation carryover cannot rewrite what it proposed'
        USING ERRCODE = '55000';
    END IF;
    -- Lo ya decidido tampoco se reescribe al vencer o al pagar más tarde: quien
    -- arrastró los días sigue siendo quien los arrastró.
    IF OLD.status <> 'proposed' AND (
      NEW.decided_by_membership_id IS DISTINCT FROM OLD.decided_by_membership_id
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
      OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
    ) THEN
      RAISE EXCEPTION 'a decided vacation carryover cannot rewrite who decided it'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.agreement_id::text || ':' || NEW.source_year_index::text, 6)
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER vacation_carryovers_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.vacation_carryovers
FOR EACH ROW EXECUTE FUNCTION app.enforce_vacation_carryover_append();

-- Aquí SÍ hay auditoría, al revés que en la marca de agua de 0028: esto es una
-- decisión sobre días y sobre dinero, y el rastro es el objetivo.
CREATE TRIGGER vacation_carryovers_audit
AFTER INSERT OR UPDATE OR DELETE ON app.vacation_carryovers
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

-- ── El otro extremo de la cadena: el concepto nombra su arrastre ────────────
ALTER TABLE app.manual_adjustments
  ADD COLUMN vacation_carryover_id uuid;

/*
 * DEFERRABLE INITIALLY DEFERRED, y no por comodidad: las dos filas se apuntan
 * la una a la otra. El concepto no puede nacer sin su arrastre (esta clave) y
 * el arrastre 'compensated' no puede nacer sin su concepto (la CHECK de
 * arriba), así que en una transacción normal una de las dos tendría que
 * mentir un instante. Aplazar la comprobación al COMMIT deja escribir el par
 * completo y sigue rechazando cualquier huérfano: lo que se relaja es CUÁNDO se
 * comprueba, no QUÉ.
 */
ALTER TABLE app.manual_adjustments
  ADD CONSTRAINT manual_adjustments_vacation_carryover_fkey
  FOREIGN KEY (household_id, vacation_carryover_id)
  REFERENCES app.vacation_carryovers(household_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

COMMENT ON COLUMN app.manual_adjustments.vacation_carryover_id IS
  'Arrastre de vacaciones que originó este concepto, cuando lo hay. Sin él, «Vacaciones del segundo año no disfrutadas» sería indistinguible de una gratificación cualquiera.';

/*
 * Se REESCRIBE el disparador de 0022 para incluir la columna nueva en la lista
 * de lo que la anulación no puede tocar. El resto del cuerpo es idéntico al de
 * aquella migración; si no se hiciera, un UPDATE de anulación podría cambiar de
 * paso a qué arrastre apunta el concepto, y con eso mover un pago de un año a
 * otro sin dejar rastro.
 */
CREATE OR REPLACE FUNCTION app.enforce_manual_adjustment_append()
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
      OR NEW.vacation_carryover_id IS DISTINCT FROM OLD.vacation_carryover_id
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

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE app.vacation_carryovers ENABLE ROW LEVEL SECURITY;

/*
 * Lo ve quien administra y LA PROPIA EMPLEADA, con el mismo tercer argumento
 * `false` que `manual_adjustments_read` (0022) y NO el `true` de
 * `vacation_periods_read` (0020): la fila lleva importe, y los importes de esta
 * casa no llegan a la familia no administradora. Elegir `true` aquí sería una
 * fuga silenciosa, y hay precedente de las dos formas en 0005.
 */
CREATE POLICY vacation_carryovers_read ON app.vacation_carryovers
  FOR SELECT USING (app.employee_row_visible(household_id, employee_membership_id, false));

-- Decide quien administra la casa, como todo lo demás del contrato. La empleada
-- lo ve, no lo decide: es coherente con la decisión ya tomada en el ADR de
-- vacaciones de que no hay flujo de aprobación por su parte.
CREATE POLICY vacation_carryovers_admin_write ON app.vacation_carryovers
  FOR ALL USING (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  ) WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );

-- Sin DELETE en el GRANT: aunque alguien escribiera una política permisiva por
-- error, el rol de la aplicación no tiene el privilegio de borrar.
GRANT SELECT, INSERT, UPDATE ON app.vacation_carryovers TO casa_clara_app;

-- ── Aserción: lo que esta migración promete, comprobado ──────────────────────
DO $check$
DECLARE
  cuerpo text;
BEGIN
  -- El olvido que costaría caro: que el disparador de los conceptos siga sin
  -- enumerar la columna nueva. Se comprueba sobre el cuerpo real de la función
  -- instalada, no sobre la intención de quien la escribió.
  SELECT prosrc INTO cuerpo
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'enforce_manual_adjustment_append';
  IF cuerpo IS NULL OR cuerpo NOT LIKE '%NEW.vacation_carryover_id IS DISTINCT FROM OLD.vacation_carryover_id%' THEN
    RAISE EXCEPTION 'la anulación de un concepto todavía podría reescribir su arrastre';
  END IF;

  -- El cerrojo consultivo tiene que estar en el espacio 6, no en el 4 de
  -- vacaciones ni en el 5 del cierre de mes: reutilizarlos serializaría de más
  -- y el fallo sería invisible.
  SELECT prosrc INTO cuerpo
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app' AND p.proname = 'enforce_vacation_carryover_append';
  IF cuerpo IS NULL OR cuerpo NOT LIKE '%, 6)%' THEN
    RAISE EXCEPTION 'el arrastre no toma el cerrojo consultivo del espacio 6';
  END IF;

  -- Nadie puede borrar una decisión, ni siquiera con una política equivocada.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'app' AND table_name = 'vacation_carryovers'
       AND grantee = 'casa_clara_app' AND privilege_type = 'DELETE'
  ) THEN
    RAISE EXCEPTION 'casa_clara_app tiene DELETE sobre los arrastres de vacaciones';
  END IF;
END
$check$;

/*
 * FORCE al FINAL, después de todo lo demás. Ver la nota de la cabecera: en un
 * clúster cuyo propietario no puede puentear RLS —Supabase, y el banco con el
 * que se ensaya esta migración— forzarlo antes de crear cualquier función que
 * nombre la tabla haría imposible aplicar el fichero, y el fallo llegaría en
 * silencio.
 */
ALTER TABLE app.vacation_carryovers FORCE ROW LEVEL SECURITY;

COMMIT;
