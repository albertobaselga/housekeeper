import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWikiHome, loadWikiPage, searchWikiPages } from '../src/lib/server/wiki.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_wiki_login';
// Base de datos propia (como la suite de auth): la de employment recrea el
// esquema entero en paralelo y ambas no pueden compartir instancia.
const WIKI_DB = 'casaclara_wiki_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
const SPACE = '30000000-0000-4000-8000-000000000001';
const PAGE_LAVADORA = '31000000-0000-4000-8000-000000000001';
const PAGE_FILTRO = '31000000-0000-4000-8000-000000000002';
const PAGE_DRAFT = '31000000-0000-4000-8000-000000000003';
const REV_LAVADORA_1 = '31100000-0000-4000-8000-000000000001';
const REV_LAVADORA_2 = '31100000-0000-4000-8000-000000000002';
const REV_FILTRO_1 = '31100000-0000-4000-8000-000000000003';
const REV_DRAFT_1 = '31100000-0000-4000-8000-000000000004';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };

function wikiUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${WIKI_DB}`;
  return url.toString();
}

const WIKI_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id)
VALUES ('${SPACE}', '${FIXTURE_HOUSEHOLD}', 'equipamiento', 'Equipamiento', 'Aparatos de la casa', 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, parent_page_id, status, current_slug, pinned, position, created_by_membership_id)
VALUES
  ('${PAGE_LAVADORA}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', NULL, 'published', 'lavadora', true, 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_FILTRO}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', '${PAGE_LAVADORA}', 'published', 'lavadora-filtro', false, 1, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_DRAFT}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', NULL, 'draft', 'caldera-borrador', false, 2, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', 'lavadora'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', 'lavadora-vieja'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_FILTRO}', 'lavadora-filtro'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 'caldera-borrador');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id)
VALUES ('${REV_LAVADORA_1}', '${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', 1,
        'Lavadora · programa corto',
        'Usa el programa Mixto 40°.
El detergente va en el compartimento II.',
        '', ARRAY['colada'], ARRAY['lavadora'], '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id)
VALUES ('${REV_LAVADORA_2}', '${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', 2,
        'Lavadora · programa corto',
        'Usa el programa Mixto 40° para media carga.
El detergente va en el compartimento II.
No uses el programa rápido para toallas.',
        'Añadido el límite de carga', ARRAY['colada'], ARRAY['lavadora'], '${EMPLOYEE_MEMBERSHIP}');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id)
VALUES ('${REV_FILTRO_1}', '${FIXTURE_HOUSEHOLD}', '${PAGE_FILTRO}', 1,
        'Limpiar el filtro de la lavadora',
        'Cierra el agua antes de abrir la tapa inferior.',
        '', ARRAY['colada'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id)
VALUES ('${REV_DRAFT_1}', '${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 1,
        'Caldera',
        'Presión entre 1 y 1,5 bar. Borrador pendiente de revisar.',
        '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '${REV_LAVADORA_2}' WHERE id = '${PAGE_LAVADORA}';
UPDATE app.wiki_pages SET current_revision_id = '${REV_FILTRO_1}' WHERE id = '${PAGE_FILTRO}';
UPDATE app.wiki_pages SET current_revision_id = '${REV_DRAFT_1}' WHERE id = '${PAGE_DRAFT}';

INSERT INTO app.wiki_page_reads (household_id, page_id, read_on, read_count) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', current_date, 3),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', current_date - 10, 2),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', current_date - 40, 7);

COMMIT;
`;

