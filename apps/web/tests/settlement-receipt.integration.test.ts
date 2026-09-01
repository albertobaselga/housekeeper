import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadEmploymentOverview, loadSettlementReceipt } from '../src/lib/server/employment.server';
import { GET } from '../src/routes/api/v1/households/[householdId]/settlements/[settlementId]/receipt/+server';
import { FIXTURE_HOUSEHOLD } from './helpers';

/**
 * La ruta lee su pool de `$env/dynamic/private` (`getDatabasePool`), así que
 * para llamar a `GET` de verdad (y no solo a `loadSettlementReceipt`) hace
 * falta decirle dónde está esta base — mismo patrón que
 * `ics-feed.integration.test.ts`. Las variables `S3_*` describen un almacén
 * DISTINTO del bucket sembrado (`fixture-documents`, ver `RECEIPT_SEED` más
 * abajo): son solo configuración, `createS3Backend` no llega a conectar nada
 * hasta que se lee un objeto, y aquí el 503 por bucket equivocado corta antes.
 */
const RECEIPT_ROUTE_DATABASE_URL = vi.hoisted(() => {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) return '';
  const url = new URL(base);
  url.pathname = '/housekeeper_off_settlement_receipt_it';
  url.username = 'it_housekeeper_settlement_receipt_login';
  url.password = 'integration-only';
  return url.toString();
});
vi.mock('$env/dynamic/private', () => ({
  env: {
    DATABASE_URL: RECEIPT_ROUTE_DATABASE_URL,
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_PRIVATE_BUCKET: 'otro-almacen',
    S3_ACCESS_KEY_ID: 'fixture',
    S3_SECRET_ACCESS_KEY: 'fixture'
  }
}));

// Frente E: el recibo PDF registrado (migración 0035) y descargable desde
// `GET /api/v1/households/{householdId}/settlements/{id}/receipt`. Calcado de
// receipts.integration.test.ts (Ola D-3): solo lectura, y quien decide el
// acceso es RLS (`settlement_receipts_read`, calcada de `settlements_read`),
// no este código.
//
// El worker registra vía `app_private.record_settlement_receipt` (probada en
// `packages/db/tests/190_settlement_receipts.sql`); aquí solo se comprueba el
// lado de LECTURA de la web, que es lo que este paquete puede ejercitar.

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_settlement_receipt_login';
const RECEIPT_DB = 'housekeeper_off_settlement_receipt_it';

/** Liquidación de marzo de 2025 de la fixture, ya cerrada (empleada …0003). */
const SETTLEMENT_WITH_RECEIPT = '12b00000-0000-4000-8000-000000000001';
const STORAGE_OBJECT = 'fd000000-0000-4000-8000-000000000001';
const DOCUMENT = 'fd000000-0000-4000-8000-000000000002';
/**
 * Segunda liquidación, sembrada por este fichero, cerrada pero SIN recibo
 * registrado: el hueco real entre «se cerró» (encola `document.render_receipt`)
 * y «el PDF ya quedó registrado» (lo hace el worker al procesar la cola).
 */
const SETTLEMENT_WITHOUT_RECEIPT = 'fd100000-0000-4000-8000-000000000001';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const FAMILY_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const OTHER_EMPLOYEE_USER = { id: 'fixture:roble:employee2' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };
const OTHER_HOUSEHOLD_USER = { id: 'fixture:olivo:admin' };

function receiptDbUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${RECEIPT_DB}`;
  return url.toString();
}

// Registro directo, sin pasar por app_private.record_settlement_receipt (esa
// función la ejercita la suite SQL): aquí solo hace falta que exista la fila
// que la web tiene que leer.
const RECEIPT_SEED = `
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.settlements (
  id, household_id, agreement_id, employee_membership_id, period_start, period_end,
  due_on, status, created_by_membership_id, closed_by_membership_id, closed_at, snapshot_hash
) VALUES (
  '${SETTLEMENT_WITHOUT_RECEIPT}', '${FIXTURE_HOUSEHOLD}', '12000000-0000-4000-8000-000000000001',
  '11000000-0000-4000-8000-000000000003', '2025-04-01', '2025-04-30', '2025-04-30', 'closed',
  '11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001',
  '2025-04-30T18:00:00Z', repeat('8', 64)
);
INSERT INTO app.storage_objects (
  id, household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id
) VALUES (
  '${STORAGE_OBJECT}', '${FIXTURE_HOUSEHOLD}', 'fixture-documents',
  'fixture/casa-roble/receipt-2025-03.pdf', 'application/pdf', 4096, repeat('7', 64),
  '11000000-0000-4000-8000-000000000001'
);
INSERT INTO app.documents (
  id, household_id, storage_object_id, owner_membership_id, visibility, document_type, title,
  created_by_membership_id
) VALUES (
  '${DOCUMENT}', '${FIXTURE_HOUSEHOLD}', '${STORAGE_OBJECT}', '11000000-0000-4000-8000-000000000003',
  'employment', 'settlement_receipt', 'Recibo 2025-03', '11000000-0000-4000-8000-000000000001'
);
INSERT INTO app.settlement_receipts (
  settlement_id, household_id, document_id, bucket, object_key, sha256, byte_size
) VALUES (
  '${SETTLEMENT_WITH_RECEIPT}', '${FIXTURE_HOUSEHOLD}', '${DOCUMENT}', 'fixture-documents',
  'fixture/casa-roble/receipt-2025-03.pdf', repeat('7', 64), 4096
);
COMMIT;
`;

describe.runIf(Boolean(adminUrl))('recibo PDF visible en la liquidación cerrada', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${RECEIPT_DB} with (force)`);
      await cluster.query(`create database ${RECEIPT_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: receiptDbUrlFor(adminUrl as string) });
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
      await admin.query(RECEIPT_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(receiptDbUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la familia administradora y la empleada del contrato llegan al recibo', async () => {
    for (const user of [ADMIN_USER, EMPLOYEE_USER]) {
      const receipt = await loadSettlementReceipt(user, FIXTURE_HOUSEHOLD, SETTLEMENT_WITH_RECEIPT, appPool);
      expect(receipt, user.id).not.toBeNull();
      expect(receipt!).toMatchObject({
        documentId: DOCUMENT,
        bucket: 'fixture-documents',
        objectKey: 'fixture/casa-roble/receipt-2025-03.pdf',
        mediaType: 'application/pdf',
        period: '2025-03'
      });
    }
  });

  it('nadie más llega al recibo: otra empleada, family_member, helper, viewer, ni el otro hogar', async () => {
    for (const user of [OTHER_EMPLOYEE_USER, FAMILY_USER, HELPER_USER, VIEWER_USER, OTHER_HOUSEHOLD_USER]) {
      expect(
        await loadSettlementReceipt(user, FIXTURE_HOUSEHOLD, SETTLEMENT_WITH_RECEIPT, appPool),
        user.id
      ).toBeNull();
    }
  });

  it('una liquidación cerrada sin recibo registrado (aún generándose) devuelve null, no un error', async () => {
    expect(
      await loadSettlementReceipt(ADMIN_USER, FIXTURE_HOUSEHOLD, SETTLEMENT_WITHOUT_RECEIPT, appPool)
    ).toBeNull();
  });

  it('la cuenta cerrada marca el recibo como disponible en el resumen del expediente', async () => {
    const overview = await loadEmploymentOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    const march = overview!.settlements.find((settlement) => settlement.periodStart === '2025-03-01');
    expect(march).toBeDefined();
    expect(march!.receiptDocumentAvailable).toBe(true);

    const april = overview!.settlements.find((settlement) => settlement.periodStart === '2025-04-01');
    expect(april).toBeDefined();
    expect(april!.receiptDocumentAvailable).toBe(false);
  });

  it('sin pool (demo) no hay recibo que enseñar', async () => {
    expect(await loadSettlementReceipt(ADMIN_USER, FIXTURE_HOUSEHOLD, SETTLEMENT_WITH_RECEIPT, null)).toBeNull();
  });

  // La ruta, llamada de verdad (no solo `loadSettlementReceipt`): el bucket
  // registrado en la fila (`fixture-documents`, ver RECEIPT_SEED) no coincide
  // con el `S3_PRIVATE_BUCKET` con el que este proceso mockeó `$env/dynamic/private`
  // (`otro-almacen`). Antes de leer nada del almacén, la ruta debe pararse en
  // 503 y decir con qué almacén está registrado el recibo y de cuál lee esta
  // instalación — nunca un 404 (eso mentiría: el recibo SÍ está registrado) ni
  // un intento de lectura contra un endpoint S3 inexistente.
  it('el bucket registrado no coincide con el del almacén desplegado: 503 que nombra los dos', async () => {
    const event = {
      locals: {
        user: {
          id: ADMIN_USER.id,
          name: '',
          initials: '',
          email: '',
          memberships: [{ householdId: FIXTURE_HOUSEHOLD, membershipId: 'fixture-membership', role: 'family_admin' }],
          mustChangePassword: false
        }
      },
      params: { householdId: FIXTURE_HOUSEHOLD, settlementId: SETTLEMENT_WITH_RECEIPT },
      setHeaders: () => {}
    };

    type FakeReceiptEvent = typeof event;
    await expect(
      (GET as unknown as (fakeEvent: FakeReceiptEvent) => Promise<Response>)(event)
    ).rejects.toMatchObject({
      status: 503,
      body: { message: expect.stringContaining('fixture-documents') }
    });
  });
});
