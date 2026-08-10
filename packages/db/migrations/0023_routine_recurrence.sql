BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rutinas con ritmo propio · EXPANDIR (fase 1 de 2; la 0024 contrae).
--
-- Hoy una rutina solo sabe decir `daily|weekly|monthly|quarterly` × 1..12 con
-- una única fecha (`0008_food_and_rhythm.sql:196-214`). Con eso no se puede
-- escribir «la cocina a fondo los lunes Y los jueves», ni «el cambio de ropa de
-- temporada», ni —lo más grave— «esto se hace, falta decidir cuándo», que es el
-- estado real de la mayor parte de las tareas del manual del hogar: `frequency`
-- y `next_due_on` son NOT NULL, así que ese estado sencillamente no existe.
--
-- Esta migración añade el vocabulario (§2.2 de docs/rutinas-y-calendario.md),
-- las restricciones que impiden los estados imposibles (§2.4), rellena las
-- rutinas existentes SIN moverles la próxima fecha (§3.2) y reescribe las
-- funciones SECURITY DEFINER que dependían de la recurrencia (§5.1, §5.4).
--
-- ORDEN OBLIGATORIO (§3.1). No es estética: la 0021 pasó todas las suites con
-- las tablas vacías y reventó contra datos reales con «cannot ALTER TABLE …
-- because it has pending trigger events», porque un UPDATE deja en cola las
-- comprobaciones diferidas y el ALTER TABLE siguiente ya no puede correr.
--
--   1. CREATE TYPE + la función de forma de los arrays.
--   2. TODOS los ADD COLUMN, sin CHECK y sin NOT NULL, más el DROP NOT NULL.
--   3. El UPDATE de relleno.
--   4. SET CONSTRAINTS ALL IMMEDIATE  ← la línea que faltó en la 0021.
--   5. Aserción de coherencia: si el relleno no reproduce `next_due_on`, la
--      migración entera se deshace.
--   6. Recién ahora, las CHECK y los COMMENT.
--   7. DROP+CREATE del feed ICS (CREATE OR REPLACE no puede cambiar el tipo de
--      retorno) reemitiendo REVOKE y GRANT.
--   8. Las dos funciones definer nuevas.
--
-- Lo que NO se toca a propósito: `frequency`, `interval_count`,
-- `app.advance_routine_after_completion` y `app.routine_completions` entera. La
-- clave primaria de las finalizaciones ya es (household_id, routine_id,
-- due_on): las ocurrencias YA están indexadas una a una, y por eso «lunes y
-- jueves» cabe sin tocar esa tabla. Retirar lo viejo es trabajo de la 0024,
-- separado por un despliegue para que ningún envelope encolado sin conexión se
-- pierda.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1 · Vocabulario ─────────────────────────────────────────────────────────
/*
 * Campos propios cerrados, NO RRULE (§2.1). El argumento decisivo no es la
 * expresividad: el subconjunto de RRULE que este repo ya parsea
 * (`apps/worker/src/ics.ts:426,443,463`) rechaza YEARLY —justo lo estacional— y
 * prohíbe BYDAY fuera de WEEKLY. Adoptarlo obligaría a extender el parser por
 * donde se cerró, escribir un segundo parser en plpgsql y volver a parsear la
 * cadena para pintar el formulario de la familia. Con cuatro columnas, la CHECK
 * valida en base y el formulario ES el esquema. RRULE se emite al generar el
 * feed ICS, que es la dirección fácil.
 *
 * Un quinto valor («el segundo martes de cada mes») se añade después sin tocar
 * ninguna fila existente. AVISO para quien lo haga: la CHECK de forma de más
 * abajo es un CASE sin ELSE, así que un valor nuevo sin su rama evaluaría a
 * NULL y la restricción lo dejaría pasar todo. Añadir valor ⇒ añadir rama.
 */
