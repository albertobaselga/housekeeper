-- Eventos de calendarios enlazados (migración 0015): la escritura pasa SOLO
-- por app_private.replace_ics_source_events (definer del worker) y la lectura
-- calca la capability calendar.read (familia, empleada y visor; el apoyo no).
-- Prefijos UUID ca* (roble) / cb* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off): una fuente por hogar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.ics_sources (id, household_id, url, label, enabled, created_by_membership_id) VALUES
  ('ca000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'https://calendario.example.com/roble.ics', 'Cole de los niños', true,
   '11000000-0000-4000-8000-000000000001'),
  ('cb000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'https://calendario.example.com/olivo.ics', 'Agenda del olivo', true,
   '21000000-0000-4000-8000-000000000001');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Worker: sustitución idempotente por hash y borrado de lo que ya no viene.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_worker;

DO $worker_replace$
DECLARE
  written integer;
BEGIN
  -- Primera pasada: dos ocurrencias del roble.
  SELECT app_private.replace_ics_source_events(
    '10000000-0000-4000-8000-000000000001',
    'ca000000-0000-4000-8000-000000000001',
    '[{"uid":"evento-1@example.com","startsAt":"2026-08-08T15:00:00Z","endsAt":"2026-08-08T16:00:00Z",
       "allDay":false,"summary":"Natación","location":"Piscina municipal",
       "contentHash":"1111111111111111111111111111111111111111111111111111111111111111"},
      {"uid":"evento-2@example.com","startsAt":"2026-08-10T00:00:00Z","endsAt":null,
       "allDay":true,"summary":"Excursión","location":null,
       "contentHash":"2222222222222222222222222222222222222222222222222222222222222222"}]'::jsonb
  ) INTO written;
  IF written <> 2 THEN
    RAISE EXCEPTION 'first replace expected 2 written rows, got %', written;
  END IF;

  -- Réplica exacta: cero reescrituras (idempotencia por hash).
  SELECT app_private.replace_ics_source_events(
    '10000000-0000-4000-8000-000000000001',
    'ca000000-0000-4000-8000-000000000001',
    '[{"uid":"evento-1@example.com","startsAt":"2026-08-08T15:00:00Z","endsAt":"2026-08-08T16:00:00Z",
       "allDay":false,"summary":"Natación","location":"Piscina municipal",
       "contentHash":"1111111111111111111111111111111111111111111111111111111111111111"},
      {"uid":"evento-2@example.com","startsAt":"2026-08-10T00:00:00Z","endsAt":null,
       "allDay":true,"summary":"Excursión","location":null,
       "contentHash":"2222222222222222222222222222222222222222222222222222222222222222"}]'::jsonb
  ) INTO written;
  IF written <> 0 THEN
    RAISE EXCEPTION 'identical replace expected 0 written rows, got %', written;
  END IF;

  -- El evento 2 desaparece del feed y el 1 cambia de contenido.
  SELECT app_private.replace_ics_source_events(
    '10000000-0000-4000-8000-000000000001',
    'ca000000-0000-4000-8000-000000000001',
    '[{"uid":"evento-1@example.com","startsAt":"2026-08-08T15:00:00Z","endsAt":"2026-08-08T17:00:00Z",
       "allDay":false,"summary":"Natación (ampliada)","location":"Piscina municipal",
       "contentHash":"3333333333333333333333333333333333333333333333333333333333333333"}]'::jsonb
  ) INTO written;
  IF written <> 1 THEN
    RAISE EXCEPTION 'update replace expected 1 written row, got %', written;
  END IF;

  -- Una fuente inexistente en ese hogar no escribe nada y devuelve NULL
  -- (también cubre el intento cruzado: fuente del olivo bajo hogar roble).
  SELECT app_private.replace_ics_source_events(
    '10000000-0000-4000-8000-000000000001',
    'cb000000-0000-4000-8000-000000000001',
    '[]'::jsonb
  ) INTO written;
  IF written IS NOT NULL THEN
    RAISE EXCEPTION 'cross-household replace must return NULL, got %', written;
  END IF;

  -- Fuente del olivo, en su hogar, con un evento propio.
  SELECT app_private.replace_ics_source_events(
    '20000000-0000-4000-8000-000000000001',
    'cb000000-0000-4000-8000-000000000001',
    '[{"uid":"olivo-1@example.com","startsAt":"2026-08-09T10:00:00Z","endsAt":null,
       "allDay":false,"summary":"Evento del olivo","location":null,
       "contentHash":"4444444444444444444444444444444444444444444444444444444444444444"}]'::jsonb
  ) INTO written;
  IF written <> 1 THEN
    RAISE EXCEPTION 'olivo replace expected 1 written row, got %', written;
  END IF;
