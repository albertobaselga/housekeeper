import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuthCore, runAuthMigrations, type AuthCore, type MagicLinkMessage } from '../src/lib/server/auth-core';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const AUTH_DB = 'casaclara_auth_it';

function authUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${AUTH_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('Better Auth contra Postgres real', () => {
  const sent: MagicLinkMessage[] = [];
  let core: AuthCore;
  let passwordless: AuthCore;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`drop database if exists ${AUTH_DB} with (force)`);
    await admin.query(`create database ${AUTH_DB}`);
    await admin.end();

    core = createAuthCore({
      databaseUrl: authUrlFor(adminUrl as string),
      secret: 'integration-secret-not-for-production-0001',
      baseURL: 'http://localhost:3000',
      demoPasswordEnabled: true,
      sendMagicLink: async (message) => {
        sent.push(message);
      }
    });
    await runAuthMigrations(core.auth);

    passwordless = createAuthCore({
      databaseUrl: authUrlFor(adminUrl as string),
      secret: 'integration-secret-not-for-production-0001',
      baseURL: 'http://localhost:3000',
      demoPasswordEnabled: false,
      sendMagicLink: async () => {}
    });
  }, 60_000);

  afterAll(async () => {
    await core?.pool.end();
    await passwordless?.pool.end();
  });

  it('crea la cuenta demo y entra con contraseña solo cuando el flag lo permite', async () => {
    const signup = await core.auth.api.signUpEmail({
      body: { name: 'Ana Fixture', email: 'ana.it@casaclara.demo', password: 'Demo-It-2026!' }
    });
    expect(signup.user.id).toBeTruthy();

    const signin = await core.auth.api.signInEmail({
      body: { email: 'ana.it@casaclara.demo', password: 'Demo-It-2026!' }
    });
    expect(signin.token).toBeTruthy();

    await expect(
      passwordless.auth.api.signInEmail({
        body: { email: 'ana.it@casaclara.demo', password: 'Demo-It-2026!' }
      })
    ).rejects.toMatchObject({ status: expect.anything() });
  });

  it('entrega enlace mágico de un solo uso para cuentas existentes y calla para desconocidas', async () => {
    sent.length = 0;
    await core.auth.api.signInMagicLink({ body: { email: 'ana.it@casaclara.demo' }, headers: new Headers() });
    expect(sent).toHaveLength(1);
    const delivered = sent[0]!;
    expect(delivered.email).toBe('ana.it@casaclara.demo');
    expect(delivered.url).toContain(delivered.token);

    const verification = await core.auth.api.magicLinkVerify({
      query: { token: delivered.token },
      headers: new Headers()
    });
    expect(verification.token).toBeTruthy();

    // Reutilizar el mismo token debe fallar: un solo uso.
    await expect(
      core.auth.api.magicLinkVerify({ query: { token: delivered.token }, headers: new Headers() })
    ).rejects.toMatchObject({ status: expect.anything() });

    // Cuenta inexistente: la petición responde igual (sin enumeración), pero con
    // disableSignUp el token entregado no crea cuenta ni sesión al verificarse.
    sent.length = 0;
    await core.auth.api
      .signInMagicLink({ body: { email: 'nadie@casaclara.demo' }, headers: new Headers() })
      .catch(() => {});
    const strangerToken = sent[0]?.token;
    if (strangerToken) {
      await expect(
        core.auth.api.magicLinkVerify({ query: { token: strangerToken }, headers: new Headers() })
      ).rejects.toMatchObject({ status: expect.anything() });
    }
    const stranger = await core.pool.query(
      "select count(*)::int as n from \"user\" where email = 'nadie@casaclara.demo'"
    );
    expect(stranger.rows[0].n).toBe(0);
  });
});