CREATE TYPE app.routine_pattern AS ENUM (
  'every_n_days',    -- «todos los días», «cada 3 días», «cada 15 días»
  'days_of_week',    -- «los lunes y los jueves», «cada 2 semanas los martes»
  'day_of_month',    -- «el día 1 de cada mes», «cada 3 meses»
  'months_of_year'   -- «en junio y en diciembre» → las temporadas
);

/*
 * `carry` = la ocurrencia se arrastra hasta que alguien la marque, y se enseña
 * UNA sola línea, la más antigua pendiente. `skip` = si no se hizo, la
 * ocurrencia de hoy sustituye a la de ayer. Es lo que impide que diez rutinas
 * diarias por siete días de vacaciones se conviertan en setenta filas y setenta
 * toques. En fase 1 no hay control en la interfaz: el valor se deriva del
 * patrón en un único sitio del servidor (§2.5); la columna existe para que la
 * excepción futura no necesite otra migración.
 */
CREATE TYPE app.routine_overdue_policy AS ENUM ('carry', 'skip');

/*
 * Un conjunto de números pequeños bien formado: no vacío, sin repetidos,
 * ordenado y dentro de rango. Ordenado y sin repetidos no es capricho estético:
 * hace que dos reglas iguales se comparen como iguales y que el generador de
 * ocurrencias no tenga que normalizar nada.
 *
 * IMMUTABLE porque la usa una CHECK. Solo toca funciones de pg_catalog, así que
 * el search_path fijo no le quita nada y le quita una vía de secuestro.
 */
CREATE FUNCTION app.is_normalized_smallints(vals smallint[], lo smallint, hi smallint)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT vals IS NOT NULL
     AND cardinality(vals) BETWEEN 1 AND (hi - lo + 1)
     AND vals = (SELECT array_agg(v ORDER BY v) FROM (SELECT DISTINCT unnest(vals) AS v) d)
     AND (SELECT bool_and(v BETWEEN lo AND hi) FROM unnest(vals) v)
$$;

COMMENT ON FUNCTION app.is_normalized_smallints(smallint[], smallint, smallint) IS
  'true si el array no es nulo ni vacío, está ordenado, sin repetidos y dentro de [lo, hi]. Pensada para las CHECK de forma de app.routines.';

-- ── 2 · Columnas: todas de golpe, sin CHECK y sin NOT NULL ──────────────────
/*
 * `pattern` es NULLABLE a conciencia (§2.3). `pattern IS NULL` significa «se
 * hace, falta decidir cuándo», y es el desbloqueo más importante de toda la
 * ola: sin ese estado, las ~21 tareas de zona y colada que el manual nombra sin
 * frecuencia no pueden entrar en el sistema para que la familia les ponga día
 * después, y los tres planes del manual siguen vacíos porque no hay nada que
 * editar.
 *
 * Esa fila aparece en la página de Rutinas y JAMÁS en Hoy, ni en el calendario,
 * ni en el ICS, ni en los avisos — y no hace falta tocar una línea de las
 * consultas: los prefiltros `next_due_on <= $2` excluyen NULL por sí solos.
 * Esa es exactamente la razón de que la CHECK de más abajo exija
 * `next_due_on IS NULL` cuando no hay patrón.
 *
 * `overdue_policy` es la única que puede nacer NOT NULL: tiene DEFAULT, así que
 * PostgreSQL la rellena sin reescribir la tabla y sin necesitar el UPDATE. Las
 * demás nacen nulas porque el paso 3 es quien les da valor.
 */
ALTER TABLE app.routines
  ADD COLUMN pattern        app.routine_pattern,
  ADD COLUMN anchor_on      date,
  ADD COLUMN repeat_every   integer,
  ADD COLUMN weekdays       smallint[],
  ADD COLUMN month_day      smallint,
  ADD COLUMN months         smallint[],
  ADD COLUMN overdue_policy app.routine_overdue_policy NOT NULL DEFAULT 'carry',
  ADD COLUMN ends_on        date;

