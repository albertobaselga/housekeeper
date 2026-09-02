import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { REVISION_PAGE_SIZE, loadFinanceRevision } from '../src/lib/server/finance.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

/**
 * [FASE 5 · despacho de cierre, F5-I1 / Ruling R37] La bandeja de Revisión no
 * acotaba nada: ni el SQL, ni el render, ni el tope de 500 ids del comando en
 * bloque. Con los 675 pendientes del hogar real, «✓ Confirmar N sugerencias»
 * se rechazaba SIEMPRE con `invalid_payload`. El loader pagina ahora a
 * `REVISION_PAGE_SIZE` y devuelve `totalPending` (el conteo completo del mismo
 * `where`) para que la pantalla pueda decir cuántos quedan.
 *
 * Base propia por ejecución (patrón de `finance-access.integration.test.ts`):
 * el clúster es compartido y dos carriles simultáneos se borrarían la base el
 * uno al otro con un nombre fijo.
 */
const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgres://prueba/afirmada' } }));

const RUN = process.pid;
const APP_LOGIN = `it_finance_revision_login_${RUN}`;
const REVISION_DB = `casaclara_finance_revision_it_${RUN}`;

const ADMIN = { id: 'fixture:roble:admin' };
const ACCOUNT = 'f1a00000-0000-4000-8000-000000000001';
// Marzo de 2026: fuera del rango del único pendiente que traen las fixtures
// (25/01/2026), para que `totalPending` sea exactamente lo que siembra este
// fichero y la aserción no dependa de datos ajenos.
const RANGE = { from: '2026-03-01', to: '2026-03-31' };
const PENDING = REVISION_PAGE_SIZE + 1;

/** Misma URL del clúster, apuntando a la base propia de esta suite. */
function revisionUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${REVISION_DB}`;
  return url.toString();
}

/**
 * Conexión de mantenimiento: `drop database` no puede ejecutarse desde la base
 * que se está borrando, y la base asignada a esta ola (`casaclara_finance_it`)
 * es una base de trabajo cualquiera del clúster. `postgres` existe siempre.
 */
function maintenanceUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = '/postgres';
  return url.toString();
}

describe.runIf(adminUrl !== '')('Revisión acotada a una página sobre Postgres real', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: maintenanceUrlFor(adminUrl) });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${REVISION_DB} with (force)`);
      await cluster.query(`create database ${REVISION_DB}`);
    } finally {
      await cluster.end();
    }

    const owner = new pg.Client({ connectionString: revisionUrlFor(adminUrl) });
    await owner.connect();
    try {
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(owner);
      const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((name) => name.endsWith('.sql')).sort()) {
        await owner.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      // 201 pendientes en el rango, repartidos por días distintos para que el
      // `order by op_date desc` tenga algo que ordenar.
      // Sentencia parametrizada: `pg` no admite varias órdenes en la misma
      // consulta preparada, así que la transacción va por separado.
      await owner.query('begin');
      await owner.query('set local row_security = off');
      await owner.query(
        `insert into app.finance_transactions
           (household_id, account_id, op_date, concept, provider, provider_norm,
            amount_cents, status, dedup_hash, raw, currency_code)
         select $1, $2, date '2026-03-01' + (n % 28), 'PENDIENTE IT ' || n,
                'PROVEEDOR IT', 'proveedor it', -100 - n, 'pendiente',
                'it-revision-' || n, '{}'::jsonb, 'EUR'
           from generate_series(1, $3::int) as n`,
        [FIXTURE_HOUSEHOLD, ACCOUNT, PENDING]
      );
      await owner.query('commit');
      await owner.query(`drop role if exists ${APP_LOGIN}`);
      await owner.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await owner.end();
    }

    const url = new URL(revisionUrlFor(adminUrl));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    const cluster = new pg.Client({ connectionString: maintenanceUrlFor(adminUrl) });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${REVISION_DB} with (force)`);
      await cluster.query(`drop role if exists ${APP_LOGIN}`);
    } finally {
      await cluster.end();
    }
  }, 120_000);

  it('con 201 pendientes devuelve 200 filas y dice que hay 201', async () => {
    const revision = await loadFinanceRevision(ADMIN, FIXTURE_HOUSEHOLD, RANGE, appPool);
    if (!revision) throw new Error('el loader devolvió null con el admin con concesión');
    expect(revision.rows).toHaveLength(REVISION_PAGE_SIZE);
    expect(revision.totalPending).toBe(PENDING);
    // La página es la MÁS RECIENTE, no una cualquiera: el orden del SQL manda.
    const fechas = revision.rows.map((row) => row.opDate);
    expect([...fechas].sort().reverse()).toEqual(fechas);
    expect(fechas[0]).toBe('2026-03-28');
  });

  it('el conteo usa el mismo rango que las filas: fuera de él no hay nada que revisar', async () => {
    const vacio = await loadFinanceRevision(ADMIN, FIXTURE_HOUSEHOLD, { from: '2026-05-01', to: '2026-05-31' }, appPool);
    expect(vacio?.rows).toEqual([]);
    expect(vacio?.totalPending).toBe(0);
  });

  it('cuando caben todos, `totalPending` coincide con las filas y la pantalla no avisa de nada', async () => {
    // El único pendiente de las fixtures (25/01/2026): el aviso de la pantalla
    // se dispara con `totalPending > rows.length`, así que este caso lo apaga.
    const enero = await loadFinanceRevision(ADMIN, FIXTURE_HOUSEHOLD, { from: '2026-01-01', to: '2026-01-31' }, appPool);
    expect(enero?.totalPending).toBe(enero?.rows.length);
    expect(enero?.totalPending).toBe(1);
  });
});
