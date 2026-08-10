BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Desmarcar una rutina marcada por error (enmienda E5.1 de
-- docs/rutinas-y-calendario.md).
--
-- Hoy marcar es irreversible, y no solo deja la tarea como hecha sin haberse
-- hecho: MUEVE la caché `next_due_on`, así que la casa deja de ver la tarea el
-- día que le tocaba. Un toque accidental en un móvil borra trabajo del día.
--
-- Tres decisiones, y las tres se leen en el esquema:
--
--   1. NO SE BORRA. La enmienda E2 hizo el historial consultable con su
--      autoría; un completado anulado se anota como anulado —igual que un pago
--      o unas vacaciones— y deja de contar. `DELETE` habría sido una línea
--      menos y una mentira: el hecho «alguien pulsó esto» ocurrió.
--
--   2. NO SE PIDE MOTIVO. Es la excepción DELIBERADA al patrón de anulación con
--      motivo del expediente laboral (`app.extra_work_transitions.reason`,
--      `app.manual_adjustments.reason`). Un error de dedo en una tarea
--      doméstica no es una corrección contable: pedir justificación sería
--      fricción sin valor, y quien la escribiera escribiría «me equivoqué».
--      Queda dicho aquí para que la ausencia no parezca un descuido.
--
--   3. LA FECHA SE RESTAURA, NO SE RECALCULA. Esto no necesita columna: desde
--      la 0023 las ocurrencias se generan DESDE EL ANCLA y `next_due_on` es
--      caché derivada de (regla, finalizaciones vivas). Quitar la finalización
--      del conjunto devuelve exactamente la fecha que había antes de marcar,
--      porque `pendingFor` es una función pura de ese conjunto. Guardar «la
--      fecha anterior» en una columna habría sido guardar un dato que el
--      generador ya sabe deducir, con el riesgo de que las dos se separen.
--
-- Lo que NO se toca, a propósito:
--
--   · La clave primaria (household_id, routine_id, due_on). Sigue habiendo una
--     fila por ocurrencia. Volver a marcar una ocurrencia anulada REVIVE la
--     fila (`packages/server/src/commands/rhythm.ts`) en vez de insertar otra;
--     de ahí que la política de UPDATE de más abajo tenga dos ramas.
--   · `app.set_routine_due_hint` (0023). Su guardián exige que exista ALGUNA
--     finalización de la rutina en este hogar, y una anulada sigue existiendo:
--     por eso deshacer puede refrescar la caché. Exigir una finalización VIVA
--     habría impedido justamente el caso que esta migración viene a resolver.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE app.routine_completions
  ADD COLUMN voided_at timestamptz,
  ADD COLUMN voided_by_membership_id uuid;

ALTER TABLE app.routine_completions
  ADD CONSTRAINT routine_completions_voided_by_fkey
  FOREIGN KEY (household_id, voided_by_membership_id)
  REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT;

/*
 * Las dos columnas van juntas o no van: una anulación sin autor no se puede
 * consultar («quién lo marcó y quién lo anuló» es lo que E2 pide), y un autor
 * de anulación sin fecha es una fila que nadie sabe leer.
 */
ALTER TABLE app.routine_completions
  ADD CONSTRAINT routine_completions_void_is_complete
  CHECK ((voided_at IS NULL) = (voided_by_membership_id IS NULL));

COMMENT ON COLUMN app.routine_completions.voided_at IS
  'Instante en que se deshizo el marcado. NULL = la finalización cuenta. Una anulada no se borra: deja de contar y sigue consultable con su autoría (enmienda E5.1).';
COMMENT ON COLUMN app.routine_completions.voided_by_membership_id IS
  'Quién deshizo el marcado. Sin motivo: es un error de dedo, no una corrección contable, y es la excepción deliberada al patrón de anulación del expediente laboral.';

/*
 * Índice parcial sobre lo VIVO. Todos los lectores (Hoy, el snapshot, el
 * calendario, el barrido de avisos) preguntan siempre por finalizaciones no
 * anuladas y acotadas por ventana; las anuladas solo se leen de una en una,
 * por su clave primaria, al deshacer o al revivir.
 */
CREATE INDEX routine_completions_live_idx
  ON app.routine_completions (household_id, routine_id, due_on)
  WHERE voided_at IS NULL;

/*
 * Una finalización no cambia de ocurrencia. La política de UPDATE de más abajo
 * necesita una rama que deje escribir sobre una fila ya anulada (revivirla), y
 * sin este cerrojo esa rama serviría además para ARRASTRAR la fila anulada a
 * otro `due_on` y borrar de paso el rastro de la anulación. Mismo criterio que
 * `manual_adjustments_append_only` (0022): anular no puede reescribir lo que se
 * registró.
 *
 * Solo UPDATE. El DELETE se queda fuera a propósito: no hay política de RLS que
 * lo permita desde la aplicación, y la cascada de `app.routines` (0008:223) sí
 * tiene que poder llevarse las finalizaciones cuando se borra una rutina.
 */
CREATE FUNCTION app.keep_routine_completion_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
    OR NEW.routine_id IS DISTINCT FROM OLD.routine_id
    OR NEW.due_on IS DISTINCT FROM OLD.due_on THEN
    RAISE EXCEPTION 'una finalización no cambia de ocurrencia: anúlala y marca la que toque'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER routine_completions_keep_identity
