BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Semanas de menú plantilla con nombre («Semana de cole», «Semana de verano»):
-- la familia guarda el snapshot de una semana y lo aplica sobre otra vacía.
--
-- Los huecos se guardan NORMALIZADOS (día relativo 0-6, franja, grupo, receta,
-- texto, notas, raciones) para que las FKs compuestas validen grupo y receta
-- dentro del hogar. La degradación es explícita, no un fallo:
--   · receta borrada  → recipe_page_id pasa a NULL por ON DELETE SET NULL y
--     queda `recipe_title` (snapshot del título al guardar) para aplicar el
--     hueco como texto libre;
--   · grupo borrado   → sus huecos de plantilla caen con él (CASCADE);
--   · grupo/página ARCHIVADOS → la fila persiste y es el comando `apply` quien
--     degrada (salta el grupo, convierte la receta en texto).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.menu_week_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  source_week_starts_on date NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

-- Nombre único por hogar, insensible a mayúsculas (mismo patrón que foods).
CREATE UNIQUE INDEX menu_week_templates_name_per_household_idx
  ON app.menu_week_templates (household_id, lower(name));

CREATE TABLE app.menu_week_template_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  template_id uuid NOT NULL,
  day_offset integer NOT NULL CHECK (day_offset BETWEEN 0 AND 6),
  meal app.meal_slot NOT NULL,
  group_id uuid NOT NULL,
  recipe_page_id uuid,
  -- Título de la receta al guardar la plantilla: si la receta desaparece, el
  -- hueco se aplica como texto libre con este título en vez de romperse.
  recipe_title text NOT NULL DEFAULT '',
  free_text text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  servings_override integer CHECK (servings_override IS NULL OR servings_override > 0),
  UNIQUE (household_id, id),
  UNIQUE (household_id, template_id, group_id, day_offset, meal),
  FOREIGN KEY (household_id, template_id)
    REFERENCES app.menu_week_templates(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, group_id)
    REFERENCES app.menu_groups(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, recipe_page_id)
    REFERENCES app.recipes(household_id, page_id) ON DELETE SET NULL (recipe_page_id),
  -- Un hueco de plantilla siempre conserva algo aplicable: receta viva, texto
  -- libre o, como mínimo, el título capturado de la receta.
  CHECK (
    recipe_page_id IS NOT NULL
    OR length(btrim(free_text)) > 0
    OR length(btrim(recipe_title)) > 0
  )
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: mismas reglas que el resto del menú — leen familia, empleada y apoyo
-- (food_reader); escribe solo la familia (family_role).
-- ─────────────────────────────────────────────────────────────────────────────
DO $menu_template_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['menu_week_templates', 'menu_week_template_slots'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$menu_template_rls$;

CREATE POLICY menu_week_templates_read ON app.menu_week_templates
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY menu_week_templates_family_write ON app.menu_week_templates
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

CREATE POLICY menu_week_template_slots_read ON app.menu_week_template_slots
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY menu_week_template_slots_family_write ON app.menu_week_template_slots
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.menu_week_templates, app.menu_week_template_slots TO casa_clara_app;

COMMIT;
