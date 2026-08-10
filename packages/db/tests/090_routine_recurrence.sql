-- Recurrencia de rutinas tras la migración 0023: comportamiento, no catálogo.
--
-- Cubre las cuatro cosas que pueden salir mal de verdad:
--
--   1. Que la CHECK de forma deje pasar un estado imposible. El peor de todos no
--      es un número fuera de rango: es una rutina SIN cadencia confirmada que
--      conserve `next_due_on`, porque esa fila pasaría el prefiltro
--      «next_due_on <= hoy» y aparecería en Hoy como trabajo que nadie ha
--      decidido cuándo se hace.
--   2. Que las columnas nuevas abran una rendija en el aislamiento por hogar o
--      en el modelo de audiencia. Enmienda del propietario E3: la interna ve sus
--      rutinas y las de toda la casa, NUNCA las de audiencia `family` — ni la
--      fila, ni su patrón, ni sus finalizaciones.
--   3. Que `app.set_routine_due_hint` (la definer que sustituye al avance de la
--      0009) se convierta en una vía para escribir en `app.routines` sin
--      contexto, sin finalización que lo justifique o en otro hogar.
--   4. Que el feed ICS publique lo que no debe (rutinas sin cadencia) o pierda
--      su GRANT al recrearse — que es literalmente lo que pasó una vez y por lo
--      que existe la migración 0011.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- UUIDs con prefijos ea* (roble) / eb* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off).
--
-- Una rutina por patrón más la que no tiene ninguno, para que las asercciones
-- de visibilidad tengan algo real que filtrar en cada rama de la CHECK. Los
-- correos no vienen en las fixtures y los necesita el barrido de avisos: se
-- ponen aquí, incluido el de una membresía REVOCADA, que es el negativo que
-- comprueba que la definer filtra por vigencia y no solo por rol.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

UPDATE app.user_profiles SET email = 'admin.roble@casa.demo'     WHERE user_id = 'fixture:roble:admin';
UPDATE app.user_profiles SET email = 'familiar.roble@casa.demo'  WHERE user_id = 'fixture:roble:family';
UPDATE app.user_profiles SET email = 'empleada.roble@casa.demo'  WHERE user_id = 'fixture:roble:employee';
UPDATE app.user_profiles SET email = 'apoyo.roble@casa.demo'     WHERE user_id = 'fixture:roble:helper';
UPDATE app.user_profiles SET email = 'visor.roble@casa.demo'     WHERE user_id = 'fixture:roble:viewer';
UPDATE app.user_profiles SET email = 'empleada2.roble@casa.demo' WHERE user_id = 'fixture:roble:employee2';

INSERT INTO app.user_profiles (user_id, display_name, email) VALUES
  ('fixture:roble:revocada', 'Fixture Empleada Revocada Roble', 'revocada.roble@casa.demo');
INSERT INTO app.household_memberships (id, household_id, user_id, role, starts_at, revoked_at) VALUES
  ('ea000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'fixture:roble:revocada', 'employee_live_in',
   statement_timestamp() - interval '400 days', statement_timestamp() - interval '30 days');

