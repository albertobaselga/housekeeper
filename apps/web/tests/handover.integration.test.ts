import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildHandoverExport, canDownloadHandover } from '../src/lib/server/handover.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_handover_login';
// Base de datos propia (patrón de la suite de comida): las otras suites recrean
// el esquema entero en paralelo y ninguna puede compartir instancia.
const HANDOVER_DB = 'casaclara_handover_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
// Hogar limpio para el ensayo de reimportación (sin wiki previa).
const CLEAN_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const CLEAN_MEMBERSHIP = '21000000-0000-4000-8000-000000000001';

const SPACE_EQUIP = '51000000-0000-4000-8000-000000000001';
const PAGE_LAVADORA = '52000000-0000-4000-8000-000000000001';
const PAGE_CALDERA = '52000000-0000-4000-8000-000000000002';
const PAGE_DRAFT = '52000000-0000-4000-8000-000000000003';
const REV_LAVADORA = '53000000-0000-4000-8000-000000000001';
const REV_CALDERA = '53000000-0000-4000-8000-000000000002';
const REV_DRAFT = '53000000-0000-4000-8000-000000000003';
const GROUP_FAMILIA = '54000000-0000-4000-8000-000000000001';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };

// generatedAt inyectable: fija la semana del menú (lunes 2026-08-03) y hace el
// manifest determinista.
const GENERATED_AT = new Date('2026-08-07T10:00:00.000Z');
const WEEK_MONDAY = '2026-08-03';

function handoverUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${HANDOVER_DB}`;
  return url.toString();
}

// La fixture compartida (001_two_households.sql) ya siembra el expediente
// laboral del hogar: acuerdo con salario mensual 140000 y la liquidación
// cerrada de marzo. Este seed añade el contenido operativo del traspaso y una
// cadena laboral extra con la palabra «Liquidación» como canario: NADA de esto
// puede aparecer en el ZIP.
const HANDOVER_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, position, created_by_membership_id)
VALUES ('${SPACE_EQUIP}', '${FIXTURE_HOUSEHOLD}', 'equipamiento', 'Equipamiento', 'Aparatos de la casa', 0, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, position, created_by_membership_id) VALUES
  ('${PAGE_LAVADORA}', '${FIXTURE_HOUSEHOLD}', '${SPACE_EQUIP}', 'published', 'lavadora', 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_CALDERA}', '${FIXTURE_HOUSEHOLD}', '${SPACE_EQUIP}', 'published', 'caldera', 1, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_DRAFT}', '${FIXTURE_HOUSEHOLD}', '${SPACE_EQUIP}', 'draft', 'caldera-borrador', 2, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', 'lavadora'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_CALDERA}', 'caldera'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 'caldera-borrador');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id) VALUES
  ('${REV_LAVADORA}', '${FIXTURE_HOUSEHOLD}', '${PAGE_LAVADORA}', 1, 'Lavadora · programa corto',
   'Usa el programa Mixto 40° para media carga.

El detergente va en el compartimento II.', '', ARRAY['colada'], ARRAY['lavadora-vieja'], '${ADMIN_MEMBERSHIP}'),
  ('${REV_CALDERA}', '${FIXTURE_HOUSEHOLD}', '${PAGE_CALDERA}', 1, 'Caldera',
   'Presión entre 1 y 1,5 bar. Si baja, abrir la llave azul.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('${REV_DRAFT}', '${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 1, 'Caldera · borrador secreto',
   'Notas sin terminar que nadie debe recibir.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '${REV_LAVADORA}' WHERE id = '${PAGE_LAVADORA}';
UPDATE app.wiki_pages SET current_revision_id = '${REV_CALDERA}' WHERE id = '${PAGE_CALDERA}';
UPDATE app.wiki_pages SET current_revision_id = '${REV_DRAFT}' WHERE id = '${PAGE_DRAFT}';

INSERT INTO app.routines (household_id, title, details, audience, frequency, interval_count, next_due_on, created_by_membership_id) VALUES
  ('${FIXTURE_HOUSEHOLD}', 'Regar plantas', 'Terraza y salón', 'all', 'weekly', 1, '2026-08-10', '${ADMIN_MEMBERSHIP}'),
  ('${FIXTURE_HOUSEHOLD}', 'Planificar el menú', '', 'family', 'weekly', 1, '2026-08-09', '${ADMIN_MEMBERSHIP}'),
  ('${FIXTURE_HOUSEHOLD}', 'Repaso de uniformes', '', 'employee', 'weekly', 1, '2026-08-11', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.menu_groups (id, household_id, name, position)
VALUES ('${GROUP_FAMILIA}', '${FIXTURE_HOUSEHOLD}', 'Familia', 0);

INSERT INTO app.menu_slots (household_id, group_id, on_date, meal, free_text, notes, updated_by_membership_id) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${GROUP_FAMILIA}', '${WEEK_MONDAY}', 'comida', 'Lentejas con verduras', 'Triturar una ración para Leo', '${ADMIN_MEMBERSHIP}'),
  ('${FIXTURE_HOUSEHOLD}', '${GROUP_FAMILIA}', '${WEEK_MONDAY}', 'cena', 'Tortilla francesa', '', '${ADMIN_MEMBERSHIP}');

-- Contactos REALES del hogar: son los que tiene que llevar el ZIP. Uno de
-- ellos está archivado y no puede viajar.
INSERT INTO app.contacts (household_id, name, role_label, phone, kind, featured, position, archived_at, created_by_membership_id) VALUES
  ('${FIXTURE_HOUSEHOLD}', 'Portería Fixture', 'Portería del edificio', '900 000 001', 'home', true, 0, NULL, '${ADMIN_MEMBERSHIP}'),
  ('${FIXTURE_HOUSEHOLD}', 'Fontanería Fixture', 'Averías de agua', '900 000 002', 'service', false, 1, NULL, '${ADMIN_MEMBERSHIP}'),
  ('${FIXTURE_HOUSEHOLD}', 'Contacto Retirado', 'Ya no atiende', '900 000 003', 'service', false, 2, now(), '${ADMIN_MEMBERSHIP}');

-- Canario laboral: gasto pendiente cuya descripción contiene «Liquidación» y
-- cuyo importe replica el salario. El traspaso no debe olerlo siquiera.
INSERT INTO app.expenses (household_id, agreement_id, employee_membership_id, incurred_on, description, amount_cents, submitted_by_membership_id)
VALUES ('${FIXTURE_HOUSEHOLD}', '12000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000003',
        '2026-08-01', 'Liquidación de marzo · justificante', 140000, '11000000-0000-4000-8000-000000000003');

COMMIT;
`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface Manifest {
  version: number;
  household: { name: string };
  audience: string;
  generatedAt: string;
  files: Array<{ path: string; sha256: string }>;
  filesHash: string;
}

