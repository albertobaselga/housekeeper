import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { membershipIn } from '../src/lib/auth/membership';
import {
  clearPasswordChangeRequirement,
  requirePasswordChange
} from '../src/lib/server/access.server';
import { resolveAppUser } from '../src/lib/server/app-user.server';
import { createAuthCore, runAuthMigrations, type AuthCore } from '../src/lib/server/auth-core';
import { hireHouseholdMember } from '../src/lib/server/staff-hire.server';
import { loadStaffOverview } from '../src/lib/server/staff.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_hire_login';
const APP_DB = 'housekeeper_hire_it';
const AUTH_DB = 'housekeeper_hire_auth_it';
const BASE_URL = 'http://localhost:3000';

const ADMIN_PASSWORD = 'alberto-clave-de-casa-2026';
const EMPLOYEE_PASSWORD = 'ana-clave-de-casa-2026';

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Cookie de sesión que devuelve un inicio de sesión correcto. */
function sessionHeaders(response: Response): Headers {
  const raw = response.headers.getSetCookie?.() ?? [];
  return new Headers({ cookie: raw.map((cookie) => cookie.split(';', 1)[0]).join('; ') });
}

describe.runIf(Boolean(adminUrl))('alta de personal desde la aplicación', () => {
  let core: AuthCore;
  let appPool: pg.Pool;
  let adminPool: pg.Pool;
  let adminHeaders: Headers;
  let employeeHeaders: Headers;
  let adminUserId = '';
  let employeeUserId = '';

  async function signIn(username: string, password: string): Promise<Headers> {
    const response = await core.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/username`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
    );
    expect(response.status).toBe(200);
    return sessionHeaders(response);
  }

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      for (const database of [APP_DB, AUTH_DB]) {
        await cluster.query(`drop database if exists ${database} with (force)`);
        await cluster.query(`create database ${database}`);
      }
    } finally {
      await cluster.end();
    }

    // Identidad: las cuentas de arranque nacen por el adaptador interno, igual
    // que en producción. El alta por HTTP está cerrada en todos los entornos.
    core = createAuthCore({
      databaseUrl: urlFor(adminUrl as string, AUTH_DB),
      secret: 'integration-secret-not-for-production-0030',
      baseURL: BASE_URL
    });
    await runAuthMigrations(core.auth);
    const context = await core.auth.$context;
    const alberto = await context.internalAdapter.createUser({
      name: 'Alberto',
      email: 'alberto@casa.local',
      emailVerified: true,
      username: 'alberto',
      displayUsername: 'alberto',
      role: 'admin'
    });
    adminUserId = alberto.id;
    await context.internalAdapter.createAccount({
      userId: adminUserId,
      providerId: 'credential',
      accountId: adminUserId,
      password: await context.password.hash(ADMIN_PASSWORD)
    });
    const ana = await context.internalAdapter.createUser({
      name: 'Ana',
      email: 'ana@casa.local',
      emailVerified: true,
      username: 'ana',
      displayUsername: 'ana',
      role: 'user'
    });
    employeeUserId = ana.id;
    await context.internalAdapter.createAccount({
      userId: employeeUserId,
      providerId: 'credential',
      accountId: employeeUserId,
      password: await context.password.hash(EMPLOYEE_PASSWORD)
    });

    // Aplicación: esquema, fixtures y las dos identidades reales colgadas del
    // hogar del roble.
    const admin = new pg.Client({ connectionString: urlFor(adminUrl as string, APP_DB) });
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
      await admin.query('set row_security = off');
      await admin.query(
        `insert into app.user_profiles (user_id, display_name, email) values ($1, 'Alberto', 'alberto@casa.local'), ($2, 'Ana', 'ana@casa.local')`,
        [adminUserId, employeeUserId]
      );
      await admin.query(
        `insert into app.household_memberships (household_id, user_id, role)
         values ($1, $2, 'family_admin'), ($1, $3, 'employee_live_in')`,
        [FIXTURE_HOUSEHOLD, adminUserId, employeeUserId]
      );
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: urlFor(adminUrl as string, APP_DB), max: 2 });
    const appUrl = new URL(urlFor(adminUrl as string, APP_DB));
    appUrl.username = APP_LOGIN;
    appUrl.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 3 });

    adminHeaders = await signIn('alberto', ADMIN_PASSWORD);
    employeeHeaders = await signIn('ana', EMPLOYEE_PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    await core?.pool.end();
  });

  it('crea cuenta, membresía y contrato en un solo acto', async () => {
    const result = await hireHouseholdMember(
      { id: adminUserId },
      FIXTURE_HOUSEHOLD,
      {
        displayName: 'Nuria Sintética',
        username: 'nuria',
        email: 'nuria@casa.local',
        role: 'employee_live_in',
        agreement: {
          startsOn: '2026-09-01',
          terms: {
            effectiveFrom: '2026-09-01',
            monthlySalaryCents: '145000',
            contractedWeeklyMinutes: 2400,
            annualVacationDays: 30,
            reason: 'Alta desde la aplicación',
            extraWorkTypes: [],
            supplements: [],
            // El alta no pacta horario, igual que no pacta catálogo de trabajo
            // extra ni complementos: eso se hace después en El acuerdo,
            // apilando una versión. `null` no es un hueco por rellenar, es la
            // respuesta que evita que la empleada vea una sección vacía. Es lo
            // mismo que produce el formulario, donde el esquema zod lo pone por
            // omisión.
            schedule: null
          }
        }
      },
      adminHeaders,
      appPool,
      core.auth
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.username).toBe('nuria');
    expect(result.agreementId).not.toBeNull();
    // Cuatro grupos de cinco, sin caracteres que se confundan al dictar.
    expect(result.password).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/);

    const staff = await loadStaffOverview({ id: adminUserId }, FIXTURE_HOUSEHOLD, appPool);
    const nuria = staff!.current.find((person) => person.name === 'Nuria Sintética')!;
    expect(nuria.status).toBe('trabajando');
    expect(nuria.passwordPending).toBe(true);
    expect(nuria.agreements[0]!.versions.map((version) => version.versionNumber)).toEqual([1]);
    expect(nuria.agreements[0]!.versions[0]!.salaryLabel).toContain('1.450,00');
  });

  it('la persona recién dada de alta entra y llega obligada a cambiar la contraseña', async () => {
    // Se recupera la contraseña del alta anterior dando de alta a otra persona:
    // la primera no se guardó en ninguna parte, que es justamente el punto.
    const hired = await hireHouseholdMember(
      { id: adminUserId },
      FIXTURE_HOUSEHOLD,
      {
        displayName: 'Rosa Sintética',
        username: 'rosa',
        email: 'rosa@casa.local',
        role: 'helper',
        agreement: null
      },
      adminHeaders,
      appPool,
      core.auth
    );
    expect(hired.ok).toBe(true);
    if (!hired.ok) return;

    const signedIn = await core.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/username`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'rosa', password: hired.password })
      })
    );
    expect(signedIn.status).toBe(200);
    const rosaUserId = ((await signedIn.json()) as { user: { id: string } }).user.id;

    const identity = await resolveAppUser(rosaUserId, 'rosa@casa.local', 'Rosa', appPool);
    expect(identity).not.toBeNull();
    expect(identity!.mustChangePassword).toBe(true);
    expect(membershipIn(identity, FIXTURE_HOUSEHOLD)?.role).toBe('helper');
    // Y sin contrato: dar acceso y pactar condiciones son dos actos distintos.
    const staff = await loadStaffOverview({ id: adminUserId }, FIXTURE_HOUSEHOLD, appPool);
    expect(staff!.current.find((person) => person.name === 'Rosa Sintética')!.status).toBe('sin_contrato');
  });

  /**
   * La revocación instantánea sigue siendo de la RLS y no la toca el alta: la
   * contraseña sigue valiendo en Better Auth y aun así el hogar deja de existir
   * para esa persona en la petición siguiente.
   */
  it('revocar deja fuera al instante a una cuenta creada desde la aplicación', async () => {
    const hired = await hireHouseholdMember(
      { id: adminUserId },
      FIXTURE_HOUSEHOLD,
      {
        displayName: 'Eva Sintética',
        username: 'eva',
        email: 'eva@casa.local',
        role: 'employee_live_in',
        agreement: null
      },
      adminHeaders,
      appPool,
      core.auth
    );
    expect(hired.ok).toBe(true);
    if (!hired.ok) return;

    const signedIn = await core.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/username`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'eva', password: hired.password })
      })
    );
    const evaUserId = ((await signedIn.json()) as { user: { id: string } }).user.id;
    expect(await resolveAppUser(evaUserId, 'eva@casa.local', 'Eva', appPool)).not.toBeNull();

    await adminPool.query(
      `update app.household_memberships set revoked_at = statement_timestamp() where id = $1`,
      [hired.membershipId]
    );

    // Su contraseña sigue siendo válida: la identidad no se ha tocado.
    const again = await core.auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/username`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'eva', password: hired.password })
      })
    );
    expect(again.status).toBe(200);
    // Y aun así el hogar ya no existe para ella.
    expect(await resolveAppUser(evaUserId, 'eva@casa.local', 'Eva', appPool)).toBeNull();
  });

  it('quien no administra el hogar no da de alta a nadie, ni deja cuentas sueltas', async () => {
    const before = await core.pool.query('select count(*)::int as n from "user"');
    const result = await hireHouseholdMember(
      { id: employeeUserId },
      FIXTURE_HOUSEHOLD,
      {
        displayName: 'Colada Sintética',
        username: 'colada',
        email: 'colada@casa.local',
        role: 'employee_live_in',
        agreement: null
      },
      employeeHeaders,
      appPool,
      core.auth
    );
    expect(result.ok).toBe(false);
    const after = await core.pool.query('select count(*)::int as n from "user"');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('rechaza lo que no se puede corregir después sin tocar nada', async () => {
    const before = await core.pool.query('select count(*)::int as n from "user"');
    for (const [field, input] of [
      ['usuario', { username: 'NO VALE', email: 'x@casa.local' }],
      ['correo', { username: 'valido', email: 'no-es-un-correo' }]
    ] as const) {
      const result = await hireHouseholdMember(
        { id: adminUserId },
        FIXTURE_HOUSEHOLD,
        { displayName: 'Prueba', role: 'employee_live_in', agreement: null, ...input },
        adminHeaders,
        appPool,
        core.auth
      );
      expect(result.ok, field).toBe(false);
    }
    const after = await core.pool.query('select count(*)::int as n from "user"');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  /**
   * Reponer una contraseña desde Ajustes vuelve a marcarla como provisional, y
   * la marca solo la apaga quien de verdad cambió la suya. Es el mismo par de
   * llamadas que hacen las dos pantallas, contra la RLS y el disparador de 0030.
   */
  it('la obligación de cambiar la contraseña la pone la administración y la quita su dueña', async () => {
    expect(await requirePasswordChange({ id: adminUserId }, FIXTURE_HOUSEHOLD, employeeUserId, appPool)).toBe(true);
    const flagged = await resolveAppUser(employeeUserId, 'ana@casa.local', 'Ana', appPool);
    expect(flagged!.mustChangePassword).toBe(true);

    // Quien administra no puede darla por cambiada: no ha cambiado nada.
    expect(
      await clearPasswordChangeRequirement({ id: adminUserId }, FIXTURE_HOUSEHOLD, appPool)
    ).toBe(false);
    expect(
      (await resolveAppUser(employeeUserId, 'ana@casa.local', 'Ana', appPool))!.mustChangePassword
    ).toBe(true);

    expect(
      await clearPasswordChangeRequirement({ id: employeeUserId }, FIXTURE_HOUSEHOLD, appPool)
    ).toBe(true);
    expect(
      (await resolveAppUser(employeeUserId, 'ana@casa.local', 'Ana', appPool))!.mustChangePassword
    ).toBe(false);
  });

  it('quien no administra no puede exigir un cambio de contraseña ajeno', async () => {
    expect(
      await requirePasswordChange({ id: employeeUserId }, FIXTURE_HOUSEHOLD, adminUserId, appPool)
    ).toBe(false);
    expect(
      (await resolveAppUser(adminUserId, 'alberto@casa.local', 'Alberto', appPool))!.mustChangePassword
    ).toBe(false);
  });

  it('un nombre de usuario ya cogido no crea a medias', async () => {
    const result = await hireHouseholdMember(
      { id: adminUserId },
      FIXTURE_HOUSEHOLD,
      {
        displayName: 'Otra Nuria',
        username: 'nuria',
        email: 'otra.nuria@casa.local',
        role: 'employee_live_in',
        agreement: null
      },
      adminHeaders,
      appPool,
      core.auth
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('nombre de usuario');
  });
});
