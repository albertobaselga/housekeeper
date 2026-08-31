import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pickHousehold } from '../src/lib/auth/routing';
import { resolveAppUser } from '../src/lib/server/app-user.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

// De dónde sale el nombre que anuncian la cabecera y la pestaña, y a qué hogar
// sigue cuando hay más de uno. Las fixtures traen dos casas; aquí se le da a la
// administradora de la primera una membresía viva en la segunda para que el
// caso multi-hogar exista de verdad contra Postgres.
//
// Vivía en `app-user.integration.test.ts` hasta que esa misma ruta estrenó una
// batería propia sobre el PAPEL por hogar. Son dos preguntas distintas sobre la
// misma función —cómo se llama la casa que miras, y qué eres tú en ella—, cada
// una con su base y su semilla, así que viven en ficheros separados y corren en
// paralelo en vez de turnarse.

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_identity_login';
const IDENTITY_DB = 'housekeeper_identity_it';

const SECOND_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const ADMIN_USER = 'fixture:roble:admin';
const OLIVO_EMPLOYEE = 'fixture:olivo:employee';

const SECOND_MEMBERSHIP = `
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('31000000-0000-4000-8000-000000000001', '${SECOND_HOUSEHOLD}', '${ADMIN_USER}', 'family_member');
COMMIT;
`;

function identityUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${IDENTITY_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('el nombre del hogar sale de la base de datos y sigue a la URL', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${IDENTITY_DB} with (force)`);
      await cluster.query(`create database ${IDENTITY_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: identityUrlFor(adminUrl as string) });
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
      await admin.query(SECOND_MEMBERSHIP);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(identityUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('cada hogar viaja con el nombre que tiene en app.households', async () => {
    const user = await resolveAppUser(ADMIN_USER, 'admin@ejemplo.test', 'Sin nombre', appPool);
    expect(user).not.toBeNull();
    expect(user!.households?.map((household) => household.name)).toEqual([
      'Fixture Casa Roble',
      'Fixture Casa Olivo'
    ]);
  });

  it('quien pertenece a dos casas ve la de la URL, no la primera', async () => {
    const user = await resolveAppUser(ADMIN_USER, 'admin@ejemplo.test', 'Sin nombre', appPool);
    // Este es el paso exacto que da el layout de /h/[householdId].
    expect(pickHousehold(user!.households, FIXTURE_HOUSEHOLD)?.name).toBe('Fixture Casa Roble');
    expect(pickHousehold(user!.households, SECOND_HOUSEHOLD)?.name).toBe('Fixture Casa Olivo');
    // Y una casa ajena no le presta su nombre: el layout responde 404.
    expect(pickHousehold(user!.households, '99999999-0000-4000-8000-000000000001')).toBeNull();
  });

  it('quien solo pertenece a una casa solo ve la suya', async () => {
    const user = await resolveAppUser(OLIVO_EMPLOYEE, 'empleada@ejemplo.test', 'Sin nombre', appPool);
    expect(user!.households?.map((household) => household.name)).toEqual(['Fixture Casa Olivo']);
    expect(pickHousehold(user!.households, FIXTURE_HOUSEHOLD)).toBeNull();
  });
});
