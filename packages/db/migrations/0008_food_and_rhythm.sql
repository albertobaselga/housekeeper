BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Catálogo global de los 14 alérgenos de declaración obligatoria en la UE.
-- Datos de referencia sembrados por la migración; nadie los edita en runtime.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.eu_allergens (
  code text PRIMARY KEY CHECK (code = lower(code) AND code ~ '^[a-z-]+$'),
  name_es text NOT NULL,
  position integer NOT NULL UNIQUE
);

INSERT INTO app.eu_allergens (code, name_es, position) VALUES
  ('gluten', 'Cereales con gluten', 1),
  ('crustaceos', 'Crustáceos', 2),
  ('huevos', 'Huevos', 3),
  ('pescado', 'Pescado', 4),
  ('cacahuetes', 'Cacahuetes', 5),
  ('soja', 'Soja', 6),
  ('lacteos', 'Leche y derivados (lactosa)', 7),
  ('frutos-de-cascara', 'Frutos de cáscara', 8),
  ('apio', 'Apio', 9),
  ('mostaza', 'Mostaza', 10),
  ('sesamo', 'Granos de sésamo', 11),
  ('sulfitos', 'Dióxido de azufre y sulfitos', 12),
  ('altramuces', 'Altramuces', 13),
  ('moluscos', 'Moluscos', 14);

-- ─────────────────────────────────────────────────────────────────────────────
-- Alimentos del hogar y su mapeo de alérgenos. Un alimento sin revisar bloquea
-- la asignación de recetas que lo usan (regla del brief, sin excepción).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.foods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  shopping_section text NOT NULL DEFAULT 'despensa' CHECK (length(btrim(shopping_section)) BETWEEN 1 AND 60),
  allergens_reviewed boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX foods_name_per_household_idx
  ON app.foods (household_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE app.food_allergens (
  household_id uuid NOT NULL,
  food_id uuid NOT NULL,
  allergen_code text NOT NULL REFERENCES app.eu_allergens(code) ON DELETE RESTRICT,
  PRIMARY KEY (household_id, food_id, allergen_code),
  FOREIGN KEY (household_id, food_id) REFERENCES app.foods(household_id, id) ON DELETE CASCADE
);

-- Comensales y sus restricciones (DietaryFlag).
CREATE TABLE app.diners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (household_id, id)
);

