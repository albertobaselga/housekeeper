-- ─────────────────────────────────────────────────────────────────────────────
-- Rutinas con ritmo propio · CONTRAER (fase 2 de 2; la 0023 expandió).
--
-- §3.5 de docs/rutinas-y-calendario.md. La 0023 dejó a propósito en pie el
-- vocabulario viejo —`frequency`, `interval_count`,
-- `app.advance_routine_after_completion`— y la rama de compatibilidad del
-- contrato, para que un envelope encolado en el IndexedDB de un móvil ANTES de
-- aquel despliegue pudiera aterrizar al reconectar. Esta migración lo retira.
--
-- POR QUÉ VA LA ÚLTIMA Y NO SE MEZCLA CON NADA. La cita del plan de trabajo es
-- literal: «T10 nunca se adelanta ni se mezcla — separarla del despliegue
-- anterior es la única garantía de que un envelope offline antiguo no se
-- pierda.» La 0023 y todo lo que la acompaña llevan desplegados y en uso el
-- tiempo suficiente para que ninguna cola siga guardando la forma antigua. Si
-- alguna llegara igualmente tarde, YA NO SE TRADUCE: se rechaza con
-- `routine_cadence_format_retired` y su frase, que es una respuesta honesta.
-- Traducir a ciegas sería peor, porque la tabla de traducción es justamente la
-- que miente cuando la cadencia rica no cabe en el vocabulario viejo.
--
-- QUÉ SE RETIRA Y POR QUÉ CADA COSA
--
--   · `frequency` e `interval_count`. Desde la 0023 no son estado: son SOMBRA
--     que el servidor escribía por si un lector antiguo las miraba. Y mienten
--     a conciencia —«cada 15 días» se guardaba como `daily × 12`, «en junio y
--     en diciembre» como `monthly × 6`—, porque el vocabulario viejo no sabe
--     decir esas cadencias. Ya no queda ningún lector: el último era el feed
--     ICS, que se reescribe en este mismo despliegue.
--   · `app.routine_frequency`, el ENUM que solo sostenía esas dos columnas.
--   · `app.advance_routine_after_completion` (0009): ~30 líneas de `CASE
--     frequency` dentro de una SECURITY DEFINER, la cuarta copia del algoritmo
--     de recurrencia. La sustituyó `app.set_routine_due_hint` en la 0023.
--   · `next_due_on` NO se retira: se RENOMBRA a `next_due_hint`. El nombre
--     mentía. Desde §2.7 esa columna no es estado sino caché —cota INFERIOR de
--     la próxima ocurrencia—, y la verdad de la cadencia vive en las columnas
--     de patrón. Un nombre que dice «la próxima fecha es esta» invita a
--     decidir con ella, que es exactamente lo que no se debe hacer.
--
-- ORDEN OBLIGATORIO, y por qué este y no otro (la lección de la 0021 y la
-- 0023: pasar todas las suites con las tablas vacías no prueba nada):
--
--   1. Foto de la cadencia de CADA rutina, antes de tocar el esquema.
--   2. DROP de la función vieja, que es lo único que cita `frequency` desde
--      dentro del catálogo.
--   3. DROP de las dos columnas, y solo entonces DROP del ENUM (mientras la
--      columna exista, el tipo tiene dependientes y el DROP falla).
--   4. RENAME de la columna. Índices y CHECK lo siguen SOLOS: sí están
--      registrados como dependencias. Los cuerpos de función NO.
--   5. Recrear las dos funciones que citan la columna por su nombre. Este es
--      el paso que de verdad importa: el cuerpo de una función SQL o plpgsql
--      se guarda como TEXTO y no se comprueba al renombrar. Sin este paso la
--      migración pasa en verde, la base queda «bien», y el feed ICS y el
--      refresco de la caché revientan en caliente la primera vez que alguien
--      los usa. Con REVOKE y GRANT reemitidos, que es la lección de la 0011.
--   6. Aserción final, fila a fila: ninguna rutina cambió de próxima fecha ni
--      de cadencia, y no queda ni un cuerpo de función citando lo retirado.
--
-- No hay ningún UPDATE de datos en esta migración —es DDL de principio a fin—,
-- así que la cola de comprobaciones diferidas que obligó a poner
-- `SET CONSTRAINTS ALL IMMEDIATE` en la 0023 no llega a formarse. El DROP
-- COLUMN y el RENAME de PostgreSQL son cambios de catálogo: no reescriben la
-- tabla y no dependen del número de filas.
--
-- ANTES DE APLICARLA CONTRA PRODUCCIÓN, léase esto entero.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── 1 · La foto de antes, para poder demostrar el «después» ─────────────────
/*
 * La promesa del encargo no es «la migración corre»: es que NINGUNA rutina
 * pierde su próxima fecha ni su cadencia. Aquí no se declara, se comprueba, y
 * se comprueba sobre las filas REALES de la base contra la que se aplique
 * —producción incluida—, no sobre las de una prueba. Si algo no cuadrara, el
 * paso 6 levanta la excepción y la migración entera se deshace.
 *
 * ON COMMIT DROP: el runner aplica cada fichero dentro de su transacción, así
 * que la foto se desvanece con el COMMIT y no deja rastro en la base.
 */
