BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Catálogo de condiciones por versión del acuerdo.
--
-- Hasta aquí lo pactable vivía en cinco columnas fijas de
-- `app.agreement_versions`: salario, tarifa/hora, tarifa de día de descanso,
-- minutos de crédito y jornada semanal. Eso bastaba mientras solo hubiera dos
-- clases de trabajo extra cableadas en el enum `app.extra_work_kind`. No basta
-- para lo que el hogar necesita de verdad:
--
--   · «quedarse una noche de guardia serán 50 €» — un importe fijo por supuesto,
--     que no es ni una hora ni una jornada;
--   · «una cantidad fija por un número de horas concreto» — una jornada extra
--     con duración de referencia;
--   · complementos recurrentes (antigüedad, seguro médico) que hoy no existen;
--   · y, sobre todo, poder DESACTIVAR lo que no aplica: si a una empleada no se
--     le permiten horas extra, la tarifa horaria no debe existir para ella.
--
-- Esta migración añade dos catálogos colgados de la VERSIÓN del acuerdo, no del
-- acuerdo. Es la misma decisión que tomó 0020 con `annual_vacation_days`, y por
-- la misma razón: cambiar una tarifa es cambiar lo pactado, así que exige una
-- versión nueva. Como la versión es inmutable (trigger
-- `agreement_versions_append_only` de 0002), sus conceptos también lo son: aquí
-- solo se INSERTA. Modificar una tarifa, desactivar un tipo o retirar un
-- complemento se hace apilando una versión nueva con su catálogo. Esa es toda
-- la garantía de congelación: la fila que valoró un hecho no se puede reescribir
-- nunca, ni por la interfaz de administración ni por la base de datos.
--
--   1. `app.extra_work_types` — qué trabajo extra existe y a cuánto se paga.
--      Unidad `per_hour` | `per_shift` | `fixed_amount`, tarifa en céntimos
--      (NULL = «aún no tiene tarifa»), duración de referencia opcional para la
--      «jornada de X horas», y `active` como interruptor de permiso: `active`
--      es exactamente «permito a esta empleada hacer esto».
--
--   2. `app.recurring_supplements` — complementos periódicos, con la distinción
--      que decide si la cuenta del mes miente o no: `adds_to_pay`. La antigüedad
--      es dinero para ella y suma a la transferencia; el seguro médico lo paga
--      la casa por su cuenta y solo debe CONSTAR como condición pactada. Meter
--      los dos en el total inflaría la transferencia con dinero que nadie
--      transfiere.
--
-- La regla de visibilidad se impone en la RLS, no en la plantilla: la política
-- de la empleada filtra por `active AND rate_cents IS NOT NULL`. Lo que no le
-- aplica no llega a la aplicación, así que tampoco puede llegar al JSON que
-- viaja al navegador ni a los formularios donde registraría ese trabajo. Quien
-- administra sí ve el catálogo entero, porque tiene que poder editarlo.
--
-- Compatibilidad, a propósito: `overtime_hourly_rate_cents` y
-- `worked_rest_day_rate_cents` SE CONSERVAN en `app.agreement_versions`. Ver el
-- comentario al pie de la migración.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Unidades y periodicidades ────────────────────────────────────────────
CREATE TYPE app.extra_work_unit AS ENUM ('per_hour', 'per_shift', 'fixed_amount');

COMMENT ON TYPE app.extra_work_unit IS
  'Cómo se valora un tipo de trabajo extra: por hora trabajada, por jornada (con duración de referencia) o importe fijo por supuesto.';

-- Un solo valor hoy. Es un enum y no un booleano para que añadir 'annual' o
-- 'quarterly' mañana sea una migración de una línea y no un cambio de columna.
CREATE TYPE app.supplement_periodicity AS ENUM ('monthly');