CREATE TABLE app.diner_flags (
  household_id uuid NOT NULL,
  diner_id uuid NOT NULL,
  allergen_code text NOT NULL REFERENCES app.eu_allergens(code) ON DELETE RESTRICT,
  severity text NOT NULL CHECK (severity IN ('high', 'medium')),
  note text NOT NULL DEFAULT '',
  PRIMARY KEY (household_id, diner_id, allergen_code),
  FOREIGN KEY (household_id, diner_id) REFERENCES app.diners(household_id, id) ON DELETE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Receta como extensión 1:1 de una página wiki: la narrativa vive en la wiki
-- (revisiones, diff, adjuntos futuros); aquí solo los datos estructurados.
-- Cantidades como numeric; `scaling` distingue lineal de no lineal (AC-22).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.recipes (
  household_id uuid NOT NULL,
  page_id uuid NOT NULL,
  base_servings integer NOT NULL CHECK (base_servings > 0),
  time_minutes integer CHECK (time_minutes IS NULL OR time_minutes > 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, page_id),
  FOREIGN KEY (household_id, page_id) REFERENCES app.wiki_pages(household_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  page_id uuid NOT NULL,
  food_id uuid NOT NULL,
  quantity numeric(10, 2) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL CHECK (length(btrim(unit)) BETWEEN 1 AND 30),
  scaling text NOT NULL DEFAULT 'linear' CHECK (scaling IN ('linear', 'fixed')),
  position integer NOT NULL DEFAULT 0,
  UNIQUE (household_id, page_id, food_id),
  FOREIGN KEY (household_id, page_id) REFERENCES app.recipes(household_id, page_id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, food_id) REFERENCES app.foods(household_id, id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Menú: cinco franjas, grupos ilimitados de comensales, texto libre o receta.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE app.meal_slot AS ENUM ('desayuno', 'almuerzo', 'comida', 'merienda', 'cena');

CREATE TABLE app.menu_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  UNIQUE (household_id, id)
);

CREATE TABLE app.menu_group_diners (
  household_id uuid NOT NULL,
  group_id uuid NOT NULL,
  diner_id uuid NOT NULL,
  PRIMARY KEY (household_id, group_id, diner_id),
  FOREIGN KEY (household_id, group_id) REFERENCES app.menu_groups(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, diner_id) REFERENCES app.diners(household_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.menu_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  group_id uuid NOT NULL,
  on_date date NOT NULL,
  meal app.meal_slot NOT NULL,
  recipe_page_id uuid,
  free_text text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  servings_override integer CHECK (servings_override IS NULL OR servings_override > 0),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_by_membership_id uuid NOT NULL,
  UNIQUE (household_id, id),
  UNIQUE (household_id, group_id, on_date, meal),
  FOREIGN KEY (household_id, group_id) REFERENCES app.menu_groups(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, recipe_page_id) REFERENCES app.recipes(household_id, page_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, updated_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (recipe_page_id IS NOT NULL OR length(btrim(free_text)) > 0)
);

-- Confirmación bloqueante ligada al hash del contenido (receta + comensales +
-- restricciones): cualquier cambio posterior invalida la confirmación porque
-- el hash recalculado deja de coincidir.
CREATE TABLE app.menu_confirmations (
  household_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  confirmed_by_membership_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, slot_id),
  FOREIGN KEY (household_id, slot_id) REFERENCES app.menu_slots(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, confirmed_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Lista de compra: la parte derivada del menú se calcula en lectura; aquí solo
-- añadidos manuales y marcados, que admiten last-write-wins offline.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.shopping_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  food_id uuid,
  custom_name text,
  quantity numeric(10, 2) CHECK (quantity IS NULL OR quantity > 0),
  unit text CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 30),
  section text NOT NULL DEFAULT 'despensa',
  week_starts_on date,
  checked_at timestamptz,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, food_id) REFERENCES app.foods(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (food_id IS NOT NULL OR (custom_name IS NOT NULL AND length(btrim(custom_name)) > 0))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Rutinas y mantenimientos recurrentes con audiencia. Las finalizaciones se
-- registran por ocurrencia; deliberadamente NO existen vistas de porcentaje ni
-- histórico de rendimiento (AC-26).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE app.routine_audience AS ENUM ('family', 'employee', 'all');
CREATE TYPE app.routine_frequency AS ENUM ('daily', 'weekly', 'monthly', 'quarterly');

CREATE TABLE app.routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  details text NOT NULL DEFAULT '',
  audience app.routine_audience NOT NULL DEFAULT 'all',
  frequency app.routine_frequency NOT NULL,
  interval_count integer NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 12),
  next_due_on date NOT NULL,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.routine_completions (
  household_id uuid NOT NULL,
  routine_id uuid NOT NULL,
  due_on date NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  completed_by_membership_id uuid NOT NULL,
  PRIMARY KEY (household_id, routine_id, due_on),
  FOREIGN KEY (household_id, routine_id) REFERENCES app.routines(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, completed_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Feeds ICS de salida por audiencia, revocables; solo se guarda el hash del
-- token. Las fuentes de entrada las consume el worker con protección SSRF.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.ics_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  audience app.routine_audience NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  revoked_at timestamptz,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

CREATE TABLE app.ics_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  url text NOT NULL CHECK (url ~ '^https://'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  enabled boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_error text,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS. Lectura de comida/menú/compra: familia, empleada y apoyo (viewer no).
-- Escritura de catálogo/menú/recetas: familia. Compra y finalizaciones de
-- rutina: según audiencia. Feeds y fuentes ICS: solo administración.
-- ─────────────────────────────────────────────────────────────────────────────
DO $food_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'eu_allergens', 'foods', 'food_allergens', 'diners', 'diner_flags',
    'recipes', 'recipe_ingredients', 'menu_groups', 'menu_group_diners',
    'menu_slots', 'menu_confirmations', 'shopping_items',
    'routines', 'routine_completions', 'ics_feeds', 'ics_sources'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$food_rls$;

CREATE FUNCTION app.food_reader()
RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in', 'helper')
$$;

CREATE FUNCTION app.family_role()
RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() IN ('family_admin', 'family_member')
$$;

CREATE POLICY eu_allergens_read ON app.eu_allergens
  FOR SELECT USING (app.current_household_role() IS NOT NULL);

CREATE POLICY foods_read ON app.foods
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY foods_family_write ON app.foods
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());
CREATE POLICY food_allergens_read ON app.food_allergens
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY food_allergens_family_write ON app.food_allergens
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

CREATE POLICY diners_read ON app.diners
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY diners_family_write ON app.diners
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());
CREATE POLICY diner_flags_read ON app.diner_flags
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY diner_flags_family_write ON app.diner_flags
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

CREATE POLICY recipes_read ON app.recipes
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY recipes_family_write ON app.recipes
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());
CREATE POLICY recipe_ingredients_read ON app.recipe_ingredients
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY recipe_ingredients_family_write ON app.recipe_ingredients
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

CREATE POLICY menu_groups_read ON app.menu_groups
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY menu_groups_family_write ON app.menu_groups
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());
CREATE POLICY menu_group_diners_read ON app.menu_group_diners
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY menu_group_diners_family_write ON app.menu_group_diners
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());

CREATE POLICY menu_slots_read ON app.menu_slots
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY menu_slots_family_write ON app.menu_slots
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());
CREATE POLICY menu_confirmations_read ON app.menu_confirmations
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY menu_confirmations_family_write ON app.menu_confirmations
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.family_role()
    AND confirmed_by_membership_id = app.current_membership_id()
  );