ALTER TABLE app.routines ALTER COLUMN next_due_on DROP NOT NULL;

-- ── 3 · Relleno desde lo heredado (§3.2) ────────────────────────────────────
/*
 *   daily,     k  →  every_n_days,  repeat_every = k
 *   weekly,    k  →  days_of_week,  repeat_every = k,     weekdays = [isodow]
 *   monthly,   k  →  day_of_month,  repeat_every = k,     month_day = day
 *   quarterly, k  →  day_of_month,  repeat_every = 3·k,   month_day = day
 *
 * En todas: `anchor_on = next_due_on`. Con eso NINGUNA rutina pierde su próxima
 * fecha, y no por suerte: el ancla es por construcción una ocurrencia de la
 * regla nueva, y es justo la que estaba pendiente. El paso 5 lo comprueba fila
 * a fila en vez de fiarse de este comentario.
 *
 * `overdue_policy` se deriva, no se pone a `carry` para todo (§2.5): sub-semanal
 * → `skip`, de semanal para arriba → `carry`. Cambio de semántica ACEPTADO a
 * conciencia: las rutinas diarias pasan de arrastrar a caducar al acabar su
 * día. Es el arreglo que se busca —hoy una semana de vacaciones deja siete
 * líneas «Vencía el…»—, no un efecto colateral.
 */
UPDATE app.routines
   SET pattern = CASE frequency
                   WHEN 'daily'   THEN 'every_n_days'
                   WHEN 'weekly'  THEN 'days_of_week'
                   ELSE                'day_of_month'
                 END::app.routine_pattern,
       anchor_on = next_due_on,
       repeat_every = CASE frequency
                        WHEN 'quarterly' THEN 3 * interval_count
                        ELSE                  interval_count
                      END,
       weekdays = CASE frequency
                    WHEN 'weekly' THEN ARRAY[extract(isodow FROM next_due_on)::smallint]
                    ELSE NULL
                  END,
       month_day = CASE frequency
                     WHEN 'monthly'   THEN extract(day FROM next_due_on)::smallint
                     WHEN 'quarterly' THEN extract(day FROM next_due_on)::smallint
                     ELSE NULL
                   END,
       months = NULL,
       ends_on = NULL,
       overdue_policy = CASE
                          WHEN frequency = 'daily' AND interval_count <= 6 THEN 'skip'
                          WHEN frequency = 'weekly'                        THEN 'skip'
                          ELSE                                                  'carry'
                        END::app.routine_overdue_policy;

-- ── 4 · Vaciar la cola de comprobaciones diferidas ──────────────────────────
/*
 * La línea que faltó en la 0021. Un UPDATE deja pendientes las comprobaciones
 * diferidas que haya en juego; con las tablas vacías no hay ninguna y el fallo
 * no se ve, pero en cuanto hay historial el ALTER TABLE siguiente muere con
 * «cannot ALTER TABLE … because it has pending trigger events».
 *
 * Hoy `app.routines` no tiene ningún CONSTRAINT TRIGGER diferido propio, así
 * que aquí la línea no arregla un fallo conocido: es disciplina. Vale
 * exactamente lo que cuesta (nada) y cubre el día en que alguien añada uno, o
 * en que este UPDATE crezca hasta tocar una tabla que sí los tenga. Si algo no
 * cuadrara, fallaría aquí y la migración entera se desharía.
 */
SET CONSTRAINTS ALL IMMEDIATE;