CREATE TEMP TABLE routine_cadence_before ON COMMIT DROP AS
SELECT id,
       next_due_on,
       pattern,
       anchor_on,
       repeat_every,
       weekdays,
       month_day,
       months,
       ends_on,
       overdue_policy
  FROM app.routines;

-- ── 2 · La definer que avanzaba la fecha ────────────────────────────────────
/*
 * La sustituyó `app.set_routine_due_hint` (0023), que no calcula nada: recibe
 * la fecha ya resuelta por el motor puro y solo refresca la caché. El motivo
 * por el que una definer sigue haciendo falta no ha cambiado —la RLS solo deja
 * escribir `app.routines` a la familia, pero la empleada y el apoyo también
 * marcan—; lo que se va es la aritmética duplicada dentro de ella.
 */
DROP FUNCTION app.advance_routine_after_completion(uuid, date);

-- ── 3 · Las columnas sombra y el ENUM que las sostenía ──────────────────────
/*
 * `DROP COLUMN` se lleva por delante, y sin nombrarlas, las restricciones que
 * colgaban de ellas: `routines_frequency_not_null`,
 * `routines_interval_count_not_null` y `routines_interval_count_check`.
 */
ALTER TABLE app.routines
  DROP COLUMN frequency,
  DROP COLUMN interval_count;

DROP TYPE app.routine_frequency;

-- ── 4 · El nombre que mentía ────────────────────────────────────────────────
/*
 * `routines_due_hint_idx` (0023) y la CHECK `routines_pattern_shape` citan la
 * columna y NO hay que tocarlos: las dependencias de índices y restricciones
 * sí están registradas en el catálogo y PostgreSQL reescribe su definición al
 * renombrar. El paso 6 lo verifica en vez de fiarse.
 */
ALTER TABLE app.routines RENAME COLUMN next_due_on TO next_due_hint;

COMMENT ON COLUMN app.routines.next_due_hint IS
  'Caché: cota INFERIOR de la próxima ocurrencia pendiente, o NULL si la rutina no tiene cadencia confirmada. Invariante: nunca es posterior a la ocurrencia real, para que el prefiltro «next_due_hint <= hoy» jamás oculte una rutina. La verdad está en las columnas de patrón. Se llamó next_due_on hasta la 0033, cuando el nombre dejó de mentir.';

-- ── 5 · Las funciones cuyo cuerpo cita la columna por su nombre ─────────────
/*
 * Ninguna de las dos cambia de comportamiento: se reescriben porque su cuerpo
 * es texto y el RENAME del paso 4 no lo alcanza. Dejarlas como estaban sería
 * el fallo mudo clásico —esquema impecable, primera llamada en caliente con
 * «column routine.next_due_on does not exist»—.
 */
CREATE OR REPLACE FUNCTION app.set_routine_due_hint(target_routine uuid, hint date)
RETURNS date
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;
  -- Mismo guardián que la 0009: solo tras una finalización real de este hogar.
  IF NOT EXISTS (
    SELECT 1 FROM app.routine_completions
     WHERE household_id = app.current_household_id() AND routine_id = target_routine
  ) THEN
    RAISE EXCEPTION 'no existe finalización que justifique el refresco' USING ERRCODE = '42501';
  END IF;
  UPDATE app.routines SET next_due_hint = hint
   WHERE household_id = app.current_household_id() AND id = target_routine
     AND anchor_on IS NOT NULL AND hint >= anchor_on;
  RETURN hint;
END
$$;