CREATE POLICY shopping_read ON app.shopping_items
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.food_reader());
CREATE POLICY shopping_write ON app.shopping_items
  FOR ALL USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in')
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in')
  );

CREATE POLICY routines_read ON app.routines
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND (
      app.family_role()
      OR (app.current_household_role() = 'employee_live_in' AND audience IN ('employee', 'all'))
      OR (app.current_household_role() = 'helper' AND audience = 'all')
    )
  );
CREATE POLICY routines_family_write ON app.routines
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.family_role())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.family_role());
CREATE POLICY routine_completions_read ON app.routine_completions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM app.routines AS routine
       WHERE routine.household_id = routine_completions.household_id
         AND routine.id = routine_completions.routine_id
    )
  );
CREATE POLICY routine_completions_insert ON app.routine_completions
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND completed_by_membership_id = app.current_membership_id()
    AND EXISTS (
      SELECT 1 FROM app.routines AS routine
       WHERE routine.household_id = routine_completions.household_id
         AND routine.id = routine_completions.routine_id
    )
  );

CREATE POLICY ics_feeds_admin ON app.ics_feeds
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');
CREATE POLICY ics_sources_admin ON app.ics_sources
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin')
  WITH CHECK (app.tenant_context_matches(household_id) AND app.current_household_role() = 'family_admin');

GRANT SELECT ON app.eu_allergens TO casa_clara_app, casa_clara_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.foods, app.food_allergens, app.diners,
  app.diner_flags, app.recipes, app.recipe_ingredients, app.menu_groups,
  app.menu_group_diners, app.menu_slots, app.menu_confirmations,
  app.shopping_items, app.routines, app.routine_completions,
  app.ics_feeds, app.ics_sources TO casa_clara_app;

CREATE TRIGGER foods_touch_updated_at
BEFORE UPDATE ON app.foods
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();
CREATE TRIGGER menu_slots_touch_updated_at
BEFORE UPDATE ON app.menu_slots
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

COMMIT;
