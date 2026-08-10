-- Guía de la casa (migración 0026): quién puede escribirla y qué sabe la casa
-- de lo que cada cual ha leído.
--
-- Tres familias de aserciones, todas negativas donde importa:
--
--   1. Escritura. Solo `family_admin` crea, edita, publica, destaca o crea
--      apartados de la GUÍA. La familia no administradora y la interna fallan
--      con 42501 aunque hablen SQL directamente; el recetario conserva su regla
--      anterior para no romper «Nueva receta desde el hueco del menú».
--   2. Progreso. Cada cual ve el suyo y solo el suyo; nadie marca por otro;
--      la administración no lee ni una fila ajena y su única ventana son
--      cuentas por apartado. Y, estructuralmente, la tabla NO PUEDE guardar un
--      rastro temporal: no tiene ninguna columna de fecha ni disparador de
--      auditoría, y esta prueba falla si alguien se la añade.
--   3. Invalidación. Cambiar comas, negritas o saltos de línea NO invalida una
--      lectura; cambiar palabras sí.
--
-- Prefijos de UUID exclusivos de este fichero: ac… (roble) y ad… (olivo).

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (propietario, RLS off)
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, kind, created_by_membership_id) VALUES
  ('ac000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'acogida', 'Acogida', 'Apartado de la Guía sembrado por 080', 0, 'guide',
   '11000000-0000-4000-8000-000000000001'),
  ('ac000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'recetario-080', 'Recetario 080', 'Apartado de recetas sembrado por 080', 1, 'recipes',
   '11000000-0000-4000-8000-000000000001'),
  ('ad000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'acogida-olivo', 'Acogida del olivo', 'Guía del segundo hogar', 0, 'guide',
   '21000000-0000-4000-8000-000000000001');

-- Dos notas publicadas de la Guía, un borrador de la Guía escrito por la
-- INTERNA antes del cambio (el caso «borrador a medias») y una receta.
INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, position, created_by_membership_id) VALUES
  ('ac100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'ac000000-0000-4000-8000-000000000001', 'published', 'acogida-uno', 0,
   '11000000-0000-4000-8000-000000000001'),
  ('ac100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'ac000000-0000-4000-8000-000000000001', 'published', 'acogida-dos', 1,
   '11000000-0000-4000-8000-000000000001'),
  ('ac100000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'ac000000-0000-4000-8000-000000000001', 'draft', 'acogida-borrador-interna', 2,
   '11000000-0000-4000-8000-000000000003'),
  ('ac100000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   'ac000000-0000-4000-8000-000000000002', 'published', 'receta-080', 0,
   '11000000-0000-4000-8000-000000000001'),
  ('ad100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'ad000000-0000-4000-8000-000000000001', 'published', 'acogida-olivo-uno', 0,
   '21000000-0000-4000-8000-000000000001');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 'acogida-uno'),
  ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000002', 'acogida-dos'),
  ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000003', 'acogida-borrador-interna'),
  ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000004', 'receta-080'),
  ('20000000-0000-4000-8000-000000000001', 'ad100000-0000-4000-8000-000000000001', 'acogida-olivo-uno');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id) VALUES
  ('ac200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'ac100000-0000-4000-8000-000000000001', 1, 'Bienvenida',
   'La casa se explica sola, pero por si acaso: lee esto primero.',
   '11000000-0000-4000-8000-000000000001'),
  ('ac200000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'ac100000-0000-4000-8000-000000000002', 1, 'La cocina',
   'La placa es de inducción y el horno tiene sonda.',
   '11000000-0000-4000-8000-000000000001'),
  ('ac200000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001',
   'ac100000-0000-4000-8000-000000000003', 1, 'Borrador de la interna',
   'Apuntes a medio escribir.', '11000000-0000-4000-8000-000000000003'),
  ('ac200000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001',
   'ac100000-0000-4000-8000-000000000004', 1, 'Lentejas de la casa',
   'Una hora a fuego lento.', '11000000-0000-4000-8000-000000000001'),
  ('ad200000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'ad100000-0000-4000-8000-000000000001', 1, 'Bienvenida del olivo',
   'Nada de esto es asunto de la casa roble.', '21000000-0000-4000-8000-000000000001');

