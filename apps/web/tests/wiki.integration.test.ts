import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  loadGuideBook,
  loadGuideProgress,
  loadWikiHome,
  loadWikiPage,
  markGuideNoteRead,
  searchWikiPages
} from '../src/lib/server/wiki.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_wiki_login';
// Base de datos propia (como la suite de auth): la de employment recrea el
// esquema entero en paralelo y ambas no pueden compartir instancia.
const WIKI_DB = 'housekeeper_wiki_it';

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

  it('nadie fuera de la administración escribe la Guía, y los borradores son suyos', async () => {
    // La Guía es también el manual de acogida: la escribe quien administra.
    // Para la interna y el apoyo la portada llega SIN un solo control de
    // escritura, y los borradores ajenos ni siquiera existen.
    for (const reader of [EMPLOYEE_USER, HELPER_USER]) {
      const home = await loadWikiHome(reader, FIXTURE_HOUSEHOLD, appPool);
      expect(home).not.toBeNull();
      expect(home!.canWrite).toBe(false);
      expect(home!.searchGaps).toEqual([]);
      const slugs = home!.spaces.flatMap((space) => space.pages.map((page) => page.slug));
      expect(slugs).toContain('lavadora');
      expect(slugs).not.toContain('caldera-borrador');
    }
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

  // ───────────────────────────────────────────────────────────────────────────
  // Modo libro y progreso de lectura. Van al final del fichero a propósito:
  // abrir el libro registra lectura anónima y las pruebas de arriba cuentan
  // esas lecturas con números absolutos.
  // ───────────────────────────────────────────────────────────────────────────

  it('el libro solo lleva notas publicadas de la Guía, en orden de capítulo', async () => {
    const loaded = await loadGuideBook(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, 'lavadora', appPool);
    expect(loaded!.kind).toBe('book');
    if (loaded!.kind !== 'book') return;

    const { book } = loaded!;
    expect(book.outline.summary.total).toBe(2);
    expect(book.outline.order.map((note) => note.slug)).toEqual(['lavadora', 'lavadora-filtro']);
    expect(book.note.order).toBe(1);
    expect(book.note.chapterName).toBe('Equipamiento');
    expect(book.previous).toBeNull();
    expect(book.next!.slug).toBe('lavadora-filtro');
    // El borrador no está: no se le puede pedir a nadie que lea lo que no está.
    expect(book.outline.order.some((note) => note.slug === 'caldera-borrador')).toBe(false);
  });

  it('sin nota concreta el libro lleva a por dónde toca seguir; un slug viejo redirige', async () => {
    expect(await loadGuideBook(HELPER_USER, FIXTURE_HOUSEHOLD, null, appPool)).toEqual({
      kind: 'redirect',
      slug: 'lavadora'
    });
    expect(await loadGuideBook(HELPER_USER, FIXTURE_HOUSEHOLD, 'lavadora-vieja', appPool)).toEqual({
      kind: 'redirect',
      slug: 'lavadora'
    });
    expect(await loadGuideBook(HELPER_USER, FIXTURE_HOUSEHOLD, 'no-existe', appPool)).toEqual({
      kind: 'not_found'
    });
  });

  it('marcar leída es del lector: cuenta para quien lee y para nadie más', async () => {
    expect(await markGuideNoteRead(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, PAGE_LAVADORA, appPool)).toBe(true);
    // Repetir no cambia nada; un borrador no cuenta como lectura de acogida.
    expect(await markGuideNoteRead(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, PAGE_LAVADORA, appPool)).toBe(true);
    expect(await markGuideNoteRead(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, PAGE_DRAFT, appPool)).toBe(false);

    const mine = await loadGuideProgress(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(mine!.canWrite).toBe(false);
    // Quien lee no ve el avance de la casa: no es asunto suyo.
    expect(mine!.household).toBeNull();
    expect(mine!.outline.summary).toMatchObject({ total: 2, read: 1, changed: 0, complete: false });
    expect(mine!.outline.summary.nextSlug).toBe('lavadora-filtro');

    // El progreso del apoyo sigue a cero: cada cual ve el suyo.
    const helper = await loadGuideProgress(HELPER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(helper!.outline.summary).toMatchObject({ total: 2, read: 0 });
  });

  it('la administración ve cuentas por apartado, nunca el detalle de la lectura ajena', async () => {
    const view = await loadGuideProgress(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(view!.canWrite).toBe(true);
    // Su propio avance sigue siendo suyo: la lectura de la interna no se le suma.
    expect(view!.outline.summary.read).toBe(0);

    const employee = view!.household!.find((person) => person.name.includes('Empleada'));
    expect(employee).toBeDefined();
    expect(employee!.total).toBe(2);
    expect(employee!.read).toBe(1);
    expect(employee!.complete).toBe(false);
    expect(employee!.chapters.map((chapter) => chapter.name)).toEqual(['Equipamiento']);

    // Y en ningún sitio hay una nota concreta ni una fecha: solo cuentas.
    const serialized = JSON.stringify(view!.household);
    expect(serialized).not.toContain(PAGE_LAVADORA);
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    // La administración tampoco aparece en el resumen: esto es acogida.
    expect(view!.household!.some((person) => person.roleLabel === 'Administración')).toBe(false);
  });

  it('la nota suelta enseña el estado de lectura y por dónde seguir', async () => {
    const result = await loadWikiPage(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, 'lavadora', appPool);
    if (result!.kind !== 'page') throw new Error('se esperaba la nota');
    expect(result!.reading).toEqual({ state: 'read', counts: true });
    expect(result!.neighbours.next!.slug).toBe('lavadora-filtro');
    expect(result!.neighbours.previous).toBeNull();
    expect(result!.canWrite).toBe(false);
  });

  it('cambiar las palabras devuelve la nota a pendiente; la cosmética no', async () => {
    const cosmetic = await adminPool.connect();
    try {
      await cosmetic.query('begin');
      await cosmetic.query('set local row_security = off');
      await cosmetic.query('alter table app.wiki_revisions disable trigger wiki_revisions_append_only');
      await cosmetic.query(
        `insert into app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
         values ($1, $2, 3, 'Lavadora · programa corto',
                 'Usa el programa **Mixto 40°**, para media carga.

El detergente va en el compartimento II!
No uses el programa rápido para toallas.',
                 $3)`,
        [FIXTURE_HOUSEHOLD, PAGE_LAVADORA, ADMIN_MEMBERSHIP]
      );
      await cosmetic.query(
        `update app.wiki_pages
            set current_revision_id = (select id from app.wiki_revisions
                                        where page_id = $1 and revision_number = 3)
          where id = $1`,
        [PAGE_LAVADORA]
      );
      await cosmetic.query('alter table app.wiki_revisions enable trigger wiki_revisions_append_only');
      await cosmetic.query('commit');
    } finally {
      cosmetic.release();
    }

    // Solo ha cambiado el marcado y la puntuación: la lectura sigue vigente.
    let mine = await loadGuideProgress(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(mine!.outline.summary).toMatchObject({ read: 1, changed: 0 });

    const rewrite = await adminPool.connect();
    try {
      await rewrite.query('begin');
      await rewrite.query('set local row_security = off');
      await rewrite.query('alter table app.wiki_revisions disable trigger wiki_revisions_append_only');
      await rewrite.query(
        `insert into app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
         values ($1, $2, 4, 'Lavadora · programa corto',
                 'La lavadora nueva solo admite el programa ecológico de tres horas.', $3)`,
        [FIXTURE_HOUSEHOLD, PAGE_LAVADORA, ADMIN_MEMBERSHIP]
      );
      await rewrite.query(
        `update app.wiki_pages
            set current_revision_id = (select id from app.wiki_revisions
                                        where page_id = $1 and revision_number = 4)
          where id = $1`,
        [PAGE_LAVADORA]
      );
      await rewrite.query('alter table app.wiki_revisions enable trigger wiki_revisions_append_only');
      await rewrite.query('commit');
    } finally {
      rewrite.release();
    }

    // Ahora sí: la nota vuelve a la lista, pero como «cambió», no como «nunca
    // leída», que sería falso.
    mine = await loadGuideProgress(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(mine!.outline.summary).toMatchObject({ read: 1, changed: 1 });
    expect(mine!.outline.order[0]!.state).toBe('changed');

    // Y el hito de acogida no se revoca por corregir una nota: para la casa,
    // esa nota sigue contando como leída una vez.
    const view = await loadGuideProgress(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    const employee = view!.household!.find((person) => person.name.includes('Empleada'))!;
    expect(employee.read).toBe(1);
  });
});
