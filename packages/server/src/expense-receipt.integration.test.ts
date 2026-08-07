import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { submitExpenseHandler } from "./commands/expense.js";
import { processSyncBatch, type CommandHandlers } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

const HANDLERS: CommandHandlers = { expense: submitExpenseHandler };

function submitEnvelope(payload: Record<string, unknown>): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType: "expense",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T12:00:00.000Z",
    payload: { agreementId: ROBLE_AGREEMENT, ...payload },
  };
}

// Fechas de julio 2025: mes propio de este suite para no pisar las fixtures
// (marzo), el recorrido de liquidación (abril) ni expense-extra (junio).
describe.runIf(Boolean(adminUrl))("gasto con justificante adjunto (receiptStorageObjectId)", () => {
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

  async function run(command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, EMPLOYEE, [command], HANDLERS);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  /** Siembra un storage_object con el pool admin (bypassrls), como haría la ruta de adjuntos. */
  async function seedStorageObject(createdByMembershipId: string): Promise<string> {
    const key = `receipts/${randomUUID()}.jpg`;
    const sha256 = createHash("sha256").update(key).digest("hex");
    const inserted = await adminPool.query<{ id: string }>(
      `insert into app.storage_objects
         (household_id, bucket, object_key, media_type, byte_size, sha256, created_by_membership_id)
       values ($1, 'casa-clara-it', $2, 'image/jpeg', 2048, $3, $4)
       returning id`,
      [ROBLE_HOUSEHOLD, key, sha256, createdByMembershipId],
    );
    return inserted.rows[0]!.id;
  }

  it("enlaza el justificante: crea app.documents y fija receipt_document_id", async () => {
    const storageObjectId = await seedStorageObject(ROBLE_EMPLOYEE_MEMBERSHIP);

    const ack = await run(
      submitEnvelope({
        incurredOn: "2025-07-03",
        description: "Farmacia con ticket de julio",
        amountCents: "1250",
        receiptStorageObjectId: storageObjectId,
      }),
    );
    expect(ack).toMatchObject({ status: "accepted" });

    const expense = await adminPool.query(
      `select status, receipt_document_id from app.expenses where id = $1`,
      [ack.resourceId],
    );
    expect(expense.rows[0]!.status).toBe("pending");
    expect(expense.rows[0]!.receipt_document_id).not.toBeNull();

    const document = await adminPool.query(
      `select storage_object_id, visibility, document_type, title,
              owner_membership_id, created_by_membership_id
         from app.documents where household_id = $1 and id = $2`,
      [ROBLE_HOUSEHOLD, expense.rows[0]!.receipt_document_id],
    );
    expect(document.rows[0]).toEqual({
      storage_object_id: storageObjectId,
      visibility: "employment",
      document_type: "expense_receipt",
      title: "Farmacia con ticket de julio",
      owner_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      created_by_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
    });
  });

  it("rechaza un storage_object ajeno (subido por otra membresía) sin dejar rastro", async () => {
    const foreignObjectId = await seedStorageObject(ROBLE_ADMIN_MEMBERSHIP);

    const ack = await run(
      submitEnvelope({
        incurredOn: "2025-07-08",
        description: "Intento con objeto ajeno",
        amountCents: "900",
        receiptStorageObjectId: foreignObjectId,
      }),
    );
    expect(ack).toMatchObject({ status: "rejected", errorCode: "receipt_not_found" });

    // Ni gasto ni documento: la transacción del comando se revirtió entera.
    const expenses = await adminPool.query(
      `select id from app.expenses where household_id = $1 and description = 'Intento con objeto ajeno'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(expenses.rows).toHaveLength(0);
    const documents = await adminPool.query(
      `select id from app.documents where household_id = $1 and storage_object_id = $2`,
      [ROBLE_HOUSEHOLD, foreignObjectId],
    );
    expect(documents.rows).toHaveLength(0);
  });

  it("rechaza un identificador inexistente con receipt_not_found", async () => {
    const ack = await run(
      submitEnvelope({
        incurredOn: "2025-07-10",
        description: "Justificante fantasma",
        amountCents: "500",
        receiptStorageObjectId: randomUUID(),
      }),
    );
    expect(ack).toMatchObject({ status: "rejected", errorCode: "receipt_not_found" });
  });

  it("sin justificante el alta de gasto sigue funcionando igual", async () => {
    const ack = await run(
      submitEnvelope({
        incurredOn: "2025-07-15",
        description: "Gasto de julio sin foto",
        amountCents: "760",
      }),
    );
    expect(ack).toMatchObject({ status: "accepted" });

    const expense = await adminPool.query(
      `select status, receipt_document_id from app.expenses where id = $1`,
      [ack.resourceId],
    );
    expect(expense.rows[0]).toEqual({ status: "pending", receipt_document_id: null });
  });
});