INSERT INTO app.routines (
  id, household_id, title, details, audience, frequency, interval_count, next_due_on,
  pattern, anchor_on, repeat_every, weekdays, month_day, months, overdue_policy, ends_on,
  created_by_membership_id
) VALUES
  -- Estacional de la familia: «al empezar el verano y al empezar el invierno».
  ('ea100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Cambio de ropa de temporada', 'Armarios de toda la casa.', 'family',
   'quarterly', 2, '2026-12-01',
   'months_of_year', '2026-06-01', NULL, NULL, 1, ARRAY[6, 12]::smallint[], 'carry', NULL,
   '11000000-0000-4000-8000-000000000001'),
  -- «Los lunes y los jueves», que es justo lo que el modelo viejo no sabía decir.
  ('ea100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'Cocina a fondo', 'Campana, horno y frigorífico.', 'employee',
   'weekly', 1, '2026-08-13',
   'days_of_week', '2026-08-10', 1, ARRAY[1, 4]::smallint[], NULL, NULL, 'skip', NULL,
   '11000000-0000-4000-8000-000000000001'),
  -- Diaria de toda la casa: sub-semanal, luego `skip`.
  ('ea100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'Ventilación de la mañana', 'Ventilar solo de forma segura.', 'all',
   'daily', 1, '2026-08-10',
   'every_n_days', '2026-08-10', 1, NULL, NULL, NULL, 'skip', NULL,
   '11000000-0000-4000-8000-000000000001'),
  -- «El último día del mes» dicho como lo que es, en vez de un 31 que el avance
  -- viejo degradaba a 28 para siempre en cuanto pasaba por febrero.
  ('ea100000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   'Lectura de contadores', 'Agua y luz.', 'all',
   'monthly', 1, '2026-08-31',
   'day_of_month', '2026-08-31', 1, NULL, -1, NULL, 'carry', NULL,
   '11000000-0000-4000-8000-000000000001'),
  -- SIN CADENCIA: el estado que esta ola existe para poder expresar.
  ('ea100000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001',
   'Limpieza a fondo del garaje', 'Falta acordar cada cuánto.', 'employee',
   'monthly', 1, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, 'carry', NULL,
   '11000000-0000-4000-8000-000000000001'),
  -- Del otro hogar, para que las asercciones cruzadas tengan una fila que filtrar.
  ('eb100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Rutina estacional del olivo', 'Del otro hogar.', 'all',
   'quarterly', 1, '2026-09-01',
   'months_of_year', '2026-09-01', NULL, NULL, 1, ARRAY[3, 9]::smallint[], 'carry', NULL,
   '21000000-0000-4000-8000-000000000001');

-- Una finalización de la rutina familiar y otra de la de la empleada. La
-- primera es la que la interna NO debe poder leer; la segunda es la que
-- justifica el refresco de caché más abajo.
INSERT INTO app.routine_completions (household_id, routine_id, due_on, completed_by_membership_id) VALUES
  ('10000000-0000-4000-8000-000000000001', 'ea100000-0000-4000-8000-000000000001', '2026-06-01',
   '11000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', 'ea100000-0000-4000-8000-000000000002', '2026-08-10',
   '11000000-0000-4000-8000-000000000003');

