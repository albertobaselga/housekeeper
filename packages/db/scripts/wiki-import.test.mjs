// Integración del importador de wiki contra Postgres real. Se activa solo con
// TEST_DATABASE_URL (rol admin propietario de migraciones); sin ella la suite
// se omite. Los casos son secuenciales y comparten estado a propósito: el
// segundo pase idempotente y el rollback solo tienen sentido tras el primero.
import { appendFile, cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrate.mjs';
import { importCorpus } from './wiki-import.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const corpusDir = path.join(packageRoot, 'fixtures', 'wiki-corpus');
const invalidDir = path.join(packageRoot, 'fixtures', 'wiki-corpus-invalid');

const HOUSEHOLD = '77000000-0000-4000-8000-000000000001';
const MEMBERSHIP = '77000000-0000-4000-8000-000000000002';
const IMPORT_ARGS = { householdId: HOUSEHOLD, membershipId: MEMBERSHIP, dir: corpusDir };

const ALL_SLUGS = [
  'cafetera',
  'cama-invitados',
  'cocina',
  'horno',
  'invitados',
  'lavadora',
  'limpieza-semanal',
  'placa-de-induccion',
  'plantas-de-interior',
];

describe.runIf(Boolean(adminUrl))('importador por lotes de la wiki', () => {
  /** @type {pg.Client} */
  let client;

  const count = async (table) => {
    const res = await client.query(`select count(*)::int as n from app.${table}`);
    return res.rows[0].n;
  };

  const wikiCounts = async () => ({
    spaces: await count('wiki_spaces'),
    pages: await count('wiki_pages'),
    revisions: await count('wiki_revisions'),
    slugs: await count('wiki_page_slugs'),
  });

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema if exists app_private cascade');
    await client.query('drop table if exists public.schema_migrations');
    await applyMigrations(client);
    // Hogar + membresía mínimos; el propietario de migraciones salta FORCE RLS.
    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'hogar-importador', 'Hogar del importador')`,
      [HOUSEHOLD]
    );
    await client.query(
      `insert into app.user_profiles (user_id, display_name)
       values ('fixture:importador', 'Bot importador')`
    );
    await client.query(
      `insert into app.household_memberships (id, household_id, user_id, role)
       values ($1, $2, 'fixture:importador', 'family_admin')`,
      [MEMBERSHIP, HOUSEHOLD]
    );
    await client.query('commit');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('el dry-run informa del plan completo sin escribir nada', async () => {
    const report = await importCorpus(client, { ...IMPORT_ARGS, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.spaces.created.sort()).toEqual(['electrodomesticos', 'rutinas']);
    expect([...report.pages.created].sort()).toEqual(ALL_SLUGS);
    expect(report.revisions).toBe(9);
    expect(report.linkRewrites).toHaveLength(2);

    expect(await wikiCounts()).toEqual({ spaces: 0, pages: 0, revisions: 0, slugs: 0 });
  });

  it('la importación real crea espacios, páginas, revisiones, slugs y jerarquía', async () => {
    const report = await importCorpus(client, IMPORT_ARGS);

    expect(report.errors).toEqual([]);
    expect(report.spaces.created.sort()).toEqual(['electrodomesticos', 'rutinas']);
    expect([...report.pages.created].sort()).toEqual(ALL_SLUGS);
    expect(report.revisions).toBe(9);
    expect(await wikiCounts()).toEqual({ spaces: 2, pages: 9, revisions: 9, slugs: 9 });

    const spaces = await client.query(
      `select slug, name, description from app.wiki_spaces order by slug`
    );
    expect(spaces.rows).toEqual([
      {
        slug: 'electrodomesticos',
        name: 'Electrodomésticos',
        description: 'Manuales y trucos de los aparatos de la casa.',
      },
      { slug: 'rutinas', name: 'rutinas', description: '' },
    ]);

    // Jerarquía: la carpeta con index.md es la página padre de sus hermanas.
    const hierarchy = await client.query(
      `select child.current_slug as child, parent.current_slug as parent
         from app.wiki_pages child
         left join app.wiki_pages parent on parent.id = child.parent_page_id`
    );
    const parents = Object.fromEntries(hierarchy.rows.map((r) => [r.child, r.parent]));
    expect(parents).toEqual({
      'placa-de-induccion': null,
      lavadora: null,
      cocina: null,
      horno: 'cocina',
      cafetera: 'cocina',
      'limpieza-semanal': null,
      'plantas-de-interior': null,
      invitados: null,
      'cama-invitados': 'invitados',
    });

    // Front-matter variado: status, tags y aliases llegan a la revisión vigente.
    const placa = await client.query(
      `select p.status, r.title, r.tags, r.aliases, r.summary
         from app.wiki_pages p
         join app.wiki_revisions r on r.id = p.current_revision_id
        where p.current_slug = 'placa-de-induccion'`
    );
    expect(placa.rows[0].title).toBe('Placa de inducción');
    expect(placa.rows[0].aliases).toEqual(['vitro', 'vitrocerámica']);
    expect(placa.rows[0].tags).toEqual(['cocina', 'seguridad']);
    expect(placa.rows[0].summary).toMatch(/^import:[0-9a-f]{12}$/);

    const horno = await client.query(
      `select status from app.wiki_pages where current_slug = 'horno'`
    );
    expect(horno.rows[0].status).toBe('draft');
  });

  it('los enlaces relativos quedan reescritos a wiki:slug en el cuerpo importado', async () => {
    const bodies = await client.query(
      `select p.current_slug, r.body_markdown
         from app.wiki_pages p
         join app.wiki_revisions r on r.id = p.current_revision_id
        where p.current_slug in ('lavadora', 'cafetera')`
    );
    const bySlug = Object.fromEntries(bodies.rows.map((r) => [r.current_slug, r.body_markdown]));
    expect(bySlug.lavadora).toContain('(wiki:placa-de-induccion)');
    expect(bySlug.cafetera).toContain('(wiki:placa-de-induccion)');
    expect(bySlug.lavadora).not.toContain('.md)');
  });

  it('un segundo pase idéntico omite todo y no crea revisiones', async () => {
    const before = await wikiCounts();
    const report = await importCorpus(client, IMPORT_ARGS);

    expect(report.errors).toEqual([]);
    expect(report.revisions).toBe(0);
    expect(report.spaces.created).toEqual([]);
    expect(report.spaces.updated).toEqual([]);
    expect(report.spaces.skipped.sort()).toEqual(['electrodomesticos', 'rutinas']);
    expect(report.pages.created).toEqual([]);
    expect(report.pages.updated).toEqual([]);
    expect([...report.pages.skipped].sort()).toEqual(ALL_SLUGS);
    expect(await wikiCounts()).toEqual(before);
  });

  it('editar un fichero solo da revisión nueva a esa página y conserva su slug', async () => {
    const editedCorpus = await mkdtemp(path.join(tmpdir(), 'wiki-corpus-'));
    await cp(corpusDir, editedCorpus, { recursive: true });
    await appendFile(
      path.join(editedCorpus, 'electrodomesticos', 'lavadora.md'),
      '\nNuevo: el programa de lana exige centrifugado suave.\n'
    );

    const report = await importCorpus(client, { ...IMPORT_ARGS, dir: editedCorpus });

    expect(report.errors).toEqual([]);
    expect(report.revisions).toBe(1);
    expect(report.pages.updated).toEqual(['lavadora']);
    expect(report.pages.created).toEqual([]);
    expect(report.pages.skipped).toHaveLength(8);

    const lavadora = await client.query(
      `select p.current_slug, r.revision_number, r.body_markdown
         from app.wiki_pages p
         join app.wiki_revisions r on r.id = p.current_revision_id
        where p.current_slug = 'lavadora'`
    );
    expect(lavadora.rows[0].current_slug).toBe('lavadora');
    expect(lavadora.rows[0].revision_number).toBe(2);
    expect(lavadora.rows[0].body_markdown).toContain('centrifugado suave');

    const revisions = await client.query(
      `select p.current_slug, count(r.*)::int as n
         from app.wiki_pages p join app.wiki_revisions r on r.page_id = p.id
        group by p.current_slug having count(r.*) > 1`
    );
    expect(revisions.rows).toEqual([{ current_slug: 'lavadora', n: 2 }]);
    expect(await count('wiki_page_slugs')).toBe(9);
  });

  it('un corpus inválido provoca rollback total e identifica el fichero culpable', async () => {
    const before = await wikiCounts();

    await expect(importCorpus(client, { ...IMPORT_ARGS, dir: invalidDir })).rejects.toThrow(
      /rota\.md/
    );

    expect(await wikiCounts()).toEqual(before);
    const averias = await client.query(
      `select count(*)::int as n from app.wiki_spaces where slug = 'averias'`
    );
    expect(averias.rows[0].n).toBe(0);

    // El ensayo del mismo corpus tampoco escribe y detalla fichero y motivo.
    const rehearsal = await importCorpus(client, {
      ...IMPORT_ARGS,
      dir: invalidDir,
      dryRun: true,
    });
    expect(rehearsal.errors).toHaveLength(1);
    expect(rehearsal.errors[0].file).toContain('rota.md');
    expect(rehearsal.errors[0].reason).toContain('lista en línea sin cerrar');
    expect(await wikiCounts()).toEqual(before);
  });
});