-- ── 2. Tipos de trabajo extra ───────────────────────────────────────────────
CREATE TABLE app.extra_work_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  agreement_version_id uuid NOT NULL,
  -- Identidad estable del concepto A TRAVÉS de las versiones: la «Jornada
  -- extra» de la v3 y la de la v4 comparten código aunque sean filas distintas
  -- con tarifas distintas. Sin él, el historial no podría decir «esto subió de
  -- 45 € a 50 €», solo «apareció un concepto y desapareció otro».
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,38}[a-z0-9]$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  unit app.extra_work_unit NOT NULL,
  -- NULL es «pactado pero sin tarifa todavía», y la RLS lo trata como
  -- inexistente para la empleada: no se le puede enseñar un derecho cuyo precio
  -- nadie ha fijado.
  rate_cents bigint CHECK (rate_cents IS NULL OR rate_cents >= 0),
  -- «Jornada de X horas». Una semana entera (10080 min) es el techo: por encima
  -- ya no es una jornada, es un error de tecleo.
  reference_minutes integer
    CHECK (reference_minutes IS NULL OR (reference_minutes > 0 AND reference_minutes <= 10080)),
  -- El interruptor de permiso. `false` = «a esta empleada no le dejo hacer
  -- esto», y entonces la RLS se lo oculta por completo.
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, agreement_version_id, code),
  -- Pareja que permite a `app.extra_work_events` referirse a un tipo Y exigir
  -- que pertenezca a la versión que congeló el hecho.
  UNIQUE (household_id, id, agreement_version_id),
  FOREIGN KEY (household_id, agreement_version_id, agreement_id)
    REFERENCES app.agreement_versions(household_id, id, agreement_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  -- Una tarifa por hora no tiene duración de referencia: la duración la pone el
  -- hecho. Una jornada sí la necesita, porque «jornada» sin horas no dice nada.
  CHECK (unit <> 'per_hour' OR reference_minutes IS NULL),
  CHECK (unit <> 'per_shift' OR reference_minutes IS NOT NULL)
);

COMMENT ON TABLE app.extra_work_types IS
  'Catálogo de trabajo extra congelado en una versión del acuerdo. Solo INSERT: cambiar una tarifa exige apilar una versión nueva.';
COMMENT ON COLUMN app.extra_work_types.active IS
  'Permiso, no adorno: si es false la empleada no ve el tipo ni su tarifa por ninguna vía (la RLS lo filtra).';
COMMENT ON COLUMN app.extra_work_types.rate_cents IS
  'NULL = sin tarifa pactada. La RLS lo oculta a la empleada igual que un tipo desactivado.';

CREATE INDEX extra_work_types_version_idx
  ON app.extra_work_types (household_id, agreement_version_id, sort_order);

-- ── 3. Complementos recurrentes ─────────────────────────────────────────────
CREATE TABLE app.recurring_supplements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  agreement_version_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,38}[a-z0-9]$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  amount_cents bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  periodicity app.supplement_periodicity NOT NULL DEFAULT 'monthly',
  -- LA columna de esta tabla. true: dinero para ella, entra en el total del mes.
  -- false: gasto que asume la casa (seguro médico); consta como condición
  -- pactada y NO toca la transferencia.
  adds_to_pay boolean NOT NULL,
  -- Vigencia dentro de la versión: un complemento puede empezar más tarde que
  -- la versión que lo pactó, o acabar antes que ella.
  starts_on date,
  ends_on date,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, agreement_version_id, code),
  FOREIGN KEY (household_id, agreement_version_id, agreement_id)
    REFERENCES app.agreement_versions(household_id, id, agreement_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);

COMMENT ON TABLE app.recurring_supplements IS
  'Complementos periódicos congelados en una versión del acuerdo. Solo INSERT, igual que los tipos de trabajo extra.';
COMMENT ON COLUMN app.recurring_supplements.adds_to_pay IS
  'true: suma a la transferencia del mes. false: lo paga la casa aparte y solo consta como condición; el total del mes no lo incluye.';

CREATE INDEX recurring_supplements_version_idx
  ON app.recurring_supplements (household_id, agreement_version_id, sort_order);