INSERT INTO app.ics_feeds (id, household_id, audience, token_hash, created_by_membership_id, revoked_at) VALUES
  ('ea200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'all', repeat('a', 64), '11000000-0000-4000-8000-000000000001', NULL),
  ('ea200000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'all', repeat('b', 64), '11000000-0000-4000-8000-000000000001', statement_timestamp());

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Forma: los estados imposibles se rechazan, uno por uno y con nombre.
--
-- Todos los intentos fallan, así que el bloque no deja ninguna fila detrás; la
-- última comprobación lo verifica en vez de darlo por hecho.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_pattern_shape$
DECLARE
  attempt record;
  leftovers integer;
BEGIN
  FOR attempt IN
    SELECT * FROM (VALUES
      -- El estado imposible que de verdad importa: sin cadencia pero con fecha.
      -- Esa fila pasaría el prefiltro de Hoy y saldría como trabajo pendiente.
      ('sin cadencia con next_due_on',
       NULL::text, NULL::date, NULL::integer, NULL::smallint[], NULL::smallint, NULL::smallint[], NULL::date, '2026-08-10'::date),
      ('sin cadencia con ancla',
       NULL, '2026-08-10', NULL, NULL, NULL, NULL, NULL, NULL),
      ('sin cadencia con intervalo',
       NULL, NULL, 3, NULL, NULL, NULL, NULL, NULL),
      ('sin cadencia con fecha de fin',
       NULL, NULL, NULL, NULL, NULL, NULL, '2026-12-31', NULL),
      -- Con patrón, el ancla no es opcional: sin fase no hay ocurrencias.
      ('con patrón y sin ancla',
       'every_n_days', NULL, 1, NULL, NULL, NULL, NULL, NULL),
      ('every_n_days con días de la semana',
       'every_n_days', '2026-08-10', 1, ARRAY[1]::smallint[], NULL, NULL, NULL, NULL),
      ('every_n_days cada 0 días',
       'every_n_days', '2026-08-10', 0, NULL, NULL, NULL, NULL, NULL),
      ('every_n_days cada 367 días',
       'every_n_days', '2026-08-10', 367, NULL, NULL, NULL, NULL, NULL),
      ('days_of_week sin ningún día',
       'days_of_week', '2026-08-10', 1, ARRAY[]::smallint[], NULL, NULL, NULL, NULL),
      ('days_of_week con los días desordenados',
       'days_of_week', '2026-08-10', 1, ARRAY[4,1]::smallint[], NULL, NULL, NULL, NULL),
      ('days_of_week con un día repetido',
       'days_of_week', '2026-08-10', 1, ARRAY[1,1]::smallint[], NULL, NULL, NULL, NULL),
      -- Domingo es 7 en ISO, no 0: la convención 0..6 es del ICS y se queda en
      -- la frontera del ICS. Aquí un 0 es un error de conversión, no un domingo.
      ('days_of_week con el domingo a la manera del ICS',
       'days_of_week', '2026-08-10', 1, ARRAY[0]::smallint[], NULL, NULL, NULL, NULL),
      ('days_of_week con un octavo día',
       'days_of_week', '2026-08-10', 1, ARRAY[8]::smallint[], NULL, NULL, NULL, NULL),
      ('days_of_week cada 13 semanas',
       'days_of_week', '2026-08-10', 13, ARRAY[1]::smallint[], NULL, NULL, NULL, NULL),
      ('day_of_month cada 37 meses',
       'day_of_month', '2026-08-10', 37, NULL, 1, NULL, NULL, NULL),
      ('day_of_month con día 0',
       'day_of_month', '2026-08-10', 1, NULL, 0, NULL, NULL, NULL),
      ('day_of_month con día 32',
       'day_of_month', '2026-08-10', 1, NULL, 32, NULL, NULL, NULL),
      -- -1 es «el último día»; no hay «el penúltimo».
      ('day_of_month con penúltimo día',
       'day_of_month', '2026-08-10', 1, NULL, -2, NULL, NULL, NULL),
      ('day_of_month con meses del año',
       'day_of_month', '2026-08-10', 1, NULL, 1, ARRAY[6]::smallint[], NULL, NULL),
      ('months_of_year con intervalo',
       'months_of_year', '2026-08-10', 2, NULL, 1, ARRAY[6]::smallint[], NULL, NULL),
      ('months_of_year con un mes 13',
       'months_of_year', '2026-08-10', NULL, NULL, 1, ARRAY[13]::smallint[], NULL, NULL),
      ('months_of_year sin meses',
       'months_of_year', '2026-08-10', NULL, NULL, 1, NULL, NULL, NULL),
      ('la serie termina antes de empezar',
       'every_n_days', '2026-08-10', 1, NULL, NULL, NULL, '2026-08-09', NULL)
    ) AS cases(label, pattern, anchor_on, repeat_every, weekdays, month_day, months, ends_on, next_due_on)
  LOOP
    BEGIN
      INSERT INTO app.routines (
        id, household_id, title, audience, frequency, interval_count,
        pattern, anchor_on, repeat_every, weekdays, month_day, months, ends_on, next_due_on,
        created_by_membership_id
      ) VALUES (
        'ea900000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        'Intento imposible', 'all', 'daily', 1,
        attempt.pattern::app.routine_pattern, attempt.anchor_on, attempt.repeat_every,
        attempt.weekdays, attempt.month_day, attempt.months, attempt.ends_on, attempt.next_due_on,
        '11000000-0000-4000-8000-000000000001'
      );
      RAISE EXCEPTION 'la CHECK de forma aceptó un estado imposible: %', attempt.label;
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
  END LOOP;

  SELECT count(*)::integer INTO leftovers
    FROM app.routines WHERE id = 'ea900000-0000-4000-8000-000000000001';
  IF leftovers <> 0 THEN
    RAISE EXCEPTION 'los intentos imposibles dejaron % filas detrás', leftovers;
  END IF;
END
$assert_pattern_shape$;

-- Y las reglas legítimas del límite entran. El 36 no es un capricho de la
-- CHECK: `interval_count` admitía hasta 12 y una `quarterly` con intervalo 12
-- son 36 meses, así que una cota de 24 habría hecho fallar la propia migración
-- sobre datos reales.
DO $assert_pattern_accepts$
DECLARE
  accepted integer;
BEGIN
  INSERT INTO app.routines (
    id, household_id, title, audience, frequency, interval_count, next_due_on,
    pattern, anchor_on, repeat_every, weekdays, month_day, ends_on, created_by_membership_id
  ) VALUES
    ('ea900000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
     'Trimestral heredada al límite', 'all', 'quarterly', 12, '2026-08-31',
     'day_of_month', '2026-08-31', 36, NULL, 31, NULL, '11000000-0000-4000-8000-000000000001'),
    -- Una serie que empieza y acaba el mismo día: `ends_on = anchor_on` es el
    -- borde exacto de routines_ends_after_anchor, y tiene que caber.
    ('ea900000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
     'Serie de un solo día', 'all', 'weekly', 1, '2026-08-10',
     'days_of_week', '2026-08-10', 2, ARRAY[1,3,5]::smallint[], NULL, '2026-08-10',
     '11000000-0000-4000-8000-000000000001');

  -- La CHECK vigila también los UPDATE, no solo las altas: cambiar de patrón
  -- sin limpiar las columnas del anterior es la forma más fácil de dejar una
  -- regla incoherente.
  BEGIN
    UPDATE app.routines SET pattern = 'every_n_days'
     WHERE id = 'ea900000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'se pudo cambiar de patrón dejando los días de la semana puestos';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  SELECT count(*)::integer INTO accepted
    FROM app.routines
   WHERE id IN ('ea900000-0000-4000-8000-000000000002', 'ea900000-0000-4000-8000-000000000003');
  IF accepted <> 2 THEN
    RAISE EXCEPTION 'las reglas legítimas del límite no entraron';
  END IF;

  -- No se quedan: los recuentos de visibilidad de más abajo cuentan la siembra.
  DELETE FROM app.routines
   WHERE id IN ('ea900000-0000-4000-8000-000000000002', 'ea900000-0000-4000-8000-000000000003');
END
$assert_pattern_accepts$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- E3 · «Familia completo, interna solo lo suyo».
--
-- La separación se impone EN LA CONSULTA BAJO RLS, no filtrando en el cliente.
-- Esta es la prueba negativa que la enmienda exige: la interna no recibe una
-- rutina de audiencia `family` por ninguna vía, ni la fila, ni sus columnas de
-- patrón, ni sus finalizaciones.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_never_sees_family_routines$
DECLARE
  family_rows integer;
  patterns_leaked integer;
  completions_leaked integer;
  cross_tenant integer;
  own_rows integer;
  updated integer;
BEGIN
  SELECT count(*)::integer INTO family_rows FROM app.routines WHERE audience = 'family';
  IF family_rows <> 0 THEN
    RAISE EXCEPTION 'la interna vio % rutinas de audiencia family', family_rows;
  END IF;

  -- La misma pregunta por la puerta de atrás: por el id concreto de la rutina
  -- familiar y por la columna NUEVA, que es la que esta migración estrena.
  SELECT count(*)::integer INTO patterns_leaked
    FROM app.routines
   WHERE id = 'ea100000-0000-4000-8000-000000000001'
      OR pattern = 'months_of_year';
  IF patterns_leaked <> 0 THEN
    RAISE EXCEPTION 'las columnas de patrón filtraron la rutina familiar (% filas)', patterns_leaked;
  END IF;

  SELECT count(*)::integer INTO completions_leaked
    FROM app.routine_completions
   WHERE routine_id = 'ea100000-0000-4000-8000-000000000001';
  IF completions_leaked <> 0 THEN
    RAISE EXCEPTION 'la interna leyó % finalizaciones de una rutina familiar', completions_leaked;
  END IF;

  -- Lo suyo y lo de toda la casa sí, incluida la que no tiene cadencia: se
  -- gestiona en la página de Rutinas aunque no aparezca en Hoy.
  SELECT count(*)::integer INTO own_rows
    FROM app.routines
   WHERE id IN ('ea100000-0000-4000-8000-000000000002',
                'ea100000-0000-4000-8000-000000000003',
                'ea100000-0000-4000-8000-000000000004',
                'ea100000-0000-4000-8000-000000000005');
  IF own_rows <> 4 THEN
    RAISE EXCEPTION 'la interna debería ver sus 4 rutinas y vio %', own_rows;
  END IF;

  SELECT count(*)::integer INTO cross_tenant
    FROM app.routines WHERE household_id = '20000000-0000-4000-8000-000000000001';
  IF cross_tenant <> 0 THEN
    RAISE EXCEPTION 'la interna alcanzó % rutinas del otro hogar', cross_tenant;
  END IF;

  -- Escribir la cadencia sigue siendo cosa de la familia: la política de
  -- escritura no se aflojó al añadir columnas.
  UPDATE app.routines SET weekdays = ARRAY[1,2,3,4,5,6,7]::smallint[], overdue_policy = 'carry'
   WHERE id = 'ea100000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated <> 0 THEN
    RAISE EXCEPTION 'la interna reescribió la cadencia de % rutinas', updated;
  END IF;

  BEGIN
    INSERT INTO app.routines (
      household_id, title, audience, frequency, interval_count, next_due_on,
      pattern, anchor_on, repeat_every, created_by_membership_id
    ) VALUES (
      '10000000-0000-4000-8000-000000000001', 'Alta por la interna', 'employee',
      'daily', 1, '2026-08-10', 'every_n_days', '2026-08-10', 1,
      '11000000-0000-4000-8000-000000000003'
    );
    RAISE EXCEPTION 'la interna dio de alta una rutina';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_employee_never_sees_family_routines$;

COMMIT;

-- El apoyo, igual que antes: solo audiencia 'all'. El visor, nada. Las columnas
-- nuevas no cambian ni un caso de la matriz.
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper$
BEGIN
  IF (SELECT count(*) FROM app.routines WHERE audience <> 'all') <> 0
     OR (SELECT count(*) FROM app.routines WHERE pattern = 'months_of_year') <> 0
     OR (SELECT count(*) FROM app.routine_completions
          WHERE routine_id = 'ea100000-0000-4000-8000-000000000002') <> 0 THEN
    RAISE EXCEPTION 'el apoyo alcanzó rutinas que no son de audiencia all';
  END IF;
END
$assert_helper$;

COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer$
BEGIN
  IF (SELECT count(*) FROM app.routines) <> 0
     OR (SELECT count(*) FROM app.routine_completions) <> 0 THEN
    RAISE EXCEPTION 'el visor leyó rutinas o finalizaciones';
  END IF;
END
$assert_viewer$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- `app.set_routine_due_hint`: la definer que sustituye al avance de la 0009.
--
-- Refrescar la caché es lo ÚNICO que puede hacer. Contexto incompleto, sin
-- finalización que lo justifique, otro hogar o una fecha anterior al ancla se
-- quedan fuera.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

DO $assert_hint_needs_context$
BEGIN
  PERFORM app.set_routine_due_hint('ea100000-0000-4000-8000-000000000002', '2026-08-13');
  RAISE EXCEPTION 'la definer aceptó refrescar la caché sin contexto de transacción';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END
$assert_hint_needs_context$;

COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_hint_guards$
DECLARE
  refreshed date;
BEGIN
  -- Sin finalización detrás no hay nada que refrescar. Mismo guardián que la
  -- 0009: la definer no es una vía general de escritura sobre app.routines.
  BEGIN
    PERFORM app.set_routine_due_hint('ea100000-0000-4000-8000-000000000003', '2026-08-11');
    RAISE EXCEPTION 'la definer refrescó una rutina sin finalización que lo justifique';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Y una rutina de otro hogar no existe para este contexto aunque se acierte el
  -- uuid: el guardián busca la finalización en el hogar actual.
  BEGIN
    PERFORM app.set_routine_due_hint('eb100000-0000-4000-8000-000000000001', '2026-09-01');
    RAISE EXCEPTION 'la definer alcanzó una rutina del otro hogar';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- El caso legítimo: la empleada completó el lunes y la caché avanza al jueves.
  refreshed := app.set_routine_due_hint('ea100000-0000-4000-8000-000000000002', '2026-08-13');
  IF refreshed <> '2026-08-13' THEN
    RAISE EXCEPTION 'la definer devolvió % en vez de la pista pedida', refreshed;
  END IF;
END
$assert_hint_guards$;

COMMIT;

BEGIN;
SET LOCAL row_security = off;

DO $assert_hint_effect$
DECLARE
  refreshed app.routines%ROWTYPE;
  untouched app.routines%ROWTYPE;
BEGIN
  SELECT * INTO refreshed FROM app.routines WHERE id = 'ea100000-0000-4000-8000-000000000002';
  SELECT * INTO untouched FROM app.routines WHERE id = 'ea100000-0000-4000-8000-000000000003';
  IF refreshed.next_due_on <> '2026-08-13' THEN
    RAISE EXCEPTION 'la caché quedó en % en vez del jueves 13', refreshed.next_due_on;
  END IF;
  -- Una columna, una fila: la regla no se toca al refrescar la caché, que es
  -- justo lo que hacía mal el avance de la 0009.
  IF refreshed.anchor_on <> '2026-08-10'
     OR refreshed.weekdays <> ARRAY[1, 4]::smallint[]
     OR refreshed.overdue_policy <> 'skip'
     OR untouched.next_due_on <> '2026-08-10' THEN
    RAISE EXCEPTION 'la definer tocó más de lo suyo';
  END IF;
END
$assert_hint_effect$;

COMMIT;

BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_hint_never_precedes_the_anchor$
DECLARE
  refreshed date;
BEGIN
  -- Una pista anterior al ancla se ignora en silencio, y la definer devuelve lo
  -- que le pidieron. No es un descuido: por la invariante de cota inferior, no
  -- mover la caché solo puede dejarla ATRÁS, el prefiltro selecciona de más y el
  -- generador descarta. Lo único que no se puede permitir es que la caché
  -- ADELANTE la ocurrencia real y esconda una rutina.
  refreshed := app.set_routine_due_hint('ea100000-0000-4000-8000-000000000002', '2026-08-03');
  IF refreshed <> '2026-08-03' THEN
    RAISE EXCEPTION 'la definer devolvió % en vez de la pista pedida', refreshed;
  END IF;
END
$assert_hint_never_precedes_the_anchor$;

COMMIT;

BEGIN;
SET LOCAL row_security = off;

DO $assert_hint_ignored_before_anchor$
BEGIN
  IF (SELECT next_due_on FROM app.routines WHERE id = 'ea100000-0000-4000-8000-000000000002')
       <> '2026-08-13' THEN
    RAISE EXCEPTION 'una pista anterior al ancla movió la caché';
  END IF;
END
$assert_hint_ignored_before_anchor$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Feed ICS y barrido de avisos: las dos definer, con sus privilegios.
--
-- Los privilegios se miran con la misma insistencia que el contenido porque el
-- DROP+CREATE de la 0023 los borra: recrear una función devuelve su ACL al
-- DEFAULT, que es EXECUTE para PUBLIC. La 0011 existe por haberlo aprendido por
-- las malas, y un `proacl` nulo es exactamente ese estado.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_definer_grants$
DECLARE
  target record;
  acl aclitem[];
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('app_private.ics_feed_events(text)',       'casa_clara_app',    'casa_clara_worker'),
      ('app.set_routine_due_hint(uuid, date)',    'casa_clara_app',    'casa_clara_worker'),
      -- El barrido es del worker y solo del worker: resolver los correos del
      -- hogar entero sin contexto no es algo que la aplicación deba poder hacer.
      ('app_private.routine_digest_inputs(date)', 'casa_clara_worker', 'casa_clara_app')
    ) AS f(signature, allowed, denied)
  LOOP
    SELECT proacl INTO acl FROM pg_catalog.pg_proc WHERE oid = target.signature::regprocedure;
    IF acl IS NULL THEN
      RAISE EXCEPTION '% quedó con la ACL por defecto: PUBLIC puede ejecutarla', target.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(acl) AS entry WHERE entry.grantee = 0) THEN
      RAISE EXCEPTION '% es ejecutable por PUBLIC', target.signature;
    END IF;
    IF NOT has_function_privilege(target.allowed, target.signature, 'EXECUTE') THEN
      RAISE EXCEPTION '% perdió el GRANT a %', target.signature, target.allowed;
    END IF;
    IF has_function_privilege(target.denied, target.signature, 'EXECUTE') THEN
      RAISE EXCEPTION '% quedó ejecutable por %', target.signature, target.denied;
    END IF;
  END LOOP;
