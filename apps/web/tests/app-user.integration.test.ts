import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { membershipIn } from '../src/lib/auth/membership';
import { resolveAppUser } from '../src/lib/server/app-user.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_appuser_login';
// Base propia: cada suite de integración recrea el esquema entero y no puede
// compartir instancia con las demás (patrón de access.integration.test.ts).
const APPUSER_DB = 'casaclara_appuser_it';

/** Segundo hogar de las fixtures sintéticas (packages/db/fixtures). */
const OLIVO_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';

// Dos identidades con dos casas cada una, en los dos órdenes posibles: la que
// administra primero y mira después, y la que apoya primero y administra
// después. Con el rol leído de la primera membresía una escala privilegios y
// la otra los pierde; ambas cosas están mal.
const ADMIN_LUEGO_VISOR = 'fixture:doble:admin-visor';
const ADMIN_LUEGO_VISOR_ROBLE = '31000000-0000-4000-8000-000000000001';
const ADMIN_LUEGO_VISOR_OLIVO = '31000000-0000-4000-8000-000000000002';

const APOYO_LUEGO_ADMIN = 'fixture:doble:apoyo-admin';
const APOYO_LUEGO_ADMIN_ROBLE = '31000000-0000-4000-8000-000000000003';
const APOYO_LUEGO_ADMIN_OLIVO = '31000000-0000-4000-8000-000000000004';

// Una tercera casa a la que ya no pertenece: la membresía revocada no puede
// asomar en la lista, porque de ella salen rol y capacidades.
const REVOCADA_OLIVO = '31000000-0000-4000-8000-000000000005';

function appUserUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${APPUSER_DB}`;
  return url.toString();
}

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('${ADMIN_LUEGO_VISOR}', 'Fixture Dos Casas Admin'),
  ('${APOYO_LUEGO_ADMIN}', 'Fixture Dos Casas Apoyo');

-- created_at explícito: el orden de la consulta es por antigüedad y es
-- justamente el que producía el fallo.
INSERT INTO app.household_memberships (id, household_id, user_id, role, created_at) VALUES
  ('${ADMIN_LUEGO_VISOR_ROBLE}', '${FIXTURE_HOUSEHOLD}', '${ADMIN_LUEGO_VISOR}', 'family_admin', now() - interval '3 days'),
  ('${ADMIN_LUEGO_VISOR_OLIVO}', '${OLIVO_HOUSEHOLD}', '${ADMIN_LUEGO_VISOR}', 'viewer', now() - interval '1 day'),
  ('${APOYO_LUEGO_ADMIN_ROBLE}', '${FIXTURE_HOUSEHOLD}', '${APOYO_LUEGO_ADMIN}', 'helper', now() - interval '3 days'),
  ('${APOYO_LUEGO_ADMIN_OLIVO}', '${OLIVO_HOUSEHOLD}', '${APOYO_LUEGO_ADMIN}', 'family_admin', now() - interval '1 day');
COMMIT;
`;