UPDATE app.wiki_pages SET current_revision_id = 'ac200000-0000-4000-8000-000000000001' WHERE id = 'ac100000-0000-4000-8000-000000000001';
UPDATE app.wiki_pages SET current_revision_id = 'ac200000-0000-4000-8000-000000000002' WHERE id = 'ac100000-0000-4000-8000-000000000002';
UPDATE app.wiki_pages SET current_revision_id = 'ac200000-0000-4000-8000-000000000003' WHERE id = 'ac100000-0000-4000-8000-000000000003';
UPDATE app.wiki_pages SET current_revision_id = 'ac200000-0000-4000-8000-000000000004' WHERE id = 'ac100000-0000-4000-8000-000000000004';
UPDATE app.wiki_pages SET current_revision_id = 'ad200000-0000-4000-8000-000000000001' WHERE id = 'ad100000-0000-4000-8000-000000000001';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Estructura: el esquema no puede guardar un rastro de vigilancia
-- ─────────────────────────────────────────────────────────────────────────────
DO $assert_progress_shape$
DECLARE
  time_columns integer;
  triggers integer;
  forced boolean;
  enabled boolean;
  signature text;
BEGIN
  SELECT count(*)::integer INTO time_columns
    FROM information_schema.columns
   WHERE table_schema = 'app'
     AND table_name = 'wiki_reading_progress'
     AND data_type IN (
       'timestamp with time zone', 'timestamp without time zone',
       'date', 'time with time zone', 'time without time zone', 'interval'
     );
  IF time_columns <> 0 THEN
    RAISE EXCEPTION 'wiki_reading_progress ganó % columna(s) de tiempo: eso reconstruye el rastro que el diseño prohíbe', time_columns;
  END IF;

  SELECT count(*)::integer INTO triggers
    FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'app.wiki_reading_progress'::regclass AND NOT tgisinternal;
  IF triggers <> 0 THEN
    RAISE EXCEPTION 'wiki_reading_progress tiene disparadores (%): la auditoría sellaría cada lectura con su hora', triggers;
  END IF;

  SELECT relrowsecurity, relforcerowsecurity INTO enabled, forced
    FROM pg_catalog.pg_class WHERE oid = 'app.wiki_reading_progress'::regclass;
  IF NOT enabled THEN
    RAISE EXCEPTION 'wiki_reading_progress sin row level security';
  END IF;

  -- La aplicación LEE su progreso; escribir es solo por la función.
  IF NOT has_table_privilege('casa_clara_app', 'app.wiki_reading_progress', 'SELECT') THEN
    RAISE EXCEPTION 'casa_clara_app no puede leer su propio progreso';
  END IF;
  IF has_table_privilege('casa_clara_app', 'app.wiki_reading_progress', 'INSERT')
     OR has_table_privilege('casa_clara_app', 'app.wiki_reading_progress', 'UPDATE')
     OR has_table_privilege('casa_clara_app', 'app.wiki_reading_progress', 'DELETE') THEN
    RAISE EXCEPTION 'casa_clara_app escribe el progreso directamente; debe pasar por app.mark_wiki_note_read';
  END IF;

  -- Marcar por otro no se rechaza: no se puede ni expresar.
  SELECT pg_catalog.pg_get_function_arguments(oid) INTO signature
    FROM pg_catalog.pg_proc
   WHERE proname = 'mark_wiki_note_read'
     AND pronamespace = 'app'::regnamespace;
  IF signature <> 'target_page uuid' THEN
    RAISE EXCEPTION 'app.mark_wiki_note_read cambió de firma («%»): admitir una membresía permitiría marcar por otro', signature;
  END IF;
END
$assert_progress_shape$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Escritura de la Guía: solo la administración
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