END
$assert_definer_grants$;

DO $assert_ics_feed_contents$
DECLARE
  published integer;
  unscheduled integer;
  revoked integer;
  sample record;
BEGIN
  SELECT count(*)::integer INTO published
    FROM app_private.ics_feed_events(repeat('a', 64)) WHERE routine_id IS NOT NULL;
  IF published = 0 THEN
    RAISE EXCEPTION 'el feed no publicó ninguna rutina';
  END IF;

  SELECT count(*)::integer INTO unscheduled
    FROM app_private.ics_feed_events(repeat('a', 64))
   WHERE routine_id = 'ea100000-0000-4000-8000-000000000005';
  IF unscheduled <> 0 THEN
    RAISE EXCEPTION 'el feed publicó una rutina sin cadencia confirmada';
  END IF;

  -- Lo que el emisor necesita para escribir una RRULE de verdad viaja entero.
  SELECT * INTO sample
    FROM app_private.ics_feed_events(repeat('a', 64))
   WHERE routine_id = 'ea100000-0000-4000-8000-000000000002';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el feed no devolvió la rutina de días fijos';
  END IF;
  IF sample.pattern <> 'days_of_week' OR sample.weekdays <> ARRAY[1, 4]::smallint[]
     OR sample.anchor_on <> '2026-08-10' OR sample.repeat_every <> 1 THEN
    RAISE EXCEPTION 'el feed no lleva la regla completa de la rutina';
  END IF;

  SELECT count(*)::integer INTO revoked FROM app_private.ics_feed_events(repeat('b', 64));
  IF revoked <> 0 THEN
    RAISE EXCEPTION 'un feed revocado siguió devolviendo filas';
  END IF;
