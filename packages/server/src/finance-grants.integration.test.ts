import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@housekeeper/contracts";
import { financeCommandPayloadSchema } from "@housekeeper/contracts/schemas";

import { financeCommandHandlers, requireFinanceAdmin } from "./commands/finance.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };
const HELPER_MEMBERSHIP = "11000000-0000-4000-8000-000000000004";

// Administración adicional sembrada SOLO por esta suite (prefijo f09*): la
// fixture compartida solo tiene un admin en el roble y las concesiones se
// ejercen sobre alguien a quien apagar y encender sin tocar la fixture.
const SECOND_ADMIN_USER = "fixture:roble:finance-admin";
const SECOND_ADMIN: AuthenticatedPrincipal = { userId: SECOND_ADMIN_USER };
const SECOND_ADMIN_MEMBERSHIP = "f0900000-0000-4000-8000-000000000001";

function envelope(payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE,
    schemaVersion: 1,
    aggregateType: "finance",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-31T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("concesión y revocación de Finanzas sobre Postgres real (spec §4)", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], financeCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function financeEnabledFor(principal: AuthenticatedPrincipal): Promise<boolean> {
    return withAuthorizedTransaction(appPool, principal, ROBLE, async (client) => {
      const result = await client.query<{ enabled: boolean }>("select app.finance_enabled() as enabled");
      return Boolean(result.rows[0]?.enabled);
    });
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    await adminPool.query(
      `insert into app.user_profiles (user_id, display_name)
       values ($1, 'Fixture Admin Finanzas') on conflict (user_id) do nothing`,
      [SECOND_ADMIN_USER],
    );
    // `do update` y no `do nothing`: el afterAll la deja revocada (ver allí por
    // qué no puede borrarla), así que una segunda corrida la encuentra muerta y
    // tiene que revivirla o no habría con quién ejercer las concesiones.
    await adminPool.query(
      `insert into app.household_memberships (id, household_id, user_id, role)
       values ($1, $2, $3, 'family_admin')
       on conflict (id) do update
          set revoked_at = null, expires_at = null, updated_at = statement_timestamp()`,
      [SECOND_ADMIN_MEMBERSHIP, ROBLE, SECOND_ADMIN_USER],
    );
  });

  afterAll(async () => {
    // El paquete corre con fileParallelism: false y sequencer alfabético: esta
    // base la heredan food, guide-reading, rhythm, sync, vacation, wiki… Dejar
    // un family_admin VIVO de más en el roble les cambiaría el reparto por
    // debajo, así que la suite apaga lo que encendió.
    //
    // La concesión sí se borra. La membresía NO se puede borrar: emitir la
    // auto-revocación deja recibo de idempotencia y evento de auditoría, ambos
    // la retienen con ON DELETE RESTRICT, y `app.audit_events` es append-only
    // por trigger (0004) incluso para el propietario. Retirarla del todo es
    // imposible por diseño, así que se queda revocada —muerta para
    // withAuthorizedTransaction y para app.current_household_role()—, que es el
    // mismo rastro inerte que access.integration.test.ts deja con su viewer.
    await adminPool.query(
      `delete from app.finance_module_grants
        where membership_id = $1
           or granted_by_membership_id = $1
           or revoked_by_membership_id = $1`,
      [SECOND_ADMIN_MEMBERSHIP],
    );
    await adminPool.query(
      `update app.household_memberships
          set revoked_at = statement_timestamp(), updated_at = statement_timestamp()
        where id = $1 and revoked_at is null`,
      [SECOND_ADMIN_MEMBERSHIP],
    );
    await appPool?.end();
    await adminPool?.end();
  });

  it("concede, rechaza el duplicado, permite auto-revocarse y rechaza revocar dos veces", async () => {
    expect(await financeEnabledFor(SECOND_ADMIN)).toBe(false);

    const granted = await run(
      ADMIN,
      envelope({ kind: "finance.grant.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(granted.status).toBe("accepted");
    expect(granted.resourceId).toBeTruthy();
    expect(await financeEnabledFor(SECOND_ADMIN)).toBe(true);

    // Conceder siembra el árbol de categorías SOLO si el hogar está vacío
    // (spec §5). El roble ya trae las cuatro de la fixture: la semilla no
    // duplica nada. El caso «hogar virgen → 50 categorías» lo prueba la matriz
    // SQL de la Task 4, que puede vaciar un hogar y revertir.
    const categories = await adminPool.query<{ total: string }>(
      "select count(*) as total from app.finance_categories where household_id = $1",
      [ROBLE],
    );
    expect(Number(categories.rows[0]?.total)).toBe(4);

    const repeated = await run(
      ADMIN,
      envelope({ kind: "finance.grant.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(repeated).toMatchObject({ status: "rejected", errorCode: "already_granted" });

    // Un admin puede revocarse a sí mismo; otro admin puede devolvérselo.
    const revoked = await run(
      SECOND_ADMIN,
      envelope({ kind: "finance.revoke.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(revoked.status).toBe("accepted");
    expect(await financeEnabledFor(SECOND_ADMIN)).toBe(false);

    const reRevoked = await run(
      ADMIN,
      envelope({ kind: "finance.revoke.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(reRevoked).toMatchObject({ status: "rejected", errorCode: "not_granted" });
  });

  it("solo se concede a family_admin y solo un family_admin emite", async () => {
    const toHelper = await run(
      ADMIN,
      envelope({ kind: "finance.grant.write", membershipId: HELPER_MEMBERSHIP }),
    );
    expect(toHelper).toMatchObject({ status: "rejected", errorCode: "grant_target_not_admin" });

    const fromFamily = await run(
      FAMILY,
      envelope({ kind: "finance.grant.write", membershipId: SECOND_ADMIN_MEMBERSHIP }),
    );
    expect(fromFamily).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const badPayload = await run(ADMIN, envelope({ kind: "finance.grant.write" }));
    expect(badPayload).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });
  });

  it("requireFinanceAdmin exige rol Y concesión viva dentro de la transacción", async () => {
    // El admin de la fixture tiene concesión viva (fixtures/002_finance.sql).
    await withAuthorizedTransaction(appPool, ADMIN, ROBLE, async (client, membership) => {
      await expect(requireFinanceAdmin(client, membership)).resolves.toBeUndefined();
    });
    // Admin sin concesión (revocada en el test anterior): finance_not_granted.
    await expect(
      withAuthorizedTransaction(appPool, SECOND_ADMIN, ROBLE, (client, membership) =>
        requireFinanceAdmin(client, membership),
      ),
    ).rejects.toMatchObject({ errorCode: "finance_not_granted" });
    // Sin rol de administración: not_allowed.
    await expect(
      withAuthorizedTransaction(appPool, FAMILY, ROBLE, (client, membership) =>
        requireFinanceAdmin(client, membership),
      ),
    ).rejects.toMatchObject({ errorCode: "not_allowed" });
  });
});

// FUERA del describe con base de datos: esta regla se congela siempre, haya
// Postgres delante o no.
describe("la puerta del agregado finance", () => {
  it("solo tiene dos kinds en esta fase: quien añada uno nuevo abre requireFinanceAdmin, no la puerta de conceder", () => {
    expect(
      financeCommandPayloadSchema.options.map((option) => option.shape.kind.value).sort(),
    ).toEqual(["finance.grant.write", "finance.revoke.write"]);
  });
});
