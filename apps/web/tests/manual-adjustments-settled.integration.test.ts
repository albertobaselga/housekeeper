import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEmploymentOverview } from '../src/lib/server/employment.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_ajustes_login';
// Base propia (patrón de las suites de exportación y documento): las demás
// recrean el esquema entero en paralelo y ninguna puede compartir instancia.
const AJUSTES_DB = 'casaclara_ajustes_it';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const AGREEMENT = '12000000-0000-4000-8000-000000000001';
const EMPLOYEE_M = '11000000-0000-4000-8000-000000000003';
const ADMIN_M = '11000000-0000-4000-8000-000000000001';

function dbUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${AJUSTES_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('conceptos a mano ya aplicados en una nómina, bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${AJUSTES_DB} with (force)`);
      await cluster.query(`create database ${AJUSTES_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: dbUrlFor(adminUrl as string) });
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

      // El caso del parte del propietario, por el camino legal: un adelanto
      // imputado a julio, la nómina de julio abierta, su línea materializada y
      // el cierre. Y un segundo concepto del mes en curso, sin aplicar.
      await admin.query('begin');
      await admin.query('set local row_security = off');
      await admin.query(
        `insert into app.manual_adjustments
           (id, household_id, agreement_id, employee_membership_id, period_month,
            requested_period_month, label, reason, amount_cents, adds_to_pay,
            recorded_by_membership_id, recorded_at)
         values
           ('ac100000-0000-4000-8000-000000000001', $1, $2, $3,
            date '2026-07-01', date '2026-07-01', 'IT Adelanto aplicado',
            'Entregado a cuenta en julio', -10000, true, $4, '2026-07-10T10:00:00Z'),
           ('ac100000-0000-4000-8000-000000000002', $1, $2, $3,
            date_trunc('month', current_date)::date, date_trunc('month', current_date)::date,
            'IT Pendiente de aplicar', 'Acordado este mes', 4000, true, $4, now())`,
        [FIXTURE_HOUSEHOLD, AGREEMENT, EMPLOYEE_M, ADMIN_M]
      );
      await admin.query(
        `insert into app.settlements
           (id, household_id, agreement_id, employee_membership_id, period_start,
            period_end, due_on, created_by_membership_id)
         values ('ac000000-0000-4000-8000-000000000001', $1, $2, $3,
                 date '2026-07-01', date '2026-07-31', date '2026-07-31', $4)`,
        [FIXTURE_HOUSEHOLD, AGREEMENT, EMPLOYEE_M, ADMIN_M]
      );
      await admin.query(
        `insert into app.settlement_lines
           (household_id, settlement_id, agreement_id, employee_membership_id,
            line_number, section, kind, occurred_on, concept, amount_cents, manual_adjustment_id)
         values ($1, 'ac000000-0000-4000-8000-000000000001', $2, $3,
                 1, 'salary', 'adjustment', date '2026-07-10',
                 'IT Adelanto aplicado · Entregado a cuenta', -10000,
                 'ac100000-0000-4000-8000-000000000001')`,
        [FIXTURE_HOUSEHOLD, AGREEMENT, EMPLOYEE_M]
      );
      await admin.query(
        `update app.settlements
            set status = 'closed', closed_by_membership_id = $1,
                closed_at = '2026-07-31T18:00:00Z', snapshot_hash = repeat('f', 64)
          where id = 'ac000000-0000-4000-8000-000000000001'`,
        [ADMIN_M]
      );
      await admin.query('commit');

      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(dbUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('lo materializado en una nómina cerrada llega marcado, y lo pendiente no', async () => {
    const overview = await loadEmploymentOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();

    const aplicado = overview!.manualAdjustments.find((row) => row.label === 'IT Adelanto aplicado');
    expect(aplicado).toBeDefined();
    expect(aplicado!.settled).toBe(true);
    expect(aplicado!.settledLabel).toBe('Aplicado en la nómina de julio 2026');

    const pendiente = overview!.manualAdjustments.find(
      (row) => row.label === 'IT Pendiente de aplicar'
    );
    expect(pendiente).toBeDefined();
    expect(pendiente!.settled).toBe(false);
    expect(pendiente!.settledLabel).toBeNull();
  });

  it('la empleada ve la misma verdad: su adelanto aplicado no vuelve como pendiente', async () => {
    const overview = await loadEmploymentOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    const aplicado = overview!.manualAdjustments.find((row) => row.label === 'IT Adelanto aplicado');
    expect(aplicado?.settled).toBe(true);
  });
});
