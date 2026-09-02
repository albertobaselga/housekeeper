import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandAckV1, type CommandEnvelopeV1 } from "@housekeeper/contracts";
import { financeWritePayloadSchema } from "@housekeeper/contracts/schemas";

import { financeCommandHandler } from "./commands/finance.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_housekeeper_app_login";

// Los hogares fixture compartidos (roble/olivo) los usan otras suites con
// aserciones de conteo EXACTO (finance/queries.integration.test.ts en
// particular) y, sobre roble, la concesión viva de 002_finance.sql. Esta
// suite necesita crear cuentas, transacciones y un evento propios para
// ejercer transaction.update/bulk/assignConceptRecurrence de verdad — así que
// siembra un TERCER hogar (prefijo `ab…`, exclusivo de este fichero) con su
// propia administración y su propia concesión, en vez de escribir sobre
// roble u olivo. Roble y olivo se usan aquí SOLO de lectura (comandos que se
// rechazan antes de tocar ninguna fila de finanzas).
const ROBLE = "10000000-0000-4000-8000-000000000001";
const OLIVO = "20000000-0000-4000-8000-000000000001";
const HH = "ab000000-0000-4000-8000-000000000001";
const ADMIN_USER = "fixture:finance-review:admin";
const ADMIN_MEMBERSHIP = "ab010000-0000-4000-8000-000000000001";

const ADMIN: AuthenticatedPrincipal = { userId: ADMIN_USER };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };
const OLIVO_ADMIN_NO_GRANT: AuthenticatedPrincipal = { userId: "fixture:olivo:admin" };

const FIN = {
  account: "ab100000-0000-4000-8000-000000000001",
  catTransfer: "ab200000-0000-4000-8000-00000000000f",
  catRoot: "ab200000-0000-4000-8000-000000000001",
  catSub: "ab200000-0000-4000-8000-000000000002",
  txPend1: "ab300000-0000-4000-8000-000000000001",
  txPend2: "ab300000-0000-4000-8000-000000000002",
  event: "ab400000-0000-4000-8000-000000000001",
} as const;

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.households (id, slug, display_name) VALUES
  ('${HH}', 'fixture-finance-review-it', 'Fixture Revisión Finanzas IT');

INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('${ADMIN_USER}', 'Fixture Admin Revisión Finanzas IT');

INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('${ADMIN_MEMBERSHIP}', '${HH}', '${ADMIN_USER}', 'family_admin');

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id) VALUES
  ('${HH}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id) VALUES
  ('${HH}', '${FIN.catTransfer}', 'Transferencias IT', 'transferencia', NULL),
  ('${HH}', '${FIN.catRoot}', 'Casa IT Revision', 'gasto', NULL),
  ('${HH}', '${FIN.catSub}', 'Luz IT Revision', 'gasto', '${FIN.catRoot}');

INSERT INTO app.finance_accounts
  (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('${HH}', '${FIN.account}', 'Cuenta IT Revision', 'openbank', 'comun', 'familia', 'IT-REV-0001', '[]'::jsonb, '[]'::jsonb);

INSERT INTO app.finance_transactions
  (household_id, id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
   amount_cents, balance_cents, category_id, status, transfer_group_id, dedup_hash,
   recurrence, recurrence_manual, raw, currency_code) VALUES
  ('${HH}', '${FIN.txPend1}', '${FIN.account}', NULL, current_date - 20, NULL,
   'RECIBO ACME LUZ IT JULIO', 'ACME LUZ IT', 'ACME LUZ IT',
   -4200, NULL, NULL, 'pendiente', NULL, 'it-rev-0001', NULL, false, '{}'::jsonb, 'EUR'),
  ('${HH}', '${FIN.txPend2}', '${FIN.account}', NULL, current_date - 10, NULL,
   'RECIBO ACME LUZ IT AGOSTO', 'ACME LUZ IT', 'ACME LUZ IT',
   -4300, NULL, NULL, 'pendiente', NULL, 'it-rev-0002', NULL, false, '{}'::jsonb, 'EUR');

INSERT INTO app.finance_events (household_id, id, name) VALUES
  ('${HH}', '${FIN.event}', 'Evento IT Revision');

-- Alias del proveedor de las dos transacciones fixture: casa por display
-- normalizado, no por provider_norm — ejercita la rama de alias de
-- matchingFinanceTxIds (Issue #2 de la revisión ronda 1).
INSERT INTO app.finance_provider_aliases (household_id, provider_norm, display) VALUES
  ('${HH}', 'ACME LUZ IT', 'Acme Luz [alias]');

COMMIT;
`;

function envelope(payload: unknown, householdId: string = HH): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId,
    schemaVersion: 1,
    aggregateType: "finance",
    aggregateId: null,
    baseRevision: null,
    occurredAt: new Date().toISOString(),
    payload,
  } as CommandEnvelopeV1;
}

describe.runIf(Boolean(adminUrl))("comandos de revisión de finanzas sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(
    principal: AuthenticatedPrincipal,
    payload: unknown,
    householdId: string = HH,
  ): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [envelope(payload, householdId)], {
      finance: financeCommandHandler,
    });
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function txRow(id: string): Promise<{ status: string; category_id: string | null; recurrence: string | null; recurrence_manual: boolean }> {
    return withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select status, category_id, recurrence, recurrence_manual
           from app.finance_transactions where household_id = $1 and id = $2`,
        [HH, id],
      );
      return loaded.rows[0];
    });
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await adminPool.query(SEED);
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("un miembro de familia sin rol admin recibe rejected", async () => {
    // Se dispara contra ROBLE, el único hogar donde este principal es
    // realmente family_member: así el rechazo nace del rol (`requireFinanceAdmin`),
    // no de una membresía inexistente en el hogar dedicado de esta suite.
    const ack = await run(
      FAMILY,
      { kind: "finance.transaction.update", transactionId: FIN.txPend1, categoryId: FIN.catSub },
      ROBLE,
    );
    expect(ack).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
  });

  it("actualiza la categoría de una transacción", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      categoryId: FIN.catSub,
    });
    expect(ack).toMatchObject({ status: "accepted", resourceId: FIN.txPend1 });
    expect((await txRow(FIN.txPend1)).category_id).toBe(FIN.catSub);
  });

  it("rechaza recategorizar a la raíz de transferencias", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      categoryId: FIN.catTransfer,
    });
    expect(ack).toMatchObject({ status: "rejected", errorCode: "finance_category_is_transfer" });
  });

  it("confirma con regla: crea la regla y el pipeline sugiere la gemela", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      status: "confirmada",
      createRule: { ruleType: "proveedor_exacto" },
    });
    expect(ack.status).toBe("accepted");
    const rule = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select rule_type, category_id, origin from app.finance_rules
          where household_id = $1 and pattern = 'ACME LUZ IT'`,
        [HH],
      );
      return loaded.rows[0];
    });
    expect(rule).toMatchObject({ rule_type: "proveedor_exacto", category_id: FIN.catSub, origin: "manual" });
    expect((await txRow(FIN.txPend2)).status).toBe("sugerida_regla");
  });

  it("confirma en bloque", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.bulk",
      transactionIds: [FIN.txPend2],
      status: "confirmada",
    });
    expect(ack.status).toBe("accepted");
    expect((await txRow(FIN.txPend2)).status).toBe("confirmada");
  });

  it("en bloque se puede cambiar solo la categoría, sin tocar el estado", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.bulk",
      transactionIds: [FIN.txPend2],
      categoryId: FIN.catRoot,
    });
    expect(ack.status).toBe("accepted");
    const row = await txRow(FIN.txPend2);
    expect(row.category_id).toBe(FIN.catRoot);
    expect(row.status).toBe("confirmada"); // el caso anterior ya lo confirmó: el bloque no lo revierte
  });

  it("en bloque rechaza recategorizar a la raíz de transferencias", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.bulk",
      transactionIds: [FIN.txPend2],
      categoryId: FIN.catTransfer,
    });
    expect(ack).toMatchObject({ status: "rejected", errorCode: "finance_category_is_transfer" });
  });

  it("en bloque rechaza si algún id de la selección no existe (todo o nada)", async () => {
    // Un id con formato válido pero que no existe en ningún hogar: el
    // comando entero se rechaza en vez de aplicar el cambio solo a txPend2.
    const missingId = "ab300000-0000-4000-8000-0000000000ff";
    const ack = await run(ADMIN, {
      kind: "finance.transactions.bulk",
      transactionIds: [FIN.txPend2, missingId],
      categoryId: FIN.catSub,
    });
    expect(ack).toMatchObject({ status: "rejected", errorCode: "finance_transaction_not_found" });
    // La categoría de txPend2 (fijada por el caso anterior) no cambió: no hay
    // aplicación parcial.
    expect((await txRow(FIN.txPend2)).category_id).toBe(FIN.catRoot);
  });

  it("fija la naturaleza en bloque por proveedor y marca el override manual", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.assignConceptRecurrence",
      provider: "ACME LUZ IT",
      recurrence: "recurrente",
    });
    expect(ack.status).toBe("accepted");
    const row = await txRow(FIN.txPend1);
    expect(row.recurrence).toBe("recurrente");
    expect(row.recurrence_manual).toBe(true);
    // El proveedor coincide en las dos transacciones fixture (sin categoría
    // ni concepto en el selector): a las dos les toca el cambio.
    expect((await txRow(FIN.txPend2)).recurrence).toBe("recurrente");
  });

  // Las siguientes cuatro pruebas cierran el Issue #2 de la ronda 1: las tres
  // ramas de matchingFinanceTxIds sin cubrir (categoría, alias, afinado por
  // concepto en memoria) y el rechazo por selector vacío. En este punto de la
  // secuencia txPend1 está en catSub y txPend2 en catRoot (fijado por los
  // casos de arriba), así que catRoot cubre a las dos por la rama de hijas
  // directas.

  it("selecciona por categoría: la raíz incluye a sus hijas directas", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.assignConceptRecurrence",
      categoryId: FIN.catRoot,
      recurrence: "extraordinario",
    });
    expect(ack.status).toBe("accepted");
    expect((await txRow(FIN.txPend1)).recurrence).toBe("extraordinario"); // vía catSub, hija de catRoot
    expect((await txRow(FIN.txPend2)).recurrence).toBe("extraordinario"); // vía catRoot directamente
  });

  it("acepta el proveedor por su alias, no solo por el texto literal", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.assignConceptRecurrence",
      provider: "Acme Luz [alias]",
      recurrence: "recurrente",
    });
    expect(ack.status).toBe("accepted");
    // Si el alias no casara, el selector no encontraría nada y el valor
    // seguiría en "extraordinario" (fijado por el caso anterior).
    expect((await txRow(FIN.txPend1)).recurrence).toBe("recurrente");
    expect((await txRow(FIN.txPend2)).recurrence).toBe("recurrente");
  });

  it("afina por concepto en memoria tras el filtro de proveedor en SQL", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.assignConceptRecurrence",
      provider: "ACME LUZ IT",
      concept: "recibo acme luz it julio", // solo el concepto de txPend1 (minúsculas: prueba la normalización)
      recurrence: "extraordinario",
    });
    expect(ack.status).toBe("accepted");
    expect((await txRow(FIN.txPend1)).recurrence).toBe("extraordinario");
    // txPend2 comparte proveedor pero no concepto: el afinado en memoria lo deja fuera.
    expect((await txRow(FIN.txPend2)).recurrence).toBe("recurrente");
  });

  it("rechaza el selector vacío: ni proveedor ni categoría", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transactions.assignConceptRecurrence",
      recurrence: "recurrente",
    });
    expect(ack).toMatchObject({ status: "rejected", errorCode: "finance_selector_required" });
  });

  it("asigna eventos por sustitución completa", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.update",
      transactionId: FIN.txPend1,
      eventIds: [FIN.event],
    });
    expect(ack.status).toBe("accepted");
    const links = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select event_id from app.finance_transaction_events
          where household_id = $1 and transaction_id = $2`,
        [HH, FIN.txPend1],
      );
      return loaded.rows;
    });
    expect(links).toEqual([{ event_id: FIN.event }]);
  });

  // El cerrojo estructural del dispatcher (requireFinanceAdmin antes de
  // despachar) tiene que valer para TODO kind de escritura, no solo para los
  // tres que esta tarea implementa de verdad: los 19 restantes, aún "no
  // implementados", entran igual por la puerta. Un payload mínimo `{ kind }`
  // basta porque la autorización corre ANTES del safeParse del esquema.
  // Se prueba contra roble/olivo (no el hogar dedicado de arriba): ninguno
  // de los dos casos llega a tocar una fila de finanzas.
  it("congela el cerrojo: TODO kind de financeWritePayloadSchema exige rol admin y concesión viva", async () => {
    const kinds = financeWritePayloadSchema.options.map((option) => option.shape.kind.value);
    expect(kinds.length).toBe(22);

    for (const kind of kinds) {
      const fromFamily = await run(FAMILY, { kind }, ROBLE);
      expect(fromFamily, `kind=${kind} (family_member)`).toMatchObject({
        status: "rejected",
        errorCode: "not_allowed",
      });

      const fromUngrantedAdmin = await run(OLIVO_ADMIN_NO_GRANT, { kind }, OLIVO);
      expect(fromUngrantedAdmin, `kind=${kind} (admin sin concesión)`).toMatchObject({
        status: "rejected",
        errorCode: "finance_not_granted",
      });
    }
  });
});
