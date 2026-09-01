import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { financeAccessGranted } from '../src/lib/server/finance-access.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Comportamiento CON base configurada (producción): fixturesAllowed() = false.
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgres://prueba/afirmada' } }));

const APP_LOGIN = 'it_casa_clara_finance_login';
// Base propia (patrón de la suite de contactos): las suites vecinas recrean
// el esquema en paralelo y ninguna puede compartir instancia.
const FINANCE_DB = 'casaclara_finance_it';

const OLIVO_HOUSEHOLD = '20000000-0000-4000-8000-000000000001';
const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const OLIVO_ADMIN_USER = { id: 'fixture:olivo:admin' };

function financeUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${FINANCE_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('doble cerrojo de Finanzas leído por el layout', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${FINANCE_DB} with (force)`);
      await cluster.query(`create database ${FINANCE_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: financeUrlFor(adminUrl as string) });
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
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(financeUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('true SOLO para la administración con concesión viva; false para el resto', async () => {
    expect(await financeAccessGranted(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(true);
    expect(await financeAccessGranted(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    expect(await financeAccessGranted(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    // Admin de un hogar CON datos de finanzas pero SIN concesión: false.
    expect(await financeAccessGranted(OLIVO_ADMIN_USER, OLIVO_HOUSEHOLD, appPool)).toBe(false);
  });

  it('falla cerrado: sin membresía en el hogar la respuesta es false', async () => {
    expect(await financeAccessGranted({ id: 'fixture:olivo:admin' }, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
    expect(await financeAccessGranted({ id: 'nadie:desconocido' }, FIXTURE_HOUSEHOLD, appPool)).toBe(false);
  });
});