describe.runIf(Boolean(adminUrl))('traspaso operativo (F4-02) desde Postgres bajo RLS', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${HANDOVER_DB} with (force)`);
      await cluster.query(`create database ${HANDOVER_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: handoverUrlFor(adminUrl as string) });
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
      await admin.query(HANDOVER_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: handoverUrlFor(adminUrl as string), max: 2 });
    const url = new URL(handoverUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  async function buildZip(audience: 'helper' | 'family'): Promise<Record<string, Uint8Array>> {
    const zip = await buildHandoverExport(ADMIN_USER, FIXTURE_HOUSEHOLD, audience, appPool, GENERATED_AT);
    expect(zip).not.toBeNull();
    return unzipSync(zip!);
  }

  it('el manifest lista cada fichero con su sha-256 correcto y un hash global verificable', async () => {
    const entries = await buildZip('helper');
    expect(entries['manifest.json']).toBeDefined();
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as Manifest;

    expect(manifest.version).toBe(1);
    expect(manifest.audience).toBe('helper');
    expect(manifest.generatedAt).toBe(GENERATED_AT.toISOString());
    // Solo el nombre del hogar: ningún otro dato identificativo.
    expect(manifest.household).toEqual({ name: 'Fixture Casa Roble' });

    // El manifest cubre exactamente el resto de entradas del ZIP, ordenadas.
    const zipPaths = Object.keys(entries)
      .filter((name) => name !== 'manifest.json')
      .sort((left, right) => left.localeCompare(right, 'en'));
    expect(manifest.files.map((file) => file.path)).toEqual(zipPaths);

    // Recalcular cada sha-256 y el hash global del conjunto.
    for (const file of manifest.files) {
      expect(sha256(entries[file.path]!)).toBe(file.sha256);
    }
    const recomputedFilesHash = sha256(
      new TextEncoder().encode(manifest.files.map((file) => `${file.path}\n${file.sha256}\n`).join(''))
    );
    expect(manifest.filesHash).toBe(recomputedFilesHash);
  });

  it('exporta las páginas publicadas con front-matter reimportable y excluye el borrador', async () => {
    const entries = await buildZip('family');

    const lavadora = strFromU8(entries['wiki/equipamiento/lavadora.md']!);
    expect(lavadora.startsWith('---\n')).toBe(true);
    expect(lavadora).toContain('title: "Lavadora · programa corto"');
    expect(lavadora).toContain('slug: "lavadora"');
    expect(lavadora).toContain('tags: ["colada"]');
    expect(lavadora).toContain('aliases: ["lavadora-vieja"]');
    expect(lavadora).toContain('El detergente va en el compartimento II.');

    const caldera = strFromU8(entries['wiki/equipamiento/caldera.md']!);
    expect(caldera).toContain('title: "Caldera"');
    // Sin tags ni aliases no se emiten claves vacías (el importador las rechaza).
    expect(caldera).not.toContain('tags:');
    expect(caldera).not.toContain('aliases:');

    // El espacio viaja como carpeta + _space.md, donde el importador lo espera.
    const space = strFromU8(entries['wiki/equipamiento/_space.md']!);
    expect(space).toContain('name: "Equipamiento"');
    expect(space).toContain('description: "Aparatos de la casa"');

    // El borrador no existe en el traspaso, ni como ruta ni como contenido.
    const allText = Object.values(entries).map((bytes) => strFromU8(bytes)).join('\n');
    expect(Object.keys(entries).some((name) => name.includes('caldera-borrador'))).toBe(false);
    expect(allText).not.toContain('borrador secreto');
    expect(allText).not.toContain('Notas sin terminar');
  });

  it('la audiencia helper recibe solo rutinas de toda la casa; la familia, todas', async () => {
    const helperEntries = await buildZip('helper');
    const helperRoutines = strFromU8(helperEntries['rutinas.md']!);
    expect(helperRoutines).toContain('Regar plantas');
    expect(helperRoutines).not.toContain('Planificar el menú');
    expect(helperRoutines).not.toContain('Repaso de uniformes');

    const familyEntries = await buildZip('family');
    const familyRoutines = strFromU8(familyEntries['rutinas.md']!);
    expect(familyRoutines).toContain('Regar plantas');
    expect(familyRoutines).toContain('Planificar el menú');
    expect(familyRoutines).toContain('Repaso de uniformes');
  });

  it('menu-semana.md trae la semana en curso y contactos.md los contactos REALES', async () => {
    const entries = await buildZip('helper');
    const menu = strFromU8(entries['menu-semana.md']!);
    expect(menu).toContain(WEEK_MONDAY);
    expect(menu).toContain('Comida · Familia: Lentejas con verduras — Triturar una ración para Leo');
    expect(menu).toContain('Cena · Familia: Tortilla francesa');

    const contacts = strFromU8(entries['contactos.md']!);
    expect(contacts).toContain('Portería Fixture');
    expect(contacts).toContain('900 000 001');
    expect(contacts).toContain('Fontanería Fixture');
    // Lo archivado no viaja…
    expect(contacts).not.toContain('Contacto Retirado');
    // …y la maqueta compartida tampoco: el ZIP que recibe quien va a llevar la
    // casa no puede mezclar los datos del hogar con teléfonos inventados.
    expect(contacts).not.toContain('Centro Pediátrico Olmo');
    expect(contacts).not.toContain('910 000 111');
    expect(contacts).not.toContain('Carmen · 2.º B');
  });

  it('JAMÁS expediente laboral: ninguna entrada contiene los canarios sembrados', async () => {
    for (const audience of ['helper', 'family'] as const) {
      const entries = await buildZip(audience);
      for (const [name, bytes] of Object.entries(entries)) {
        const text = strFromU8(bytes);
        expect(text, `${audience}/${name} filtra el salario`).not.toContain('140000');
        expect(text, `${audience}/${name} filtra la liquidación`).not.toContain('Liquidación');
        expect(text, `${audience}/${name} filtra la liquidación`).not.toContain('liquidación');
      }
    }
  });

  it('el ZIP es determinista: dos builds con el mismo generatedAt son bytes idénticos', async () => {
    const first = await buildHandoverExport(ADMIN_USER, FIXTURE_HOUSEHOLD, 'helper', appPool, GENERATED_AT);
    const second = await buildHandoverExport(ADMIN_USER, FIXTURE_HOUSEHOLD, 'helper', appPool, GENERATED_AT);
    expect(first).not.toBeNull();
    expect(Buffer.from(first!).equals(Buffer.from(second!))).toBe(true);
  });

  it('solo family_admin: empleada y helper reciben null (y la puerta de la UI, false)', async () => {
    expect(await buildHandoverExport(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, 'helper', appPool, GENERATED_AT)).toBeNull();
    expect(await buildHandoverExport(HELPER_USER, FIXTURE_HOUSEHOLD, 'helper', appPool, GENERATED_AT)).toBeNull();
    expect(await buildHandoverExport({ id: 'fixture:olivo:employee' }, FIXTURE_HOUSEHOLD, 'helper', appPool, GENERATED_AT)).toBeNull();

    expect(await canDownloadHandover(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(true);
    expect(await canDownloadHandover(HELPER_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    expect(await canDownloadHandover(ADMIN_USER, FIXTURE_HOUSEHOLD, null)).toBe(false);
  });

  it('round-trip: el directorio wiki/ del ZIP pasa por el importador sin errores', async () => {
    const entries = await buildZip('family');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'handover-wiki-'));
    try {
      for (const [name, bytes] of Object.entries(entries)) {
        if (!name.startsWith('wiki/')) continue;
        const target = path.join(tempDir, name.slice('wiki/'.length));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }

      const importerHref = new URL('../../../packages/db/scripts/wiki-import.mjs', import.meta.url).href;
      const { buildPlan, importCorpus } = (await import(/* @vite-ignore */ importerHref)) as {
        buildPlan: (dir: string) => Promise<{
          spaces: Array<{ slug: string; name: string }>;
          pages: Array<{ slug: string; title: string; status: string }>;
          errors: Array<{ file: string; reason: string }>;
        }>;
        importCorpus: (
          client: pg.PoolClient,
          args: { householdId: string; membershipId: string; dir: string; dryRun: boolean }
        ) => Promise<{
          pages: { created: string[]; updated: string[]; skipped: string[] };
          errors: Array<{ file: string; reason: string }>;
        }>;
      };

      // El plan reconoce las páginas exportadas sin un solo error.
      const plan = await buildPlan(tempDir);
      expect(plan.errors).toEqual([]);
      expect(plan.spaces.map((space) => space.slug)).toEqual(['equipamiento']);
      expect(plan.spaces[0]!.name).toBe('Equipamiento');
      expect(plan.pages.map((page) => page.slug).sort()).toEqual(['caldera', 'lavadora']);
      expect(plan.pages.every((page) => page.status === 'published')).toBe(true);

      // Ensayo real (dry-run) sobre un hogar limpio de esta misma base.
      const client = await adminPool.connect();
      try {
        const report = await importCorpus(client, {
          householdId: CLEAN_HOUSEHOLD,
          membershipId: CLEAN_MEMBERSHIP,
          dir: tempDir,
          dryRun: true
        });
        expect(report.errors).toEqual([]);
        expect(report.pages.created.sort()).toEqual(['caldera', 'lavadora']);
      } finally {
        client.release();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
