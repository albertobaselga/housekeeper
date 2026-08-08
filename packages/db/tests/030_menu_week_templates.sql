-- RLS negativa de las plantillas de semana de menú (migración 0014): un hogar
-- jamás ve ni escribe plantillas del otro; escribe solo la familia y el visor
-- no lee. Requiere migraciones + fixtures/001_two_households.sql aplicadas y
-- una conexión que pueda SET ROLE casa_clara_app.
--
-- UUIDs con prefijos ba* (roble) / bb* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off): un grupo y una plantilla con un hueco por
-- hogar, para que las aserciones cross-tenant tengan filas reales que filtrar.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.menu_groups (id, household_id, name, position) VALUES
  ('ba100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Mesa plantilla roble', 20),
  ('bb100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Mesa plantilla olivo', 20);

INSERT INTO app.menu_week_templates (id, household_id, name, source_week_starts_on, created_by_membership_id) VALUES
  ('ba200000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Semana de cole', '2026-09-07', '11000000-0000-4000-8000-000000000001'),
  ('bb200000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Semana del olivo', '2026-09-07', '21000000-0000-4000-8000-000000000001');

INSERT INTO app.menu_week_template_slots
  (id, household_id, template_id, day_offset, meal, group_id, free_text) VALUES
  ('ba300000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'ba200000-0000-4000-8000-000000000001', 0, 'comida', 'ba100000-0000-4000-8000-000000000001', 'Lentejas de cole'),
  ('bb300000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'bb200000-0000-4000-8000-000000000001', 0, 'cena', 'bb100000-0000-4000-8000-000000000001', 'Sopa del olivo');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- family_admin de roble: ve SOLO su plantilla y no puede escribir en olivo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_templates$
BEGIN
  IF (SELECT count(*) FROM app.menu_week_templates) <> 1
     OR (SELECT count(*) FROM app.menu_week_template_slots) <> 1
     OR (SELECT count(*) FROM app.menu_week_templates WHERE name = 'Semana de cole') <> 1 THEN
    RAISE EXCEPTION 'family_admin debería ver exactamente su plantilla de roble';
  END IF;

  IF (SELECT count(*) FROM app.menu_week_templates
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.menu_week_template_slots
          WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_admin de roble filtra plantillas del olivo';
  END IF;

  -- Escritura cross-tenant: el INSERT hacia el otro hogar debe fallar por RLS.
  BEGIN
    INSERT INTO app.menu_week_templates (household_id, name, source_week_starts_on, created_by_membership_id)
    VALUES ('20000000-0000-4000-8000-000000000001', 'Intrusa', '2026-09-07',
            '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'el INSERT cross-tenant de plantilla no debió aceptarse';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.menu_week_template_slots (household_id, template_id, day_offset, meal, group_id, free_text)
    VALUES ('20000000-0000-4000-8000-000000000001', 'bb200000-0000-4000-8000-000000000001',
            1, 'comida', 'bb100000-0000-4000-8000-000000000001', 'Hueco intruso');
    RAISE EXCEPTION 'el INSERT cross-tenant de hueco de plantilla no debió aceptarse';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Ni borrar lo ajeno: el DELETE cross-tenant no alcanza ninguna fila.
  DELETE FROM app.menu_week_templates WHERE id = 'bb200000-0000-4000-8000-000000000001';
  IF FOUND THEN
    RAISE EXCEPTION 'el DELETE cross-tenant de plantilla no debió borrar nada';
  END IF;
END
$assert_admin_templates$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- helper de roble: lee (food_reader) pero NO escribe (family_role).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_templates$
BEGIN
  IF (SELECT count(*) FROM app.menu_week_templates) <> 1 THEN
    RAISE EXCEPTION 'helper debería poder leer la plantilla de su hogar';
  END IF;

  BEGIN
    INSERT INTO app.menu_week_templates (household_id, name, source_week_starts_on, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Plantilla del apoyo', '2026-09-07',
            '11000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'el INSERT del apoyo no debió aceptarse (escribe solo la familia)';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  DELETE FROM app.menu_week_templates WHERE id = 'ba200000-0000-4000-8000-000000000001';
  IF FOUND THEN
    RAISE EXCEPTION 'el DELETE del apoyo no debió borrar la plantilla';
  END IF;
END
$assert_helper_templates$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- viewer de roble: cero filas (no es food_reader).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer_templates$
BEGIN
  IF (SELECT count(*) FROM app.menu_week_templates) <> 0
     OR (SELECT count(*) FROM app.menu_week_template_slots) <> 0 THEN
    RAISE EXCEPTION 'viewer no debería ver plantilla alguna';
  END IF;
END
$assert_viewer_templates$;

COMMIT;

-- Limpieza: las filas sembradas no deben condicionar a otros ficheros de test.
BEGIN;
SET LOCAL row_security = off;
DELETE FROM app.menu_week_templates
 WHERE id IN ('ba200000-0000-4000-8000-000000000001', 'bb200000-0000-4000-8000-000000000001');
DELETE FROM app.menu_groups
 WHERE id IN ('ba100000-0000-4000-8000-000000000001', 'bb100000-0000-4000-8000-000000000001');
COMMIT;
