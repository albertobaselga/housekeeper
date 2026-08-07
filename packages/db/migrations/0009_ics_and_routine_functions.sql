BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Emisión anónima del feed ICS: quien posee el token puede leer, sin sesión,
-- exclusivamente las rutinas de la audiencia del feed. La función es la única
-- puerta (RLS forzada impide cualquier otra vía sin contexto).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app_private.ics_feed_events(feed_token_hash text)
RETURNS TABLE (
  feed_id uuid,
  household_id uuid,
  feed_audience text,
  routine_id uuid,
  title text,
  details text,
  next_due_on date,
  frequency text,
  interval_count integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
  SELECT feed.id,
         feed.household_id,
         feed.audience::text,
         routine.id,
         routine.title,
         routine.details,
         routine.next_due_on,
         routine.frequency::text,
         routine.interval_count
    FROM app.ics_feeds AS feed
    LEFT JOIN app.routines AS routine
      ON routine.household_id = feed.household_id
     AND routine.archived_at IS NULL
     AND (feed.audience = 'all' OR routine.audience = 'all' OR routine.audience = feed.audience)
   WHERE feed.token_hash = feed_token_hash
     AND feed.revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION app_private.ics_feed_events(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.ics_feed_events(text) TO casa_clara_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- El worker registra el resultado de sincronizar una fuente ICS sin necesitar
-- lectura ni escritura directa de la tabla.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app_private.record_ics_sync(
  target_household uuid,
  target_source uuid,
  sync_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  updated boolean;
BEGIN
  UPDATE app.ics_sources
     SET last_fetched_at = statement_timestamp(),
         last_error = nullif(sync_error, '')
   WHERE household_id = target_household
     AND id = target_source
  RETURNING true INTO updated;
  RETURN COALESCE(updated, false);
END
$$;

REVOKE ALL ON FUNCTION app_private.record_ics_sync(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.record_ics_sync(uuid, uuid, text) TO casa_clara_worker;

-- ─────────────────────────────────────────────────────────────────────────────
-- Avance de la rutina al completarse la ocurrencia vigente: la escritura de
-- app.routines es solo familiar por RLS, pero empleada y apoyo también
-- completan según audiencia. La función exige contexto completo y que exista
-- la finalización recién insertada bajo la RLS del actor; el clamp de fin de
-- mes lo hace la aritmética de intervalos de PostgreSQL (31/01 +1 mes → 28/02).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.advance_routine_after_completion(
  target_routine uuid,
  completed_due date
)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  advanced date;
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.routine_completions
     WHERE household_id = app.current_household_id()
       AND routine_id = target_routine
       AND due_on = completed_due
  ) THEN
    RAISE EXCEPTION 'no existe la finalización a avanzar' USING ERRCODE = '42501';
  END IF;

  UPDATE app.routines
     SET next_due_on = CASE frequency
       WHEN 'daily' THEN completed_due + interval_count
       WHEN 'weekly' THEN completed_due + 7 * interval_count
       WHEN 'monthly' THEN (completed_due + make_interval(months => interval_count))::date
       WHEN 'quarterly' THEN (completed_due + make_interval(months => 3 * interval_count))::date
     END
   WHERE household_id = app.current_household_id()
     AND id = target_routine
     AND next_due_on = completed_due
  RETURNING next_due_on INTO advanced;
  RETURN advanced;
END
$$;

REVOKE ALL ON FUNCTION app.advance_routine_after_completion(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.advance_routine_after_completion(uuid, date) TO casa_clara_app;

COMMIT;
