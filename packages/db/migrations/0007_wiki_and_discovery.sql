BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() es STABLE; este envoltorio fija el diccionario y se declara
-- IMMUTABLE para poder usarlo en columnas generadas e índices de expresión.
CREATE FUNCTION app.unaccent_es(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, coalesce(value, ''))
$$;

-- array_to_string es STABLE; para texto plano es efectivamente inmutable y las
-- columnas generadas exigen esa declaración.
CREATE FUNCTION app.join_words(words text[])
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT array_to_string(words, ' ')
$$;

CREATE TYPE app.wiki_page_status AS ENUM ('draft', 'published');

CREATE TABLE app.wiki_spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  UNIQUE (household_id, slug),
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE TABLE app.wiki_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  space_id uuid NOT NULL,
  parent_page_id uuid,
  status app.wiki_page_status NOT NULL DEFAULT 'draft',
  current_slug text NOT NULL CHECK (current_slug = lower(current_slug) AND current_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  pinned boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archived_at timestamptz,
  current_revision_id uuid,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, space_id)
    REFERENCES app.wiki_spaces(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, parent_page_id)
    REFERENCES app.wiki_pages(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  CHECK (parent_page_id IS NULL OR parent_page_id <> id),
  CHECK (updated_at >= created_at),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

-- Los slugs históricos nunca se liberan: renombrar una página añade el slug
-- nuevo y conserva los anteriores, de modo que ningún enlace interno se rompe
-- (AC-15). La unicidad es por hogar para poder resolver cualquier slug.
CREATE TABLE app.wiki_page_slugs (
  household_id uuid NOT NULL,
  page_id uuid NOT NULL,
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (household_id, slug),
  FOREIGN KEY (household_id, page_id)
    REFERENCES app.wiki_pages(household_id, id) ON DELETE RESTRICT
);

-- Historial append-only de contenido. El Markdown canónico vive aquí; la
-- revisión vigente se referencia desde la página. `locale` deja preparadas las
-- traducciones por página sin exigir contenido traducido todavía.
CREATE TABLE app.wiki_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  page_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  locale text NOT NULL DEFAULT 'es' CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  body_markdown text NOT NULL,
  summary text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  aliases text[] NOT NULL DEFAULT '{}',
  authored_by_membership_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish'::regconfig, app.unaccent_es(title)), 'A')
    || setweight(to_tsvector('spanish'::regconfig, app.unaccent_es(app.join_words(aliases))), 'A')
    || setweight(to_tsvector('spanish'::regconfig, app.unaccent_es(app.join_words(tags))), 'B')
    || setweight(to_tsvector('spanish'::regconfig, app.unaccent_es(body_markdown)), 'C')
  ) STORED,
  UNIQUE (household_id, id),
  UNIQUE (household_id, page_id, revision_number),
  FOREIGN KEY (household_id, page_id)
    REFERENCES app.wiki_pages(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, authored_by_membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT
);

ALTER TABLE app.wiki_pages
  ADD CONSTRAINT wiki_pages_current_revision_fk
  FOREIGN KEY (household_id, current_revision_id)
  REFERENCES app.wiki_revisions(household_id, id) ON DELETE RESTRICT;

CREATE INDEX wiki_revisions_search_idx ON app.wiki_revisions USING gin (search_document);
CREATE INDEX wiki_revisions_title_trgm_idx
  ON app.wiki_revisions USING gin (app.unaccent_es(title) gin_trgm_ops);
CREATE INDEX wiki_pages_space_idx ON app.wiki_pages (household_id, space_id, position);

CREATE FUNCTION app.enforce_wiki_revision_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  expected integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'las revisiones de wiki son inmutables; añade una revisión nueva'
      USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.page_id::text, 7));
  SELECT COALESCE(max(revision_number), 0) + 1
    INTO expected
    FROM app.wiki_revisions
   WHERE household_id = NEW.household_id AND page_id = NEW.page_id;
  IF NEW.revision_number <> expected THEN
    RAISE EXCEPTION 'se esperaba la revisión %, llegó %', expected, NEW.revision_number
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER wiki_revisions_append_only
BEFORE INSERT OR UPDATE OR DELETE ON app.wiki_revisions
FOR EACH ROW EXECUTE FUNCTION app.enforce_wiki_revision_append();

CREATE TRIGGER wiki_pages_touch_updated_at
BEFORE UPDATE ON app.wiki_pages
FOR EACH ROW EXECUTE FUNCTION app_private.touch_updated_at();

-- Lecturas agregadas por día y página, sin identidad alguna (AC-20): la
-- portada usa sumas de 30 días. El incremento pasa por una función para que
-- ningún rol necesite UPDATE directo sobre la tabla.
CREATE TABLE app.wiki_page_reads (
  household_id uuid NOT NULL,
  page_id uuid NOT NULL,
  read_on date NOT NULL DEFAULT current_date,
  read_count integer NOT NULL DEFAULT 0 CHECK (read_count >= 0),
  PRIMARY KEY (household_id, page_id, read_on),
  FOREIGN KEY (household_id, page_id)
    REFERENCES app.wiki_pages(household_id, id) ON DELETE RESTRICT
);

