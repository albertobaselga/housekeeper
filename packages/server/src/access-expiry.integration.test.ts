import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

// Identidades exclusivas de este suite: el resto de ficheros de integración
// comparte la misma base en paralelo y ninguno debe tropezar con membresías
// que caducan por reloj.
const EXPIRED_USER = "fixture:roble:expiry-past";
const EXPIRED_MEMBERSHIP = "11000000-0000-4000-8000-000000000095";
const EXPIRED_PRINCIPAL: AuthenticatedPrincipal = { userId: EXPIRED_USER };

const SOON_USER = "fixture:roble:expiry-soon";
const SOON_MEMBERSHIP = "11000000-0000-4000-8000-000000000096";
const SOON_PRINCIPAL: AuthenticatedPrincipal = { userId: SOON_USER };

describe.runIf(Boolean(adminUrl))("F4-03: expires_at bloquea al vencer, por reloj de la base", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    for (const [userId, name] of [
      [EXPIRED_USER, "Fixture Caducada Pasado"],
      [SOON_USER, "Fixture Caduca En Un Segundo"],
    ]) {
      await adminPool.query(
        `insert into app.user_profiles (user_id, display_name)
         values ($1, $2) on conflict (user_id) do nothing`,
        [userId, name],
      );
    }

    // Membresía ya caducada: el CHECK exige expires_at > starts_at, así que se
    // siembra con un arranque anterior. El reloj que decide es el de Postgres.
    await adminPool.query(
      `insert into app.household_memberships (id, household_id, user_id, role, starts_at, expires_at)
       values ($1, $2, $3, 'helper', now() - interval '2 days', now() - interval '1 day')
       on conflict (id) do nothing`,
      [EXPIRED_MEMBERSHIP, ROBLE_HOUSEHOLD, EXPIRED_USER],
    );
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("una membresía con expires_at en el pasado lanza AuthorizationError YA, sin proceso alguno", async () => {
    await expect(
      withAuthorizedTransaction(appPool, EXPIRED_PRINCIPAL, ROBLE_HOUSEHOLD, async () => undefined),
    ).rejects.toThrow(AuthorizationError);

    // La barrera también vive en la propia base, no solo en el resolvedor del
    // BFF: la selección de contexto con esa membresía muere con 42501.
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.user_id', $1, true)", [EXPIRED_USER]);
      await expect(
        client.query("select app.set_household_context($1, $2)", [ROBLE_HOUSEHOLD, EXPIRED_MEMBERSHIP]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("una membresía que expira en ~1s funciona ahora y deja de funcionar en la petición siguiente", async () => {
    // Caducidad a +1,25 s según el reloj de la BASE (no el del proceso): la
    // caducidad se aplica en la siguiente petición, sin ningún job ni proceso.
    await adminPool.query(
      `insert into app.household_memberships (id, household_id, user_id, role, starts_at, expires_at)
       values ($1, $2, $3, 'viewer', now() - interval '1 minute', now() + interval '1.25 seconds')`,
      [SOON_MEMBERSHIP, ROBLE_HOUSEHOLD, SOON_USER],
    );

    // Aún viva: la transacción autorizada entra con normalidad.
    const membership = await withAuthorizedTransaction(
      appPool,
      SOON_PRINCIPAL,
      ROBLE_HOUSEHOLD,
      async (_client, active) => active,
    );
    expect(membership.id).toBe(SOON_MEMBERSHIP);
    expect(membership.expiresAt).not.toBeNull();

    // Espera hasta que el reloj de la base rebase expires_at (~1,5 s), con
    // sondeo para no depender de la deriva entre el reloj del test y el de
    // Postgres.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const check = await adminPool.query<{ expired: boolean }>(
        "select clock_timestamp() > expires_at as expired from app.household_memberships where id = $1",
        [SOON_MEMBERSHIP],
      );
      if (check.rows[0]?.expired) break;
      if (Date.now() > deadline) throw new Error("expires_at nunca venció; revisa el reloj de la base");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // La MISMA membresía, sin revocación ni escritura alguna, ya no autoriza:
    // la caducidad la aplica el reloj de la base en la petición siguiente.
    await expect(
      withAuthorizedTransaction(appPool, SOON_PRINCIPAL, ROBLE_HOUSEHOLD, async () => undefined),
    ).rejects.toThrow(AuthorizationError);

    // Y el descubrimiento de membresías propias tampoco la devuelve ya (RLS
    // memberships_discover_own compara contra statement_timestamp()).
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.user_id', $1, true)", [SOON_USER]);
      const discovered = await client.query(
        "select id from app.household_memberships",
      );
      expect(discovered.rows).toEqual([]);
      await client.query("commit");
    } finally {
      client.release();
    }
  });
});
