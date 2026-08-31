import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEmploymentOverview } from '../src/lib/server/employment.server';
import { loadExpenseReceipt } from '../src/lib/server/receipts.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

// Ola D-3: en la cuenta del mes ya pagada, el gasto reembolsado enseña el
// enlace a su justificante. Solo lectura y solo para quien ya ve la cuenta:
// quien decide es RLS, no este código.

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_receipts_login';
const RECEIPTS_DB = 'housekeeper_off_receipts_it';

/** Gasto de farmacia de la fixture, ya reembolsado en la cuenta de marzo. */
const EXPENSE_WITH_RECEIPT = '12a00000-0000-4000-8000-000000000001';
/** Gasto de compra de la fixture, reembolsado pero SIN foto. */
const EXPENSE_WITHOUT_RECEIPT = '12a00000-0000-4000-8000-000000000002';
const DOCUMENT = '12f00000-0000-4000-8000-000000000002';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };

function receiptsUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${RECEIPTS_DB}`;
  return url.toString();
}

// La fixture ya trae el documento y su objeto de almacenamiento; aquí solo se
// enlaza con el gasto de farmacia, como haría el comando del gasto con foto.
const RECEIPTS_SEED = `
BEGIN;
SET LOCAL row_security = off;
UPDATE app.expenses SET receipt_document_id = '${DOCUMENT}' WHERE id = '${EXPENSE_WITH_RECEIPT}';
COMMIT;
`;

describe.runIf(Boolean(adminUrl))('justificante visible en la cuenta del mes cerrada', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${RECEIPTS_DB} with (force)`);
      await cluster.query(`create database ${RECEIPTS_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: receiptsUrlFor(adminUrl as string) });
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
      await admin.query(RECEIPTS_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(receiptsUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la familia y la empleada llegan al justificante del gasto reembolsado', async () => {
    for (const user of [ADMIN_USER, FAMILY_USER, EMPLOYEE_USER]) {
      const receipt = await loadExpenseReceipt(user, FIXTURE_HOUSEHOLD, EXPENSE_WITH_RECEIPT, appPool);
      expect(receipt, user.id).not.toBeNull();
      expect(receipt!).toMatchObject({
        documentId: DOCUMENT,
        bucket: 'fixture-documents',
        objectKey: 'fixture/casa-roble/receipt.txt',
        mediaType: 'text/plain'
      });
    }
  });

  it('quien no ve la cuenta tampoco ve el justificante', async () => {
    for (const user of [HELPER_USER, VIEWER_USER, { id: 'fixture:otro:usuario' }]) {
      expect(
        await loadExpenseReceipt(user, FIXTURE_HOUSEHOLD, EXPENSE_WITH_RECEIPT, appPool),
        user.id
      ).toBeNull();
    }
  });

  it('un gasto aprobado sin foto no ofrece justificante', async () => {
    expect(
      await loadExpenseReceipt(ADMIN_USER, FIXTURE_HOUSEHOLD, EXPENSE_WITHOUT_RECEIPT, appPool)
    ).toBeNull();
  });

  it('la cuenta cerrada marca SOLO la línea del gasto que tiene justificante', async () => {
    const overview = await loadEmploymentOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    const march = overview!.settlements.find((settlement) => settlement.periodStart === '2025-03-01');
    expect(march).toBeDefined();
    expect(march!.fullyPaid).toBe(true);
    const withReceipt = march!.lines.filter((line) => line.receiptExpenseId !== null);
    expect(withReceipt.map((line) => line.concept)).toEqual(['Fixture pharmacy reimbursement']);
    expect(withReceipt[0]!.receiptExpenseId).toBe(EXPENSE_WITH_RECEIPT);
  });

  it('sin pool (demo) no hay justificante que enseñar', async () => {
    expect(await loadExpenseReceipt(ADMIN_USER, FIXTURE_HOUSEHOLD, EXPENSE_WITH_RECEIPT, null)).toBeNull();
  });
});