-- ── 4. Inmutabilidad ────────────────────────────────────────────────────────
/*
 * El catálogo hereda la inmutabilidad de la versión que lo contiene. No hay
 * corrección «en sitio» ni anulación: la corrección es una versión nueva, que
 * el historial enseña al lado de la anterior. Es más estricto que
 * `app.vacation_periods` (que sí admite anular) porque un periodo apuntado es
 * un hecho que puede estar mal tecleado, mientras que una tarifa es un ACUERDO:
 * si cambia, cambió en una fecha, y esa fecha es la de la versión nueva.
 */
CREATE FUNCTION app.reject_agreement_catalogue_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION
    '% is frozen with its agreement version; stack a new version instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER extra_work_types_frozen
BEFORE UPDATE OR DELETE ON app.extra_work_types
FOR EACH ROW EXECUTE FUNCTION app.reject_agreement_catalogue_mutation();

CREATE TRIGGER recurring_supplements_frozen
BEFORE UPDATE OR DELETE ON app.recurring_supplements
FOR EACH ROW EXECUTE FUNCTION app.reject_agreement_catalogue_mutation();

CREATE TRIGGER extra_work_types_audit
AFTER INSERT OR UPDATE OR DELETE ON app.extra_work_types
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

CREATE TRIGGER recurring_supplements_audit
AFTER INSERT OR UPDATE OR DELETE ON app.recurring_supplements
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

-- ── 5. Qué versión rige un día ──────────────────────────────────────────────
/*
 * La versión vigente el día trabajado: la de mayor `effective_from` que no sea
 * posterior a esa fecha. Es la misma regla que `agreementVersionForDate` aplica
 * en el motor puro; aquí vive en SQL porque el disparador del punto 6 la
 * necesita sin salir de la base de datos.
 *
 * Se ejecuta bajo la RLS de quien escribe. No hay agujero: escriben
 * `family_admin` (ve todas las versiones de su hogar) y la propia empleada (ve
 * las de su acuerdo, política `agreement_versions_read`).
 */
CREATE FUNCTION app.agreement_version_in_force(
  row_household_id uuid,
  row_agreement_id uuid,
  on_date date
)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, app
AS $$
  SELECT version.id
    FROM app.agreement_versions AS version
   WHERE version.household_id = row_household_id
     AND version.agreement_id = row_agreement_id
     AND version.effective_from <= on_date
   ORDER BY version.effective_from DESC
   LIMIT 1
$$;

-- ── 6. El hecho nombra su concepto ──────────────────────────────────────────
ALTER TABLE app.extra_work_events
  ADD COLUMN extra_work_type_id uuid;

COMMENT ON COLUMN app.extra_work_events.extra_work_type_id IS
  'Tipo del catálogo que nombra y valora este hecho. NULL solo en el histórico anterior a 0021, que conserva su valoración por `kind`.';

ALTER TABLE app.extra_work_events
  ADD CONSTRAINT extra_work_events_type_fkey
  FOREIGN KEY (household_id, extra_work_type_id)
  REFERENCES app.extra_work_types(household_id, id) ON DELETE RESTRICT;

CREATE INDEX extra_work_events_type_idx
  ON app.extra_work_events (household_id, extra_work_type_id);

/*
 * La congelación, impuesta por la base de datos y no por confianza en el
 * servidor. Cuando un hecho nombra un tipo del catálogo:
 *
 *   · el tipo debe ser del MISMO acuerdo y de la versión vigente EL DÍA
 *     TRABAJADO. Una tarifa aprobada después no puede reescribir lo que valió
 *     aquel día, y una tarifa retirada después tampoco lo desvaloriza;
 *   · el tipo debe estar activo y tener tarifa. Registrar trabajo de un tipo
 *     que no aplica es imposible aunque alguien fabrique la petición a mano;
 *   · al resolver, `resolved_agreement_version_id` tiene que ser la versión del
 *     tipo y `frozen_unit_rate_cents` tiene que ser EXACTAMENTE su tarifa. El
 *     importe congelado ya no puede divergir del catálogo que lo justificó.
 *
 * Los hechos sin tipo (histórico de 0002) pasan sin comprobación: su valoración
 * salió de `overtime_hourly_rate_cents` / `worked_rest_day_rate_cents` y sigue
 * siendo válida. No se reescribe el pasado para estrenar un modelo.
 */