-- ── 5 · Aserción: una migración a medias se deshace, no se despliega ────────
/*
 * §3.3, literal. La última condición (`anchor_on <> next_due_on`) subsume a la
 * de `every_n_days`; se conserva la comprobación por patrón porque es la que
 * dice QUÉ se rompió cuando salta.
 */
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM app.routines WHERE pattern IS NULL OR anchor_on IS NULL) THEN
    RAISE EXCEPTION 'quedan rutinas sin patrón tras el relleno';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.routines
     WHERE (pattern = 'days_of_week'
            AND NOT (extract(isodow FROM next_due_on)::smallint = ANY (weekdays)))
        OR (pattern = 'day_of_month'
            AND month_day <> extract(day FROM next_due_on)::smallint)
        OR (pattern = 'every_n_days' AND anchor_on <> next_due_on)
        OR anchor_on <> next_due_on
  ) THEN
    RAISE EXCEPTION 'la regla derivada no reproduce next_due_on';
  END IF;
END
$check$;

/*
 * Límite conocido e IRRECUPERABLE, dicho en voz alta en vez de escondido: si
 * una rutina mensual venía del día 31 y el avance viejo ya la había recortado a
 * 28/02, `month_day` queda en 28 y la intención original se ha perdido. No hay
 * de dónde sacarla (la primera finalización lleva el mismo recorte). Lo que sí
 * se puede hacer es señalarlas para que una persona las mire: en producción son
 * las 5 rutinas sembradas del manual, inspección de un minuto.
 */
DO $review$
DECLARE
  suspicious record;
BEGIN
  FOR suspicious IN
    SELECT household_id, id, title, next_due_on
      FROM app.routines
     WHERE pattern = 'day_of_month'
       AND month_day >= 28
     ORDER BY household_id, title
  LOOP
    RAISE NOTICE 'revisar a mano: rutina % (%) del hogar % quedó con day_of_month=% desde next_due_on=%; si venía del 31 el recorte ya era anterior a esta migración',
      suspicious.title, suspicious.id, suspicious.household_id,
      extract(day FROM suspicious.next_due_on), suspicious.next_due_on;
  END LOOP;
END
$review$;

-- ── 6 · Restricciones de forma y documentación ──────────────────────────────
/*
 * El estado imposible que esta CHECK persigue no es «un número fuera de rango»:
 * es «una rutina sin patrón que sin embargo tiene fecha», porque esa fila SÍ
 * pasaría el prefiltro `next_due_on <= hoy` y aparecería en Hoy como una tarea
 * que nadie ha decidido cuándo se hace. Por eso la rama de `pattern IS NULL`
 * exige que TODO lo demás, incluida `next_due_on`, esté vacío.
 *
 * El 36 de `day_of_month` no es capricho: `interval_count` admite hasta 12 y una
 * rutina `quarterly` con intervalo 12 son 36 meses. Una CHECK de 24 haría
 * fallar esta misma migración sobre datos reales.
 */
ALTER TABLE app.routines ADD CONSTRAINT routines_pattern_shape CHECK (
  CASE
    WHEN pattern IS NULL THEN
      anchor_on IS NULL AND repeat_every IS NULL AND weekdays IS NULL
      AND month_day IS NULL AND months IS NULL AND next_due_on IS NULL
      AND ends_on IS NULL
    ELSE
      anchor_on IS NOT NULL AND
      CASE pattern
        WHEN 'every_n_days' THEN
          repeat_every BETWEEN 1 AND 366
          AND weekdays IS NULL AND month_day IS NULL AND months IS NULL
        WHEN 'days_of_week' THEN
          repeat_every BETWEEN 1 AND 12
          AND app.is_normalized_smallints(weekdays, 1::smallint, 7::smallint)
          AND month_day IS NULL AND months IS NULL
        WHEN 'day_of_month' THEN
          repeat_every BETWEEN 1 AND 36
          AND (month_day = -1 OR month_day BETWEEN 1 AND 31)
          AND weekdays IS NULL AND months IS NULL
        WHEN 'months_of_year' THEN
          repeat_every IS NULL
          AND (month_day = -1 OR month_day BETWEEN 1 AND 31)
          AND app.is_normalized_smallints(months, 1::smallint, 12::smallint)
          AND weekdays IS NULL
      END
  END
);