BEFORE UPDATE ON app.routine_completions
FOR EACH ROW EXECUTE FUNCTION app.keep_routine_completion_identity();

-- ── Quién puede deshacer ────────────────────────────────────────────────────
/*
 * «Puede deshacerlo quien lo marcó, y la administración. La empleada no puede
 * desmarcar lo que marcó otra persona» (E5.1). Se impone EN LA BASE, no en el
 * comando, por el mismo motivo que AC-25: una regla de quién-puede-qué que
 * vive solo en TypeScript se salta con la siguiente vía de escritura que
 * alguien añada.
 *
 * La política tiene dos ramas porque la tabla tiene dos escrituras distintas
 * con la misma sentencia:
 *
 *   · ANULAR — la fila está viva. Solo su autor o `family_admin`.
 *   · REVIVIR — la fila está anulada y alguien vuelve a marcar esa ocurrencia
 *     de verdad. Eso es una finalización nueva y se rige por la regla de las
 *     finalizaciones nuevas: la escribe quien la hace, para sí misma. Sin esta
 *     rama, deshacer sería una trampa: la ocurrencia quedaría bloqueada para
 *     siempre contra la clave primaria y nadie podría volver a marcarla.
 *
 * El WITH CHECK cierra la falsificación de autoría en los dos sentidos: una
 * fila que queda viva tiene que estar a nombre de quien escribe (la misma
 * regla que `routine_completions_insert`) y sin rastro de anulación; una que
 * queda anulada tiene que llevar el nombre de quien la anula.
 *
 * `USING` no repite el EXISTS sobre `app.routines`: la política de SELECT ya lo
 * aplica, y una fila que el actor no puede leer no llega a evaluarse. El
 * `WITH CHECK` sí lo lleva, porque comprueba la fila NUEVA.
 */
CREATE POLICY routine_completions_void ON app.routine_completions
  FOR UPDATE USING (
    app.tenant_context_matches(household_id)
    AND (
      voided_at IS NOT NULL
      OR completed_by_membership_id = app.current_membership_id()
      OR app.current_household_role() = 'family_admin'
    )
  )
  WITH CHECK (
    app.tenant_context_matches(household_id)
    AND EXISTS (
      SELECT 1 FROM app.routines AS routine
       WHERE routine.household_id = routine_completions.household_id
         AND routine.id = routine_completions.routine_id
    )
    AND CASE
          WHEN voided_at IS NULL
            THEN completed_by_membership_id = app.current_membership_id()
          ELSE voided_by_membership_id = app.current_membership_id()
        END
  );

-- ── El barrido de avisos deja de contar lo anulado ──────────────────────────
/*
 * `CREATE OR REPLACE` y no DROP+CREATE: el tipo de retorno no cambia, así que
 * la ACL se conserva. Aun así se reemiten REVOKE y GRANT, que es la lección de
 * la 0011 y cuesta dos líneas.
 *
 * Sin este filtro, deshacer un marcado no volvería a avisar de la rutina: el
 * worker recibiría la ocurrencia como completada y `pendingFor` la descartaría.
 */
CREATE OR REPLACE FUNCTION app_private.routine_digest_inputs(for_date date)
RETURNS TABLE (
  household_id uuid,
  routine_id uuid,
  title text,
  details text,
  audience text,
  pattern text,
  anchor_on date,
  repeat_every integer,
  weekdays smallint[],
  month_day smallint,
  months smallint[],
  overdue_policy text,
  ends_on date,
  completed_due_ons date[],
  recipients text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT routine.household_id,
         routine.id,
         routine.title,
         routine.details,
         routine.audience::text,
         routine.pattern::text,
         routine.anchor_on,
         routine.repeat_every,
         routine.weekdays,
         routine.month_day,
         routine.months,
         routine.overdue_policy::text,
         routine.ends_on,
         COALESCE((
           SELECT array_agg(done.due_on ORDER BY done.due_on)
             FROM app.routine_completions AS done
            WHERE done.household_id = routine.household_id
              AND done.routine_id = routine.id
              AND done.voided_at IS NULL
              AND done.due_on BETWEEN for_date - 400 AND for_date
         ), ARRAY[]::date[]),
         COALESCE((
           SELECT array_agg(DISTINCT profile.email)
             FROM app.household_memberships AS membership
             JOIN app.user_profiles AS profile ON profile.user_id = membership.user_id
            WHERE membership.household_id = routine.household_id
              AND membership.role::text = ANY (
                    CASE routine.audience
                      WHEN 'family'   THEN ARRAY['family_admin', 'family_member']
                      WHEN 'employee' THEN ARRAY['employee_live_in']
                      WHEN 'all'      THEN ARRAY['family_admin', 'family_member', 'employee_live_in']
                    END
                  )
              AND membership.starts_at <= statement_timestamp()
              AND membership.revoked_at IS NULL
              AND (membership.expires_at IS NULL OR membership.expires_at > statement_timestamp())
              AND profile.email IS NOT NULL
              AND length(btrim(profile.email)) > 0
         ), ARRAY[]::text[])
    FROM app.routines AS routine
   WHERE routine.archived_at IS NULL
     AND routine.pattern IS NOT NULL
     AND routine.anchor_on <= for_date
     AND (routine.ends_on IS NULL OR routine.ends_on >= for_date - 400)
$$;

REVOKE ALL ON FUNCTION app_private.routine_digest_inputs(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.routine_digest_inputs(date) TO casa_clara_worker;

COMMIT;
