import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildHandoverExport } from '../src/lib/server/handover.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_handover_rt_login';
// Base propia (patrón de la suite de traspaso): las suites del paquete corren
// en paralelo y cada una reprovisiona su esquema completo.
const ROUNDTRIP_DB = 'casaclara_handover_rt';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const ADMIN_USER = { id: 'fixture:roble:admin' };

// Hogar limpio del propio clúster de fixtures (olivo, sin wiki) para la
// reimportación REAL: el árbol debe reconstruirse idéntico desde el ZIP.
const CLEAN_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const CLEAN_MEMBERSHIP = '21000000-0000-4000-8000-000000000001';

const SPACE_MANT = '61000000-0000-4000-8000-000000000001';
const PAGE_MAQUINAS = '62000000-0000-4000-8000-000000000001';
const PAGE_LAVAVAJILLAS = '62000000-0000-4000-8000-000000000002';
const PAGE_FILTRO = '62000000-0000-4000-8000-000000000003';
const PAGE_CALDERA = '62000000-0000-4000-8000-000000000004';
const PAGE_DRAFT = '62000000-0000-4000-8000-000000000005';

const GENERATED_AT = new Date('2026-08-07T10:00:00.000Z');

// Jerarquía de TRES niveles (maquinas → lavavajillas → filtro-lavavajillas)
// más una hoja en la raíz y un borrador que jamás debe viajar. Los cuerpos
// llevan enlaces `wiki:` que deben sobrevivir intactos al round-trip.
const ROUNDTRIP_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id)
VALUES ('${SPACE_MANT}', '${FIXTURE_HOUSEHOLD}', 'mantenimiento', 'Mantenimiento', 'Cuidado de la casa', 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, parent_page_id, status, current_slug, position, created_by_membership_id) VALUES
  ('${PAGE_MAQUINAS}', '${FIXTURE_HOUSEHOLD}', '${SPACE_MANT}', NULL, 'published', 'maquinas', 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_LAVAVAJILLAS}', '${FIXTURE_HOUSEHOLD}', '${SPACE_MANT}', '${PAGE_MAQUINAS}', 'published', 'lavavajillas', 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_FILTRO}', '${FIXTURE_HOUSEHOLD}', '${SPACE_MANT}', '${PAGE_LAVAVAJILLAS}', 'published', 'filtro-lavavajillas', 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_CALDERA}', '${FIXTURE_HOUSEHOLD}', '${SPACE_MANT}', NULL, 'published', 'caldera-anual', 1, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_DRAFT}', '${FIXTURE_HOUSEHOLD}', '${SPACE_MANT}', '${PAGE_MAQUINAS}', 'draft', 'maquinas-borrador', 1, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_MAQUINAS}', 'maquinas'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVAVAJILLAS}', 'lavavajillas'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_FILTRO}', 'filtro-lavavajillas'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_CALDERA}', 'caldera-anual'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 'maquinas-borrador');