ALTER TABLE app.routines ADD CONSTRAINT routines_ends_after_anchor
  CHECK (ends_on IS NULL OR anchor_on IS NULL OR ends_on >= anchor_on);

COMMENT ON COLUMN app.routines.pattern IS
  'Clase de ritmo. NULL = «se hace, falta decidir cuándo»: sale en la página de Rutinas y en ningún otro sitio.';
COMMENT ON COLUMN app.routines.anchor_on IS
  'Desde cuándo rige la regla; da la FASE. Las ocurrencias se generan DESDE aquí, nunca desde la última completada: por eso una mensual anclada el 31 hace 31/01 → 28/02 → 31/03 en vez de degradarse a 28 para siempre.';
COMMENT ON COLUMN app.routines.repeat_every IS
  'Cada cuántos días (every_n_days), semanas (days_of_week) o meses (day_of_month). NULL en months_of_year, donde el año es el periodo.';
COMMENT ON COLUMN app.routines.weekdays IS
  'Días de la semana en convención ISO 1=lunes … 7=domingo, ordenados y sin repetidos. La conversión a la convención 0..6 del ICS se hace SOLO en la frontera del ICS.';
COMMENT ON COLUMN app.routines.month_day IS
  'Día del mes 1..31, o -1 = «último día del mes». Un día mayor que el último del mes se RECORTA, no se salta: saltar significaría que en febrero no se hace la limpieza a fondo.';
COMMENT ON COLUMN app.routines.months IS
  'Meses del año 1..12 para months_of_year, ordenados y sin repetidos. Las temporadas son meteorológicas: 3, 6, 9, 12.';
COMMENT ON COLUMN app.routines.overdue_policy IS
  'carry: se arrastra hasta que alguien la marque, y se enseña UNA línea, la más antigua pendiente. skip: la ocurrencia de hoy sustituye a la de ayer.';
COMMENT ON COLUMN app.routines.ends_on IS
  'Última fecha en que la regla puede producir ocurrencias. Sin control en la interfaz: existe para el ICS y el archivado.';
COMMENT ON COLUMN app.routines.next_due_on IS
  'Caché: cota INFERIOR de la próxima ocurrencia pendiente, o NULL si la rutina no tiene cadencia confirmada. Invariante: nunca es posterior a la ocurrencia real, para que el prefiltro «next_due_on <= hoy» jamás oculte una rutina. La verdad está en las columnas de patrón.';
COMMENT ON COLUMN app.routines.frequency IS
  'RELIQUIA de 0008, en pie solo durante la ventana de despliegue de la 0023. La verdad de la cadencia está en pattern y sus columnas. La 0024 la retira.';
COMMENT ON COLUMN app.routines.interval_count IS
  'RELIQUIA de 0008, en pie solo durante la ventana de despliegue de la 0023. La 0024 la retira.';

/*
 * Ayuda de consulta para el único prefiltro caliente que existe («lo que toca
 * hoy», `today.server.ts` y `snapshot.server.ts`). Hasta ahora `app.routines` no
 * tenía ni un índice y no hacía falta: son decenas de filas por hogar. Lo que
 * cambia con esta ola es la PROPORCIÓN: el volcado del manual mete del orden de
 * 21 rutinas sin cadencia por hogar, que son justamente las que este índice
 * parcial deja fuera. El índice indexa lo que se consulta y nada más.
 */
CREATE INDEX routines_due_hint_idx
  ON app.routines (household_id, next_due_on)
  WHERE archived_at IS NULL AND next_due_on IS NOT NULL;

