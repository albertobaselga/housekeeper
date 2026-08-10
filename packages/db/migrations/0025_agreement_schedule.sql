BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- El horario pactado: colgado de la VERSIÓN del contrato, como el salario.
--
-- Hasta aquí el horario existía, pero solo como PROSA. El guion de alta lo
-- redactaba en una frase y la dejaba en `app.agreement_versions.terms->>'schedule'`
-- («Presencia de 08:00 a 19:00. Descanso largo de 120 minutos. …»). Esa frase
-- no se puede consultar, no se puede comparar con la jornada semanal contratada
-- y no se puede enseñar bien en pantalla: es un comentario, no un dato. La
-- consecuencia práctica es que la persona que trabaja no tenía en la aplicación
-- ningún sitio donde leer a qué hora entra, a qué hora sale y qué día libra.
--
-- Esta migración lo modela de verdad, con la misma decisión de 0020 (días de
-- vacaciones) y 0021 (catálogo de conceptos): cuelga de la VERSIÓN y no del
-- contrato, porque cambiar el horario es cambiar lo pactado. Exige versión
-- nueva, queda en el historial y no se reescribe jamás. Como la versión es
-- inmutable (disparador `agreement_versions_append_only` de 0002), su horario
-- también lo es: aquí solo se INSERTA.
--
--   1. `app.agreement_schedules` — la JORNADA TIPO: hora de entrada, hora de
--      salida, minutos del descanso largo del mediodía y una nota. Como mucho
--      una por versión.
--
--      Que la fila EXISTA es exactamente el «si aplica» del encargo: un contrato
--      que no declara horario no tiene fila, y entonces la vista de la empleada
--      no le enseña una sección vacía ni un hueco con guiones; sencillamente no
--      hay sección. No hace falta ninguna bandera `has_schedule`: la ausencia ya
--      lo dice, y una bandera podría contradecir a los datos.
--
--   2. `app.agreement_schedule_days` — las EXCEPCIONES por día de la semana,
--      incluida la libranza. Un día libre es el caso extremo de un día
--      distinto, así que vive en la misma tabla y no en una lista aparte: si
--      fueran dos sitios, dos sitios podrían contradecirse («jueves libre» y
--      «jueves de 9 a 14» a la vez).
--
--      Solo se apunta lo que SE DESVÍA de la jornada tipo. Un contrato en el
--      que se trabaja de lunes a sábado igual y se libra el domingo es UNA fila
--      («domingo, no se trabaja»), no siete. El encargo lo pide con esas
--      palabras: admitir excepciones por día «sin obligar a rellenar los siete».
--
--      Cada campo del día es NULLABLE y NULL significa «como la jornada tipo».
--      El caso que motivó todo esto —«un par de días se termina antes»— se
--      escribe cambiando SOLO `ends_at`, sin repetir la hora de entrada ni el
--      descanso, que no cambian.
--
-- Lo que esta migración NO hace, a propósito:
--
--   · No calcula ni almacena los minutos semanales que suma el horario. Se
--     calculan en lectura, en el motor puro (`packages/domain/agreement-schedule`),
--     y se comparan con `contracted_weekly_minutes` para AVISAR en pantalla
--     cuando no cuadran. No se rechaza la escritura: un horario que no cuadra
--     con la jornada contratada es un hecho que la casa tiene que ver y
--     corregir pactando, no un error de tecleo que la base pueda arreglar sola.
--     Callarlo sería peor que las dos cosas.
--
--   · No toca `terms->>'schedule'`. La frase de prosa que escribió el guion de
--     alta sigue donde estaba: es lo que se pactó por escrito con los hogares ya
--     dados de alta y el expediente no reescribe el pasado. A partir de aquí la
--     verdad consultable es esta tabla, y el guion de alta escribe las dos.
--
--   · No admite jornadas que crucen la medianoche (`ends_at > starts_at`). Lo
--     pactado en esta casa es una franja de presencia diurna. Una guardia
--     nocturna no es horario ordinario: es trabajo extra, y para eso está el
--     catálogo de 0021 (unidad `fixed_amount`, «noche de guardia»). Modelarla
--     aquí obligaría a que cada lector supiera sumar horas a caballo de dos
--     días para nada.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. La jornada tipo ──────────────────────────────────────────────────────
CREATE TABLE app.agreement_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  agreement_version_id uuid NOT NULL,
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  -- El descanso largo del mediodía, que es lo que esta casa pacta. En minutos
  -- y no en horas porque «hora y media» existe y «1,5 h» invita a la coma
  -- flotante. 0 es legítimo: hay contratos sin descanso largo pactado.
  long_break_minutes integer NOT NULL DEFAULT 0
    CHECK (long_break_minutes >= 0 AND long_break_minutes < 1440),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  -- Como mucho un horario por versión. Dos horarios vigentes a la vez no serían
  -- «lo pactado»: serían una pregunta sin respuesta.
  UNIQUE (household_id, agreement_version_id),
  -- Pareja que permite a los días exigir que su horario sea del mismo contrato.
  UNIQUE (household_id, id, agreement_id),
  FOREIGN KEY (household_id, agreement_version_id, agreement_id)
    REFERENCES app.agreement_versions(household_id, id, agreement_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (ends_at > starts_at),
  -- Un descanso que no cabe en la jornada deja horas efectivas negativas, y con
  -- ellas una semana contratada imposible. Se rechaza aquí y no en pantalla.
  CHECK (make_interval(mins => long_break_minutes) < ends_at - starts_at)
);

