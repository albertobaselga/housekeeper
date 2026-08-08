BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ola E: eventos reales de calendarios enlazados (fuentes ICS entrantes).
--
-- Cada fila es UNA ocurrencia ya expandida por el worker (las RRULE simples se
-- despliegan a ocurrencias dentro de la ventana [ahora−7d, ahora+90d]; ver
-- apps/worker/src/ics.ts). La clave natural de upsert es
-- (household_id, source_id, uid, starts_at): un evento recurrente comparte uid
-- y se distingue por su instante de inicio.
--
-- `source_label` es un snapshot del label de la fuente en el momento de la
-- sincronización: la RLS de app.ics_sources es solo de administración y los
-- demás roles del calendario no podrían resolver el nombre por join. La
-- función definer lo refresca en cada pasada.
--
-- Retención: el worker solo envía la ventana [ahora−7d, ahora+90d] y la
-- función definer borra todo lo de la fuente que no venga en la pasada, así
-- que la propia sincronización periódica es la retención (nada sobrevive más
-- de 7 días tras salir de la ventana mientras la fuente siga activa; al borrar
-- la fuente, el ON DELETE CASCADE arrastra sus eventos).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.ics_source_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL,
  uid text NOT NULL CHECK (length(uid) BETWEEN 1 AND 300),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  all_day boolean NOT NULL DEFAULT false,
  summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 300),
  location text CHECK (location IS NULL OR length(location) BETWEEN 1 AND 300),
  source_label text NOT NULL CHECK (length(source_label) <= 120),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  synced_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  UNIQUE (household_id, source_id, uid, starts_at),
  FOREIGN KEY (household_id, source_id)
    REFERENCES app.ics_sources(household_id, id) ON DELETE CASCADE,
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);

-- Lecturas de agenda: siempre por hogar y rango de inicio.
CREATE INDEX ics_source_events_agenda
  ON app.ics_source_events (household_id, starts_at);

ALTER TABLE app.ics_source_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ics_source_events FORCE ROW LEVEL SECURITY;

-- Lectura: exactamente los roles con capability calendar.read en
-- packages/contracts (familia, empleada y visor; el apoyo NO ve Calendario).
-- Escritura: NINGUNA política ni grant para casa_clara_app — la única vía es
-- la función definer del worker de más abajo (patrón record_ics_sync).
CREATE POLICY ics_source_events_read ON app.ics_source_events
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in', 'viewer')
  );

GRANT SELECT ON app.ics_source_events TO casa_clara_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- Superficie mínima de escritura del worker: sustituye de una pasada el
-- conjunto de ocurrencias de UNA fuente. Borra lo que ya no venga, inserta lo
-- nuevo y solo reescribe filas cuyo hash de contenido (o label) cambió, para
-- que synced_at refleje cambios reales. Devuelve cuántas filas escribió, o
-- NULL si la fuente no existe en ese hogar (no se escribe nada).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app_private.replace_ics_source_events(
  target_household uuid,
  target_source uuid,
  events jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  label_snapshot text;
  written integer;
BEGIN
  IF events IS NULL OR jsonb_typeof(events) <> 'array' THEN
    RAISE EXCEPTION 'events debe ser un array JSON' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(events) > 2000 THEN
    RAISE EXCEPTION 'demasiados eventos por fuente (máximo 2000)' USING ERRCODE = '22023';
  END IF;

  SELECT label INTO label_snapshot
    FROM app.ics_sources
   WHERE household_id = target_household AND id = target_source;
  IF label_snapshot IS NULL THEN
    RETURN NULL;
  END IF;

  WITH incoming AS (
    SELECT DISTINCT ON (uid, starts_at) uid, starts_at, ends_at, all_day, summary, location, content_hash
      FROM (
        SELECT value->>'uid' AS uid,
               (value->>'startsAt')::timestamptz AS starts_at,
               nullif(value->>'endsAt', '')::timestamptz AS ends_at,
               coalesce((value->>'allDay')::boolean, false) AS all_day,
               value->>'summary' AS summary,
               nullif(value->>'location', '') AS location,
               value->>'contentHash' AS content_hash
          FROM jsonb_array_elements(events)
      ) AS raw
  ),
  pruned AS (
    DELETE FROM app.ics_source_events AS existing
     WHERE existing.household_id = target_household
       AND existing.source_id = target_source
       AND NOT EXISTS (
         SELECT 1 FROM incoming
          WHERE incoming.uid = existing.uid
            AND incoming.starts_at = existing.starts_at
       )
  )
  INSERT INTO app.ics_source_events AS target
    (household_id, source_id, uid, starts_at, ends_at, all_day, summary, location, source_label, content_hash)
  SELECT target_household, target_source, uid, starts_at, ends_at, all_day, summary, location, label_snapshot, content_hash
    FROM incoming
  ON CONFLICT (household_id, source_id, uid, starts_at) DO UPDATE
    SET ends_at = excluded.ends_at,
        all_day = excluded.all_day,
        summary = excluded.summary,
        location = excluded.location,
        source_label = excluded.source_label,
        content_hash = excluded.content_hash,
        synced_at = statement_timestamp()
  WHERE target.content_hash IS DISTINCT FROM excluded.content_hash
     OR target.source_label IS DISTINCT FROM excluded.source_label;

  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END
$$;

REVOKE ALL ON FUNCTION app_private.replace_ics_source_events(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.replace_ics_source_events(uuid, uuid, jsonb) TO casa_clara_worker;

-- ─────────────────────────────────────────────────────────────────────────────
-- Encolado periódico: el worker no tiene lectura de app.ics_sources, así que
-- esta función definer le da exactamente lo necesario para programar la
-- sincronización de cada fuente activa (hogar, id y URL — la URL viaja en el
-- payload del job, como en el encolado inmediato del comando ics_feed).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app_private.list_ics_sources_for_sync()
RETURNS TABLE (household_id uuid, source_id uuid, url text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT household_id, id, url
    FROM app.ics_sources
   WHERE enabled
$$;

REVOKE ALL ON FUNCTION app_private.list_ics_sources_for_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.list_ics_sources_for_sync() TO casa_clara_worker;

COMMIT;
