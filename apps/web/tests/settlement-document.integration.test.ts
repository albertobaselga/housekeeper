import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSettlementDocument } from '../src/lib/server/settlement-document.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_doc_login';
// Base de datos propia (patrón de la suite de exportación): las otras suites
// recrean el esquema entero en paralelo y ninguna puede compartir instancia.
const DOC_DB = 'casaclara_settlement_doc_it';

const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const ADMIN_USER = { id: 'fixture:roble:admin' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const OLIVO_EMPLOYEE_USER = { id: 'fixture:olivo:employee' };

/** La cuenta de marzo de 2025 de la fixture compartida, cerrada y pagada. */
const MARCH_SETTLEMENT = '12b00000-0000-4000-8000-000000000001';

const GENERATED_AT = new Date('2026-08-07T10:00:00.000Z');

function docUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${DOC_DB}`;
  return url.toString();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * El texto que un PDF de pdf-lib enseña de verdad (mismo lector que la suite
 * de exportación): se inflan los flujos Flate y se decodifican las cadenas
 * hexadecimales de `Tj`, para afirmar sobre el documento y no sobre sus bytes.
 */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = raw.indexOf('stream', cursor);
    if (start === -1) break;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    cursor = end + 'endstream'.length;
    let from = start + 'stream'.length;
    if (raw[from] === 0x0d) from += 1;
    if (raw[from] === 0x0a) from += 1;
    try {
      pieces.push(inflateSync(raw.subarray(from, end)).toString('latin1'));
    } catch {
      // Un flujo que no es Flate (una fuente incrustada, por ejemplo): se salta.
    }
  }
  const content = pieces.join('\n');
  const shown: string[] = [];
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
    shown.push(Buffer.from(match[1]!.replace(/\s+/g, ''), 'hex').toString('latin1'));
  }
  for (const match of content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    shown.push(match[1]!.replace(/\\([()\\])/g, '$1'));
  }
  return shown.join('\n');
}

describe.runIf(Boolean(adminUrl))('documento de pago por liquidación bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${DOC_DB} with (force)`);
      await cluster.query(`create database ${DOC_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: docUrlFor(adminUrl as string) });
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
      // Un pago ANULADO sembrado a propósito: el documento no puede imprimirlo
      // como pago real mientras los totales (que salen de la vista filtrada)
      // lo excluyen — serían filas que no suman lo que el propio papel dice.
      await admin.query('begin');
      await admin.query('set local row_security = off');
      await admin.query(
        `insert into app.payments
           (id, household_id, settlement_id, employee_membership_id, amount_cents,
            method, status, value_on, reference, recorded_by_membership_id, recorded_at,
            voided_by_membership_id, voided_at, void_reason)
         values
           ('12d00000-0000-4000-8000-00000000000f', $1, $2,
            '11000000-0000-4000-8000-000000000003', 50000,
            'bank_transfer', 'voided', '2025-03-30', 'ANULADO-IT',
            '11000000-0000-4000-8000-000000000001', '2025-03-30T10:00:00Z',
            '11000000-0000-4000-8000-000000000001', '2025-03-30T11:00:00Z',
            'Referencia equivocada (siembra IT)')`,
        [FIXTURE_HOUSEHOLD, MARCH_SETTLEMENT]
      );
      await admin.query('commit');
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(docUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la administración descarga el documento con TODOS los conceptos, los pagos y el cobro', async () => {
    const document = await buildSettlementDocument(
      ADMIN_USER,
      FIXTURE_HOUSEHOLD,
      MARCH_SETTLEMENT,
      appPool,
      GENERATED_AT
    );
    expect(document).not.toBeNull();
    expect(document!.filename).toBe('pago-2025-03.pdf');
    expect(String.fromCharCode(...document!.pdf.subarray(0, 5))).toBe('%PDF-');

    const text = pdfText(document!.pdf);
    // Todos los conceptos: los que suman, el que resta y los reembolsos.
    expect(text).toContain('Fixture base salary');
    expect(text).toContain('Fixture worked rest day');
    expect(text).toContain('Fixture advance installment');
    expect(text).toContain('-100,00 EUR');
    expect(text).toContain('Fixture pharmacy reimbursement');
    expect(text).toContain('Fixture grocery reimbursement');
    // Totales congelados y estado del pago.
    expect(text).toContain('1.453,30 EUR');
    expect(text).toContain('Transferencia');
    expect(text).toContain('Fixture part one');
    expect(text).toContain('Fixture part two');
    // El pago anulado NO sale: imprimirlo como real contradiría los totales,
    // que la vista de pagos ya excluye.
    expect(text).not.toContain('ANULADO-IT');
    expect(text).toContain('cobro confirmado');
    // El instante de generación va entero y con su Z: una fecha pelada
    // mentiría un día a cada lado de la medianoche de Madrid.
    expect(text).toContain('generado 2026-08-07T10:00:00.000Z');
    // La marca de siempre: esto no es un recibo oficial.
    expect(text).toContain('Documento dom');
  });

  it('la propia empleada también puede descargarlo, y los bytes son deterministas', async () => {
    const first = await buildSettlementDocument(
      EMPLOYEE_USER,
      FIXTURE_HOUSEHOLD,
      MARCH_SETTLEMENT,
      appPool,
      GENERATED_AT
    );
    const second = await buildSettlementDocument(
      EMPLOYEE_USER,
      FIXTURE_HOUSEHOLD,
      MARCH_SETTLEMENT,
      appPool,
      GENERATED_AT
    );
    expect(first).not.toBeNull();
    expect(sha256(first!.pdf)).toBe(sha256(second!.pdf));
  });

  it('quien la RLS no deja leer recibe null: apoyo del hogar y otra casa', async () => {
    // El apoyo no ve liquidaciones: null, sin distinguir «no existe» de «no te toca».
    await expect(
      buildSettlementDocument(HELPER_USER, FIXTURE_HOUSEHOLD, MARCH_SETTLEMENT, appPool, GENERATED_AT)
    ).resolves.toBeNull();
    // Y una empleada de OTRA casa tampoco llega a la cuenta de esta.
    await expect(
      buildSettlementDocument(
        OLIVO_EMPLOYEE_USER,
        FIXTURE_HOUSEHOLD,
        MARCH_SETTLEMENT,
        appPool,
        GENERATED_AT
      )
    ).resolves.toBeNull();
  });
});
