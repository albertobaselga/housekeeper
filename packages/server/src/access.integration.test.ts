import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@housekeeper/contracts";

import { accessCommandHandlers } from "./commands/membership.js";
import { processSyncBatch } from "./sync.js";
import { AuthorizationError, withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };

const ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const HELPER_MEMBERSHIP = "11000000-0000-4000-8000-000000000004";

// Visor propio del suite: las demás suites de integración comparten esta base
// en paralelo y usan al viewer de la fixture, así que la revocación destructiva
// se ejerce sobre una membresía sembrada solo para estas pruebas.
const REVOKABLE_USER = "fixture:roble:access-viewer";
const REVOKABLE_PRINCIPAL: AuthenticatedPrincipal = { userId: REVOKABLE_USER };
const REVOKABLE_MEMBERSHIP = "11000000-0000-4000-8000-000000000091";

const FUTURE_EXPIRY = "2030-06-01T08:00:00.000Z";

function envelope(payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType: "membership",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("caducidad y revocación de accesos sobre Postgres real (F4-03)", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], accessCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    await adminPool.query(
      `insert into app.user_profiles (user_id, display_name)
       values ($1, 'Fixture Visor Accesos') on conflict (user_id) do nothing`,
      [REVOKABLE_USER],
    );
    await adminPool.query(
      `insert into app.household_memberships (id, household_id, user_id, role)
       values ($1, $2, $3, 'viewer') on conflict (id) do nothing`,
      [REVOKABLE_MEMBERSHIP, ROBLE_HOUSEHOLD, REVOKABLE_USER],
    );
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("el administrador fija una caducidad futura a la persona de apoyo y la lectura la refleja", async () => {
    const ack = await run(
      ADMIN,
      envelope({ action: "set_expiry", membershipId: HELPER_MEMBERSHIP, expiresAt: FUTURE_EXPIRY }),
    );
    expect(ack).toMatchObject({ status: "accepted", resourceId: HELPER_MEMBERSHIP });

    // La misma lectura de membresías del hogar que consume la web (RLS
    // memberships_admin_read del propio admin) devuelve el estado nuevo.
    const seen = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, async (client) => {
      const rows = await client.query<{ expires_at: Date | null }>(
        "select expires_at from app.household_memberships where household_id = $1 and id = $2",
        [ROBLE_HOUSEHOLD, HELPER_MEMBERSHIP],
      );
      return rows.rows[0];
    });
    expect(seen?.expires_at?.toISOString()).toBe(FUTURE_EXPIRY);

    // Retirar la caducidad (expiresAt: null) también es cosa del admin.
    const cleared = await run(
      ADMIN,
      envelope({ action: "set_expiry", membershipId: HELPER_MEMBERSHIP, expiresAt: null }),
    );
    expect(cleared).toMatchObject({ status: "accepted" });
    const after = await adminPool.query<{ expires_at: Date | null }>(
      "select expires_at from app.household_memberships where id = $1",
      [HELPER_MEMBERSHIP],
    );
    expect(after.rows[0]).toEqual({ expires_at: null });
  });

  it("una caducidad en el pasado se rechaza con expiry_in_past", async () => {
    const ack = await run(
      ADMIN,
      envelope({ action: "set_expiry", membershipId: HELPER_MEMBERSHIP, expiresAt: "2020-01-01T00:00:00.000Z" }),
    );
    expect(ack).toMatchObject({ status: "rejected", errorCode: "expiry_in_past" });
    const untouched = await adminPool.query<{ expires_at: Date | null }>(
      "select expires_at from app.household_memberships where id = $1",
      [HELPER_MEMBERSHIP],
    );
    expect(untouched.rows[0]).toEqual({ expires_at: null });
  });

  it("revocar corta el acceso al instante: la siguiente transacción del revocado lanza AuthorizationError", async () => {
    // Antes de la revocación el visor entra con normalidad.
    await withAuthorizedTransaction(appPool, REVOKABLE_PRINCIPAL, ROBLE_HOUSEHOLD, async (_client, membership) => {
      expect(membership.id).toBe(REVOKABLE_MEMBERSHIP);
    });

    const ack = await run(ADMIN, envelope({ action: "revoke", membershipId: REVOKABLE_MEMBERSHIP }));
    expect(ack).toMatchObject({ status: "accepted", resourceId: REVOKABLE_MEMBERSHIP });

    const stored = await adminPool.query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from app.household_memberships where id = $1",
      [REVOKABLE_MEMBERSHIP],
    );
    expect(stored.rows[0]).toEqual({ revoked: true });

    // F4-03: sin más fontanería, la resolución por petición ya no encuentra
    // membresía viva y el acceso muere en la petición siguiente.
    await expect(
      withAuthorizedTransaction(appPool, REVOKABLE_PRINCIPAL, ROBLE_HOUSEHOLD, async () => undefined),
    ).rejects.toThrow(AuthorizationError);
  });

  it("re-revocar responde already_revoked sin re-sellar revoked_at", async () => {
    const first = await adminPool.query<{ revoked_at: Date | null }>(
      "select revoked_at from app.household_memberships where id = $1",
      [REVOKABLE_MEMBERSHIP],
    );
    const replayed = await run(ADMIN, envelope({ action: "revoke", membershipId: REVOKABLE_MEMBERSHIP }));
    expect(replayed).toMatchObject({ status: "rejected", errorCode: "already_revoked" });

    const second = await adminPool.query<{ revoked_at: Date | null }>(
      "select revoked_at from app.household_memberships where id = $1",
      [REVOKABLE_MEMBERSHIP],
    );
    expect(second.rows[0]?.revoked_at?.toISOString()).toBe(first.rows[0]?.revoked_at?.toISOString());

    // Y su caducidad tampoco se reprograma una vez muerto el acceso.
    const expiry = await run(
      ADMIN,
      envelope({ action: "set_expiry", membershipId: REVOKABLE_MEMBERSHIP, expiresAt: FUTURE_EXPIRY }),
    );
    expect(expiry).toMatchObject({ status: "rejected", errorCode: "already_revoked" });
  });

  it("el administrador no puede caducar ni revocar su propia membresía", async () => {
    const expiry = await run(
      ADMIN,
      envelope({ action: "set_expiry", membershipId: ADMIN_MEMBERSHIP, expiresAt: FUTURE_EXPIRY }),
    );
    expect(expiry).toMatchObject({ status: "rejected", errorCode: "cannot_modify_self" });

    const revoke = await run(ADMIN, envelope({ action: "revoke", membershipId: ADMIN_MEMBERSHIP }));
    expect(revoke).toMatchObject({ status: "rejected", errorCode: "cannot_modify_self" });

    const intact = await adminPool.query<{ expires_at: Date | null; revoked_at: Date | null }>(
      "select expires_at, revoked_at from app.household_memberships where id = $1",
      [ADMIN_MEMBERSHIP],
    );
    expect(intact.rows[0]).toEqual({ expires_at: null, revoked_at: null });
  });

  it("un family_member no gestiona accesos: not_allowed", async () => {
    const expiry = await run(
      FAMILY,
      envelope({ action: "set_expiry", membershipId: HELPER_MEMBERSHIP, expiresAt: FUTURE_EXPIRY }),
    );
    expect(expiry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const revoke = await run(FAMILY, envelope({ action: "revoke", membershipId: HELPER_MEMBERSHIP }));
    expect(revoke).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
  });

  it("una membresía de otro hogar no es visible: membership_not_found", async () => {
    const ack = await run(
      ADMIN,
      envelope({ action: "revoke", membershipId: "21000000-0000-4000-8000-000000000002" }),
    );
    expect(ack).toMatchObject({ status: "rejected", errorCode: "membership_not_found" });
  });
});