COMMENT ON TABLE app.agreement_schedules IS
  'Jornada tipo pactada en una versión del contrato. Como mucho una por versión; solo INSERT, se cambia apilando versión. Que no exista fila significa que el contrato no declara horario.';
COMMENT ON COLUMN app.agreement_schedules.long_break_minutes IS
  'Minutos del descanso largo del mediodía pactado. 0 = no se pactó ninguno.';

CREATE INDEX agreement_schedules_version_idx
  ON app.agreement_schedules (household_id, agreement_version_id);

-- ── 2. Los días que se salen de la jornada tipo ─────────────────────────────
CREATE TABLE app.agreement_schedule_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  -- ISO-8601, el mismo convenio que `EXTRACT(isodow FROM …)` de Postgres:
  -- 1 lunes … 7 domingo. Se elige ese y no el `dow` de Postgres (0 domingo)
  -- para que la semana laboral no empiece por el día que casi siempre se libra.
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  -- La libranza. `false` = ese día no se trabaja, y entonces no hay horas que
  -- declarar; el CHECK de abajo lo impone.
  works boolean NOT NULL,
  -- NULL en los tres = «como la jornada tipo». El caso real de esta casa
  -- —terminar antes un par de días— es una fila con `ends_at` y nada más.
  starts_at time,
  ends_at time,
  long_break_minutes integer
    CHECK (long_break_minutes IS NULL OR (long_break_minutes >= 0 AND long_break_minutes < 1440)),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  -- Un día de la semana no puede decir dos cosas distintas del mismo horario.
  UNIQUE (household_id, schedule_id, weekday),
  FOREIGN KEY (household_id, schedule_id, agreement_id)
    REFERENCES app.agreement_schedules(household_id, id, agreement_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  -- Un día libre no tiene horas: si las tuviera, «libre» dejaría de significar
  -- nada y el cálculo de la semana tendría dos lecturas posibles.
  CHECK (
    works
    OR (starts_at IS NULL AND ends_at IS NULL AND long_break_minutes IS NULL)
  ),
  -- Un día que se trabaja EXACTAMENTE como la jornada tipo no necesita fila. Si
  -- alguien la escribe sin desviar nada ni explicar nada, es ruido que el
  -- resumen tendría que repetir sin decir nada nuevo.
  CHECK (
    NOT works
    OR num_nonnulls(starts_at, ends_at, long_break_minutes) > 0
    OR length(btrim(note)) > 0
  )
);

COMMENT ON TABLE app.agreement_schedule_days IS
  'Días de la semana que se salen de la jornada tipo, incluida la libranza. Solo se apunta lo que se desvía: los días que no aparecen siguen la jornada tipo.';
COMMENT ON COLUMN app.agreement_schedule_days.weekday IS
  'ISO-8601: 1 lunes … 7 domingo, el mismo convenio que EXTRACT(isodow).';
COMMENT ON COLUMN app.agreement_schedule_days.works IS
  'false = día de libranza. true = se trabaja, con las horas de la jornada tipo salvo en lo que esta fila cambie.';

CREATE INDEX agreement_schedule_days_schedule_idx
  ON app.agreement_schedule_days (household_id, schedule_id, weekday);

-- ── 3. Inmutabilidad ────────────────────────────────────────────────────────
/*
 * El horario hereda la inmutabilidad de la versión que lo contiene, exactamente
 * como el catálogo de 0021. No hay corrección en sitio ni anulación: cambiar la
 * hora de salida de los jueves es cambiar lo pactado, y eso se hace apilando una
 * versión nueva que el historial enseña al lado de la anterior. La fila que
 * describía la jornada de un día trabajado no se puede reescribir nunca, ni por
 * la pantalla de administración ni por la base de datos.
 *
 * Se reutiliza `app.reject_agreement_catalogue_mutation()` de 0021: dice
 * literalmente lo que hay que hacer («stack a new version instead») y ya es la
 * regla de las otras dos tablas que cuelgan de la versión.
 */
CREATE TRIGGER agreement_schedules_frozen
BEFORE UPDATE OR DELETE ON app.agreement_schedules
FOR EACH ROW EXECUTE FUNCTION app.reject_agreement_catalogue_mutation();

CREATE TRIGGER agreement_schedule_days_frozen
BEFORE UPDATE OR DELETE ON app.agreement_schedule_days
FOR EACH ROW EXECUTE FUNCTION app.reject_agreement_catalogue_mutation();

CREATE TRIGGER agreement_schedules_audit
AFTER INSERT OR UPDATE OR DELETE ON app.agreement_schedules
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