-- ── 7 · Feed ICS: deja de exponer la recurrencia vieja ──────────────────────
/*
 * DROP + CREATE y no CREATE OR REPLACE: no se puede cambiar el tipo de retorno
 * de una función existente.
 *
 * Y REVOKE + GRANT reemitidos, sin excepción: al recrear la función se pierden
 * sus privilegios y vuelve el DEFAULT (EXECUTE para PUBLIC). La migración 0011
 * existe precisamente porque un grant de este feed se perdió una vez y toda
 * petición murió con «permission denied for schema app_private».
 *
 * Las filas con `pattern IS NULL` se omiten (una rutina sin cadencia no tiene
 * nada que publicar). El LEFT JOIN se conserva para que un token válido de un
 * hogar sin rutinas devuelva su fila de feed y el emisor pueda distinguir «no
 * hay nada» de «este calendario ya no existe» (404).
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
  next_due_on date,
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
         routine.next_due_on,
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

-- ── 8 · Las dos funciones definer nuevas ────────────────────────────────────
/*
 * `app.advance_routine_after_completion` (0009) existía por un motivo estrecho:
 * la RLS solo deja escribir `app.routines` a la familia, pero la empleada y el
 * apoyo también completan. Ese motivo sigue en pie SOLO para refrescar la
 * caché. De ~30 líneas con un `CASE frequency` a un UPDATE de una columna:
 * desaparece la cuarta copia del algoritmo de recurrencia y se encoge la
 * superficie de seguridad.
 *
 * Devuelve `hint` aunque el UPDATE no llegue a aplicarse (rutina de otro hogar,
 * `hint` anterior al ancla, cadencia aún sin confirmar). No es un descuido: por
 * la invariante de cota inferior, dejar la caché como estaba solo puede dejarla
 * ATRÁS, el prefiltro selecciona de más y el generador descarta. Nunca puede
 * ocultar una rutina, que es lo único que no se puede permitir.
 *
 * La 0009 se deja en pie: durante la ventana de despliegue el código anterior
 * sigue llamándola y sigue funcionando igual. La retira la 0024.
 */
CREATE FUNCTION app.set_routine_due_hint(target_routine uuid, hint date)
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
  UPDATE app.routines SET next_due_on = hint
   WHERE household_id = app.current_household_id() AND id = target_routine
     AND anchor_on IS NOT NULL AND hint >= anchor_on;
  RETURN hint;
END
$$;

REVOKE ALL ON FUNCTION app.set_routine_due_hint(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_routine_due_hint(uuid, date) TO casa_clara_app;

/*
 * Entrada del barrido diario de avisos (§5.2), que sustituye al job por
 * ocurrencia. El encolado actual tiene dos fallos que «lunes y jueves» obliga a
 * mirar de frente: editar una rutina no rearma nada, y una rutina que nadie
 * completa nunca vuelve a avisar. Un job al día los cierra los dos.
 *
 * Dos cosas se resuelven AQUÍ DENTRO y no en el worker, y las dos por el mismo
 * motivo —que el worker no tiene contexto de hogar ni debe tenerlo—:
 *
 *   · Los destinatarios, con la lista COMPLETA. Hoy `resolveAudienceRecipients`
 *     los lee bajo la RLS de quien encoló, de modo que un `family_member` o la
 *     empleada encolan avisos con la lista parcial que su RLS les deja ver.
 *   · La correspondencia audiencia → roles, que es AC-25 escrito en SQL:
 *     `family` JAMÁS incluye a la empleada, y `helper` no recibe aviso aunque
 *     vea la rutina.
 *
 * Las ocurrencias NO se calculan aquí: se generan en el worker con el mismo
 * módulo puro que usan Hoy y el calendario. Esta función devuelve reglas y
 * hechos, no fechas derivadas — es justo lo contrario de lo que hacía la 0009.
 *
 * `completed_due_ons` llega acotado a la misma ventana de 400 días que usa el
 * generador, para que `pendingFor` reciba el conjunto que espera sin que el
 * array pueda crecer sin tope. Los prefiltros de la cláusula WHERE tampoco
 * pueden esconder nada: descartan lo archivado, lo que aún no ha empezado y lo
 * que terminó antes de que la ventana empiece.
 */
CREATE FUNCTION app_private.routine_digest_inputs(for_date date)
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
