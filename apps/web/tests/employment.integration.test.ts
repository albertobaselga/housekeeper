import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEmploymentOverview } from '../src/lib/server/employment.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_web_login';
const MARCH_SETTLEMENT = '12b00000-0000-4000-8000-000000000001';

describe.runIf(Boolean(adminUrl))('expediente laboral desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    // Igual que packages/server/test-support/global-setup.mjs, pero local a esta
    // suite: esquema limpio, migraciones, fixtures y un login sin BYPASSRLS.
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query('drop schema if exists app cascade');
      await admin.query('drop schema if exists app_private cascade');
      await admin.query('drop table if exists public.schema_migrations');
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

    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la empleada ve liquidación de marzo pagada y confirmada, crédito permanente y anticipo pendiente', async () => {
    const overview = await loadEmploymentOverview(
      { id: 'fixture:roble:employee' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );

    expect(overview).not.toBeNull();
    expect(overview!.hasEmploymentData).toBe(true);
    expect(overview!.agreement?.status).toBe('active');

    // Liquidación cerrada de marzo: transfer 145330, 8 líneas trazables,
    // pagada al completo (vista settlement_payment_totals) y cobro confirmado.
    const march = overview!.settlements.find((settlement) => settlement.id === MARCH_SETTLEMENT);
    expect(march).toBeDefined();
    expect(march!.status).toBe('closed');
    expect(march!.transferTotalCents).toBe('145330');
    expect(march!.transferTotalLabel).toBe('1.453,30 €');
    expect(march!.paidCents).toBe('145330');
    expect(march!.pendingCents).toBe('0');
    expect(march!.fullyPaid).toBe(true);
    expect(march!.receiptConfirmed).toBe(true);
    expect(march!.paymentStateLabel).toBe('Pagada y cobro confirmado');
    expect(march!.lines).toHaveLength(8);
    expect(march!.payments.map((payment) => payment.amountCents)).toEqual(['80000', '65330']);
    const baseLine = march!.lines.find((line) => line.kind === 'base_salary');
    expect(baseLine?.href).toBe('#version-12100000-0000-4000-8000-000000000001');
    const advanceLine = march!.lines.find((line) => line.kind === 'advance_deduction');
    expect(advanceLine?.amountCents).toBe('-10000');
    expect(advanceLine?.href).toBe('#anticipo-12800000-0000-4000-8000-000000000001');

    // Saldos: crédito permanente de 1440 min (sin caducidad) y 200,00 € de anticipo.
    const credit = overview!.balances.compensation.find(
      (balance) => balance.balanceType === 'worked_rest_day'
    );
    expect(credit?.balanceMinutes).toBe('1440');
    expect(credit?.minutesLabel).toBe('1 día');
    expect(credit?.permanent).toBe(true);
    const advance = overview!.balances.advances[0];
    expect(advance?.outstandingCents).toBe('20000');

    // Versiones con diff de salario: v2 vigente en 2026-08, +100,00 €.
    expect(overview!.versions.map((version) => version.state)).toEqual(['historica', 'vigente']);
    expect(overview!.versions[1]!.salaryDiffCents).toBe('10000');

    // Devengo proyectado del periodo en curso: salario vigente 1.500,00 € menos
    // la cuota del anticipo aún vivo; los gastos de marzo ya liquidados no se
    // vuelven a reembolsar.
    expect(overview!.accrual).not.toBeNull();
    expect(overview!.accrual!.period).toBe('2026-08');
    expect(overview!.accrual!.agreementVersionId).toBe('12100000-0000-4000-8000-000000000002');
    expect(overview!.accrual!.salaryCents).toBe('140000');
    expect(overview!.accrual!.reimbursementCents).toBe('0');
    expect(overview!.accrual!.transferTotalCents).toBe('140000');
    const kinds = overview!.accrual!.lines.map((line) => line.kind);
    expect(kinds).toEqual(['base_salary', 'advance_deduction']);
  });

  it('el rol helper no ve datos laborales y el modelo degrada limpiamente', async () => {
    const overview = await loadEmploymentOverview(
      { id: 'fixture:roble:helper' },
      FIXTURE_HOUSEHOLD,
      appPool,
      new Date('2026-08-07T10:00:00Z')
    );
    expect(overview).not.toBeNull();
    expect(overview!.hasEmploymentData).toBe(false);
    expect(overview!.agreement).toBeNull();
    expect(overview!.versions).toEqual([]);
    expect(overview!.accrual).toBeNull();
    expect(overview!.settlements).toEqual([]);
    expect(overview!.balances).toEqual({ compensation: [], advances: [] });
  });

  it('un usuario sin membresía en el hogar recibe null y la página cae a la fixture', async () => {
    const overview = await loadEmploymentOverview(
      { id: 'fixture:olivo:employee' },
      FIXTURE_HOUSEHOLD,
      appPool
    );
    expect(overview).toBeNull();
  });
});