CREATE FUNCTION app.enforce_extra_work_type_freeze()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  chosen record;
  version_that_day uuid;
BEGIN
  -- Sin tipo no hay nada que congelar: es un hecho anterior al catálogo y se
  -- resuelve con las tarifas de 0002. No es un olvido, es el puente de
  -- compatibilidad descrito al pie de esta migración.
  IF NEW.extra_work_type_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT extra_work_type.agreement_id,
         extra_work_type.agreement_version_id,
         extra_work_type.rate_cents,
         extra_work_type.active
    INTO chosen
    FROM app.extra_work_types AS extra_work_type
   WHERE extra_work_type.household_id = NEW.household_id
     AND extra_work_type.id = NEW.extra_work_type_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'extra-work type is not visible in this household'
      USING ERRCODE = '23503';
  END IF;
  IF chosen.agreement_id <> NEW.agreement_id THEN
    RAISE EXCEPTION 'extra-work type belongs to another agreement' USING ERRCODE = '23514';
  END IF;
  IF NOT chosen.active OR chosen.rate_cents IS NULL THEN
    RAISE EXCEPTION 'extra-work type is not available: inactive or without a rate'
      USING ERRCODE = '23514';
  END IF;

  version_that_day := app.agreement_version_in_force(NEW.household_id, NEW.agreement_id, NEW.worked_on);
  IF version_that_day IS DISTINCT FROM chosen.agreement_version_id THEN
    RAISE EXCEPTION 'extra-work type is not the one in force on %', NEW.worked_on
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'resolved' THEN
    IF NEW.resolved_agreement_version_id IS DISTINCT FROM chosen.agreement_version_id THEN
      RAISE EXCEPTION 'a resolved extra-work event must freeze the version of its type'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.frozen_unit_rate_cents IS DISTINCT FROM chosen.rate_cents THEN
      RAISE EXCEPTION 'the frozen unit rate must be the catalogued rate of its type'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER extra_work_events_type_freeze
BEFORE INSERT OR UPDATE ON app.extra_work_events
FOR EACH ROW EXECUTE FUNCTION app.enforce_extra_work_type_freeze();

-- ── 7. El complemento que suma es una línea de la liquidación ───────────────
/*
 * Reutilizar 'adjustment' haría pasar los complementos por correcciones
 * manuales en el recibo, que es justo lo que no son: son condiciones pactadas
 * que se repiten cada mes. Necesitan su propia clase de línea y su propia
 * referencia de procedencia, para que la línea del recibo apunte a la condición
 * que la justifica igual que la de salario apunta a la versión del acuerdo.
 *
 * Los complementos que NO suman no llegan aquí: no son línea de nada, porque
 * ninguna cantidad que la casa paga por su cuenta debe poder colarse en un
 * total. Constan en las condiciones de contrato y en la proyección del mes,
 * fuera de `lines`.
 */
ALTER TYPE app.settlement_line_kind ADD VALUE IF NOT EXISTS 'supplement';

ALTER TABLE app.settlement_lines
  ADD COLUMN recurring_supplement_id uuid;

ALTER TABLE app.settlement_lines
  ADD CONSTRAINT settlement_lines_supplement_fkey
  FOREIGN KEY (household_id, recurring_supplement_id)
  REFERENCES app.recurring_supplements(household_id, id) ON DELETE RESTRICT;

COMMENT ON COLUMN app.settlement_lines.recurring_supplement_id IS
  'Condición pactada que justifica una línea de complemento, como agreement_version_id justifica la de salario.';