describe.runIf(Boolean(adminUrl))('resolveAppUser devuelve una membresía por hogar', () => {
  let appPool: pg.Pool;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${APPUSER_DB} with (force)`);
      await cluster.query(`create database ${APPUSER_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: appUserUrlFor(adminUrl as string) });
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

    adminPool = new pg.Pool({ connectionString: appUserUrlFor(adminUrl as string), max: 2 });
    const url = new URL(appUserUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  /**
   * La regresión. Quien administra el roble es SOLO visor en el olivo, y la
   * identidad que la aplicación construye tiene que decir exactamente eso en
   * cada hogar. Si el rol vuelve a salir de la primera membresía, esta prueba
   * falla con `family_admin` donde espera `viewer`.
   */
  it('quien administra un hogar entra en el otro con el papel del otro', async () => {
    const user = await resolveAppUser(
      ADMIN_LUEGO_VISOR,
      'admin-visor@ejemplo.test',
      'Sin nombre',
      appPool
    );
    expect(user).not.toBeNull();
    expect(user!.memberships).toHaveLength(2);

    expect(membershipIn(user, FIXTURE_HOUSEHOLD)).toEqual({
      householdId: FIXTURE_HOUSEHOLD,
      membershipId: ADMIN_LUEGO_VISOR_ROBLE,
      role: 'family_admin'
    });
    expect(membershipIn(user, OLIVO_HOUSEHOLD)).toEqual({
      householdId: OLIVO_HOUSEHOLD,
      membershipId: ADMIN_LUEGO_VISOR_OLIVO,
      role: 'viewer'
    });
  });

  /** El mismo fallo por el otro lado: administrar de verdad y no poder. */
  it('quien solo apoya en un hogar sí administra en el otro', async () => {
    const user = await resolveAppUser(
      APOYO_LUEGO_ADMIN,
      'apoyo-admin@ejemplo.test',
      'Sin nombre',
      appPool
    );
    expect(membershipIn(user, FIXTURE_HOUSEHOLD)?.role).toBe('helper');
    expect(membershipIn(user, OLIVO_HOUSEHOLD)?.role).toBe('family_admin');
    expect(membershipIn(user, OLIVO_HOUSEHOLD)?.membershipId).toBe(APOYO_LUEGO_ADMIN_OLIVO);
  });

  it('el nombre del perfil llega una sola vez y no depende del hogar', async () => {
    const user = await resolveAppUser(ADMIN_LUEGO_VISOR, 'x@ejemplo.test', 'Respaldo', appPool);
    expect(user!.name).toBe('Fixture Dos Casas Admin');
    expect(user!.initials).toBe('FD');
    // Los dos hogares llegan con su nombre para el selector.
    expect(user!.households?.map((household) => household.id).sort()).toEqual(
      [FIXTURE_HOUSEHOLD, OLIVO_HOUSEHOLD].sort()
    );
  });

  /**
   * La revocación sigue siendo instantánea y la aplica la RLS: al retirarle el
   * acceso al olivo, ese hogar desaparece de su identidad en la petición
   * siguiente, sin desconectar sesiones ni tocar código de aplicación.
   */
  it('una membresía revocada deja de existir en la identidad', async () => {
    const antes = await resolveAppUser(APOYO_LUEGO_ADMIN, 'x@ejemplo.test', 'Respaldo', appPool);
    expect(antes!.memberships).toHaveLength(2);

    await adminPool.query(
      `update app.household_memberships set revoked_at = statement_timestamp() where id = $1`,
      [APOYO_LUEGO_ADMIN_OLIVO]
    );
    try {
      const despues = await resolveAppUser(APOYO_LUEGO_ADMIN, 'x@ejemplo.test', 'Respaldo', appPool);
      expect(despues!.memberships).toHaveLength(1);
      expect(membershipIn(despues, OLIVO_HOUSEHOLD)).toBeNull();
      expect(membershipIn(despues, FIXTURE_HOUSEHOLD)?.role).toBe('helper');
    } finally {
      await adminPool.query(
        `update app.household_memberships set revoked_at = null where id = $1`,
        [APOYO_LUEGO_ADMIN_OLIVO]
      );
    }
  });

  it('sin ninguna membresía viva no hay identidad de aplicación', async () => {
    await adminPool.query(
      `insert into app.user_profiles (user_id, display_name)
       values ($1, 'Fixture Sin Casa') on conflict (user_id) do nothing`,
      ['fixture:doble:sin-casa']
    );
    await adminPool.query(
      `insert into app.household_memberships (id, household_id, user_id, role, revoked_at)
       values ($1, $2, $3, 'viewer', statement_timestamp())
       on conflict (id) do nothing`,
      [REVOCADA_OLIVO, OLIVO_HOUSEHOLD, 'fixture:doble:sin-casa']
    );
    expect(await resolveAppUser('fixture:doble:sin-casa', 'x@ejemplo.test', 'X', appPool)).toBeNull();
  });
});