REVOKE ALL ON FUNCTION app.set_routine_due_hint(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_routine_due_hint(uuid, date) TO casa_clara_app;

/*
 * DROP + CREATE y no CREATE OR REPLACE: cambia el NOMBRE de una columna del
 * tipo de retorno, y eso PostgreSQL lo trata como cambiar el tipo de retorno.
 * Al recrear se pierden los privilegios y vuelve el DEFAULT (EXECUTE para
 * PUBLIC), así que REVOKE y GRANT se reemiten sin excepción: la 0011 existe
 * porque un grant de este mismo feed se perdió una vez y toda petición murió
 * con «permission denied for schema app_private».
 *
 * El LEFT JOIN y el filtro `pattern IS NOT NULL` se conservan tal cual los
 * dejó la 0023: un token válido de un hogar sin rutinas devuelve su fila de
 * feed para que el emisor pueda distinguir «no hay nada» de «este calendario
 * ya no existe» (404), y una rutina sin cadencia confirmada no publica nada.
 */
DROP FUNCTION app_private.ics_feed_events(text);

CREATE FUNCTION app_private.ics_feed_events(feed_token_hash text)
RETURNS TABLE (
  feed_id uuid,
  household_id uuid,
  feed_audience text,
  routine_id uuid,
  title text,
  details text,
  next_due_hint date,
  pattern text,
  anchor_on date,
  repeat_every integer,
  weekdays smallint[],
  month_day smallint,
  months smallint[],
  ends_on date
)
LANGUAGE sql
STABLE
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
         routine.next_due_hint,
         routine.pattern::text,
         routine.anchor_on,
         routine.repeat_every,
         routine.weekdays,
         routine.month_day,
         routine.months,
         routine.ends_on
    FROM app.ics_feeds AS feed
    LEFT JOIN app.routines AS routine
      ON routine.household_id = feed.household_id
     AND routine.archived_at IS NULL
     AND routine.pattern IS NOT NULL
     AND (feed.audience = 'all' OR routine.audience = 'all' OR routine.audience = feed.audience)
   WHERE feed.token_hash = feed_token_hash
     AND feed.revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION app_private.ics_feed_events(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.ics_feed_events(text) TO casa_clara_app;

-- ── 6 · Aserción: una contracción a medias se deshace, no se despliega ──────
DO $check$
DECLARE
  divergentes integer;
  huerfanas text;
  ics_result text;
BEGIN
  -- 6a · Fila a fila: la próxima fecha y la cadencia entera, intactas. Se
  -- comparan con IS DISTINCT FROM para que un NULL cuente como valor y no
  -- como comodín: una rutina sin cadencia confirmada tiene que seguir sin
  -- ella, y una con fecha tiene que conservar exactamente la suya.
  SELECT count(*) INTO divergentes
    FROM routine_cadence_before AS antes
    FULL JOIN app.routines AS ahora ON ahora.id = antes.id
   WHERE antes.id IS NULL
      OR ahora.id IS NULL
      OR ahora.next_due_hint  IS DISTINCT FROM antes.next_due_on
      OR ahora.pattern        IS DISTINCT FROM antes.pattern
      OR ahora.anchor_on      IS DISTINCT FROM antes.anchor_on
      OR ahora.repeat_every   IS DISTINCT FROM antes.repeat_every
      OR ahora.weekdays       IS DISTINCT FROM antes.weekdays
      OR ahora.month_day      IS DISTINCT FROM antes.month_day
      OR ahora.months         IS DISTINCT FROM antes.months
      OR ahora.ends_on        IS DISTINCT FROM antes.ends_on
      OR ahora.overdue_policy IS DISTINCT FROM antes.overdue_policy;
  IF divergentes > 0 THEN
    RAISE EXCEPTION 'la contracción movió la cadencia de % rutina(s)', divergentes;
  END IF;

  -- 6b · Ni un cuerpo de función se quedó citando lo retirado. Es el fallo que
  -- el RENAME no puede provocar por sí solo pero tampoco puede evitar.
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY p.proname)
    INTO huerfanas
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('app', 'app_private')
     AND (p.prosrc LIKE '%next_due_on%' OR p.prosrc LIKE '%interval_count%');
  IF huerfanas IS NOT NULL THEN
    RAISE EXCEPTION 'quedan funciones citando columnas retiradas: %', huerfanas;
  END IF;

  -- 6c · El feed ICS publica el nombre nuevo y ninguno de los viejos. Se mira
  -- el TIPO DE RETORNO, que es lo que consume el emisor.
  SELECT pg_catalog.pg_get_function_result(oid) INTO ics_result
    FROM pg_catalog.pg_proc
   WHERE oid = 'app_private.ics_feed_events(text)'::regprocedure;
  IF ics_result NOT LIKE '%next_due_hint%' OR ics_result LIKE '%next_due_on%'
     OR ics_result LIKE '%frequency%' OR ics_result LIKE '%interval_count%' THEN
    RAISE EXCEPTION 'el feed ICS no expone la caché renombrada: %', ics_result;
  END IF;

  -- 6d · El índice y la CHECK siguieron al RENAME. Si PostgreSQL dejara de
  -- reescribir las dependencias registradas, esto se pone rojo aquí y no en
  -- la primera consulta de «lo que toca hoy».
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
     WHERE schemaname = 'app' AND tablename = 'routines'
       AND indexname = 'routines_due_hint_idx' AND indexdef LIKE '%next_due_hint%'
  ) THEN
    RAISE EXCEPTION 'routines_due_hint_idx no siguió al renombrado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'app.routines'::regclass AND conname = 'routines_pattern_shape'
       AND pg_get_constraintdef(oid) LIKE '%next_due_hint%'
  ) THEN
    RAISE EXCEPTION 'routines_pattern_shape no siguió al renombrado';
  END IF;

  -- 6e · Y lo retirado está retirado de verdad.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'routines'
       AND column_name IN ('frequency', 'interval_count', 'next_due_on')
  ) THEN
    RAISE EXCEPTION 'las columnas heredadas siguen en app.routines';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'routine_frequency') THEN
    RAISE EXCEPTION 'el ENUM app.routine_frequency sigue en pie';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname = 'advance_routine_after_completion'
  ) THEN
    RAISE EXCEPTION 'la definer app.advance_routine_after_completion sigue en pie';
  END IF;
END
$check$;

COMMIT;