-- 2.a · La administradora sí escribe la Guía.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_writes_guide$
BEGIN
  INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, created_by_membership_id)
  VALUES ('ac100000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-000000000001',
          'ac000000-0000-4000-8000-000000000001', 'draft', 'nota-de-la-admin',
          '11000000-0000-4000-8000-000000000001');
  INSERT INTO app.wiki_page_slugs (household_id, page_id, slug)
  VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-00000000000a', 'nota-de-la-admin');
  INSERT INTO app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-00000000000a', 1,
          'Nota de la admin', 'Cuerpo.', '11000000-0000-4000-8000-000000000001');
  UPDATE app.wiki_pages SET pinned = true
   WHERE id = 'ac100000-0000-4000-8000-000000000001';
  IF (SELECT count(*) FROM app.wiki_pages WHERE pinned) <> 1 THEN
    RAISE EXCEPTION 'la administración no pudo destacar una nota de la Guía';
  END IF;

  -- Los slugs de las vistas propias de la Guía están reservados.
  BEGIN
    INSERT INTO app.wiki_page_slugs (household_id, page_id, slug)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-00000000000a', 'libro');
    RAISE EXCEPTION 'el slug reservado «libro» entró en wiki_page_slugs';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$assert_admin_writes_guide$;

-- 2.b · La familia no administradora: nada en la Guía, todo en el recetario.
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002'
);

DO $assert_family_member_cannot_write_guide$
BEGIN
  BEGIN
    INSERT INTO app.wiki_pages (household_id, space_id, status, current_slug, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
            'draft', 'nota-de-la-familiar', '11000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'family_member creó una nota de la Guía';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    UPDATE app.wiki_pages SET status = 'published'
     WHERE id = 'ac100000-0000-4000-8000-000000000003';
    IF FOUND THEN
      RAISE EXCEPTION 'family_member publicó un borrador de la Guía';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.wiki_spaces (household_id, slug, name, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'apartado-de-la-familiar', 'Apartado',
            '11000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'family_member creó un apartado de la Guía';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 2,
            'Bienvenida editada', 'Texto ajeno.', '11000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'family_member editó una nota de la Guía';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- El recetario NO se toca: sigue siendo de la familia (flujo del menú).
  INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, created_by_membership_id)
  VALUES ('ac100000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-000000000001',
          'ac000000-0000-4000-8000-000000000002', 'published', 'receta-de-la-familiar',
          '11000000-0000-4000-8000-000000000002');
  INSERT INTO app.wiki_page_slugs (household_id, page_id, slug)
  VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-00000000000b', 'receta-de-la-familiar');
  INSERT INTO app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-00000000000b', 1,
          'Receta de la familiar', 'Sofreír y esperar.', '11000000-0000-4000-8000-000000000002');
  INSERT INTO app.wiki_spaces (household_id, slug, name, kind, created_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'recetas', 'Recetas', 'recipes',
          '11000000-0000-4000-8000-000000000002');
END
$assert_family_member_cannot_write_guide$;

