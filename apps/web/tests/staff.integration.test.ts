import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadStaffOverview } from '../src/lib/server/staff.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_staff_login';
const STAFF_DB = 'housekeeper_staff_it';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const FAMILY_USER = { id: 'fixture:roble:family' };

// La empleada de la fixture (Ana) ya trae acuerdo con dos versiones, y las
// fixtures traen además a una compañera SIN contrato («Fixture Segunda Empleada
// Roble»). A ellas se les suman aquí una empleada nueva con contrato propio y
// una que ya se fue: es el escenario que el propietario pidió ver de un
// vistazo, con las cuatro situaciones posibles a la vez.
const SEGUNDA_MEMBERSHIP = 'ef000000-0000-4000-8000-000000000001';
const ANTERIOR_MEMBERSHIP = 'ef000000-0000-4000-8000-000000000002';
const SEGUNDA_AGREEMENT = 'ef100000-0000-4000-8000-000000000001';
const ANTERIOR_AGREEMENT = 'ef100000-0000-4000-8000-000000000002';
const FIXTURE_EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';

function staffUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${STAFF_DB}`;
  return url.toString();
}

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.user_profiles (user_id, display_name, must_change_password) VALUES
  -- Nombre distinto del de la fixture a propósito: «Fixture Segunda Empleada
  -- Roble» ya existe y no tiene contrato, y dos nombres casi iguales en la
  -- misma lista son una trampa para quien lea el fallo dentro de un año.
  ('fixture:roble:segunda', 'Fixture Empleada Nueva', true),
  ('fixture:roble:anterior', 'Fixture Empleada Anterior', false);

-- starts_at explícito: el CHECK de 0001 exige que la revocación no sea anterior
-- a la entrada, y por defecto la entrada sería ahora mismo.
INSERT INTO app.household_memberships (id, household_id, user_id, role, starts_at, created_at, revoked_at) VALUES
  ('${SEGUNDA_MEMBERSHIP}', '${FIXTURE_HOUSEHOLD}', 'fixture:roble:segunda', 'employee_live_in',
   now() - interval '10 days', now() - interval '10 days', NULL),
  ('${ANTERIOR_MEMBERSHIP}', '${FIXTURE_HOUSEHOLD}', 'fixture:roble:anterior', 'employee_live_in',
   now() - interval '400 days', now() - interval '400 days', now() - interval '30 days');

INSERT INTO app.employment_agreements (
  id, household_id, employee_membership_id, status, starts_on, ends_on,
  created_by_membership_id, ended_at
) VALUES
  ('${SEGUNDA_AGREEMENT}', '${FIXTURE_HOUSEHOLD}', '${SEGUNDA_MEMBERSHIP}', 'active',
   '2026-08-01', NULL, '11000000-0000-4000-8000-000000000001', NULL),
  ('${ANTERIOR_AGREEMENT}', '${FIXTURE_HOUSEHOLD}', '${ANTERIOR_MEMBERSHIP}', 'ended',
   '2024-01-15', '2025-07-31', '11000000-0000-4000-8000-000000000001', now() - interval '30 days');

INSERT INTO app.agreement_versions (
  id, household_id, agreement_id, version_number, effective_from,
  monthly_salary_cents, overtime_hourly_rate_cents, worked_rest_day_rate_cents,
  worked_rest_day_credit_minutes, contracted_weekly_minutes, annual_vacation_days,
  reason, created_by_membership_id
) VALUES
  ('ef200000-0000-4000-8000-000000000001', '${FIXTURE_HOUSEHOLD}', '${SEGUNDA_AGREEMENT}', 1,
   '2026-08-01', 125000, 0, 0, 1440, 2000, 30, 'Alta de la segunda empleada',
   '11000000-0000-4000-8000-000000000001'),
  ('ef200000-0000-4000-8000-000000000002', '${FIXTURE_HOUSEHOLD}', '${ANTERIOR_AGREEMENT}', 1,
   '2024-01-15', 118000, 0, 0, 1440, 2400, 30, 'Condiciones iniciales',
   '11000000-0000-4000-8000-000000000001');
COMMIT;
`;