/*
 * Las dos comprobaciones de 0003 que enumeraban las clases tienen que admitir
 * la nueva. Se reescriben CON NOMBRE —las de 0003 son anónimas y se llamaban
 * `settlement_lines_check` y `..._check3`— para que la próxima migración que
 * las toque no tenga que adivinar cómo las bautizó Postgres.
 *
 * La rama nueva NO nombra el valor 'supplement' del enum: `ALTER TYPE ... ADD
 * VALUE` prohíbe usar el valor recién añadido en la misma transacción. Se
 * identifica por exclusión de las seis clases anteriores, que es además la
 * forma honesta de decirlo: una línea que no es ninguna de ellas y lleva una
 * condición recurrente detrás.
 */
ALTER TABLE app.settlement_lines DROP CONSTRAINT settlement_lines_check;
ALTER TABLE app.settlement_lines ADD CONSTRAINT settlement_lines_provenance_by_kind CHECK (
  (kind = 'base_salary' AND agreement_version_id IS NOT NULL
    AND extra_work_event_id IS NULL AND advance_ledger_entry_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL)
  OR (kind IN ('extra_work', 'time_off_compensation') AND extra_work_event_id IS NOT NULL
    AND advance_ledger_entry_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL)
  OR (kind = 'advance_deduction' AND advance_ledger_entry_id IS NOT NULL
    AND agreement_version_id IS NULL AND extra_work_event_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL)
  OR (kind = 'expense_reimbursement' AND expense_id IS NOT NULL
    AND agreement_version_id IS NULL AND extra_work_event_id IS NULL
    AND advance_ledger_entry_id IS NULL AND recurring_supplement_id IS NULL)
  OR (kind = 'adjustment' AND agreement_version_id IS NULL AND extra_work_event_id IS NULL
    AND advance_ledger_entry_id IS NULL AND expense_id IS NULL
    AND recurring_supplement_id IS NULL)
  OR (kind NOT IN ('base_salary', 'extra_work', 'time_off_compensation', 'advance_deduction',
                   'expense_reimbursement', 'adjustment')
    AND recurring_supplement_id IS NOT NULL
    AND agreement_version_id IS NULL AND extra_work_event_id IS NULL
    AND advance_ledger_entry_id IS NULL AND expense_id IS NULL)
);

ALTER TABLE app.settlement_lines DROP CONSTRAINT settlement_lines_check3;
ALTER TABLE app.settlement_lines ADD CONSTRAINT settlement_lines_non_negative_credits CHECK (
  (kind NOT IN ('base_salary', 'extra_work', 'expense_reimbursement') AND recurring_supplement_id IS NULL)
  OR amount_cents >= 0
);

-- ── 8. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE app.extra_work_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.extra_work_types FORCE ROW LEVEL SECURITY;
ALTER TABLE app.recurring_supplements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recurring_supplements FORCE ROW LEVEL SECURITY;

-- Quien administra ve y edita el catálogo completo, incluidos los conceptos
-- desactivados y los que aún no tienen tarifa: sin verlos no podría editarlos.
CREATE POLICY extra_work_types_admin_read ON app.extra_work_types
  FOR SELECT USING (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY extra_work_types_admin_insert ON app.extra_work_types
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );

/*
 * La empleada ve SOLO lo que le aplica: su acuerdo, activo y con tarifa. Es la
 * misma frase del propietario convertida en política: «si algo no tiene tarifa,
 * Nuria no lo ve; o si algo no le aplica, tampoco».
 *
 * Vive aquí y no en la plantilla porque la plantilla no es una frontera: una
 * fila filtrada en Svelte ya viajó dentro del JSON de la página. Filtrada en la
 * RLS, la fila no sale de Postgres.
 *
 * `family_member` no entra: como `agreement_versions_read`, el catálogo lleva
 * dinero y se queda en quien administra y la propia interesada.
 */
