-- RLS de la compra tras la migración 0016: la lista «Personal» de la interna
-- solo la ven y escriben la empleada interna y la administración familiar; la
-- lista de casa mantiene la matriz de 0008; y nadie cruza de hogar. Cubre
-- también el marcado por línea (app.shopping_line_checks) y el archivado de
-- fichas de receta.
--
-- Requiere migraciones + fixtures/001_two_households.sql aplicadas y una
-- conexión que pueda SET ROLE casa_clara_app.
--
-- UUIDs con prefijos ca* (roble) / cb* (olivo), exclusivos de este fichero.

-- ─────────────────────────────────────────────────────────────────────────────
-- Siembra (superusuario, RLS off): un artículo de casa y uno personal por
-- hogar, más un marcado de línea de cada clase.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.shopping_items
  (id, household_id, custom_name, quantity, unit, section, week_starts_on, list_kind,
   created_by_membership_id) VALUES
  ('ca100000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'Detergente de la casa', 2, 'ud', 'hogar', '2026-09-07', 'casa',
   '11000000-0000-4000-8000-000000000001'),
  ('ca100000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'Champú de Ana', 1, 'ud', 'personal', '2026-09-07', 'personal',
   '11000000-0000-4000-8000-000000000003'),
  ('cb100000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
   'Detergente del olivo', 1, 'ud', 'hogar', '2026-09-07', 'casa',
   '21000000-0000-4000-8000-000000000001'),
  ('cb100000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001',
   'Crema del olivo', 1, 'ud', 'personal', '2026-09-07', 'personal',
   '21000000-0000-4000-8000-000000000002');

INSERT INTO app.shopping_line_checks
  (household_id, week_starts_on, list_kind, line_key, checked_by_membership_id) VALUES
  ('10000000-0000-4000-8000-000000000001', '2026-09-07', 'casa',
   'name:detergente de la casa', '11000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000001', '2026-09-07', 'personal',
   'name:champú de ana', '11000000-0000-4000-8000-000000000003'),
  ('20000000-0000-4000-8000-000000000001', '2026-09-07', 'casa',
   'name:detergente del olivo', '21000000-0000-4000-8000-000000000001');

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- family_admin de roble: ve las dos listas de SU hogar y ninguna del olivo.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:admin', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000001'
);