describe.runIf(Boolean(adminUrl))('personal del hogar leído desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${STAFF_DB} with (force)`);
      await cluster.query(`create database ${STAFF_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: staffUrlFor(adminUrl as string) });
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
      await admin.query(SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(staffUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la administración ve a las empleadas de hoy y a la de antes', async () => {
    const staff = await loadStaffOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(staff).not.toBeNull();

    // Las tres empleadas vivas y el apoyo; la que se fue, en el historial. Dos
    // de ellas tienen contrato y una no, y las tres son personal igual: quien
    // administra tiene que verlas todas o la pantalla no sirve para lo que se
    // hizo.
    expect(staff!.current.map((person) => person.name).sort()).toEqual([
      'Fixture Apoyo Roble',
      'Fixture Empleada Nueva',
      'Fixture Empleada Roble',
      'Fixture Segunda Empleada Roble'
    ]);
    expect(staff!.past.map((person) => person.name)).toEqual(['Fixture Empleada Anterior']);

    // La familia y el visor no son personal: no salen en ninguna de las dos
    // listas, aunque la administración los vea en Ajustes.
    const everyone = [...staff!.current, ...staff!.past].map((person) => person.name);
    expect(everyone).not.toContain('Fixture Admin Roble');
    expect(everyone).not.toContain('Fixture Familiar Roble');
    expect(everyone).not.toContain('Fixture Visor Roble');
  });

  it('cada empleada trae SUS contratos, no los de la casa', async () => {
    const staff = await loadStaffOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    const ana = staff!.current.find((person) => person.membershipId === FIXTURE_EMPLOYEE_MEMBERSHIP)!;
    const segunda = staff!.current.find((person) => person.membershipId === SEGUNDA_MEMBERSHIP)!;
    const anterior = staff!.past[0]!;

    expect(ana.agreements.map((agreement) => agreement.id)).toEqual([
      '12000000-0000-4000-8000-000000000001'
    ]);
    // El historial de condiciones de Ana son sus dos versiones, no una sola.
    expect(ana.agreements[0]!.versions.map((version) => version.versionNumber)).toEqual([2, 1]);

    expect(segunda.agreements.map((agreement) => agreement.id)).toEqual([SEGUNDA_AGREEMENT]);
    expect(segunda.status).toBe('trabajando');
    expect(segunda.passwordPending).toBe(true);

    expect(anterior.agreements.map((agreement) => agreement.id)).toEqual([ANTERIOR_AGREEMENT]);
    expect(anterior.agreements[0]!.status).toBe('ended');
    expect(anterior.agreements[0]!.periodLabel).toBe('Del 15 ene 2024 al 31 jul 2025');
    expect(anterior.status).toBe('anterior');
  });

  it('el apoyo del hogar aparece como personal aunque no tenga contrato', async () => {
    const staff = await loadStaffOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    const apoyo = staff!.current.find((person) => person.role === 'helper')!;
    expect(apoyo.agreements).toEqual([]);
    expect(apoyo.status).toBe('sin_contrato');
  });

  /**
   * La pantalla es de administración y solo de administración: el expediente
   * de las compañeras (nombres, sueldos, fechas) no se le enseña a nadie más.
   * Quien no administra recibe null y la página dice que ahí no hay nada.
   */
  it('ni la empleada ni la familia no administradora reciben la lista', async () => {
    expect(await loadStaffOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
    expect(await loadStaffOverview(FAMILY_USER, FIXTURE_HOUSEHOLD, appPool)).toBeNull();
  });

  it('quien administra un hogar no ve el personal del otro', async () => {
    expect(
      await loadStaffOverview(ADMIN_USER, '20000000-0000-4000-8000-000000000001', appPool)
    ).toBeNull();
  });
});
