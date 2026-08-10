BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- La hora a la que despierta un aviso programado «para el día X».
--
-- Hasta aquí los dos encolados que parten de una FECHA civil calculaban su
-- `run_at` con `$1::date::timestamptz`. Esa conversión no es neutra: resuelve
-- la medianoche EN LA ZONA DE LA SESIÓN. El servidor de producción va en UTC,
-- así que «el aviso de la rutina del 15 de agosto» quedaba encolado a las
-- 00:00Z, que en el salón de esta casa son **las 02:00 de la madrugada**. Un
-- recordatorio doméstico que suena de madrugada es un recordatorio roto: o
-- despierta a alguien, o —lo normal— se lee doce horas tarde.
--
-- La corrección tiene dos mitades, y las dos viven aquí para que no puedan
-- separarse: una función que fija el criterio, y un UPDATE que arregla lo que
-- ya está en la cola con el criterio viejo.
--
--   1. `app.job_run_at(día, hora)` traduce «para el día X» al instante real en
--      la zona del hogar. La zona es `Europe/Madrid`, la misma constante que ya
--      usan el expansor de ICS (`ICS_DEFAULT_TIME_ZONE`, apps/worker/src/ics.ts)
--      y todos los formateadores de la web; el día se entiende siempre como el
--      día del calendario que ve la familia, no el de la sesión que encola. La
--      hora por omisión son las **08:00**: la mañana, antes de que empiece la
--      jornada, que es cuando un aviso sirve de algo.
--
--      Es STABLE y no IMMUTABLE a propósito: `AT TIME ZONE 'Europe/Madrid'`
--      depende de la base de datos de husos horarios, que se actualiza con el
--      sistema. Un índice sobre esta expresión mentiría tras un cambio de reglas
--      de horario de verano; una función STABLE no permite construirlo.
--
--   2. El UPDATE reprograma las filas que YA están encoladas con el criterio
--      viejo. El filtro es deliberadamente estrecho: sólo los dos tipos que se
--      encolan a partir de una fecha civil, sólo los que siguen `queued` (los
--      terminados son inmutables por el trigger de la 0004) y sólo aquellos
--      cuyo `run_at` cae exactamente en la medianoche UTC, que es la huella que
--      dejaba `::date::timestamptz` bajo una sesión en UTC. Un aviso encolado a
--      cualquier otra hora no lo puso este error y no se toca.
--
--      Los otros tipos de la cola no entran porque no nacen de una fecha:
--      `time_report.autoconfirm` es `envío + 3 días`, `ics.sync_all` y
--      `maintenance.prune_discovery` se re-encolan con desplazamientos
--      relativos. Ninguno apunta a una hora civil concreta.
--
--      Reprogramar hacia adelante no pierde ningún aviso: la escalada de la
--      liquidación se vuelve a encolar sola cada tres días mientras siga
--      pendiente, y un aviso cuya hora nueva ya haya pasado sale en el primer
--      drenaje, igual que salía antes.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION app.job_run_at(
  target_day date,
  wall_clock time DEFAULT time '08:00'
)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT (target_day + wall_clock) AT TIME ZONE 'Europe/Madrid'
$$;

COMMENT ON FUNCTION app.job_run_at(date, time) IS
  'Instante real de un trabajo programado «para el día X»: hora civil (08:00 por '
  'omisión) en la zona del hogar (Europe/Madrid), no en la de la sesión.';

REVOKE ALL ON FUNCTION app.job_run_at(date, time) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.job_run_at(date, time) TO casa_clara_app, casa_clara_worker;

UPDATE app_private.job_queue
   SET run_at = app.job_run_at((run_at AT TIME ZONE 'UTC')::date)
 WHERE status = 'queued'
   AND job_type IN ('notification.settlement_due', 'notification.routine_due')
   AND run_at = date_trunc('day', run_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

COMMIT;
