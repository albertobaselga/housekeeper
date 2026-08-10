// Validación del corpus real del «Manual de convivencia y operaciones v0.1»
// (packages/db/content/manual, generado por convert-manual.mjs y commiteado).
//
// La primera parte no necesita base de datos: comprueba con buildPlan que el
// corpus cumple el contrato del plan de importación (7 apartados ordenados,
// fijadas, borradores solo donde hay pendientes, índice enlazando cada hueco).
// La segunda, solo con TEST_DATABASE_URL, importa el corpus real contra
// Postgres: dry-run sin efectos, importación completa e idempotencia.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrate.mjs';
import { buildPlan, importCorpus } from './wiki-import.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const corpusDir = path.join(packageRoot, 'content', 'manual');

const PENDIENTE = '> **Pendiente de completar por la familia:**';

// Orden de LECTURA, no de uso (ver el comentario del test): quien llega nuevo
// necesita primero saber qué casa es esta y cómo se trata la gente, después el
// plano y la forma del día, después quiénes viven aquí, y solo entonces el
// detalle operativo. Mantenimiento cierra porque se consulta, no se estudia.
const EXPECTED_SPACES = [
  'convivencia',
  'la-casa-y-sus-zonas',
  'los-ninos',
  'cocina',
  'limpieza',
  'ropa-y-colada',
  'mantenimiento',
];

const EXPECTED_PINNED = [
  'guia-rapida-cierre-de-jornada',
  'guia-rapida-durante-la-jornada',
  'guia-rapida-inicio-de-jornada',
  'pendientes-de-completar',
  'principios-generales',
];

describe('corpus real del manual de convivencia', () => {
  /** @type {Awaited<ReturnType<typeof buildPlan>>} */
  let plan;

  beforeAll(async () => {
    plan = await buildPlan(corpusDir);
  });

  it('es un corpus válido con los siete apartados en el orden del manual', () => {
    expect(plan.errors).toEqual([]);
    // buildPlan recorre en orden alfabético; el orden de portada lo da position.
    const byPosition = [...plan.spaces].sort((a, b) => a.position - b.position);
    expect(byPosition.map((space) => space.slug)).toEqual(EXPECTED_SPACES);
    expect(byPosition.map((space) => space.position)).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(plan.spaces.every((space) => space.name.length > 0 && space.description.length > 0)).toBe(
      true
    );
  });

  it('trae ~45 notas y las tres guías rápidas de la jornada + índice fijadas', () => {
    expect(plan.pages.length).toBeGreaterThanOrEqual(45);
    expect(plan.pages.length).toBeLessThanOrEqual(60);
    const pinned = plan.pages
      .filter((page) => page.pinned)
      .map((page) => page.slug)
      .sort();
    expect(pinned).toEqual(EXPECTED_PINNED);
  });

  it('una nota queda en borrador si y solo si conserva pendientes', () => {
    for (const page of plan.pages) {
      const hasPendiente = page.body.includes(PENDIENTE);
      if (page.status === 'draft') {
        expect(hasPendiente || page.slug === 'pendientes-de-completar').toBe(true);
      } else {
        expect(hasPendiente, `${page.slug} publicada con pendientes`).toBe(false);
      }
    }
    const drafts = plan.pages.filter((page) => page.status === 'draft');
    expect(drafts.length).toBeGreaterThanOrEqual(5);
    expect(drafts.length).toBeLessThan(plan.pages.length / 3);
  });

  it('el índice de pendientes enlaza (reescrito a wiki:) cada nota con huecos', () => {
    const index = plan.pages.find((page) => page.slug === 'pendientes-de-completar');
    expect(index).toBeDefined();
    expect(index.status).toBe('draft');
    expect(index.pinned).toBe(true);
    const draftSlugs = plan.pages
      .filter((page) => page.status === 'draft' && page.slug !== index.slug)
      .map((page) => page.slug);
    for (const slug of draftSlugs) {
      expect(index.body).toContain(`(wiki:${slug})`);
    }
  });

  it('las fichas clave del plan existen, con tabla donde el Word la traía', () => {
    const bySlug = new Map(plan.pages.map((page) => [page.slug, page]));
    for (const slug of [
      'rutina-diaria-de-referencia',
      'ficha-operativa-marmol',
      'ficha-operativa-tarima',
      'ficha-operativa-terrazo',
      'particularidades-por-zona',
      'thermomix-horno-e-induccion',
      'compra-personal-de-alimentos',
      'ventilacion-orden-y-residuos',
    ]) {
      expect(bySlug.has(slug), `falta la nota ${slug}`).toBe(true);
    }
    expect(bySlug.get('rutina-diaria-de-referencia').body).toContain('| Momento |');
    expect(bySlug.get('particularidades-por-zona').body).toContain('| Zona |');
    // Los avisos del Word llegan como citas destacadas.
    expect(bySlug.get('metodo-general-de-limpieza').body).toContain('> **REGLA NO NEGOCIABLE:**');
  });

  it('no importa lo excluido: ruta de consulta, anexos G/H/I/J ni control de versiones', () => {
    const corpusText = plan.pages.map((page) => `${page.title}\n${page.body}`).join('\n');
    expect(corpusText).not.toContain('Ruta de consulta');
    expect(corpusText).not.toContain('Anexo I');
    expect(corpusText).not.toContain('Anexo J');
    expect(corpusText).not.toContain('Control de versiones');
    // El 112 del Anexo G vive en Contactos (seed-manual), no como nota.
    expect(plan.pages.some((page) => page.title.includes('Anexo G'))).toBe(false);
  });
});

