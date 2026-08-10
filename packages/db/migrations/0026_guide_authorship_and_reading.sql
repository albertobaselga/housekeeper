BEGIN;

-- ═════════════════════════════════════════════════════════════════════════════
-- La Guía de la casa: quién la escribe y quién se la ha leído.
--
-- Tres cambios, en este orden:
--
--   1. La Guía y el recetario dejan de ser la misma cosa. Comparten tablas
--      (`wiki_*`) por historia, no por sentido: la Guía es el manual de la casa
--      —y el manual de acogida de quien trabaja aquí—, mientras que el
--      recetario es contenido doméstico que la familia mantiene a diario desde
--      el menú. `wiki_spaces.kind` los separa para poder darles reglas
--      distintas sin romper «Nueva receta desde el hueco del menú».
--
--   2. Escribir la GUÍA pasa a ser de `family_admin` y de nadie más (crear,
--      editar, publicar, destacar, crear apartados, marcar modelos). El
--      recetario conserva la regla anterior (familia). La interfaz deja de
--      dibujar los controles a quien no puede usarlos, pero la verdad vive
--      aquí: sin esta política ninguna escritura ajena entra, venga de donde
--      venga.
--
--   3. Progreso de lectura POR PERSONA, para el uso de acogida.
--
-- Sobre el punto 3 hay que ser explícito, porque INVIERTE una decisión previa:
-- la migración 0007 creó `app.wiki_page_reads` como agregado deliberadamente
-- ANÓNIMO (página × día × contador, podado a 45 días por 0012) para descubrir
-- qué se consulta y qué no se encuentra. Esa tabla NO se toca ni se reutiliza:
-- sigue sirviendo a su propósito. Lo que se añade es un registro distinto, con
-- identidad, y con un límite que es parte del diseño y no un descuido:
--
--   · `app.wiki_reading_progress` NO tiene ninguna columna de tiempo. Ni
--     `read_at`, ni `created_at`, ni `updated_at`. No es olvido: es la garantía.
--     Un esquema sin fecha no puede responder «¿a qué hora leyó Ana la nota de
--     la lavadora?» ni «¿qué abrió el martes?», hoy ni dentro de dos años, ni
--     por una consulta nueva, ni por un volcado, ni por una sesión de soporte.
--   · La tabla NO lleva disparador de auditoría, por lo mismo: `audit_events`
--     guarda actor y `occurred_at`, y eso reconstruiría el rastro por la puerta
--     de atrás. Marcar una nota como leída no es un hecho auditable de la casa.
--   · Marcar leído no pasa por la cola de comandos (`app.command_receipts`, con
--     actor y sello de tiempo) por la misma razón: va por una función propia.
--   · La administración NO puede leer ni una fila de la tabla (no hay política
--     que se lo permita). Su única ventana es `app.wiki_reading_overview()`,
--     que devuelve CUENTAS por persona y apartado —cuántas notas hay y cuántas
--     lleva— y jamás qué nota concreta ni cuándo.
--   · Nadie puede marcar por otro: `app.mark_wiki_note_read(uuid)` no acepta
--     membresía como argumento; siempre usa la del contexto.
--
-- Y sobre la invalidación: el progreso guarda la HUELLA del texto leído
-- (`wiki_revisions.reading_fingerprint`), no el número de revisión. La huella
-- normaliza acentos, mayúsculas, puntuación, marcado Markdown y espacios, así
-- que reordenar el formato, corregir una coma, poner una palabra en negrita o
-- reimportar el manual con otro salto de línea NO invalida nada. Cambiar
-- palabras sí: entonces esa nota —solo esa— vuelve a la lista de pendientes,
-- pero conservando la fila, para que la aplicación pueda decir «cambió desde
-- que la leíste» en vez de «nunca la has leído», que sería mentira.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · La Guía y el recetario
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE app.wiki_space_kind AS ENUM ('guide', 'recipes');

ALTER TABLE app.wiki_spaces
  ADD COLUMN kind app.wiki_space_kind NOT NULL DEFAULT 'guide';

COMMENT ON COLUMN app.wiki_spaces.kind IS
  'guide = apartado de la Guía de la casa (lo escribe la administración; cuenta para el progreso de lectura). recipes = recetario del hogar (lo mantiene la familia desde el menú; no cuenta para la acogida).';