describe.runIf(Boolean(adminUrl))('wiki desde Postgres bajo RLS', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    // Igual que la suite de employment (migraciones + fixtures + login sin
    // BYPASSRLS), pero sobre una base propia y con la siembra de wiki encima.
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${WIKI_DB} with (force)`);
      await cluster.query(`create database ${WIKI_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: wikiUrlFor(adminUrl as string) });
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
      await admin.query(WIKI_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: wikiUrlFor(adminUrl as string), max: 2 });
    const url = new URL(wikiUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  async function readsTotal(pageId: string): Promise<number> {
    const client = await adminPool.connect();
    try {
      await client.query('begin');
      await client.query('set local row_security = off');
      const result = await client.query<{ total: number }>(
        'select coalesce(sum(read_count), 0)::int as total from app.wiki_page_reads where page_id = $1',
        [pageId]
      );
      await client.query('commit');
      return result.rows[0]!.total;
    } finally {
      client.release();
    }
  }

  async function gapRow(query: string): Promise<{ missCount: number; noClickCount: number } | null> {
    const client = await adminPool.connect();
    try {
      await client.query('begin');
      await client.query('set local row_security = off');
      const result = await client.query<{ missCount: number; noClickCount: number }>(
        `select miss_count as "missCount", no_click_count as "noClickCount"
           from app.search_gap_events
          where household_id = $1 and query_normalized = $2`,
        [FIXTURE_HOUSEHOLD, query]
      );
      await client.query('commit');
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  it('la portada del admin trae jerarquía, fijadas, borradores y contadores de 30 días', async () => {
    const home = await loadWikiHome(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(home).not.toBeNull();
    expect(home!.canWrite).toBe(true);
    expect(home!.canPublish).toBe(true);

    const space = home!.spaces.find((candidate) => candidate.slug === 'equipamiento');
    expect(space).toBeDefined();
    const roots = space!.pages.map((page) => page.slug);
    expect(roots).toContain('lavadora');
    expect(roots).toContain('caldera-borrador');
    expect(roots).not.toContain('lavadora-filtro');

    const lavadora = space!.pages.find((page) => page.slug === 'lavadora')!;
    expect(lavadora.children.map((child) => child.slug)).toEqual(['lavadora-filtro']);
    expect(lavadora.pinned).toBe(true);
    // 3 hoy + 2 hace diez días; las 7 de hace cuarenta quedan fuera de la ventana.
    expect(lavadora.reads30d).toBe(5);

    const draft = space!.pages.find((page) => page.slug === 'caldera-borrador')!;
    expect(draft.status).toBe('draft');

    expect(home!.pinned.map((entry) => entry.slug)).toEqual(['lavadora']);
    expect(home!.recent.map((entry) => entry.slug)).toContain('lavadora');
  });

  it('la empleada escribe pero no publica; el helper ve publicadas sin borradores', async () => {
    const employee = await loadWikiHome(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(employee!.canWrite).toBe(true);
    expect(employee!.canPublish).toBe(false);
    const employeeSlugs = employee!.spaces.flatMap((space) => space.pages.map((page) => page.slug));
    expect(employeeSlugs).toContain('caldera-borrador');

    const helper = await loadWikiHome(HELPER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(helper).not.toBeNull();
    expect(helper!.canWrite).toBe(false);
    const helperSlugs = helper!.spaces.flatMap((space) => space.pages.map((page) => page.slug));
    expect(helperSlugs).toContain('lavadora');
    expect(helperSlugs).not.toContain('caldera-borrador');
  });

  it('el viewer no ve nada: RLS devuelve cero filas', async () => {
    const home = await loadWikiHome(VIEWER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(home).not.toBeNull();
    expect(home!.spaces).toEqual([]);
    expect(home!.pinned).toEqual([]);
    expect(home!.recent).toEqual([]);
  });

  it('un usuario sin membresía en el hogar recibe null y la página cae a la fixture', async () => {
    expect(await loadWikiHome({ id: 'fixture:olivo:employee' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
    expect(
      await loadWikiPage({ id: 'fixture:olivo:employee' }, FIXTURE_HOUSEHOLD, 'lavadora', appPool)
    ).toBeNull();
  });

  it('un slug histórico redirige al slug vigente sin registrar lectura', async () => {
    const before = await readsTotal(PAGE_LAVADORA);
    const result = await loadWikiPage(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, 'lavadora-vieja', appPool);
    expect(result).toEqual({ kind: 'redirect', slug: 'lavadora' });
    expect(await readsTotal(PAGE_LAVADORA)).toBe(before);
  });

  it('la página publicada trae revisión vigente, historial, diff y registra la lectura', async () => {
    const before = await readsTotal(PAGE_LAVADORA);
    const result = await loadWikiPage(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, 'lavadora', appPool);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('page');
    if (result!.kind !== 'page') return;

    expect(result!.page.slug).toBe('lavadora');
    expect(result!.page.spaceName).toBe('Equipamiento');
    expect(result!.revision.number).toBe(2);
    expect(result!.revision.title).toBe('Lavadora · programa corto');
    expect(result!.revision.aliases).toEqual(['lavadora']);

    expect(result!.revisions.map((revision) => revision.number)).toEqual([2, 1]);
    expect(result!.revisions[0]!.summary).toBe('Añadido el límite de carga');

    // Diff vigente ↔ anterior calculado en el servidor.
    expect(result!.diffAgainst).toBe(1);
    const added = result!.diff!.filter((line) => line.type === 'added').map((line) => line.text);
    const removed = result!.diff!.filter((line) => line.type === 'removed').map((line) => line.text);
    expect(removed).toEqual(['Usa el programa Mixto 40°.']);
    expect(added).toEqual([
      'Usa el programa Mixto 40° para media carga.',
      'No uses el programa rápido para toallas.'
    ]);

    expect(await readsTotal(PAGE_LAVADORA)).toBe(before + 1);
  });

  it('el borrador existe para quien escribe, no cuenta lecturas y es invisible para el helper', async () => {
    const before = await readsTotal(PAGE_DRAFT);
    const asAdmin = await loadWikiPage(ADMIN_USER, FIXTURE_HOUSEHOLD, 'caldera-borrador', appPool);
    expect(asAdmin!.kind).toBe('page');
    if (asAdmin!.kind === 'page') expect(asAdmin!.page.status).toBe('draft');
    expect(await readsTotal(PAGE_DRAFT)).toBe(before);

    const asHelper = await loadWikiPage(HELPER_USER, FIXTURE_HOUSEHOLD, 'caldera-borrador', appPool);
    expect(asHelper).toEqual({ kind: 'not_found' });
  });

  it("la búsqueda 'lavadra' encuentra la lavadora por similitud y registra búsqueda con resultados", async () => {
    const results = await searchWikiPages(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, 'lavadra', {}, appPool);
    expect(results).not.toBeNull();
    expect(results!.map((result) => result.slug)).toContain('lavadora');
    const gap = await gapRow('lavadra');
    expect(gap).not.toBeNull();
    expect(gap!.missCount).toBe(0);
    expect(gap!.noClickCount).toBeGreaterThanOrEqual(1);
  });

  it('una búsqueda sin resultados registra el hueco (miss)', async () => {
    const results = await searchWikiPages(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, 'vitrocopter', {}, appPool);
    expect(results).toEqual([]);
    const gap = await gapRow('vitrocopter');
    expect(gap).not.toBeNull();
    expect(gap!.missCount).toBeGreaterThanOrEqual(1);
  });

  it('la búsqueda respeta RLS: el borrador aparece al admin y no al helper', async () => {
    const asAdmin = await searchWikiPages(ADMIN_USER, FIXTURE_HOUSEHOLD, 'caldera', {}, appPool);
    expect(asAdmin!.map((result) => result.slug)).toContain('caldera-borrador');

    const asHelper = await searchWikiPages(HELPER_USER, FIXTURE_HOUSEHOLD, 'caldera', {}, appPool);
    expect(asHelper).toEqual([]);
  });
});
