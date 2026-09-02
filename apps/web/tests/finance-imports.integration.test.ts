import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { API_VERSION, type CommandEnvelopeV1 } from '@housekeeper/contracts';
import { financeCommandHandler, processSyncBatch, withAuthorizedTransaction } from '@housekeeper/server';

import { confirmImport, previewImport } from '../src/lib/server/finance-imports.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: 'postgres://prueba/afirmada' } }));

const APP_LOGIN = 'it_casa_clara_finance_login';
const FINANCE_DB = 'casaclara_finance_it';
const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const ADMIN = { id: 'fixture:roble:admin' };

// Extracto SINTÉTICO de OpenBank: HTML disfrazado de .xls, importes es-ES.
const OPENBANK_HTML = `<html>
<head><title>OPENBANK - Cuentas - Movimientos</title></head>
<body><table>
<tr><td>Número de cuenta:</td><td>ES21 0073 0100 5500 1234 5678</td></tr>
<tr><td>Fecha Operación</td><td>Fecha Valor</td><td>Concepto</td><td>Importe</td><td>Saldo</td></tr>
<tr><td>05/07/2026</td><td>05/07/2026</td><td>TRANSFERENCIA A FAVOR DE CLARA DEMO, CONCEPTO ALQUILER JULIO</td><td>-850,00</td><td>1.150,00</td></tr>
<tr><td>03/07/2026</td><td>03/07/2026</td><td>LIQUIDACION CUENTA INTERESES</td><td>1,23</td><td>2.000,00</td></tr>
</table></body></html>`;
const BYTES = new Uint8Array(Buffer.from(OPENBANK_HTML, 'latin1'));
const REF = 'ES2100730100550012345678';

const GRANT_SEED = `
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${FIXTURE_HOUSEHOLD}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${FIXTURE_HOUSEHOLD}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);
COMMIT;
`;

/** Misma URL del clúster, apuntando a la base propia de esta suite. */
function financeUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${FINANCE_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('ciclo importar → confirmar → deshacer sobre Postgres real', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let batchId: string;

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
      for (const fixture of (await readdir(fixturesDir)).filter((name) => name.endsWith('.sql')).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      await admin.query(GRANT_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: financeUrlFor(adminUrl as string), max: 2 });
    const url = new URL(financeUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it('previsualiza: banco detectado, 2 nuevas, cuenta desconocida', async () => {
    const preview = await previewImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', appPool);
    expect(preview.bank).toBe('openbank');
    expect(preview.newCount).toBe(2);
    expect(preview.dupCount).toBe(0);
    expect(preview.unknownRefs).toEqual([REF]);
    expect(preview.sample[0]?.amountCents).toBe('-85000');
  });

  it('confirma: crea la cuenta, el lote y las transacciones, y ejecuta el pipeline', async () => {
    const confirmed = await confirmImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', [
      { bankRef: REF, name: 'OpenBank IT', kind: 'comun', ownerLabel: 'familia' },
    ], appPool);
    expect(confirmed.newCount).toBe(2);
    expect(confirmed.batchId).not.toBeNull();
    const state = await withAuthorizedTransaction(appPool, { userId: ADMIN.id }, FIXTURE_HOUSEHOLD, async (client) => {
      const txs = await client.query(
        `select count(*)::int as n from app.finance_transactions where household_id = $1 and batch_id = $2`,
        [FIXTURE_HOUSEHOLD, confirmed.batchId],
      );
      return txs.rows[0].n as number;
    });
    expect(state).toBe(2);
    batchId = confirmed.batchId as string;
  });

  it('re-confirmar el mismo fichero es determinista: todo duplicado, sin lote nuevo', async () => {
    const again = await confirmImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', [], appPool);
    expect(again).toMatchObject({ batchId: null, newCount: 0, dupCount: 2 });
  });

  it('deshacer por comando con acuse deja la base como estaba', async () => {
    const envelope: CommandEnvelopeV1 = {
      apiVersion: API_VERSION, operationId: crypto.randomUUID(), householdId: FIXTURE_HOUSEHOLD,
      schemaVersion: 1, aggregateType: 'finance', aggregateId: null, baseRevision: null,
      occurredAt: new Date().toISOString(),
      payload: { kind: 'finance.import.undo', batchId },
    } as CommandEnvelopeV1;
    const result = await processSyncBatch(appPool, { userId: ADMIN.id }, [envelope], { finance: financeCommandHandler });
    expect(result.acknowledgements[0]).toMatchObject({ status: 'accepted' });
    const after = await previewImport(ADMIN, FIXTURE_HOUSEHOLD, BYTES, 'movimientos.xls', appPool);
    expect(after.newCount).toBe(2); // vuelven a ser nuevas
  });
});