-- Lo que ya sostiene recetas es recetario, y también el apartado «recetas» que
-- el flujo del menú crea la primera vez aunque todavía esté vacío.
UPDATE app.wiki_spaces AS space
   SET kind = 'recipes'
 WHERE space.slug = 'recetas'
    OR EXISTS (
         SELECT 1
           FROM app.recipes AS recipe
           JOIN app.wiki_pages AS page
             ON page.household_id = recipe.household_id AND page.id = recipe.page_id
          WHERE page.household_id = space.household_id
            AND page.space_id = space.id
       );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Quién escribe qué
-- ─────────────────────────────────────────────────────────────────────────────

-- Predicado por tipo de apartado. Un `kind` nulo (apartado que el rol no ve)
-- cae en la rama restrictiva: en la duda, solo la administración.
CREATE FUNCTION app.wiki_kind_writer(target_kind app.wiki_space_kind)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT CASE target_kind
    WHEN 'recipes' THEN app.current_household_role() IN ('family_admin', 'family_member')
    ELSE app.current_household_role() = 'family_admin'
  END
$$;

-- SECURITY INVOKER a propósito: mira `app.wiki_spaces`, que es OTRA tabla, así
-- que puede invocarse desde las políticas de `wiki_pages` sin recursión. Si RLS
-- oculta el apartado, el resultado es la rama restrictiva.
CREATE FUNCTION app.wiki_space_writer(target_space uuid)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT app.wiki_kind_writer((
    SELECT space.kind
      FROM app.wiki_spaces AS space
     WHERE space.household_id = app.current_household_id()
       AND space.id = target_space
  ))
$$;

-- `app.wiki_writer()` (0007) queda como estaba para no romper nada que la
-- referencie, pero ninguna política de la Guía la usa ya: el permiso depende
-- ahora del apartado, no solo del rol.
COMMENT ON FUNCTION app.wiki_writer() IS
  'Obsoleta desde 0026: el permiso de escritura depende del apartado (app.wiki_space_writer). Se conserva por compatibilidad.';

DROP POLICY wiki_spaces_admin_write ON app.wiki_spaces;
CREATE POLICY wiki_spaces_write ON app.wiki_spaces
  FOR ALL USING (
    app.tenant_context_matches(household_id) AND app.wiki_kind_writer(kind)
  ) WITH CHECK (
    app.tenant_context_matches(household_id) AND app.wiki_kind_writer(kind)
  );

DROP POLICY wiki_pages_write ON app.wiki_pages;
CREATE POLICY wiki_pages_write ON app.wiki_pages
  FOR ALL USING (
    app.tenant_context_matches(household_id) AND app.wiki_space_writer(space_id)
  ) WITH CHECK (
    app.tenant_context_matches(household_id) AND app.wiki_space_writer(space_id)
  );

-- Lectura de páginas. Novedad: el TERCER caso. Quien dejó un borrador a medias
-- antes de este cambio (la interna podía escribir) sigue viendo el suyo, en
-- solo lectura, para que su trabajo no se evapore de la pantalla sin aviso.
-- Ya no puede editarlo —eso es de la administración—, pero puede leerlo y
-- pedir que se publique.
DROP POLICY wiki_pages_read ON app.wiki_pages;
CREATE POLICY wiki_pages_read ON app.wiki_pages
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND (
      (status = 'published' AND app.wiki_reader())
      OR app.wiki_space_writer(space_id)
      OR (created_by_membership_id = app.current_membership_id() AND app.wiki_reader())
    )
  );

-- Las revisiones heredan la visibilidad de su página en vez de repetir la
-- regla: si RLS deja ver la página, deja ver su historial; si no, no existe.
DROP POLICY wiki_revisions_read ON app.wiki_revisions;
CREATE POLICY wiki_revisions_read ON app.wiki_revisions
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND EXISTS (
      SELECT 1 FROM app.wiki_pages AS page
       WHERE page.household_id = wiki_revisions.household_id
         AND page.id = wiki_revisions.page_id
    )
  );

