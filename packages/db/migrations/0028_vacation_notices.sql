BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Vacaciones: hasta dónde se le ha contado a la empleada.
--
-- La migración 0020 dejó el hecho completo: `app.vacation_periods` guarda cada
-- periodo con quién lo apuntó y cuándo (`recorded_at`), y quién lo anuló y
-- cuándo (`voided_at`). Lo que faltaba no era el hecho: era saber si a la
-- persona a quien le pasa YA se le ha contado. Sin eso, la casa apunta unas
-- vacaciones y la empleada se entera —si se entera— porque entra en su sección
-- y las ve por casualidad.
--
-- Esta migración añade una sola cosa: una MARCA DE AGUA por persona.
--
--   «He visto todo lo que se había apuntado hasta este instante.»
--
-- Con ella, «lo nuevo desde la última vez que miró» se responde comparando dos
-- columnas que ya existen (`recorded_at`, `voided_at`) contra una tercera. No
-- hay tabla de avisos, ni copia del periodo, ni estado «leído» por fila: el
-- hecho sigue siendo el periodo, y esto solo dice hasta dónde llegó su lectura.
--
-- Por qué una marca de agua y no un aviso por fila:
--
--  · El aviso por fila obliga a decidir qué pasa cuando el mismo periodo se
--    apunta, se anula y se vuelve a apuntar: tres avisos, o uno que cambia de
--    significado. La marca de agua no tiene ese problema, porque no guarda
--    nada del periodo.
--  · Un aviso por fila es un hecho NUEVO que hay que mantener sincronizado con
--    el periodo. Si se desincronizan, la aplicación miente sobre el expediente.
--  · Y sobre todo: la notificación al móvil que vendrá después (docs/
--    notificaciones.md) necesita exactamente esta pregunta —«¿esto ya se lo
--    conté?»— y con la marca de agua la responde LEYENDO EL MISMO HECHO en vez
--    de inventarse otro. Si además guarda su propio «ya se lo mandé al móvil»,
--    que sea otra columna de esta misma tabla y no otra tabla de avisos.
--
-- Lo que esta marca NO es, a propósito:
--
--  · No es un acuse de recibo ni una firma. Que la empleada haya visto los días
--    apuntados no significa que esté de acuerdo con ellos, y ninguna pantalla
--    puede insinuar lo contrario. El propietario fue explícito: las vacaciones
--    las marca la administración hablándolo con ella; aquí no hay aprobación
--    que dar.
--  · No es un registro de actividad. Guarda UN instante por persona, el último,
--    y se pisa a sí mismo. No se puede reconstruir con ella cuándo abrió la
--    aplicación ni cuántas veces: solo «hasta aquí ya lo sabía». Por lo mismo
--    NO lleva disparador de auditoría (`app_private.write_audit_event` copiaría
--    cada actualización, con su actor y su `occurred_at`, a una tabla
--    append-only e inmutable, y eso sí sería el rastro que aquí se evita),
--    exactamente por la razón que la 0026 escribió para el progreso de lectura
--    de la Guía.
--  · No la ve nadie más que su dueña. Ni la administración. Saber si la
--    empleada ha abierto o no la aplicación no es asunto de la casa.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE app.vacation_notice_marks (
  household_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  -- Instante hasta el que esta persona ya ha visto lo apuntado. Es un sello del
  -- MISMO reloj que `vacation_periods.recorded_at` y `voided_at`, porque contra
  -- ellos se compara: mezclar relojes aquí sería perder o repetir avisos.
  seen_through timestamptz NOT NULL,
  PRIMARY KEY (household_id, membership_id),
  FOREIGN KEY (household_id, membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE app.vacation_notice_marks IS
  'Hasta qué instante ha visto cada persona lo apuntado en sus vacaciones. Una fila por membresía, que se pisa a sí misma: no es un registro de actividad ni un acuse de conformidad. Solo la ve su dueña.';

COMMENT ON COLUMN app.vacation_notice_marks.seen_through IS
  'Marca de agua contra app.vacation_periods.recorded_at / voided_at: lo posterior a este instante es lo que todavía no se le ha contado.';

ALTER TABLE app.vacation_notice_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vacation_notice_marks FORCE ROW LEVEL SECURITY;

-- Cada cual ve la suya y nadie más, tampoco quien administra. Misma decisión
-- que `app.wiki_reading_progress` (0026) y por el mismo motivo: la lista de
-- «cuándo miró» de otra persona no es información que la casa necesite.
CREATE POLICY vacation_notice_marks_own ON app.vacation_notice_marks
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND membership_id = app.current_membership_id()
  );

-- Solo SELECT: escribir es exclusivamente por app.mark_vacations_seen().
GRANT SELECT ON app.vacation_notice_marks TO casa_clara_app;

/**
 * «Ya he visto lo que había hasta aquí», para QUIEN LLAMA.
 *
 * No acepta membresía: marcar por otro no es algo que se rechace, es algo que
 * no se puede expresar. Mismo criterio que `app.mark_wiki_note_read` (0026).
 *
 * El argumento es el instante que la pantalla acababa de enseñar —el sello más
 * reciente de lo que se pintó—, no `now()`, y esa diferencia importa: si la
 * administración apunta unas vacaciones entre que la pantalla se dibuja y esta
 * llamada llega, marcar `now()` daría por contado algo que la empleada no llegó
 * a ver, y ese aviso se perdería para siempre. Aun así se acota por los dos
 * lados:
 *
 *   · nunca hacia el futuro (`LEAST` con el reloj del servidor), para que un
 *     cliente con la hora adelantada —o con ganas— no pueda silenciar de una
 *     vez todo lo que le apunten el mes que viene;
 *   · nunca hacia atrás (`GREATEST` con lo ya guardado), para que una pestaña
 *     vieja que se despierta no resucite avisos ya vistos.
 *
 * Devuelve la marca que queda guardada.
 */
CREATE FUNCTION app.mark_vacations_seen(seen_through timestamptz DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  requested timestamptz;
  stored timestamptz;
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;

  requested := least(coalesce(seen_through, statement_timestamp()), statement_timestamp());

  INSERT INTO app.vacation_notice_marks (household_id, membership_id, seen_through)
  VALUES (app.current_household_id(), app.current_membership_id(), requested)
  ON CONFLICT (household_id, membership_id)
  DO UPDATE SET seen_through = greatest(app.vacation_notice_marks.seen_through, excluded.seen_through)
  RETURNING app.vacation_notice_marks.seen_through INTO stored;

  RETURN stored;
END
$$;

REVOKE ALL ON FUNCTION app.mark_vacations_seen(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mark_vacations_seen(timestamptz) TO casa_clara_app;

COMMIT;