-- 2.c · La interna: lee la Guía, no la escribe; ve su propio borrador a medias.
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_cannot_write$
BEGIN
  BEGIN
    INSERT INTO app.wiki_pages (household_id, space_id, status, current_slug, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
            'draft', 'nota-de-la-interna', '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'employee_live_in creó una nota de la Guía';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Tampoco en el recetario: el catálogo doméstico es de la familia.
  BEGIN
    INSERT INTO app.wiki_pages (household_id, space_id, status, current_slug, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000002',
            'published', 'receta-de-la-interna', '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'employee_live_in creó una receta';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    UPDATE app.wiki_pages SET pinned = true
     WHERE id = 'ac100000-0000-4000-8000-000000000002';
    IF FOUND THEN
      RAISE EXCEPTION 'employee_live_in destacó una nota de la Guía';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Su borrador a medias sigue siendo legible para ella (y para nadie más que
  -- la administración), aunque ya no pueda editarlo.
  IF (SELECT count(*) FROM app.wiki_pages
       WHERE id = 'ac100000-0000-4000-8000-000000000003') <> 1 THEN
    RAISE EXCEPTION 'la interna perdió de vista el borrador que ella misma escribió';
  END IF;
  IF (SELECT count(*) FROM app.wiki_revisions
       WHERE page_id = 'ac100000-0000-4000-8000-000000000003') <> 1 THEN
    RAISE EXCEPTION 'la interna no puede leer el contenido de su propio borrador';
  END IF;
  BEGIN
    INSERT INTO app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000003', 2,
            'Borrador retomado', 'Sigo escribiendo.', '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'employee_live_in siguió editando su borrador de la Guía';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_employee_cannot_write$;

-- 2.d · El apoyo: ni escribe ni ve borradores ajenos.
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_cannot_write$
BEGIN
  IF (SELECT count(*) FROM app.wiki_pages WHERE status = 'draft') <> 0 THEN
    RAISE EXCEPTION 'el apoyo ve borradores de la Guía';
  END IF;
  BEGIN
    INSERT INTO app.wiki_pages (household_id, space_id, status, current_slug, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
            'draft', 'nota-del-apoyo', '11000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'helper creó una nota de la Guía';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_helper_cannot_write$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Progreso de lectura: del lector, y de nadie más
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;

SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003'
);

DO $assert_reader_progress$
DECLARE
  marked text;
BEGIN
  marked := app.mark_wiki_note_read('ac100000-0000-4000-8000-000000000001');
  IF marked IS NULL THEN
    RAISE EXCEPTION 'marcar una nota publicada de la Guía no dejó huella';
  END IF;

  -- Idempotente: leerla dos veces no duplica nada.
  PERFORM app.mark_wiki_note_read('ac100000-0000-4000-8000-000000000001');
  IF (SELECT count(*) FROM app.wiki_reading_progress) <> 1 THEN
    RAISE EXCEPTION 'el progreso de la interna no es exactamente una fila';
  END IF;

  -- Un borrador no cuenta como lectura de acogida (ni siquiera el suyo).
  IF app.mark_wiki_note_read('ac100000-0000-4000-8000-000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'un borrador contó como nota leída';
  END IF;
  -- Una receta tampoco: el recetario no es el manual de la casa.
  IF app.mark_wiki_note_read('ac100000-0000-4000-8000-000000000004') IS NOT NULL THEN
    RAISE EXCEPTION 'una receta contó como nota leída de la Guía';
  END IF;
  IF (SELECT count(*) FROM app.wiki_reading_progress) <> 1 THEN
    RAISE EXCEPTION 'borradores o recetas dejaron progreso';
  END IF;

  -- Otro hogar: la nota simplemente no existe.
  BEGIN
    PERFORM app.mark_wiki_note_read('ad100000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'se marcó como leída una nota de otro hogar';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- El resumen de la casa no es asunto suyo.
  BEGIN
    PERFORM * FROM app.wiki_reading_overview();
    RAISE EXCEPTION 'la interna consultó el avance de toda la casa';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_reader_progress$;

-- La familiar lee otra nota: su progreso es suyo y no ve el de la interna.
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002'
);

DO $assert_progress_is_private$
BEGIN
  PERFORM app.mark_wiki_note_read('ac100000-0000-4000-8000-000000000002');
  IF (SELECT count(*) FROM app.wiki_reading_progress) <> 1 THEN
    RAISE EXCEPTION 'la familiar ve progreso que no es el suyo';
  END IF;
  IF (SELECT count(*) FROM app.wiki_reading_progress
       WHERE membership_id = '11000000-0000-4000-8000-000000000003') <> 0 THEN
    RAISE EXCEPTION 'la familiar leyó el progreso de la interna';
  END IF;
END
$assert_progress_is_private$;

-- La administración: ni una fila ajena, y solo cuentas por apartado.
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT set_config('app.household_id', '', true);
SELECT set_config('app.membership_id', '', true);
SELECT set_config('app.role', '', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_sees_counts_only$
DECLARE
  employee_read bigint;
  employee_total bigint;
  people integer;
BEGIN
  IF (SELECT count(*) FROM app.wiki_reading_progress) <> 0 THEN
    RAISE EXCEPTION 'la administración lee filas de progreso ajenas: eso es un rastro, no una acogida';
  END IF;

  SELECT notes_read, notes_total INTO employee_read, employee_total
    FROM app.wiki_reading_overview()
   WHERE membership_id = '11000000-0000-4000-8000-000000000003'
     AND space_id = 'ac000000-0000-4000-8000-000000000001';
  IF employee_read <> 1 THEN
    RAISE EXCEPTION 'el resumen no cuenta la nota que la interna leyó (contó %)', employee_read;
  END IF;
  -- Dos publicadas al sembrar; el borrador y la nota nueva de la admin no cuentan.
  IF employee_total <> 2 THEN
    RAISE EXCEPTION 'el resumen cuenta notas que no están publicadas (total %)', employee_total;
  END IF;

  -- Ni la propia administración ni el visor aparecen en el resumen de acogida.
  SELECT count(DISTINCT membership_id)::integer INTO people FROM app.wiki_reading_overview();
  IF people <> 3 THEN
    RAISE EXCEPTION 'el resumen debería listar a familiar, interna y apoyo; listó % personas', people;
  END IF;
  IF EXISTS (SELECT 1 FROM app.wiki_reading_overview()
              WHERE membership_id = '11000000-0000-4000-8000-000000000001'
                 OR membership_role = 'viewer') THEN
    RAISE EXCEPTION 'el resumen incluye a quien no debe';
  END IF;

  -- El recetario no forma parte de la acogida.
  IF EXISTS (SELECT 1 FROM app.wiki_reading_overview()
              WHERE space_id = 'ac000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'el resumen de acogida incluye el recetario';
  END IF;
END
$assert_admin_sees_counts_only$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Invalidación con criterio
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_fingerprint_criteria$
DECLARE
  original text;
  cosmetic text;
  rewritten text;
BEGIN
  SELECT reading_fingerprint INTO original
    FROM app.wiki_revisions WHERE id = 'ac200000-0000-4000-8000-000000000001';

  -- Mismo texto, otra puntuación, otro énfasis, otros saltos de línea y un
  -- acento perdido: para la persona que ya la leyó, la nota no ha cambiado.
  INSERT INTO app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 2,
          'Bienvenida',
          E'La casa se explica sola; pero **por si acaso**:\n\nlee esto primero!!',
          '11000000-0000-4000-8000-000000000001')
  RETURNING reading_fingerprint INTO cosmetic;
  IF cosmetic <> original THEN
    RAISE EXCEPTION 'una coma y una negrita invalidaron una lectura ya hecha';
  END IF;

  -- Cambio de palabras: la nota vuelve a la lista de pendientes.
  INSERT INTO app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'ac100000-0000-4000-8000-000000000001', 3,
          'Bienvenida',
          'La casa cambió de cerradura: pide la llave nueva antes de entrar.',
          '11000000-0000-4000-8000-000000000001')
  RETURNING reading_fingerprint INTO rewritten;
  IF rewritten = original THEN
    RAISE EXCEPTION 'reescribir el texto no invalidó la lectura';
  END IF;

  UPDATE app.wiki_pages
     SET current_revision_id = (SELECT id FROM app.wiki_revisions
                                 WHERE page_id = 'ac100000-0000-4000-8000-000000000001'
                                   AND revision_number = 3)
   WHERE id = 'ac100000-0000-4000-8000-000000000001';

  -- El progreso NO se borra: sigue constando que la leyó, con la huella vieja.
  -- Así la aplicación puede decir «cambió desde que la leíste» en vez de
  -- «nunca la has leído», que sería falso.
  IF (SELECT count(*) FROM app.wiki_reading_progress
       WHERE membership_id = '11000000-0000-4000-8000-000000000003'
         AND page_id = 'ac100000-0000-4000-8000-000000000001'
         AND content_fingerprint = original) <> 1 THEN
    RAISE EXCEPTION 'la invalidación borró el recuerdo de la lectura en vez de marcarla como cambiada';
  END IF;
END
$assert_fingerprint_criteria$;

COMMIT;

-- Y, ya con la nota cambiada, la administración sigue viendo cuentas: para el
-- resumen de acogida la nota cuenta como leída una vez (el hito «se la ha leído
-- entera» no se revoca porque después se corrija una frase). Lo que ha cambiado
-- se le enseña a SU LECTORA, no a la casa.
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001'
);

DO $assert_overview_after_change$
DECLARE
  employee_read bigint;
BEGIN
  SELECT notes_read INTO employee_read
    FROM app.wiki_reading_overview()
   WHERE membership_id = '11000000-0000-4000-8000-000000000003'
     AND space_id = 'ac000000-0000-4000-8000-000000000001';
  IF employee_read <> 1 THEN
    RAISE EXCEPTION 'corregir una nota borró el hito de acogida (contó %)', employee_read;
  END IF;
END
$assert_overview_after_change$;
COMMIT;
