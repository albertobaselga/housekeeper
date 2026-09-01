import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { financeAccessGranted } from '../src/lib/server/finance-access.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Comportamiento CON base configurada (producción): fixturesAllowed() = false.
// El objeto es VIVO porque `databaseConfigured()` lo consulta en cada llamada:
// la última prueba de abajo quita la DATABASE_URL para afirmar la rama de
// maqueta y la repone, sin reimportar nada.
const { fakeEnv } = vi.hoisted(() => ({
  fakeEnv: { DATABASE_URL: 'postgres://prueba/afirmada' } as Record<string, string | undefined>
}));
vi.mock('$env/dynamic/private', () => ({ env: fakeEnv }));

// La base y el rol de login son recursos del CLÚSTER, no del proceso: con
// nombres fijos, dos ejecuciones simultáneas (dos carriles de CI, o alguien
// en local mientras corre CI) se borraban la base la una a la otra a mitad.
// El pid las separa y el `afterAll` las retira en vez de acumularlas.
const RUN = process.pid;
const APP_LOGIN = `it_casa_clara_finance_login_${RUN}`;
// Base propia (patrón de la suite de contactos): las suites vecinas recrean
// el esquema en paralelo y ninguna puede compartir instancia.
const FINANCE_DB = `casaclara_finance_it_${RUN}`;

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

/**
 * Lo que pasa cuando NO se puede preguntar. Vive fuera del `runIf` a propósito:
 * el bloque de abajo entero se salta en el carril sin base, y la degradación es
 * justo lo que no puede quedarse sin defensa. Invertir el `catch` —que ante una
 * avería se conceda en vez de retirarse— abriría Finanzas de par en par a
 * cualquier administración el día que la base tosiera, y hasta ahora eso pasaba
 * en verde.
 *
 * Ninguna de las tres necesita Postgres: una no tiene pool, otra apunta a un
 * puerto muerto y la tercera usa un pool de mentira que no devuelve membresía.
 */
describe('sin poder preguntar por la concesión, Finanzas se retira', () => {
  /**
   * Llama al ayudante y recoge, además de la respuesta, lo que escribió en el
   * registro: la diferencia entre «no te toca» (silencio: es una respuesta
   * legítima) y «no hemos podido leer» (una línea con su código) es parte del
   * comportamiento, no un detalle de implementación.
   */
  async function ask(pool: pg.Pool | null): Promise<{ granted: boolean; logs: string[] }> {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const granted = await financeAccessGranted(ADMIN_USER, FIXTURE_HOUSEHOLD, pool);
      const logs = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes('"scope":"web:finance-access"'));
      return { granted, logs };
    } finally {
      stderr.mockRestore();
    }
  }

  it('sin pool y con base configurada: false, y no es avería que registrar', async () => {
    const { granted, logs } = await ask(null);
    expect(granted).toBe(false);
    expect(logs).toEqual([]);
  });

  it('con la base caída: false, y queda registrado con su código', async () => {
    // Puerto 1: reservado y sin nadie escuchando, así que la conexión se
    // rechaza en el acto. Nunca el 5439 (la base de trabajo) ni el 54329.
    const dead = new pg.Pool({
      connectionString: 'postgresql://nadie:nada@127.0.0.1:1/casaclara_no_existe',
      connectionTimeoutMillis: 2_000
    });
    try {
      const { granted, logs } = await ask(dead);
      expect(granted).toBe(false);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('finance access check unavailable');
    } finally {
      await dead.end();
    }
  });

  it('sin membresía viva: false en silencio, que no es lo mismo que una avería', async () => {
    // Pool de mentira que responde sin filas: es lo que ve
    // `withAuthorizedTransaction` cuando la membresía no existe, está revocada
    // o ha caducado, y lo que lanza su AuthorizationError.
    const rowless = {
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined })
    } as unknown as pg.Pool;
    const { granted, logs } = await ask(rowless);
    expect(granted).toBe(false);
    expect(logs).toEqual([]);
  });

  it('sin base de datos (demo por fixtures) el módulo sí se enseña', async () => {
    // La otra mitad de la decisión, congelada aquí para que no se caiga sola:
    // sin DATABASE_URL no hay hogar real, ni concesiones, ni movimientos —y no
    // hay nadie dentro salvo en el paquete sintético—, así que la maqueta
    // enseña Finanzas como enseña el resto. Las suites e2e y a11y cuentan con
    // esto (plan de la fase, aviso a la Task 10).
    delete fakeEnv.DATABASE_URL;
    try {
      const { granted } = await ask(null);
      expect(granted).toBe(true);
    } finally {
      fakeEnv.DATABASE_URL = 'postgres://prueba/afirmada';
    }
  });
});

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
    // Se retiran los dos recursos del clúster que creó el beforeAll. Sin esto
    // quedaría una base y un rol por ejecución, que es justo lo que ya duele
    // en este clúster compartido.
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${FINANCE_DB} with (force)`);
      await cluster.query(`drop role if exists ${APP_LOGIN}`);
    } finally {
      await cluster.end();
    }
  }, 30_000);

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
