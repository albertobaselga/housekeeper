BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- El resumen de la nota vuelve a ser del usuario.
--
-- El importador del manual guardaba su marca de idempotencia —el sha-256 del
-- contenido, recortado a doce caracteres— dentro de `summary`, la misma columna
-- que la persona rellena al editar una nota («qué has cambiado»). La vista de
-- nota pinta ese resumen como subtítulo bajo el título, así que cada apartado
-- importado del manual enseñaba literalmente «import:63b79e8c247a», y lo mismo
-- salía como extracto en los resultados de búsqueda.
--
-- La marca pasa a su propia columna, que ninguna vista lee, y el resumen queda
-- libre: el importador vuelve a rellenarlo con la primera frase útil de la nota
-- en su siguiente pasada. Las revisiones ya escritas se reparan aquí mismo
-- (silenciando un momento el trigger append-only, que existe para el tráfico de
-- la aplicación, no para las migraciones del esquema): la marca se traslada y
-- el subtítulo se vacía, que ya es mejor que enseñar jerga.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE app.wiki_revisions
  ADD COLUMN import_hash text NOT NULL DEFAULT ''
    CHECK (import_hash = '' OR import_hash ~ '^[0-9a-f]{12}$');

COMMENT ON COLUMN app.wiki_revisions.import_hash IS
  'Marca de idempotencia del importador de corpus (sha-256 del contenido, 12 caracteres). Vacía en las revisiones escritas desde la aplicación. Nunca se muestra al usuario.';

ALTER TABLE app.wiki_revisions DISABLE TRIGGER wiki_revisions_append_only;

UPDATE app.wiki_revisions
   SET import_hash = substring(summary from 8),
       summary = ''
 WHERE summary ~ '^import:[0-9a-f]{12}$';

ALTER TABLE app.wiki_revisions ENABLE TRIGGER wiki_revisions_append_only;

COMMIT;