END
$worker_replace$;

COMMIT;

-- El estado final visible sin RLS: roble conserva SOLO la ocurrencia vigente.
BEGIN;
SET LOCAL row_security = off;
DO $assert_replace_state$
BEGIN
  IF (SELECT count(*) FROM app.ics_source_events
       WHERE household_id = '10000000-0000-4000-8000-000000000001') <> 1
     OR (SELECT summary FROM app.ics_source_events
          WHERE household_id = '10000000-0000-4000-8000-000000000001'
            AND uid = 'evento-1@example.com') <> 'Natación (ampliada)'
     OR (SELECT source_label FROM app.ics_source_events
          WHERE household_id = '10000000-0000-4000-8000-000000000001'
            AND uid = 'evento-1@example.com') <> 'Cole de los niños' THEN
    RAISE EXCEPTION 'replace end-state assertion failed';
  END IF;
END
$assert_replace_state$;
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rol de aplicación: lectura por rol y cero escritura (ni cruzada ni propia).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

-- family_admin del roble: ve su evento, jamás el del olivo, y no puede
-- escribir la tabla ni ejecutar la función del worker.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_events$
BEGIN
  IF (SELECT count(*) FROM app.ics_source_events) <> 1
     OR (SELECT count(*) FROM app.ics_source_events
          WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_admin calendar read failed';
  END IF;

  BEGIN
    INSERT INTO app.ics_source_events
      (household_id, source_id, uid, starts_at, summary, source_label, content_hash)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
            'intruso@example.com', '2026-08-11T10:00:00Z', 'Intruso', 'Cole de los niños',
            repeat('a', 64));
    RAISE EXCEPTION 'app-role insert into ics_source_events unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    UPDATE app.ics_source_events SET summary = 'Manipulado';
    RAISE EXCEPTION 'app-role update of ics_source_events unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    DELETE FROM app.ics_source_events;
    RAISE EXCEPTION 'app-role delete of ics_source_events unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM app_private.replace_ics_source_events(
      '10000000-0000-4000-8000-000000000001',
      'ca000000-0000-4000-8000-000000000001',
      '[]'::jsonb
    );
    RAISE EXCEPTION 'app-role execute of replace_ics_source_events unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM * FROM app_private.list_ics_sources_for_sync();
    RAISE EXCEPTION 'app-role execute of list_ics_sources_for_sync unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_admin_events$;

-- family_member y employee_live_in ven el calendario; helper NO (sin
-- calendar.read); viewer SÍ (su mínimo operativo incluye el calendario).
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);
DO $assert_member_events$
BEGIN
  IF (SELECT count(*) FROM app.ics_source_events) <> 1 THEN
    RAISE EXCEPTION 'family_member should read household calendar events';
  END IF;
END
$assert_member_events$;

SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);
DO $assert_employee_events$
BEGIN
  IF (SELECT count(*) FROM app.ics_source_events) <> 1 THEN
    RAISE EXCEPTION 'employee_live_in should read household calendar events';
  END IF;
END
$assert_employee_events$;

SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);
DO $assert_helper_events$
BEGIN
  IF (SELECT count(*) FROM app.ics_source_events) <> 0 THEN
    RAISE EXCEPTION 'helper must not read calendar events (no calendar.read)';
  END IF;
END
$assert_helper_events$;

SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);
DO $assert_viewer_events$
BEGIN
  IF (SELECT count(*) FROM app.ics_source_events) <> 1
     OR (SELECT count(*) FROM app.ics_source_events
          WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'viewer calendar read failed';
  END IF;
END
$assert_viewer_events$;

ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Limpieza: este fichero no deja estado para las suites posteriores.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;
DELETE FROM app.ics_source_events
 WHERE source_id IN ('ca000000-0000-4000-8000-000000000001', 'cb000000-0000-4000-8000-000000000001');
DELETE FROM app.ics_sources
 WHERE id IN ('ca000000-0000-4000-8000-000000000001', 'cb000000-0000-4000-8000-000000000001');
COMMIT;