CREATE FUNCTION app.record_wiki_read(target_page uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.wiki_pages
     WHERE household_id = app.current_household_id() AND id = target_page
  ) THEN
    RAISE EXCEPTION 'página inexistente en este hogar' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.wiki_page_reads (household_id, page_id, read_on, read_count)
  VALUES (app.current_household_id(), target_page, current_date, 1)
  ON CONFLICT (household_id, page_id, read_on)
  DO UPDATE SET read_count = app.wiki_page_reads.read_count + 1;
END
$$;

REVOKE ALL ON FUNCTION app.record_wiki_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_wiki_read(uuid) TO casa_clara_app;

-- Búsquedas sin resultado o sin clic, anonimizadas: consulta normalizada, día
-- y contadores; nunca quién buscó. Alimenta la detección de huecos (AC-18).
CREATE TABLE app.search_gap_events (
  household_id uuid NOT NULL REFERENCES app.households(id) ON DELETE RESTRICT,
  query_normalized text NOT NULL CHECK (length(btrim(query_normalized)) BETWEEN 1 AND 200),
  occurred_on date NOT NULL DEFAULT current_date,
  miss_count integer NOT NULL DEFAULT 0 CHECK (miss_count >= 0),
  no_click_count integer NOT NULL DEFAULT 0 CHECK (no_click_count >= 0),
  PRIMARY KEY (household_id, query_normalized, occurred_on)
);

CREATE FUNCTION app.record_search_gap(raw_query text, had_results boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  normalized text;
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;
  normalized := left(btrim(lower(app.unaccent_es(raw_query))), 200);
  IF length(normalized) = 0 THEN
    RETURN;
  END IF;
  INSERT INTO app.search_gap_events (household_id, query_normalized, occurred_on, miss_count, no_click_count)
  VALUES (app.current_household_id(), normalized, current_date,
          CASE WHEN had_results THEN 0 ELSE 1 END,
          CASE WHEN had_results THEN 1 ELSE 0 END)
  ON CONFLICT (household_id, query_normalized, occurred_on)
  DO UPDATE SET miss_count = app.search_gap_events.miss_count + excluded.miss_count,
                no_click_count = app.search_gap_events.no_click_count + excluded.no_click_count;
END
$$;

REVOKE ALL ON FUNCTION app.record_search_gap(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_search_gap(text, boolean) TO casa_clara_app;

-- RLS. Lectura de contenido: todos los roles menos viewer; los borradores solo
-- los ven quienes escriben. Escritura: familia y empleada; los espacios los
-- administra la familia.
DO $wiki_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'wiki_spaces', 'wiki_pages', 'wiki_page_slugs', 'wiki_revisions',
    'wiki_page_reads', 'search_gap_events'
  ] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END
$wiki_rls$;

CREATE FUNCTION app.wiki_reader()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in', 'helper')
$$;

CREATE FUNCTION app.wiki_writer()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.current_household_role() IN ('family_admin', 'family_member', 'employee_live_in')
$$;

CREATE POLICY wiki_spaces_read ON app.wiki_spaces
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.wiki_reader());
CREATE POLICY wiki_spaces_admin_write ON app.wiki_spaces
  FOR ALL USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() IN ('family_admin', 'family_member')
  ) WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() IN ('family_admin', 'family_member')
  );

CREATE POLICY wiki_pages_read ON app.wiki_pages
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND (
      (status = 'published' AND app.wiki_reader())
      OR app.wiki_writer()
    )
  );
CREATE POLICY wiki_pages_write ON app.wiki_pages
  FOR ALL USING (app.tenant_context_matches(household_id) AND app.wiki_writer())
  WITH CHECK (app.tenant_context_matches(household_id) AND app.wiki_writer());

CREATE POLICY wiki_slugs_read ON app.wiki_page_slugs
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.wiki_reader());
CREATE POLICY wiki_slugs_write ON app.wiki_page_slugs
  FOR INSERT WITH CHECK (app.tenant_context_matches(household_id) AND app.wiki_writer());

CREATE POLICY wiki_revisions_read ON app.wiki_revisions
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND (
      app.wiki_writer()
      OR EXISTS (
        SELECT 1 FROM app.wiki_pages AS page
         WHERE page.household_id = wiki_revisions.household_id
           AND page.id = wiki_revisions.page_id
           AND page.status = 'published'
           AND app.wiki_reader()
      )
    )
  );
CREATE POLICY wiki_revisions_write ON app.wiki_revisions
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.wiki_writer()
    AND authored_by_membership_id = app.current_membership_id()
  );

CREATE POLICY wiki_reads_select ON app.wiki_page_reads
  FOR SELECT USING (app.tenant_context_matches(household_id) AND app.wiki_reader());

CREATE POLICY search_gaps_select ON app.search_gap_events
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND app.current_household_role() IN ('family_admin', 'family_member')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON app.wiki_spaces, app.wiki_pages TO casa_clara_app;
GRANT SELECT, INSERT ON app.wiki_page_slugs, app.wiki_revisions TO casa_clara_app;
GRANT SELECT ON app.wiki_page_reads, app.search_gap_events TO casa_clara_app;

-- Auditoría de metadatos (no del cuerpo: el historial de contenido ya es
-- append-only en wiki_revisions).
CREATE TRIGGER wiki_spaces_audit
AFTER INSERT OR UPDATE OR DELETE ON app.wiki_spaces
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();
CREATE TRIGGER wiki_pages_audit
AFTER INSERT OR UPDATE OR DELETE ON app.wiki_pages
FOR EACH ROW EXECUTE FUNCTION app_private.write_audit_event();

COMMIT;