WITH revisions AS (
  INSERT INTO app.wiki_revisions (household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id) VALUES
    ('${FIXTURE_HOUSEHOLD}', '${PAGE_MAQUINAS}', 1, 'Máquinas de la casa',
     'Índice de aparatos.

Empieza por el [lavavajillas](wiki:lavavajillas).', '', ARRAY['equipos'], ARRAY['aparatos'], '${ADMIN_MEMBERSHIP}'),
    ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVAVAJILLAS}', 1, 'Lavavajillas · uso diario',
     'Programa Eco por defecto.

Limpieza mensual: ver [el filtro](wiki:filtro-lavavajillas).', '', ARRAY['equipos', 'cocina'], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
    ('${FIXTURE_HOUSEHOLD}', '${PAGE_FILTRO}', 1, 'Filtro del lavavajillas',
     'Girar a la izquierda, enjuagar y volver a encajar.

Vuelve a la página del [lavavajillas](wiki:lavavajillas).', '', ARRAY['cocina'], ARRAY['filtro'], '${ADMIN_MEMBERSHIP}'),
    ('${FIXTURE_HOUSEHOLD}', '${PAGE_CALDERA}', 1, 'Revisión anual de la caldera',
     'La revisión toca cada octubre; el técnico deja el parte en el cajón.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
    ('${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 1, 'Borrador secreto de máquinas',
     'Notas sin terminar que no deben viajar en ningún traspaso.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}')
  RETURNING id, page_id
)
UPDATE app.wiki_pages AS page
   SET current_revision_id = revisions.id
  FROM revisions
 WHERE page.id = revisions.page_id;

COMMIT;
`;

interface TreeRow {
  slug: string;
  parentSlug: string | null;
  spaceSlug: string;
  status: string;
  title: string;
  tags: string[];
  aliases: string[];
  body: string;
}

/** Árbol wiki comparable de un hogar: slug → nodo (cuerpo normalizado). */
async function readWikiTree(pool: pg.Pool, householdId: string): Promise<Map<string, TreeRow>> {
  const result = await pool.query<TreeRow>(
    `select page.current_slug as "slug",
            parent.current_slug as "parentSlug",
            space.slug as "spaceSlug",
            page.status::text as "status",
            revision.title,
            revision.tags,
            revision.aliases,
            revision.body_markdown as "body"
       from app.wiki_pages as page
       join app.wiki_spaces as space
         on space.household_id = page.household_id and space.id = page.space_id
       left join app.wiki_pages as parent
         on parent.household_id = page.household_id and parent.id = page.parent_page_id
       join app.wiki_revisions as revision
         on revision.household_id = page.household_id and revision.id = page.current_revision_id
      where page.household_id = $1
      order by page.current_slug`,
    [householdId]
  );
  return new Map(result.rows.map((row) => [row.slug, { ...row, body: row.body.trimEnd() }]));
}

function roundtripUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${ROUNDTRIP_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('traspaso F4-02: round-trip real del árbol wiki', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${ROUNDTRIP_DB} with (force)`);
      await cluster.query(`create database ${ROUNDTRIP_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: roundtripUrlFor(adminUrl as string) });
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
      await admin.query(ROUNDTRIP_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: roundtripUrlFor(adminUrl as string), max: 2 });
    const url = new URL(roundtripUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it('exporta la jerarquía como carpetas, importa DE VERDAD en un hogar limpio y el árbol es equivalente', async () => {
    const zip = await buildHandoverExport(ADMIN_USER, FIXTURE_HOUSEHOLD, 'family', appPool, GENERATED_AT);
    expect(zip).not.toBeNull();
    const entries = unzipSync(zip!);

    // 1. El ZIP replica la jerarquía en carpetas, el formato del importador:
    //    padre = carpeta con index.md; hoja = <slug>.md.
    const wikiPaths = Object.keys(entries)
      .filter((name) => name.startsWith('wiki/'))
      .sort((left, right) => left.localeCompare(right, 'en'));
    expect(wikiPaths).toEqual([
      'wiki/mantenimiento/_space.md',
      'wiki/mantenimiento/caldera-anual.md',
      'wiki/mantenimiento/maquinas/index.md',
      'wiki/mantenimiento/maquinas/lavavajillas/filtro-lavavajillas.md',
      'wiki/mantenimiento/maquinas/lavavajillas/index.md'
    ]);
    // El index.md conserva el slug real de la página padre en el front-matter.
    expect(strFromU8(entries['wiki/mantenimiento/maquinas/index.md']!)).toContain('slug: "maquinas"');
    expect(strFromU8(entries['wiki/mantenimiento/maquinas/lavavajillas/index.md']!)).toContain(
      'slug: "lavavajillas"'
    );

    // 2. Importación REAL (sin dry-run) del directorio wiki/ en el hogar limpio.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'handover-roundtrip-'));
    try {
      for (const [name, bytes] of Object.entries(entries)) {
        if (!name.startsWith('wiki/')) continue;
        const target = path.join(tempDir, name.slice('wiki/'.length));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }

      const importerHref = new URL('../../../packages/db/scripts/wiki-import.mjs', import.meta.url).href;
      const { importCorpus } = (await import(/* @vite-ignore */ importerHref)) as {
        importCorpus: (
          client: pg.PoolClient,
          args: { householdId: string; membershipId: string; dir: string; dryRun: boolean }
        ) => Promise<{
          dryRun: boolean;
          pages: { created: string[]; updated: string[]; skipped: string[] };
          revisions: number;
          errors: Array<{ file: string; reason: string }>;
        }>;
      };

      const client = await adminPool.connect();
      try {
        const report = await importCorpus(client, {
          householdId: CLEAN_HOUSEHOLD,
          membershipId: CLEAN_MEMBERSHIP,
          dir: tempDir,
          dryRun: false
        });
        expect(report.dryRun).toBe(false);
        expect(report.errors).toEqual([]);
        expect(report.pages.created.sort()).toEqual([
          'caldera-anual',
          'filtro-lavavajillas',
          'lavavajillas',
          'maquinas'
        ]);
        expect(report.revisions).toBe(4);
      } finally {
        client.release();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    // 3. Árbol equivalente: padres, hijas, títulos, tags, aliases y cuerpos.
    const source = await readWikiTree(adminPool, FIXTURE_HOUSEHOLD);
    const imported = await readWikiTree(adminPool, CLEAN_HOUSEHOLD);

    // El borrador se queda en origen: el hogar limpio recibe SOLO lo publicado.
    expect([...imported.keys()].sort()).toEqual([
      'caldera-anual',
      'filtro-lavavajillas',
      'lavavajillas',
      'maquinas'
    ]);
    expect(source.has('maquinas-borrador')).toBe(true);

    for (const slug of imported.keys()) {
      expect(imported.get(slug), slug).toEqual(source.get(slug));
    }

    // Jerarquía de tres niveles reconstruida tal cual.
    expect(imported.get('maquinas')!.parentSlug).toBeNull();
    expect(imported.get('lavavajillas')!.parentSlug).toBe('maquinas');
    expect(imported.get('filtro-lavavajillas')!.parentSlug).toBe('lavavajillas');
    expect(imported.get('caldera-anual')!.parentSlug).toBeNull();

    // 4. Los enlaces wiki: llegan intactos y resuelven dentro del hogar destino.
    const linkTargets = new Map<string, string[]>(
      [...imported.entries()].map(([slug, row]) => [
        slug,
        [...row.body.matchAll(/\(wiki:([a-z0-9-]+)\)/g)].map((match) => match[1]!)
      ])
    );
    expect(linkTargets.get('maquinas')).toEqual(['lavavajillas']);
    expect(linkTargets.get('lavavajillas')).toEqual(['filtro-lavavajillas']);
    expect(linkTargets.get('filtro-lavavajillas')).toEqual(['lavavajillas']);
    for (const targets of linkTargets.values()) {
      for (const target of targets) {
        expect(imported.has(target), `enlace wiki:${target} resuelve`).toBe(true);
      }
    }
    // Ningún enlace quedó en formato de fichero (.md): el round-trip no regresa
    // al formato de disco.
    for (const row of imported.values()) {
      expect(row.body).not.toContain('.md)');
    }
  }, 120_000);
});
