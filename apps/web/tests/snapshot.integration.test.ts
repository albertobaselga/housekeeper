import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { getCriticalSnapshotPayload } from '../src/lib/server/fixtures.server';
import { buildCriticalSnapshot, loadSnapshotHousehold } from '../src/lib/server/snapshot.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

// Ola D-1: el paquete offline en modo real deja de servir fixtures. Esta suite
// comprueba contra Postgres que el snapshot lleva el menú del día, las rutinas
// que vencen y las notas FIJADAS de la Guía del hogar de verdad, y que RLS
// decide qué ve cada rol.

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Igual que en contacts.integration: esta suite afirma el comportamiento CON
// base configurada. `fixturesAllowed()` lo decide por la DATABASE_URL del
// proceso, así que se declara aquí en vez de heredarla del shell de turno.
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgres://prueba/afirmada' } }));
const APP_LOGIN = 'it_housekeeper_snapshot_login';
const SNAPSHOT_DB = 'housekeeper_off_snapshot_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';

const SPACE = '61000000-0000-4000-8000-000000000001';
const TEMPLATE_SPACE = '61000000-0000-4000-8000-000000000002';
const PAGE_PINNED = '61100000-0000-4000-8000-000000000001';
const PAGE_PLAIN = '61100000-0000-4000-8000-000000000002';
const PAGE_DRAFT = '61100000-0000-4000-8000-000000000003';
const PAGE_TEMPLATE = '61100000-0000-4000-8000-000000000004';
const RECIPE_PAGE = '61100000-0000-4000-8000-000000000005';
const MENU_GROUP = '62000000-0000-4000-8000-000000000001';
const SLOT_COMIDA = '62100000-0000-4000-8000-000000000001';
const SLOT_CENA = '62100000-0000-4000-8000-000000000002';
const SLOT_MANANA = '62100000-0000-4000-8000-000000000003';
const ROUTINE_TODAY = '63000000-0000-4000-8000-000000000001';
const ROUTINE_LATE = '63000000-0000-4000-8000-000000000002';
const ROUTINE_FUTURE = '63000000-0000-4000-8000-000000000003';
const ROUTINE_FAMILY = '63000000-0000-4000-8000-000000000004';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };

function snapshotUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${SNAPSHOT_DB}`;
  return url.toString();
}

/** La zona del hogar: la misma con la que la aplicación decide qué día es hoy. */
const CASA_TZ = 'Europe/Madrid';

/**
 * «Hoy» EN LA ZONA DE LA CASA, para sembrar.
 *
 * Aquí ponía `current_date`, que es la fecha del SERVIDOR DE BASE DE DATOS (su
 * zona de sesión; en CI y en el Docker local, UTC). La aplicación decide qué día
 * es hoy en `Europe/Madrid` —`snapshot.server.ts` lo calcula con `Intl` y lo
 * manda como parámetro—, así que entre las 22:00 y las 00:00 UTC las dos fechas
 * eran días distintos y la prueba fallaba sola: el hueco de «mañana» pasaba a
 * ser el de hoy y el menú sembrado dejaba de coincidir. Fallo real, no ruido,
 * pero de los que aparecen y desaparecen según la hora — y un CI que falla dos
 * horas de cada veinticuatro se aprende a ignorar.
 *
 * `now() at time zone 'Europe/Madrid'` no depende de la zona de sesión de nadie:
 * dice la hora de pared de la casa, que es la única que le importa a un menú.
 */
const HOY_EN_CASA = `(now() at time zone '${CASA_TZ}')::date`;

/**
 * Zona de sesión DELIBERADAMENTE HOSTIL para la siembra, elegida para que la
 * fecha del servidor NUNCA coincida con la de la casa.
 *
 * Sin esto, el arreglo de arriba sólo se comprobaría de verdad durante las dos
 * horas al día en que las dos fechas difieren: el resto del tiempo un
 * `current_date` reintroducido pasaría la prueba. Con esto, la franja mala es
 * SIEMPRE, así que el fallo deja de depender de a qué hora corra CI.
 *
 * Antes del mediodía en casa se elige UTC−12 (la sesión va un día por detrás) y
 * a partir del mediodía UTC+14 (un día por delante). Con el desfase de Madrid
 * —+1 en invierno, +2 en verano— las dos ramas caen siempre en otro día, así
 * que no hay hora del año en la que esta prueba se relaje.
 */
function zonaQueNoEsLaDeCasa(ahora = new Date()): string {
  const hora = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: CASA_TZ,
      hour: '2-digit',
      hourCycle: 'h23'
    }).format(ahora)
  );
  return hora < 12 ? 'Etc/GMT+12' : 'Pacific/Kiritimati';
}

const ZONA_HOSTIL = zonaQueNoEsLaDeCasa();

const SNAPSHOT_SEED = `
BEGIN;
SET LOCAL row_security = off;
-- Ver zonaQueNoEsLaDeCasa(): la siembra corre a propósito en una zona cuya
-- fecha no es la de la casa, para que un current_date que volviera a colarse
-- aquí falle SIEMPRE y no sólo en la franja en que se caía antes.
SET LOCAL TIME ZONE '${ZONA_HOSTIL}';

