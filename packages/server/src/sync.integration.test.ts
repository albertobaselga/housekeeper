import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandEnvelopeV1 } from "@housekeeper/contracts";

import { submitExpenseHandler } from "./commands/expense.js";
import { processSyncBatch, type CommandHandlers } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const OLIVO_HOUSEHOLD = "20000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const HANDLERS: CommandHandlers = { expense: submitExpenseHandler };

function expenseEnvelope(operationId: string, overrides: Partial<CommandEnvelopeV1> = {}): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId,
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType: "expense",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload: {
      agreementId: ROBLE_AGREEMENT,
      incurredOn: "2026-08-05",
      description: "Farmacia sintética",
      amountCents: "1275",
    },
    ...overrides,
  };
}

describe.runIf(Boolean(adminUrl))("processSyncBatch con ACK parcial sobre Postgres real", () => {
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

  it("acepta el gasto de la empleada, replica como duplicate y detecta payload alterado", async () => {
    const operationId = randomUUID();
    const employee = { userId: "fixture:roble:employee" };

    const first = await processSyncBatch(appPool, employee, [expenseEnvelope(operationId)], HANDLERS);
    expect(first.acknowledgements).toHaveLength(1);
    expect(first.acknowledgements[0]).toMatchObject({ operationId, status: "accepted" });
    const resourceId = first.acknowledgements[0]?.resourceId;
    expect(resourceId).toBeTruthy();

    const persisted = await adminPool.query(
      "select status, amount_cents::text as cents from app.expenses where id = $1",
      [resourceId],
    );
    expect(persisted.rows[0]).toEqual({ status: "pending", cents: "1275" });

    const replay = await processSyncBatch(appPool, employee, [expenseEnvelope(operationId)], HANDLERS);
    expect(replay.acknowledgements[0]).toMatchObject({ operationId, status: "duplicate" });

    const tampered = await processSyncBatch(
      appPool,
      employee,
      [expenseEnvelope(operationId, { payload: { agreementId: ROBLE_AGREEMENT, incurredOn: "2026-08-05", description: "Otro texto", amountCents: "9999" } })],
      HANDLERS,
    );
    expect(tampered.acknowledgements[0]).toMatchObject({ operationId, status: "conflict", errorCode: "operation_conflict" });
  });

  it("un lote mixto responde ACK por comando sin bloquear al resto", async () => {
    const okId = randomUUID();
    const badPayloadId = randomUUID();
    const foreignId = randomUUID();
    const unsupportedId = randomUUID();

    const result = await processSyncBatch(
      appPool,
      { userId: "fixture:roble:employee" },
      [
        expenseEnvelope(okId),
        expenseEnvelope(badPayloadId, { payload: { amountCents: "-5" } }),
        expenseEnvelope(foreignId, { householdId: OLIVO_HOUSEHOLD }),
        expenseEnvelope(unsupportedId, { aggregateType: "wiki_page" }),
      ],
      HANDLERS,
    );

    const byId = new Map(result.acknowledgements.map((ack) => [ack.operationId, ack]));
    expect(byId.get(okId)).toMatchObject({ status: "accepted" });
    expect(byId.get(badPayloadId)).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });
    expect(byId.get(foreignId)).toMatchObject({ status: "rejected", errorCode: "not_authorized" });
    expect(byId.get(unsupportedId)).toMatchObject({ status: "rejected", errorCode: "unsupported_aggregate" });
  });

  it("rechaza roles sin permiso y payloads que RLS no permite persistir", async () => {
    const helperAck = await processSyncBatch(
      appPool,
      { userId: "fixture:roble:helper" },
      [expenseEnvelope(randomUUID())],
      HANDLERS,
    );
    expect(helperAck.acknowledgements[0]).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const unknownAgreement = await processSyncBatch(
      appPool,
      { userId: "fixture:roble:employee" },
      [
        expenseEnvelope(randomUUID(), {
          payload: {
            agreementId: randomUUID(),
            incurredOn: "2026-08-05",
            description: "Acuerdo inexistente",
            amountCents: "100",
          },
        }),
      ],
      HANDLERS,
    );
    expect(unknownAgreement.acknowledgements[0]).toMatchObject({
      status: "rejected",
      errorCode: "constraint_violation",
    });
  });
});