CREATE POLICY extra_work_types_employee_read ON app.extra_work_types
  FOR SELECT USING (
    active AND rate_cents IS NOT NULL
    AND app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'employee_live_in'
    AND EXISTS (
      SELECT 1 FROM app.employment_agreements AS agreement
       WHERE agreement.household_id = extra_work_types.household_id
         AND agreement.id = extra_work_types.agreement_id
         AND agreement.employee_membership_id = app.current_membership_id()
    )
  );

CREATE POLICY recurring_supplements_admin_read ON app.recurring_supplements
  FOR SELECT USING (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );
CREATE POLICY recurring_supplements_admin_insert ON app.recurring_supplements
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );

-- La empleada ve sus complementos activos con importe, SUMEN O NO a la
-- transferencia: el seguro médico que paga la casa es una condición suya y
-- ocultárselo sería mentir por omisión. Lo que se le oculta es lo desactivado y
-- lo que no tiene importe, igual que en los tipos.
CREATE POLICY recurring_supplements_employee_read ON app.recurring_supplements
  FOR SELECT USING (
    active AND amount_cents IS NOT NULL
    AND app.tenant_context_matches(household_id)
    AND app.current_household_role() = 'employee_live_in'
    AND EXISTS (
      SELECT 1 FROM app.employment_agreements AS agreement
       WHERE agreement.household_id = recurring_supplements.household_id
         AND agreement.id = recurring_supplements.agreement_id
         AND agreement.employee_membership_id = app.current_membership_id()
    )
  );

-- Sin UPDATE ni DELETE en el GRANT: aunque alguien escribiera una política
-- permisiva por error, el rol de la aplicación no tiene el privilegio.
GRANT SELECT, INSERT ON app.extra_work_types TO casa_clara_app;
GRANT SELECT, INSERT ON app.recurring_supplements TO casa_clara_app;

-- ── 9. Migración del modelo de 0002 al catálogo ─────────────────────────────
/*
 * Cada versión de acuerdo que ya existe estrena los dos tipos equivalentes a
 * las columnas de 0002, con SUS tarifas: la v1 conserva las suyas y la v2 las
 * suyas. Nada se revaloriza.
 *
 * Los códigos son literalmente los dos valores del enum `app.extra_work_kind`
 * ('overtime', 'worked_rest_day') para que la correspondencia con el histórico
 * sea evidente al leerla, sin tabla de traducción.
 *
 * `created_by_membership_id` apunta a quien creó la versión: es quien de hecho
 * pactó esas tarifas.
 */
INSERT INTO app.extra_work_types (
  household_id, agreement_id, agreement_version_id, code, name, unit,
  rate_cents, reference_minutes, active, sort_order, created_by_membership_id, created_at
)
SELECT version.household_id, version.agreement_id, version.id,
       'overtime', 'Hora extraordinaria', 'per_hour'::app.extra_work_unit,
       version.overtime_hourly_rate_cents, NULL, true, 10,
       version.created_by_membership_id, version.created_at
  FROM app.agreement_versions AS version
UNION ALL
SELECT version.household_id, version.agreement_id, version.id,
       'worked_rest_day', 'Festivo o descanso trabajado', 'per_shift'::app.extra_work_unit,
       version.worked_rest_day_rate_cents, version.worked_rest_day_credit_minutes, true, 20,
       version.created_by_membership_id, version.created_at
  FROM app.agreement_versions AS version;

/*
 * Los hechos ya registrados apuntan a su tipo. Dos reglas distintas a propósito:
 *
 *   · lo YA RESUELTO se ata a `resolved_agreement_version_id`, la versión que de
 *     hecho congeló su importe. Atarlo a «la vigente el día trabajado» podría
 *     mover un céntimo de una liquidación cerrada si alguna resolución antigua
 *     usó otra versión;
 *   · lo VIVO se ata a la versión vigente el día trabajado, que es la que lo
 *     valorará cuando se resuelva.
 *
 * Se anota, no se reescribe: ni el estado, ni el importe congelado, ni la
 * historia de transiciones cambian. Por eso hay que apagar el disparador de la
 * máquina de estados (rechaza cualquier UPDATE sobre un hecho terminal) y el de
 * congelación recién creado (revalidaría un pasado que no estamos revaluando).
 */
