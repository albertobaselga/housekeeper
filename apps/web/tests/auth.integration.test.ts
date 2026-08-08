import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTH_ADMIN_ROLE,
  AUTH_MEMBER_ROLE,
  createAuthCore,
  MIN_PASSWORD_LENGTH,
  runAuthMigrations,
  type AuthCore
} from '../src/lib/server/auth-core';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
// Sobrescribible para poder ejecutar varios worktrees contra el mismo cluster.
const AUTH_DB = process.env.TEST_AUTH_DB ?? 'casaclara_auth_it';
const BASE_URL = 'http://localhost:3000';

/** Contraseñas de prueba, todas por encima del mínimo. */
const ALBERTO_PASSWORD = 'alberto-clave-2026';
const NURIA_PASSWORD = 'nuria-clave-2026';
const NEW_PASSWORD = 'clave-nueva-de-casa-2026';

function authUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${AUTH_DB}`;
  return url.toString();
}

/** Petición HTTP real contra el handler montado en /api/auth. */
async function post(core: AuthCore, path: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return core.auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  );
}

/** Cookie de sesión que devuelve un inicio de sesión correcto. */
function sessionCookie(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  return raw.map((cookie) => cookie.split(';', 1)[0]).join('; ');
}

describe.runIf(Boolean(adminUrl))('Acceso por contraseña contra Postgres real', () => {
  let core: AuthCore;
  let albertoId = '';
  let nuriaId = '';

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${AUTH_DB} with (force)`);
    await admin.query(`create database ${AUTH_DB}`);
    await admin.end();

    core = createAuthCore({
      databaseUrl: authUrlFor(adminUrl as string),
      secret: 'integration-secret-not-for-production-0001',
      baseURL: BASE_URL
    });
    await runAuthMigrations(core.auth);

    // Las cuentas nacen como en producción: por el adaptador interno, nunca por
    // el endpoint de alta (que está cerrado). Es el mismo camino que recorre
    // scripts/seed-household-accounts.mjs.
    const context = await core.auth.$context;
    const alberto = await context.internalAdapter.createUser({
      name: 'Alberto',
      email: 'alberto@casa.local',
      emailVerified: true,
      username: 'alberto',
      displayUsername: 'alberto',
      role: AUTH_ADMIN_ROLE
    });
    albertoId = alberto.id;
    await context.internalAdapter.createAccount({
      userId: albertoId,
      providerId: 'credential',
      accountId: albertoId,
      password: await context.password.hash(ALBERTO_PASSWORD)
    });

    const nuria = await context.internalAdapter.createUser({
      name: 'Nuria',
      email: 'nuria@casa.local',
      emailVerified: true,
      username: 'nuria',
      displayUsername: 'nuria',
      role: AUTH_MEMBER_ROLE
    });
    nuriaId = nuria.id;
    await context.internalAdapter.createAccount({
      userId: nuriaId,
      providerId: 'credential',
      accountId: nuriaId,
      password: await context.password.hash(NURIA_PASSWORD)
    });
  }, 60_000);

  afterAll(async () => {
    await core?.pool.end();
  });

  // ── Regresión del agujero detectado (opciones-de-acceso.md §1.5) ───────────
  it('POST /api/auth/sign-up/email está cerrado y no crea ninguna cuenta', async () => {
    const before = await core.pool.query('select count(*)::int as n from "user"');
    const response = await post(core, '/sign-up/email', {
      name: 'Intruso',
      email: 'intruso@ejemplo.test',
      password: 'una-contrasena-larguisima-2026'
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' });

    const after = await core.pool.query('select count(*)::int as n from "user"');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const intruder = await core.pool.query(
      'select count(*)::int as n from "user" where email = $1',
      ['intruso@ejemplo.test']
    );
    expect(intruder.rows[0].n).toBe(0);
  });

  it('el restablecimiento por correo está deshabilitado a propósito', async () => {
    const response = await post(core, '/request-password-reset', {
      email: 'alberto@casa.local',
      redirectTo: BASE_URL
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('RESET_PASSWORD_DISABLED');
  });

  it('no queda ningún camino de enlace mágico', async () => {
    const response = await post(core, '/sign-in/magic-link', { email: 'alberto@casa.local' });
    expect(response.status).toBe(404);
  });

  it('se entra con nombre de usuario y contraseña', async () => {
    const response = await post(core, '/sign-in/username', { username: 'alberto', password: ALBERTO_PASSWORD });
    expect(response.status).toBe(200);
    expect(sessionCookie(response)).toContain('better-auth');
  });

  it('el usuario inexistente y la contraseña incorrecta fallan igual', async () => {
    const unknown = await post(core, '/sign-in/username', { username: 'nadie', password: ALBERTO_PASSWORD });
    const wrong = await post(core, '/sign-in/username', { username: 'alberto', password: 'no-es-esta-2026' });
    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.text()).toBe(await wrong.text());
  });

  it('rechaza contraseñas por debajo del mínimo al reponerlas', async () => {
    const signIn = await post(core, '/sign-in/username', { username: 'alberto', password: ALBERTO_PASSWORD });
    const response = await post(
      core,
      '/admin/set-user-password',
      { userId: nuriaId, newPassword: 'corta' },
      { cookie: sessionCookie(signIn) }
    );
    expect(response.status).toBe(400);
    expect(MIN_PASSWORD_LENGTH).toBe(10);
  });

  it('quien no es administradora no puede reponer la contraseña de nadie', async () => {
    const signIn = await post(core, '/sign-in/username', { username: 'nuria', password: NURIA_PASSWORD });
    const response = await post(
      core,
      '/admin/set-user-password',
      { userId: albertoId, newPassword: NEW_PASSWORD },
      { cookie: sessionCookie(signIn) }
    );
    expect(response.status).toBe(403);
  });

  it('la administradora repone la contraseña y cierra las sesiones de esa persona', async () => {
    const nuriaSignIn = await post(core, '/sign-in/username', { username: 'nuria', password: NURIA_PASSWORD });
    expect(nuriaSignIn.status).toBe(200);
    const nuriaCookie = sessionCookie(nuriaSignIn);

    const adminSignIn = await post(core, '/sign-in/username', { username: 'alberto', password: ALBERTO_PASSWORD });
    const adminCookie = sessionCookie(adminSignIn);

    const reset = await post(
      core,
      '/admin/set-user-password',
      { userId: nuriaId, newPassword: NEW_PASSWORD },
      { cookie: adminCookie }
    );
    expect(reset.status).toBe(200);

    const revoke = await post(core, '/admin/revoke-user-sessions', { userId: nuriaId }, { cookie: adminCookie });
    expect(revoke.status).toBe(200);

    // La sesión anterior de Nuria ya no vale.
    const stale = await core.auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie: nuriaCookie } })
    );
    expect(await stale.json()).toBeNull();

    // Y entra con la contraseña nueva, no con la vieja.
    expect((await post(core, '/sign-in/username', { username: 'nuria', password: NURIA_PASSWORD })).status).not.toBe(200);
    expect((await post(core, '/sign-in/username', { username: 'nuria', password: NEW_PASSWORD })).status).toBe(200);
  });

  it('cambiar la contraseña propia cierra las demás sesiones', async () => {
    const first = await post(core, '/sign-in/username', { username: 'nuria', password: NEW_PASSWORD });
    const firstCookie = sessionCookie(first);
    const second = await post(core, '/sign-in/username', { username: 'nuria', password: NEW_PASSWORD });
    const secondCookie = sessionCookie(second);

    const changed = await post(
      core,
      '/change-password',
      {
        currentPassword: NEW_PASSWORD,
        newPassword: 'la-de-nuria-de-verdad-2026',
        revokeOtherSessions: true
      },
      { cookie: secondCookie }
    );
    expect(changed.status).toBe(200);

    const stale = await core.auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie: firstCookie } })
    );
    expect(await stale.json()).toBeNull();
  });
});
