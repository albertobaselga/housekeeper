BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ola B — Compra real y archivado.
--
-- 1. Tamaño de paquete opcional del catálogo de alimentos: el servidor puede
--    redondear la cantidad de la compra a medidas de tienda (350 g → 1 paquete
--    de 500 g). Es OPCIONAL a propósito: sin dato, la lista muestra la cantidad
--    exacta. No se siembra ningún catálogo de paquetes: lo fija la casa.
-- 2. Lista «Personal» de la interna (Anexo H del manual de convivencia): la
--    misma tabla de la compra con un discriminador `list_kind`, y RLS REAL que
--    la deja ver y escribir solo a la empleada interna y a la administración
--    familiar (family_admin). La familia no administradora, el apoyo y el visor
--    no leen ni una fila personal: no es un filtro de la interfaz.
-- 3. Marcado de la LÍNEA de la compra, incluidos los artículos «del menú». La
--    parte derivada del menú NO se materializa (sigue calculándose en lectura
--    desde recetas y huecos): lo que se persiste es el hecho «esta línea de
--    esta semana ya está comprada», con clave semana + línea. Así, cambiar el
--    menú recalcula cantidades sin perder lo ya marcado y sin inventar filas.
-- 4. Archivado de la ficha de receta, independiente de archivar su nota de la
--    Guía: retirar una receta del recetario no debe borrar lo escrito.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tamaño de paquete de compra ──────────────────────────────────────────
ALTER TABLE app.foods
  ADD COLUMN package_size numeric(10, 2)
    CHECK (package_size IS NULL OR package_size > 0),
  ADD COLUMN package_unit text
    CHECK (package_unit IS NULL OR length(btrim(package_unit)) BETWEEN 1 AND 30);

-- Tamaño y unidad viajan juntos: «500» sin unidad no sirve para redondear.
ALTER TABLE app.foods
  ADD CONSTRAINT foods_package_size_needs_unit
    CHECK ((package_size IS NULL) = (package_unit IS NULL));

-- ── 2. Lista personal de la interna ─────────────────────────────────────────
ALTER TABLE app.shopping_items
  ADD COLUMN list_kind text NOT NULL DEFAULT 'casa'
    CHECK (list_kind IN ('casa', 'personal'));

-- La lista personal es de artículos escritos a mano (compra personal
-- quincenal): nunca sale del menú de la casa.
ALTER TABLE app.shopping_items
  ADD CONSTRAINT shopping_personal_is_manual
    CHECK (list_kind = 'casa' OR food_id IS NULL);

CREATE INDEX shopping_items_week_kind_idx
  ON app.shopping_items (household_id, list_kind, week_starts_on);

-- ── 3. Marcado por línea de la compra ───────────────────────────────────────
-- `line_key` es la identidad de la línea fusionada que calcula el servidor:
--   · `food:<uuid>`  → alimento del catálogo (fusiona el derivado del menú con
--     los añadidos manuales que apuntan a ese alimento o que repiten su nombre);
--   · `name:<nombre normalizado>` → añadido a mano sin alimento del catálogo.
CREATE TABLE app.shopping_line_checks (
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  week_starts_on date NOT NULL,
  list_kind text NOT NULL DEFAULT 'casa' CHECK (list_kind IN ('casa', 'personal')),
  line_key text NOT NULL CHECK (
    line_key ~ '^food:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (line_key LIKE 'name:%' AND length(line_key) BETWEEN 6 AND 125)
  ),
  checked_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  checked_by_membership_id uuid NOT NULL,
  PRIMARY KEY (household_id, week_starts_on, list_kind, line_key),
  FOREIGN KEY (household_id, checked_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

ALTER TABLE app.shopping_line_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shopping_line_checks FORCE ROW LEVEL SECURITY;

-- ── 4. Archivado de la ficha de receta ──────────────────────────────────────
ALTER TABLE app.recipes ADD COLUMN archived_at timestamptz;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS de la compra: la lista de casa mantiene la matriz de 0008 (leen familia,
-- empleada y apoyo; escriben familia y empleada) y la lista personal se
-- restringe a empleada interna + administración familiar. Se reescriben las
-- políticas de `shopping_items` porque las políticas permisivas se SUMAN: una
-- política nueva no podría quitar visibilidad a la de 0008.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.personal_shopping_participant()
RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() IN ('family_admin', 'employee_live_in')
$$;

CREATE FUNCTION app.house_shopping_writer()
RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in')
$$;

DROP POLICY shopping_read ON app.shopping_items;
CREATE POLICY shopping_read ON app.shopping_items
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND CASE list_kind
          WHEN 'personal' THEN app.personal_shopping_participant()
          ELSE app.food_reader()
        END
  );

DROP POLICY shopping_write ON app.shopping_items;
CREATE POLICY shopping_write ON app.shopping_items
  FOR ALL USING (
    app.tenant_context_matches(household_id)
    AND CASE list_kind
          WHEN 'personal' THEN app.personal_shopping_participant()
          ELSE app.house_shopping_writer()
        END
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND CASE list_kind
          WHEN 'personal' THEN app.personal_shopping_participant()
          ELSE app.house_shopping_writer()
        END
  );

-- El marcado hereda exactamente la misma matriz que la lista que marca.
CREATE POLICY shopping_line_checks_read ON app.shopping_line_checks
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND CASE list_kind
          WHEN 'personal' THEN app.personal_shopping_participant()
          ELSE app.food_reader()
        END
  );
CREATE POLICY shopping_line_checks_write ON app.shopping_line_checks
  FOR ALL USING (
    app.tenant_context_matches(household_id)
    AND CASE list_kind
          WHEN 'personal' THEN app.personal_shopping_participant()
          ELSE app.house_shopping_writer()
        END
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND CASE list_kind
          WHEN 'personal' THEN app.personal_shopping_participant()
          ELSE app.house_shopping_writer()
        END
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON app.shopping_line_checks TO casa_clara_app;

COMMIT;