ALTER TABLE app.extra_work_events DISABLE TRIGGER extra_work_state_machine;
ALTER TABLE app.extra_work_events DISABLE TRIGGER extra_work_events_type_freeze;

UPDATE app.extra_work_events AS event
   SET extra_work_type_id = catalogued.id
  FROM app.extra_work_types AS catalogued
 WHERE catalogued.household_id = event.household_id
   AND catalogued.agreement_id = event.agreement_id
   AND catalogued.code = event.kind::text
   AND catalogued.agreement_version_id = COALESCE(
         event.resolved_agreement_version_id,
         app.agreement_version_in_force(event.household_id, event.agreement_id, event.worked_on)
       );

/*
 * El UPDATE de arriba deja pendientes las comprobaciones diferidas de las
 * claves ajenas de la tabla; con la tabla vacía no hay ninguna y no se nota,
 * pero en cuanto hay historial PostgreSQL rechaza el ALTER TABLE siguiente con
 * «cannot ALTER TABLE ... because it has pending trigger events». Forzarlas
 * ahora vacía esa cola sin relajar ninguna garantía: si algo no cuadrara,
 * fallaría aquí y la migración entera se desharía.
 */
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE app.extra_work_events ENABLE TRIGGER extra_work_events_type_freeze;
ALTER TABLE app.extra_work_events ENABLE TRIGGER extra_work_state_machine;

/*
 * Por qué SE CONSERVAN `overtime_hourly_rate_cents` y
 * `worked_rest_day_rate_cents` en `app.agreement_versions`:
 *
 *   1. Son NOT NULL y las lee el histórico. Cada liquidación cerrada, cada
 *      recibo y cada hecho resuelto ANTES de esta migración se valoró con ellas.
 *      Borrarlas obligaría a reescribir filas que el expediente promete no
 *      tocar, y a fiarse de que la copia al catálogo fue perfecta para todos los
 *      hogares. El expediente es append-only: se añade el catálogo, no se retira
 *      lo que ya justificó un pago.
 *
 *   2. Un hecho anterior al catálogo (`extra_work_type_id IS NULL`) todavía se
 *      resuelve con ellas. Es el puente que permite migrar sin una ventana en la
 *      que resolver trabajo antiguo falle.
 *
 *   3. Las lee el guion de alta de hogar y el exportador del expediente. Un
 *      cambio de columnas en la misma entrega que estrena el catálogo
 *      multiplicaría las cosas que pueden romperse a la vez.
 *
 * A cambio quedan CONGELADAS como reliquia: a partir de aquí la valoración de
 * cualquier trabajo extra que nombre un tipo sale del catálogo, y la interfaz de
 * administración escribe ambos sitios (las columnas, con las tarifas de los dos
 * tipos equivalentes cuando existen; el catálogo, con la verdad completa) para
 * que ningún lector antiguo lea un valor obsoleto. Retirarlas es trabajo de una
 * migración futura, cuando no quede ningún hecho sin tipo.
 */
COMMENT ON COLUMN app.agreement_versions.overtime_hourly_rate_cents IS
  'Reliquia de 0002 conservada por compatibilidad. La verdad de la tarifa está en app.extra_work_types (code=''overtime''); esta columna la espeja para los lectores anteriores al catálogo.';
COMMENT ON COLUMN app.agreement_versions.worked_rest_day_rate_cents IS
  'Reliquia de 0002 conservada por compatibilidad. La verdad de la tarifa está en app.extra_work_types (code=''worked_rest_day''); esta columna la espeja para los lectores anteriores al catálogo.';

COMMIT;