END
$assert_ics_feed_contents$;

/*
 * AC-25 en SQL. El barrido resuelve los destinatarios DENTRO de la definer y con
 * la lista completa, porque hacerlo bajo la RLS de quien encola daba listas
 * parciales. Eso convierte esta función en el único sitio donde vive la
 * separación de audiencias, y por eso se prueba aquí: audiencia `family` JAMÁS
 * incluye a la interna, y el apoyo no recibe aviso aunque vea la rutina.
 */
DO $assert_digest_recipients$
DECLARE
  family_routine record;
  employee_routine record;
  everyone_routine record;
  unscheduled integer;
BEGIN
  SELECT * INTO family_routine
    FROM app_private.routine_digest_inputs(date '2026-08-10')
   WHERE routine_id = 'ea100000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el barrido perdió la rutina familiar';
  END IF;
  IF family_routine.recipients && ARRAY['empleada.roble@casa.demo', 'empleada2.roble@casa.demo'] THEN
    RAISE EXCEPTION 'AC-25 roto: un aviso de audiencia family incluyó a la interna';
  END IF;
  IF NOT (family_routine.recipients @> ARRAY['admin.roble@casa.demo', 'familiar.roble@casa.demo']) THEN
    RAISE EXCEPTION 'el aviso familiar perdió destinatarios: %', family_routine.recipients;
  END IF;

  SELECT * INTO employee_routine
    FROM app_private.routine_digest_inputs(date '2026-08-10')
   WHERE routine_id = 'ea100000-0000-4000-8000-000000000002';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el barrido perdió la rutina de la interna';
  END IF;
  IF NOT (employee_routine.recipients @> ARRAY['empleada.roble@casa.demo'])
     OR employee_routine.recipients && ARRAY['admin.roble@casa.demo', 'familiar.roble@casa.demo'] THEN
    RAISE EXCEPTION 'el aviso de la interna no es solo suyo: %', employee_routine.recipients;
  END IF;
  -- La finalización ya registrada viaja con la regla: el worker decide qué
  -- queda pendiente con el mismo módulo puro que Hoy, sin volver a preguntar.
  IF NOT (employee_routine.completed_due_ons @> ARRAY[date '2026-08-10']) THEN
    RAISE EXCEPTION 'el barrido no llevó la finalización ya registrada';
  END IF;

  SELECT * INTO everyone_routine
    FROM app_private.routine_digest_inputs(date '2026-08-10')
   WHERE routine_id = 'ea100000-0000-4000-8000-000000000003';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'el barrido perdió la rutina de toda la casa';
  END IF;
  IF NOT (everyone_routine.recipients
            @> ARRAY['admin.roble@casa.demo', 'familiar.roble@casa.demo', 'empleada.roble@casa.demo']) THEN
    RAISE EXCEPTION 'el aviso de toda la casa perdió destinatarios: %', everyone_routine.recipients;
  END IF;

  -- Ni el apoyo, ni el visor, ni una membresía revocada reciben nada, en
  -- ninguna audiencia y en ningún hogar.
  IF EXISTS (
    SELECT 1 FROM app_private.routine_digest_inputs(date '2026-08-10') AS digest
     WHERE digest.recipients && ARRAY['apoyo.roble@casa.demo', 'visor.roble@casa.demo',
                                      'revocada.roble@casa.demo']
  ) THEN
    RAISE EXCEPTION 'el barrido avisó a quien no debe (apoyo, visor o membresía revocada)';
  END IF;

  -- Y una rutina sin cadencia confirmada no entra en el barrido: no aparece en
  -- Hoy, ni en el calendario, ni en el ICS, ni en los avisos.
  SELECT count(*)::integer INTO unscheduled
    FROM app_private.routine_digest_inputs(date '2026-08-10')
   WHERE routine_id = 'ea100000-0000-4000-8000-000000000005';
  IF unscheduled <> 0 THEN
    RAISE EXCEPTION 'el barrido incluyó una rutina sin cadencia confirmada';
  END IF;
END
$assert_digest_recipients$;

COMMIT;