describe.runIf(Boolean(adminUrl))('importación del corpus real contra Postgres', () => {
  const HOUSEHOLD = '78000000-0000-4000-8000-000000000001';
  const MEMBERSHIP = '78000000-0000-4000-8000-000000000002';
  const ARGS = { householdId: HOUSEHOLD, membershipId: MEMBERSHIP, dir: corpusDir };

  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema if exists app_private cascade');
    await client.query('drop table if exists public.schema_migrations');
    await applyMigrations(client);
    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'hogar-manual', 'Hogar del manual')`,
      [HOUSEHOLD]
    );
    await client.query(
      `insert into app.user_profiles (user_id, display_name)
       values ('fixture:manual', 'Importador del manual')`
    );
    await client.query(
      `insert into app.household_memberships (id, household_id, user_id, role)
       values ($1, $2, 'fixture:manual', 'family_admin')`,
      [MEMBERSHIP, HOUSEHOLD]
    );
    await client.query('commit');
  });

  afterAll(async () => {
    await client?.end();
  });

  it('dry-run limpio, importación real y segundo pase idempotente', async () => {
    const rehearsal = await importCorpus(client, { ...ARGS, dryRun: true });
    expect(rehearsal.errors).toEqual([]);
    const total = await client.query('select count(*)::int as n from app.wiki_pages');
    expect(total.rows[0].n).toBe(0);

    const real = await importCorpus(client, ARGS);
    expect(real.errors).toEqual([]);
    expect(real.spaces.created).toHaveLength(7);
    expect(real.pages.created.length).toBe(rehearsal.pages.created.length);

    const pinned = await client.query(
      `select current_slug from app.wiki_pages where household_id = $1 and pinned
        order by current_slug`,
      [HOUSEHOLD]
    );
    expect(pinned.rows.map((row) => row.current_slug)).toEqual(EXPECTED_PINNED);

    const drafts = await client.query(
      `select count(*)::int as n from app.wiki_pages
        where household_id = $1 and status = 'draft'`,
      [HOUSEHOLD]
    );
    expect(drafts.rows[0].n).toBeGreaterThanOrEqual(5);

    const again = await importCorpus(client, ARGS);
    expect(again.errors).toEqual([]);
    expect(again.revisions).toBe(0);
    expect(again.pages.created).toEqual([]);
    expect(again.pages.updated).toEqual([]);
  });
});
