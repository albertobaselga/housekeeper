import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAccessOverview, resolveMembershipIdentity } from '../src/lib/server/access.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_access_login';
// Base de datos propia (patrón de la suite de comida): las otras suites
// recrean el esquema entero en paralelo y ninguna puede compartir instancia.
const ACCESS_DB = 'casaclara_access_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
const HELPER_MEMBERSHIP = '11000000-0000-4000-8000-000000000004';
const VIEWER_MEMBERSHIP = '11000000-0000-4000-8000-000000000005';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };

const HELPER_EXPIRY = '2030-06-01T08:00:00.000Z';

function accessUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${ACCESS_DB}`;
  return url.toString();
}

// La siembra deja estados variados para que la vista los refleje: la persona
// de apoyo con caducidad futura y el visor ya revocado.
const ACCESS_SEED = `
BEGIN;
SET LOCAL row_security = off;
UPDATE app.household_memberships SET expires_at = '${HELPER_EXPIRY}' WHERE id = '${HELPER_MEMBERSHIP}';
UPDATE app.household_memberships SET revoked_at = statement_timestamp() WHERE id = '${VIEWER_MEMBERSHIP}';
COMMIT;
`;

describe.runIf(Boolean(adminUrl))('vista de accesos del hogar desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${ACCESS_DB} with (force)`);
      await cluster.query(`create database ${ACCESS_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: accessUrlFor(adminUrl as string) });
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
      await admin.query(ACCESS_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(accessUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('loadAccessOverview para la administradora trae las seis membresías con sus estados', async () => {
    const overview = await loadAccessOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    expect(overview!.householdId).toBe(FIXTURE_HOUSEHOLD);
    // Seis desde que el hogar de la fixture emplea a dos personas a la vez.
    expect(overview!.memberships).toHaveLength(6);

    const byId = new Map(overview!.memberships.map((member) => [member.id, member]));
    const admin = byId.get(ADMIN_MEMBERSHIP)!;
    expect(admin).toMatchObject({
      name: 'Fixture Admin Roble',
      role: 'family_admin',
      expiresAt: null,
      revokedAt: null,
      isSelf: true
    });
    expect(Date.parse(admin.startsAt)).not.toBeNaN();

    // La caducidad sembrada y la revocación llegan tal cual a la vista.
    const helper = byId.get(HELPER_MEMBERSHIP)!;
    expect(helper).toMatchObject({ role: 'helper', expiresAt: HELPER_EXPIRY, revokedAt: null, isSelf: false });
    const viewer = byId.get(VIEWER_MEMBERSHIP)!;
    expect(viewer.role).toBe('viewer');
    expect(viewer.revokedAt).not.toBeNull();

    // Solo la propia membresía va marcada como isSelf.
    expect(overview!.memberships.filter((member) => member.isSelf)).toHaveLength(1);
  });

  it('para la empleada devuelve null y la página de ajustes cae a la fixture', async () => {
    expect(await loadAccessOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });

  it('sin membresía en el hogar también devuelve null', async () => {
    expect(await loadAccessOverview({ id: 'fixture:olivo:admin' }, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });

  // La reposición de contraseñas se autoriza aquí, no en Better Auth: esta
  // función es la reja que decide de quién puede cambiarse la contraseña.
  describe('resolveMembershipIdentity (reposición de contraseña)', () => {
    it('la administradora obtiene la identidad de otra persona del hogar', async () => {
      const target = await resolveMembershipIdentity(ADMIN_USER, FIXTURE_HOUSEHOLD, EMPLOYEE_MEMBERSHIP, appPool);
      expect(target).toEqual({ userId: 'fixture:roble:employee', name: 'Fixture Empleada Roble' });
    });

    it('no devuelve nunca la propia membresía', async () => {
      expect(await resolveMembershipIdentity(ADMIN_USER, FIXTURE_HOUSEHOLD, ADMIN_MEMBERSHIP, appPool)).toBeNull();
    });

    it('una membresía ya revocada no se toca', async () => {
      expect(await resolveMembershipIdentity(ADMIN_USER, FIXTURE_HOUSEHOLD, VIEWER_MEMBERSHIP, appPool)).toBeNull();
    });

    it('quien no es family_admin no obtiene ninguna identidad', async () => {
      expect(await resolveMembershipIdentity(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, ADMIN_MEMBERSHIP, appPool)).toBeNull();
    });

    it('una administradora de otro hogar tampoco', async () => {
      expect(
        await resolveMembershipIdentity({ id: 'fixture:olivo:admin' }, FIXTURE_HOUSEHOLD, HELPER_MEMBERSHIP, appPool)
      ).toBeNull();
    });
  });
});