-- Guía: un espacio vivo con una nota fijada y publicada, una publicada sin
-- fijar, un borrador fijado, y un espacio plantilla con otra nota fijada.
INSERT INTO app.wiki_spaces (id, household_id, slug, name, description, is_template, position, created_by_membership_id) VALUES
  ('${SPACE}', '${FIXTURE_HOUSEHOLD}', 'casa-off', 'Casa', 'Instrucciones de la casa', false, 0, '${ADMIN_MEMBERSHIP}'),
  ('${TEMPLATE_SPACE}', '${FIXTURE_HOUSEHOLD}', 'plantillas-off', 'Plantillas', 'Origen de clonación', true, 9, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, parent_page_id, status, current_slug, pinned, position, created_by_membership_id) VALUES
  ('${PAGE_PINNED}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', NULL, 'published', 'llave-del-agua', true, 0, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_PLAIN}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', NULL, 'published', 'plantas', false, 1, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_DRAFT}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', NULL, 'draft', 'borrador-off', true, 2, '${ADMIN_MEMBERSHIP}'),
  ('${PAGE_TEMPLATE}', '${FIXTURE_HOUSEHOLD}', '${TEMPLATE_SPACE}', NULL, 'published', 'modelo-off', true, 0, '${ADMIN_MEMBERSHIP}'),
  ('${RECIPE_PAGE}', '${FIXTURE_HOUSEHOLD}', '${SPACE}', NULL, 'published', 'lentejas-off', false, 3, '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_page_slugs (household_id, page_id, slug) VALUES
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_PINNED}', 'llave-del-agua'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_PLAIN}', 'plantas'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 'borrador-off'),
  ('${FIXTURE_HOUSEHOLD}', '${PAGE_TEMPLATE}', 'modelo-off'),
  ('${FIXTURE_HOUSEHOLD}', '${RECIPE_PAGE}', 'lentejas-off');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, summary, tags, aliases, authored_by_membership_id) VALUES
  ('61110000-0000-4000-8000-000000000001', '${FIXTURE_HOUSEHOLD}', '${PAGE_PINNED}', 1,
   'Llave de corte del agua', 'La llave está bajo el fregadero.

Gírala hacia la derecha hasta el tope.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('61110000-0000-4000-8000-000000000002', '${FIXTURE_HOUSEHOLD}', '${PAGE_PLAIN}', 1,
   'Riego de las plantas', 'Los lunes y los jueves.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('61110000-0000-4000-8000-000000000003', '${FIXTURE_HOUSEHOLD}', '${PAGE_DRAFT}', 1,
   'Nota a medias', 'Todavía sin terminar.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('61110000-0000-4000-8000-000000000004', '${FIXTURE_HOUSEHOLD}', '${PAGE_TEMPLATE}', 1,
   'Modelo de instrucción', 'Texto de plantilla.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}'),
  ('61110000-0000-4000-8000-000000000005', '${FIXTURE_HOUSEHOLD}', '${RECIPE_PAGE}', 1,
   'Lentejas de la casa', 'Cocer a fuego lento.', '', ARRAY[]::text[], ARRAY[]::text[], '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '61110000-0000-4000-8000-000000000001' WHERE id = '${PAGE_PINNED}';
UPDATE app.wiki_pages SET current_revision_id = '61110000-0000-4000-8000-000000000002' WHERE id = '${PAGE_PLAIN}';
UPDATE app.wiki_pages SET current_revision_id = '61110000-0000-4000-8000-000000000003' WHERE id = '${PAGE_DRAFT}';
UPDATE app.wiki_pages SET current_revision_id = '61110000-0000-4000-8000-000000000004' WHERE id = '${PAGE_TEMPLATE}';
UPDATE app.wiki_pages SET current_revision_id = '61110000-0000-4000-8000-000000000005' WHERE id = '${RECIPE_PAGE}';

INSERT INTO app.recipes (household_id, page_id, base_servings, time_minutes)
VALUES ('${FIXTURE_HOUSEHOLD}', '${RECIPE_PAGE}', 4, 60);

-- Menú: un hueco de hoy con receta, otro de hoy con texto libre y uno de mañana
-- (que NO debe viajar en el snapshot).
INSERT INTO app.menu_groups (id, household_id, name, position)
VALUES ('${MENU_GROUP}', '${FIXTURE_HOUSEHOLD}', 'Casa', 20);

INSERT INTO app.menu_slots (id, household_id, group_id, on_date, meal, recipe_page_id, free_text, notes, updated_by_membership_id) VALUES
  ('${SLOT_COMIDA}', '${FIXTURE_HOUSEHOLD}', '${MENU_GROUP}', ${HOY_EN_CASA}, 'comida', '${RECIPE_PAGE}', '', '', '${ADMIN_MEMBERSHIP}'),
  ('${SLOT_CENA}', '${FIXTURE_HOUSEHOLD}', '${MENU_GROUP}', ${HOY_EN_CASA}, 'cena', NULL, 'Tortilla y ensalada', '', '${ADMIN_MEMBERSHIP}'),
  ('${SLOT_MANANA}', '${FIXTURE_HOUSEHOLD}', '${MENU_GROUP}', ${HOY_EN_CASA} + 1, 'comida', NULL, 'Sopa de mañana', '', '${ADMIN_MEMBERSHIP}');

-- Rutinas: hoy (empleada), atrasada (todas), futura (todas) y una solo de familia.
INSERT INTO app.routines (id, household_id, title, details, audience, next_due_hint, created_by_membership_id,
  pattern, anchor_on, repeat_every) VALUES
  ('${ROUTINE_TODAY}', '${FIXTURE_HOUSEHOLD}', 'Sacar la basura (off)', 'Contenedor amarillo', 'employee', ${HOY_EN_CASA}, '${ADMIN_MEMBERSHIP}', 'every_n_days', ${HOY_EN_CASA}, 1),
  ('${ROUTINE_LATE}', '${FIXTURE_HOUSEHOLD}', 'Cambiar sábanas (off)', '', 'all', ${HOY_EN_CASA} - 2, '${ADMIN_MEMBERSHIP}', 'every_n_days', ${HOY_EN_CASA} - 2, 7),
  ('${ROUTINE_FUTURE}', '${FIXTURE_HOUSEHOLD}', 'Limpiar filtros (off)', '', 'all', ${HOY_EN_CASA} + 5, '${ADMIN_MEMBERSHIP}', 'every_n_days', ${HOY_EN_CASA} + 5, 30),
  ('${ROUTINE_FAMILY}', '${FIXTURE_HOUSEHOLD}', 'Revisar seguros (off)', '', 'family', ${HOY_EN_CASA}, '${ADMIN_MEMBERSHIP}', 'every_n_days', ${HOY_EN_CASA}, 90);

COMMIT;
`;

describe.runIf(Boolean(adminUrl))('snapshot crítico con datos reales del hogar', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${SNAPSHOT_DB} with (force)`);
      await cluster.query(`create database ${SNAPSHOT_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: snapshotUrlFor(adminUrl as string) });
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
      await admin.query(SNAPSHOT_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(snapshotUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la siembra llama «hoy» al mismo día que la casa, no al del servidor', async () => {
    /*
     * La invariante que faltaba, dicha en voz alta en vez de supuesta. Se
     * comprueba a la vez que la zona hostil hace su trabajo: si las dos fechas
     * de abajo coincidieran, esta prueba pasaría por casualidad y no probaría
     * nada, así que primero se afirma que DIFIEREN.
     */
    // Se lee con el rol propietario a propósito: bajo la RLS del rol de la
    // aplicación estas filas no se ven sin contexto de hogar, y lo que se
    // comprueba aquí es la SIEMBRA, no quién la puede leer.
    const duena = new pg.Client({ connectionString: snapshotUrlFor(adminUrl as string) });
    await duena.connect();
    try {
      const zonas = await duena.query<{ casa: string; hostil: string }>(
        `select ${HOY_EN_CASA}::text as casa,
                (now() at time zone '${ZONA_HOSTIL}')::date::text as hostil`
      );
      // Primero, que la zona hostil esté haciendo su trabajo: si coincidiera con
      // la de la casa, todo lo de abajo pasaría por casualidad.
      expect(
        zonas.rows[0]!.hostil,
        `la zona ${ZONA_HOSTIL} debería estar en otro día que ${CASA_TZ}`
      ).not.toBe(zonas.rows[0]!.casa);

      // Y ahora lo que importa: lo sembrado como «hoy» es el hoy DE LA CASA, no
      // el del servidor, aunque el servidor esté sembrando desde otro día.
      const hoyEnCasa = new Intl.DateTimeFormat('en-CA', { timeZone: CASA_TZ }).format(new Date());
      expect(zonas.rows[0]!.casa).toBe(hoyEnCasa);

      const slots = await duena.query<{ id: string; onDate: string }>(
        `select id::text, on_date::text as "onDate" from app.menu_slots where id = any($1::uuid[])`,
        [[SLOT_COMIDA, SLOT_MANANA]]
      );
      const porId = new Map(slots.rows.map((row) => [row.id, row.onDate]));
      expect(porId.get(SLOT_COMIDA)).toBe(hoyEnCasa);
      // El de mañana es mañana EN CASA: es el que la prueba de abajo exige que
      // NO viaje en el snapshot.
      expect(porId.get(SLOT_MANANA)! > hoyEnCasa).toBe(true);
    } finally {
      await duena.end();
    }
  });

  it('lleva el menú de HOY con su estado, no el de otros días', async () => {
    const data = await loadSnapshotHousehold(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(data).not.toBeNull();
    expect(data!.today.menu.map((slot) => slot.dish)).toEqual(['Lentejas de la casa', 'Tortilla y ensalada']);
    expect(data!.today.menu[0]).toMatchObject({ mealLabel: 'Comida', groupName: 'Casa', confirmed: false });
    expect(data!.today.menu[1]).toMatchObject({ mealLabel: 'Cena', confirmed: false });
    expect(data!.today.dateLabel.length).toBeGreaterThan(0);
  });

  it('lleva las rutinas que tocan hoy o se quedaron pendientes, con su ocurrencia', async () => {
    const data = await loadSnapshotHousehold(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    const titles = data!.today.routines.map((routine) => routine.title);
    expect(titles).toContain('Cambiar sábanas (off)');
    expect(titles).toContain('Sacar la basura (off)');
    expect(titles).not.toContain('Limpiar filtros (off)');

    const late = data!.today.routines.find((routine) => routine.title === 'Cambiar sábanas (off)')!;
    expect(late.overdue).toBe(true);
    expect(late.dueLabel).toMatch(/^Tocaba el /);

    const todayRoutine = data!.today.routines.find((routine) => routine.title === 'Sacar la basura (off)')!;
    expect(todayRoutine).toMatchObject({ overdue: false, dueLabel: 'Hoy', done: false });
    // La ocurrencia concreta viaja con la fila: sin ella, marcarla sin conexión
    // obligaba a adivinar de qué día se hablaba.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
    expect(todayRoutine.dueOn).toBe(today);
    expect(late.dueOn < today).toBe(true);
  });

  it('RLS acota las rutinas por audiencia: la empleada no ve las de familia', async () => {
    const employee = await loadSnapshotHousehold(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(employee!.today.routines.map((routine) => routine.title)).not.toContain('Revisar seguros (off)');
    const admin = await loadSnapshotHousehold(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(admin!.today.routines.map((routine) => routine.title)).toContain('Revisar seguros (off)');
  });

  it('lleva solo las notas fijadas y publicadas de espacios vivos, con su contenido', async () => {
    const data = await loadSnapshotHousehold(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(data!.wikiPages.map((page) => page.title)).toEqual(['Llave de corte del agua']);
    expect(data!.wikiPages[0]).toMatchObject({ space: 'Casa' });
    expect(data!.wikiPages[0]!.body).toContain('bajo el fregadero');
  });

  it('el snapshot firmado deja de llevar la fixture sintética', async () => {
    const data = await loadSnapshotHousehold(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    const contacts = [{ id: 'emergency-112', name: 'Emergencias', phone: '112', kind: 'emergency' }];
    const snapshot = buildCriticalSnapshot(FIXTURE_HOUSEHOLD, ADMIN_MEMBERSHIP, contacts, data);
    const serialized = JSON.stringify(snapshot.payload);
    expect(serialized).not.toContain('Leo · sin lácteos');
    expect(serialized).not.toContain('Lavadora · programa corto');
    expect(serialized).toContain('Llave de corte del agua');
    expect(snapshot.payload.dietaryFlags).toEqual([]);
    expect(snapshot.signature.length).toBeGreaterThan(0);

    // Y sin lectura real —esta suite corre SIEMPRE con base configurada, que es
    // el caso de producción— el paquete sale parcial: ni una nota, ni un menú,
    // ni una rutina inventada viaja firmada al móvil. La maqueta entera, en su
    // propio despliegue sin base, la cubre `search-offline`.
    expect(await loadSnapshotHousehold(ADMIN_USER, FIXTURE_HOUSEHOLD, null)).toBeNull();
    const partial = getCriticalSnapshotPayload(null, null);
    expect(partial.wikiPages).toEqual([]);
    expect(partial.today.menu).toEqual([]);
    expect(partial.today.routines).toEqual([]);
  });

  it('un usuario sin membresía en el hogar no recibe nada', async () => {
    expect(await loadSnapshotHousehold({ id: 'fixture:otro:usuario' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });
});
