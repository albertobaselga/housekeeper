import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandEnvelopeV1 } from "@housekeeper/contracts";

import { AuthorizationError, withAuthorizedTransaction } from "./database.js";
import { IdempotencyConflictError, executeIdempotentCommand } from "./idempotency.js";


const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const OLIVO_HOUSEHOLD = "20000000-0000-4000-8000-000000000001";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

function commandEnvelope(operationId: string, note: string): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId,
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType: "expense",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload: { note },
  };
}

describe.runIf(Boolean(adminUrl))("contexto autorizado e idempotencia sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(() => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("fija contexto de hogar y RLS limita la lectura al propio hogar", async () => {
    const counts = await withAuthorizedTransaction(
      appPool,
      { userId: "fixture:roble:admin" },
      ROBLE_HOUSEHOLD,
      async (client, membership) => {
        expect(membership.role).toBe("family_admin");
        expect(membership.id).toBe(ROBLE_ADMIN_MEMBERSHIP);
        const own = await client.query("select count(*)::int as n from app.settlements");
        const leaked = await client.query(
          "select count(*)::int as n from app.settlements where household_id = $1",
          [OLIVO_HOUSEHOLD],
        );
        return { own: own.rows[0].n, leaked: leaked.rows[0].n };
      },
    );
    expect(counts).toEqual({ own: 1, leaked: 0 });
  });

  it("rechaza una membresía de otro hogar", async () => {
    await expect(
      withAuthorizedTransaction(
        appPool,
        { userId: "fixture:roble:admin" },
        OLIVO_HOUSEHOLD,
        async () => "unreachable",
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("ejecuta una vez, responde duplicate al reintento y conflict si cambia el payload", async () => {
    const operationId = randomUUID();
    let executions = 0;
    const run = (note: string) =>
      withAuthorizedTransaction(
        appPool,
        { userId: "fixture:roble:admin" },
        ROBLE_HOUSEHOLD,
        (client, membership) =>
          executeIdempotentCommand(client, commandEnvelope(operationId, note), membership.id, async () => {
            executions += 1;
            return { status: "accepted", resourceId: randomUUID() };
          }),
      );

    const first = await run("gasto de prueba");
    expect(first.status).toBe("accepted");
    const replay = await run("gasto de prueba");
    expect(replay.status).toBe("duplicate");
    expect(replay.operationId).toBe(operationId);
    expect(executions).toBe(1);

    await expect(run("payload alterado")).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
