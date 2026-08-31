import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWikiHome } from '../src/lib/server/wiki.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_wikitpl_login';
// Base propia (patrón de las suites de wiki/food): las suites que recrean el
// esquema en paralelo no pueden compartir instancia.
const DB_NAME = 'housekeeper_wikitpl_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const SPACE_LIVE = '40000000-0000-4000-8000-000000000001';
const SPACE_TEMPLATE = '40000000-0000-4000-8000-000000000002';
const PAGE_LIVE = '41000000-0000-4000-8000-000000000001';
const PAGE_TEMPLATE = '41000000-0000-4000-8000-000000000002';
const REV_LIVE = '41100000-0000-4000-8000-000000000001';
const REV_TEMPLATE = '41100000-0000-4000-8000-000000000002';

const ADMIN_USER = { id: 'fixture:roble:admin' };

function urlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${DB_NAME}`;
  return url.toString();
}

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, is_template, created_by_membership_id)
VALUES
  ('${SPACE_LIVE}', '${FIXTURE_HOUSEHOLD}', 'equipamiento', 'Equipamiento', 'Aparatos de la casa', 0, false, '${ADMIN_MEMBERSHIP}'),
  ('${SPACE_TEMPLATE}', '${FIXTURE_HOUSEHOLD}', 'manual-plantilla', 'Manual plantilla', 'Origen de clonación', 1, true, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, pinned, position, created_by_membership_id)
VALUES
  ('${PAGE_LIVE}', '${FIXTURE_HOUSEHOLD}', '${SPACE_LIVE}', 'published', 'lavadora', true, 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_TEMPLATE}', '${FIXTURE_HOUSEHOLD}', '${SPACE_TEMPLATE}', 'published', 'guia-modelo', true, 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LIVE}', 'lavadora'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_TEMPLATE}', 'guia-modelo');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
VALUES
  ('${REV_LIVE}', '${FIXTURE_HOUSEHOLD}', '${PAGE_LIVE}', 1, 'Lavadora', 'Programa corto.', '${ADMIN_MEMBERSHIP}'),
  ('${REV_TEMPLATE}', '${FIXTURE_HOUSEHOLD}', '${PAGE_TEMPLATE}', 1, 'Guía modelo', 'Contenido de plantilla.', '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '${REV_LIVE}' WHERE id = '${PAGE_LIVE}';
UPDATE app.wiki_pages SET current_revision_id = '${REV_TEMPLATE}' WHERE id = '${PAGE_TEMPLATE}';

COMMIT;
`;

describe.runIf(Boolean(adminUrl))('portada wiki con espacios plantilla bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${DB_NAME} with (force)`);
      await cluster.query(`create database ${DB_NAME}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: urlFor(adminUrl as string) });
    await admin.connect();
    try {
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      await admin.query(SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(urlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('loadWikiHome separa las plantillas de los espacios vivos', async () => {
    const home = await loadWikiHome(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(home).not.toBeNull();

    expect(home!.spaces.map((space) => space.slug)).toEqual(['equipamiento']);
    expect(home!.spaces[0]!.isTemplate).toBe(false);

    expect(home!.templates.map((space) => space.slug)).toEqual(['manual-plantilla']);
    expect(home!.templates[0]!.isTemplate).toBe(true);
    // La plantilla conserva su jerarquía visible para poder inspeccionarla.
    expect(home!.templates[0]!.pages.map((page) => page.slug)).toEqual(['guia-modelo']);

    // Sus páginas no compiten en portada: ni fijadas ni recientes.
    expect(home!.pinned.map((entry) => entry.slug)).toEqual(['lavadora']);
    expect(home!.recent.map((entry) => entry.slug)).toEqual(['lavadora']);
  });
});