DO $assert_admin_shopping$
BEGIN
  IF (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'personal') <> 1
     OR (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'casa') <> 1 THEN
    RAISE EXCEPTION 'family_admin debería ver la lista de casa y la personal de su hogar';
  END IF;

  IF (SELECT count(*) FROM app.shopping_items
       WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0
     OR (SELECT count(*) FROM app.shopping_line_checks
          WHERE household_id = '20000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'family_admin de roble filtra compra del olivo';
  END IF;

  IF (SELECT count(*) FROM app.shopping_line_checks) <> 2 THEN
    RAISE EXCEPTION 'family_admin debería ver los dos marcados de su hogar';
  END IF;

  -- Escritura cross-tenant: rechazada por RLS.
  BEGIN
    INSERT INTO app.shopping_items
      (household_id, custom_name, section, list_kind, created_by_membership_id)
    VALUES ('20000000-0000-4000-8000-000000000001', 'Intruso', 'hogar', 'casa',
            '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'el INSERT cross-tenant de compra no debió aceptarse';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    INSERT INTO app.shopping_line_checks
      (household_id, week_starts_on, list_kind, line_key, checked_by_membership_id)
    VALUES ('20000000-0000-4000-8000-000000000001', '2026-09-07', 'casa',
            'name:intruso', '21000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'el INSERT cross-tenant de marcado no debió aceptarse';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  DELETE FROM app.shopping_items WHERE id = 'cb100000-0000-4000-8000-000000000002';
  IF FOUND THEN
    RAISE EXCEPTION 'el DELETE cross-tenant de compra no debió borrar nada';
  END IF;
END
$assert_admin_shopping$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- employee_live_in de roble: ve y escribe su lista personal.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:employee', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003'
);

DO $assert_employee_shopping$
BEGIN
  IF (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'personal') <> 1 THEN
    RAISE EXCEPTION 'la empleada interna debería ver su lista personal';
  END IF;

  INSERT INTO app.shopping_items
    (household_id, custom_name, section, week_starts_on, list_kind, created_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'Gel de Ana', 'personal', '2026-09-07',
          'personal', '11000000-0000-4000-8000-000000000003');

  INSERT INTO app.shopping_line_checks
    (household_id, week_starts_on, list_kind, line_key, checked_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', '2026-09-07', 'personal',
          'name:gel de ana', '11000000-0000-4000-8000-000000000003');

  IF (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'personal') <> 2 THEN
    RAISE EXCEPTION 'la empleada debería poder añadir a su lista personal';
  END IF;
END
$assert_employee_shopping$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- family_member de roble: lista de casa sí, lista personal NO (ni leer ni
-- escribir). Es la restricción del manual de convivencia: la compra personal
-- de la interna la verifica la administración, no toda la familia.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:family', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000002'
);

DO $assert_member_shopping$
BEGIN
  IF (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'personal') <> 0 THEN
    RAISE EXCEPTION 'family_member no debería ver ni una fila de la lista personal';
  END IF;
  IF (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'casa') <> 1 THEN
    RAISE EXCEPTION 'family_member debería seguir viendo la lista de casa';
  END IF;
  IF (SELECT count(*) FROM app.shopping_line_checks WHERE list_kind = 'personal') <> 0 THEN
    RAISE EXCEPTION 'family_member no debería ver marcados de la lista personal';
  END IF;

  BEGIN
    INSERT INTO app.shopping_items
      (household_id, custom_name, section, list_kind, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Intento personal', 'personal', 'personal',
            '11000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'family_member no debió poder escribir en la lista personal';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Y sí puede seguir escribiendo en la lista de casa.
  INSERT INTO app.shopping_items
    (household_id, custom_name, section, week_starts_on, list_kind, created_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'Servilletas', 'hogar', '2026-09-07', 'casa',
          '11000000-0000-4000-8000-000000000002');
END
$assert_member_shopping$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- helper (apoyo) de roble: lee la lista de casa, no la personal, y no escribe.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:helper', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000004'
);

DO $assert_helper_shopping$
BEGIN
  IF (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'personal') <> 0 THEN
    RAISE EXCEPTION 'el apoyo no debería ver la lista personal';
  END IF;
  IF (SELECT count(*) FROM app.shopping_items WHERE list_kind = 'casa') = 0 THEN
    RAISE EXCEPTION 'el apoyo debería seguir leyendo la lista de casa';
  END IF;

  BEGIN
    INSERT INTO app.shopping_items
      (household_id, custom_name, section, list_kind, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Intento del apoyo', 'hogar', 'casa',
            '11000000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'el apoyo no debió poder escribir en la compra';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$assert_helper_shopping$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- viewer de roble: cero filas de compra (no es food_reader).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE casa_clara_app;
SELECT set_config('app.user_id', 'fixture:roble:viewer', true);
SELECT app.set_household_context(
  '10000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000005'
);

DO $assert_viewer_shopping$
BEGIN
  IF (SELECT count(*) FROM app.shopping_items) <> 0
     OR (SELECT count(*) FROM app.shopping_line_checks) <> 0 THEN
    RAISE EXCEPTION 'el visor no debería ver compra alguna';
  END IF;
END
$assert_viewer_shopping$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariantes de esquema de 0016: paquete completo o nada, la lista personal
-- no admite alimentos del catálogo, y la ficha de receta se archiva sola.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL row_security = off;

DO $assert_schema_0016$
DECLARE
  food_id uuid;
BEGIN
  BEGIN
    INSERT INTO app.foods (household_id, name, package_size, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', 'Arroz a medias 0016', 500,
            '11000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'un tamaño de paquete sin unidad no debió aceptarse';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO app.foods (household_id, name, package_size, package_unit, created_by_membership_id)
  VALUES ('10000000-0000-4000-8000-000000000001', 'Arroz de paquete 0016', 500, 'g',
          '11000000-0000-4000-8000-000000000001')
  RETURNING id INTO food_id;

  BEGIN
    INSERT INTO app.shopping_items
      (household_id, food_id, section, list_kind, created_by_membership_id)
    VALUES ('10000000-0000-4000-8000-000000000001', food_id, 'personal', 'personal',
            '11000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'la lista personal no debió admitir un alimento del catálogo';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'recipes' AND column_name = 'archived_at') <> 1 THEN
    RAISE EXCEPTION 'app.recipes debería tener archived_at tras 0016';
  END IF;

  DELETE FROM app.foods WHERE id = food_id;
END
$assert_schema_0016$;

COMMIT;

-- Limpieza: las filas sembradas no deben condicionar a otros ficheros de test.
BEGIN;
SET LOCAL row_security = off;
DELETE FROM app.shopping_line_checks
 WHERE household_id IN ('10000000-0000-4000-8000-000000000001',
                        '20000000-0000-4000-8000-000000000001');
DELETE FROM app.shopping_items
 WHERE household_id IN ('10000000-0000-4000-8000-000000000001',
                        '20000000-0000-4000-8000-000000000001');
COMMIT;