DROP POLICY wiki_revisions_write ON app.wiki_revisions;
CREATE POLICY wiki_revisions_write ON app.wiki_revisions
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND authored_by_membership_id = app.current_membership_id()
    AND app.wiki_space_writer((
      SELECT page.space_id FROM app.wiki_pages AS page
       WHERE page.household_id = wiki_revisions.household_id
         AND page.id = wiki_revisions.page_id
    ))
  );

DROP POLICY wiki_slugs_write ON app.wiki_page_slugs;
CREATE POLICY wiki_slugs_write ON app.wiki_page_slugs
  FOR INSERT WITH CHECK (
    app.tenant_context_matches(household_id)
    AND app.wiki_space_writer((
      SELECT page.space_id FROM app.wiki_pages AS page
       WHERE page.household_id = wiki_page_slugs.household_id
         AND page.id = wiki_page_slugs.page_id
    ))
  );

-- `libro` y `progreso` son las dos vistas propias de la Guía (modo libro y
-- progreso de lectura) y cuelgan de la misma ruta que las notas. Reservar los
-- slugs evita que una nota titulada «Libro» se quede inalcanzable para siempre.
ALTER TABLE app.wiki_page_slugs
  ADD CONSTRAINT wiki_page_slugs_reserved_slug
  CHECK (slug NOT IN ('libro', 'progreso'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Huella de lectura
-- ─────────────────────────────────────────────────────────────────────────────

-- Texto normalizado para comparar «lo mismo» con criterio: sin acentos, sin
-- mayúsculas y con cualquier racha de signos, marcado o espacios convertida en
-- un separador único. Es lo que hace que una coma, un `**negrita**` o un salto
-- de línea distinto NO cuenten como cambio.
CREATE FUNCTION app.reading_normalized(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, app
AS $$
  SELECT btrim(regexp_replace(lower(app.unaccent_es(coalesce(value, ''))), '[^a-z0-9]+', ' ', 'g'))
$$;

ALTER TABLE app.wiki_revisions
  ADD COLUMN reading_fingerprint text
  GENERATED ALWAYS AS (
    md5(app.reading_normalized(title) || ' | ' || app.reading_normalized(body_markdown))
  ) STORED;

COMMENT ON COLUMN app.wiki_revisions.reading_fingerprint IS
  'Huella del texto legible de la revisión (título + cuerpo, normalizados). Solo cambia cuando cambian las PALABRAS: sirve para decidir si una nota ya leída vuelve a la lista de pendientes.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Progreso de lectura por persona
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE app.wiki_reading_progress (
  household_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  page_id uuid NOT NULL,
  -- La huella del texto que esa persona leyó. Ni fecha ni hora: ver cabecera.
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{32}$'),
  PRIMARY KEY (household_id, membership_id, page_id),
  FOREIGN KEY (household_id, membership_id)
    REFERENCES app.household_memberships(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, page_id)
    REFERENCES app.wiki_pages(household_id, id) ON DELETE RESTRICT
);

COMMENT ON TABLE app.wiki_reading_progress IS
  'Qué notas de la Guía ha leído cada persona, y con qué texto. Sin columnas de tiempo y sin auditoría A PROPÓSITO: es acogida, no vigilancia. La administración solo la consulta agregada por apartado con app.wiki_reading_overview().';

CREATE INDEX wiki_reading_progress_page_idx
  ON app.wiki_reading_progress (household_id, page_id);

ALTER TABLE app.wiki_reading_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.wiki_reading_progress FORCE ROW LEVEL SECURITY;

-- Cada cual ve el suyo. No hay política para nadie más: ni la administración
-- puede seleccionar una fila ajena, aunque sea dueña de la casa.
CREATE POLICY wiki_reading_progress_own ON app.wiki_reading_progress
  FOR SELECT USING (
    app.tenant_context_matches(household_id)
    AND membership_id = app.current_membership_id()
  );

-- Solo SELECT: escribir es exclusivamente por app.mark_wiki_note_read().
GRANT SELECT ON app.wiki_reading_progress TO casa_clara_app;

/**
 * Marca como leída UNA nota de la Guía para QUIEN LLAMA. No hay parámetro de
 * membresía: marcar por otro no es «algo que se rechaza», es algo que no se
 * puede expresar. Devuelve la huella apuntada, o NULL si la nota no cuenta
 * para la acogida (borrador o receta), para que la interfaz no mienta.
 */
CREATE FUNCTION app.mark_wiki_note_read(target_page uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
DECLARE
  fingerprint text;
  space_kind app.wiki_space_kind;
  page_status app.wiki_page_status;
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;

  SELECT revision.reading_fingerprint, space.kind, page.status
    INTO fingerprint, space_kind, page_status
    FROM app.wiki_pages AS page
    JOIN app.wiki_spaces AS space
      ON space.household_id = page.household_id AND space.id = page.space_id
    JOIN app.wiki_revisions AS revision
      ON revision.household_id = page.household_id AND revision.id = page.current_revision_id
   WHERE page.household_id = app.current_household_id()
     AND page.id = target_page
     AND page.archived_at IS NULL;

  IF fingerprint IS NULL THEN
    RAISE EXCEPTION 'nota inexistente en este hogar' USING ERRCODE = '42501';
  END IF;

  -- Los borradores y el recetario no forman parte de la lectura de acogida.
  IF space_kind <> 'guide' OR page_status <> 'published' THEN
    RETURN NULL;
  END IF;

  INSERT INTO app.wiki_reading_progress (household_id, membership_id, page_id, content_fingerprint)
  VALUES (app.current_household_id(), app.current_membership_id(), target_page, fingerprint)
  ON CONFLICT (household_id, membership_id, page_id)
  DO UPDATE SET content_fingerprint = excluded.content_fingerprint;

  RETURN fingerprint;
END
$$;

REVOKE ALL ON FUNCTION app.mark_wiki_note_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mark_wiki_note_read(uuid) TO casa_clara_app;

/**
 * La ÚNICA ventana de la administración al progreso ajeno: por persona y
 * apartado, cuántas notas publicadas hay y cuántas lleva leídas. Ni qué nota,
 * ni cuándo, ni en qué orden. Con eso se responde «¿se ha leído la guía?» y
 * «¿qué le falta?», que es lo que la acogida necesita, y nada más.
 *
 * Deja fuera a la propia administración (su progreso es suyo y lo ve en su
 * pantalla) y a `viewer`, que ni siquiera puede leer la Guía.
 */
CREATE FUNCTION app.wiki_reading_overview()
RETURNS TABLE (
  membership_id uuid,
  display_name text,
  membership_role app.household_role,
  space_id uuid,
  space_name text,
  space_position integer,
  notes_total bigint,
  notes_read bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
SET row_security = off
AS $$
BEGIN
  IF NOT app.context_is_complete() THEN
    RAISE EXCEPTION 'contexto de transacción incompleto' USING ERRCODE = '42501';
  END IF;
  IF app.current_household_role() <> 'family_admin' THEN
    RAISE EXCEPTION 'solo la administración consulta el avance de la acogida'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT membership.id,
         coalesce(profile.display_name, 'Alguien de la casa'),
         membership.role,
         space.id,
         space.name,
         space.position,
         count(page.id),
         count(progress.page_id)
    FROM app.household_memberships AS membership
    LEFT JOIN app.user_profiles AS profile ON profile.user_id = membership.user_id
    CROSS JOIN app.wiki_spaces AS space
    LEFT JOIN app.wiki_pages AS page
      ON page.household_id = space.household_id
     AND page.space_id = space.id
     AND page.archived_at IS NULL
     AND page.status = 'published'
    LEFT JOIN app.wiki_reading_progress AS progress
      ON progress.household_id = page.household_id
     AND progress.page_id = page.id
     AND progress.membership_id = membership.id
   WHERE membership.household_id = app.current_household_id()
     AND membership.revoked_at IS NULL
     AND (membership.expires_at IS NULL OR membership.expires_at > statement_timestamp())
     AND membership.role IN ('family_member', 'employee_live_in', 'helper')
     AND space.household_id = app.current_household_id()
     AND space.archived_at IS NULL
     AND space.kind = 'guide'
     AND space.is_template = false
   GROUP BY membership.id, profile.display_name, membership.role,
            space.id, space.name, space.position;
END
$$;

REVOKE ALL ON FUNCTION app.wiki_reading_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.wiki_reading_overview() TO casa_clara_app;

COMMIT;