CREATE TRIGGER agreement_schedule_days_audit
AFTER INSERT OR UPDATE OR DELETE ON app.agreement_schedule_days
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

-- ── 4. Un día excepcional sigue teniendo que ser un día ─────────────────────
/*
 * Los CHECK de la tabla no pueden mirar la jornada tipo, y la excepción se
 * define contra ella: una fila con solo `ends_at = '07:00'` es coherente por sí
 * misma y absurda si la jornada tipo empieza a las 08:00. La comprobación
 * necesita las dos filas, así que vive en un disparador.
 *
 * Se ejecuta bajo la RLS de quien escribe, y no hay agujero: escribe solo
 * `family_admin` (política `agreement_schedules_admin_insert`), que ve todos los
 * horarios de su hogar. No existe una jornada tipo oculta contra la que un día
 * pudiera validarse a ciegas.
 */
CREATE FUNCTION app.enforce_schedule_day_bounds()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  base record;
  day_start time;
  day_end time;
  day_break integer;
BEGIN
  -- Un día de libranza no tiene horas que validar: el CHECK de la tabla ya
  -- exige que llegue con las tres columnas vacías.
  IF NOT NEW.works THEN
    RETURN NEW;
  END IF;

  SELECT schedule.starts_at, schedule.ends_at, schedule.long_break_minutes
    INTO base
    FROM app.agreement_schedules AS schedule
   WHERE schedule.household_id = NEW.household_id
     AND schedule.id = NEW.schedule_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'the standard working day of this schedule is not visible in this household'
      USING ERRCODE = '23503';
  END IF;

  day_start := COALESCE(NEW.starts_at, base.starts_at);
  day_end := COALESCE(NEW.ends_at, base.ends_at);
  day_break := COALESCE(NEW.long_break_minutes, base.long_break_minutes);

  IF day_end <= day_start THEN
    RAISE EXCEPTION 'a working day cannot end at % when it starts at %', day_end, day_start
      USING ERRCODE = '23514';
  END IF;
  IF make_interval(mins => day_break) >= day_end - day_start THEN
    RAISE EXCEPTION 'a break of % minutes does not fit between % and %', day_break, day_start, day_end
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER agreement_schedule_days_bounds
BEFORE INSERT OR UPDATE ON app.agreement_schedule_days
FOR EACH ROW EXECUTE FUNCTION app.enforce_schedule_day_bounds();

-- ── 5. RLS ──────────────────────────────────────────────────────────────────
/*
 * Quién ve el horario: quien administra y la propia interesada. NADIE MÁS gana
 * acceso con esta migración.
 *
 * Es la misma frontera exacta que `agreement_versions_read` de 0005, y por la
 * misma razón: el horario es una condición del contrato de una persona
 * concreta. Que un miembro de la familia sin administración —o el apoyo, o el
 * visor— pueda leer a qué hora entra y sale la empleada cada día de la semana
 * no es información doméstica: es su vida. Por eso se reutiliza
 * `app.employee_row_visible(..., include_family_member => false)`, que ya
 * codifica esa frontera y evita escribirla otra vez con otras palabras.
 *
 * La separación se impone AQUÍ y no en la plantilla: una fila filtrada en
 * Svelte ya viajó dentro del JSON de la página.
 */
ALTER TABLE app.agreement_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.agreement_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE app.agreement_schedule_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.agreement_schedule_days FORCE ROW LEVEL SECURITY;

CREATE POLICY agreement_schedules_read ON app.agreement_schedules
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.employment_agreements AS agreement
       WHERE agreement.household_id = agreement_schedules.household_id
         AND agreement.id = agreement_schedules.agreement_id
         AND app.employee_row_visible(agreement.household_id, agreement.employee_membership_id, false)
    )
  );

CREATE POLICY agreement_schedules_admin_insert ON app.agreement_schedules
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );

-- Los días heredan la visibilidad de su jornada tipo. Se comprueba contra
-- `agreement_id` —que la clave ajena obliga a coincidir con la del horario— y
-- no atravesando `app.agreement_schedules`: así la política del día no depende
-- de que la política del horario siga diciendo lo mismo mañana.
CREATE POLICY agreement_schedule_days_read ON app.agreement_schedule_days
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.employment_agreements AS agreement
       WHERE agreement.household_id = agreement_schedule_days.household_id
         AND agreement.id = agreement_schedule_days.agreement_id
         AND app.employee_row_visible(agreement.household_id, agreement.employee_membership_id, false)
    )
  );

CREATE POLICY agreement_schedule_days_admin_insert ON app.agreement_schedule_days
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin'
  );

-- Sin UPDATE ni DELETE en el GRANT: aunque alguien escribiera una política
-- permisiva por error, el rol de la aplicación no tiene el privilegio. Es la
-- misma cerradura doble que 0021.
GRANT SELECT, INSERT ON app.agreement_schedules TO casa_clara_app;
GRANT SELECT, INSERT ON app.agreement_schedule_days TO casa_clara_app;

COMMIT;
