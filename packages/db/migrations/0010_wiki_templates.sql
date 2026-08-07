BEGIN;

-- Un espacio marcado como plantilla sirve de origen de clonación (Fase 4
-- adaptada): la jerarquía de páginas se copia como espacio nuevo editable,
-- siempre dentro del mismo hogar (F4-01 verifica el aislamiento multi-tenant).
ALTER TABLE app.wiki_spaces
  ADD COLUMN is_template boolean NOT NULL DEFAULT false;

COMMIT;
