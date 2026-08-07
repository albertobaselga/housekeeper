import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { E2E_APP_LOGIN, E2E_APP_PASSWORD } from '../playwright.db.config';

// Siembra de la base de datos para los e2e con Postgres: igual que el
// global-setup de @casa-clara/server (migraciones + fixtures sintéticas) más
// una página de wiki publicada para ejercitar el editor visual, y un login
// sin BYPASSRLS con el que corre el servidor web.

const HOUSEHOLD = '10000000-0000-4000-8000-000000000001';
const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const SPACE = '33000000-0000-4000-8000-000000000001';
const PAGE = '33100000-0000-4000-8000-000000000001';
const REVISION = '33110000-0000-4000-8000-000000000001';

const WIKI_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id)
VALUES ('${SPACE}', '${HOUSEHOLD}', 'equipamiento', 'Equipamiento', 'Aparatos de la casa', 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, parent_page_id, status, current_slug, pinned, position, created_by_membership_id)
VALUES ('${PAGE}', '${HOUSEHOLD}', '${SPACE}', NULL, 'published', 'lavadora', true, 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug)
VALUES ('${HOUSEHOLD}', '${PAGE}', 'lavadora');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id)
VALUES ('${REVISION}', '${HOUSEHOLD}', '${PAGE}', 1,
        'Lavadora · programa corto',
        'Usa el programa Mixto 40° para media carga.

El detergente va en el compartimento II.',
        '', ARRAY['colada'], ARRAY['lavadora'], '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '${REVISION}' WHERE id = '${PAGE}';

COMMIT;
`;

export default async function globalSetup(): Promise<void> {
  const adminUrl = process.env.E2E_DATABASE_URL;
  if (!adminUrl) return;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('drop schema if exists app cascade');
    await admin.query('drop schema if exists app_private cascade');
    await admin.query('drop table if exists public.schema_migrations');

    const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
    const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
    const { applyMigrations } = (await import(migrateHref)) as {
      applyMigrations: (client: pg.Client) => Promise<unknown>;
    };
    await applyMigrations(admin);

    const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
    for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
      await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
    }
    await admin.query(WIKI_SEED);

    // Login del servidor web: miembro de casa_clara_app, sin BYPASSRLS. Se
    // conserva entre ejecuciones (el servidor anterior puede seguir teniendo
    // conexiones abiertas y `drop role` fallaría).
    await admin.query(
      `do $$ begin
         if not exists (select 1 from pg_roles where rolname = '${E2E_APP_LOGIN}') then
           create role ${E2E_APP_LOGIN} login password '${E2E_APP_PASSWORD}' nosuperuser nobypassrls in role casa_clara_app;
         else
           alter role ${E2E_APP_LOGIN} with login nosuperuser nobypassrls password '${E2E_APP_PASSWORD}';
           grant casa_clara_app to ${E2E_APP_LOGIN};
         end if;
       end $$;`
    );
  } finally {
    await admin.end();
  }
}
