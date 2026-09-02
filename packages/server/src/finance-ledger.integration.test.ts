import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandAckV1, type CommandEnvelopeV1 } from "@housekeeper/contracts";

import { financeCommandHandler } from "./commands/finance.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_housekeeper_app_login";

// Hogar dedicado (prefijo `ac…`, exclusivo de este fichero): NO se reutiliza
// ROBLE/OLIVO ni el hogar `ab…` de finance-review.integration.test.ts. Con
// `fileParallelism: false` (vitest.config.ts) todas las suites de integración
// comparten una única base sin reset entre ficheros, y
// `finance/queries.integration.test.ts` hace aserciones de conteo EXACTO sobre
// ROBLE (summary.incomeCents, breakdown.length, …): escribir manuales,
// inversiones y transferencias ahí las rompería en silencio.
const HH = "ac000000-0000-4000-8000-000000000001";
const ADMIN_USER = "fixture:finance-ledger:admin";
const ADMIN_MEMBERSHIP = "ac010000-0000-4000-8000-000000000001";

const ADMIN: AuthenticatedPrincipal = { userId: ADMIN_USER };

const FIN = {
  accountA: "ac100000-0000-4000-8000-000000000001",
  accountB: "ac100000-0000-4000-8000-000000000002",
  fund: "ac100000-0000-4000-8000-000000000003",
  cash: "ac100000-0000-4000-8000-000000000004",
  catGasto: "ac200000-0000-4000-8000-000000000001",
  batch: "ac500000-0000-4000-8000-000000000001",
  txImported: "ac300000-0000-4000-8000-000000000001",
} as const;

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.households (id, slug, display_name) VALUES
  ('${HH}', 'fixture-finance-ledger-it', 'Fixture Ledger Finanzas IT');

INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('${ADMIN_USER}', 'Fixture Admin Ledger Finanzas IT');

INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('${ADMIN_MEMBERSHIP}', '${HH}', '${ADMIN_USER}', 'family_admin');

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${HH}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${HH}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id)
SELECT '${HH}', 'ac200000-0000-4000-8000-00000000000f', 'Transferencias IT', 'transferencia', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_categories
   WHERE household_id = '${HH}' AND kind = 'transferencia' AND parent_id IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id) VALUES
  ('${HH}', '${FIN.catGasto}', 'Caja IT Ledger', 'gasto', NULL);

INSERT INTO app.finance_accounts
  (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('${HH}', '${FIN.accountA}', 'Cuenta IT Ledger A', 'caixabank', 'comun', 'familia', 'IT-LED-0001', '[]'::jsonb, '[]'::jsonb),
  ('${HH}', '${FIN.accountB}', 'Cuenta IT Ledger B', 'openbank', 'personal', 'padre', 'IT-LED-0002', '[]'::jsonb, '[]'::jsonb),
  ('${HH}', '${FIN.fund}', 'Fondo IT Ledger', 'openbank', 'inversion', 'familia', 'IT-LED-0003', '[]'::jsonb, '[]'::jsonb),
  ('${HH}', '${FIN.cash}', 'Efectivo', NULL, 'comun', 'familia', 'IT-LED-CASH', '[]'::jsonb, '[]'::jsonb);

INSERT INTO app.finance_import_batches (household_id, id, filename, bank, new_count, dup_count) VALUES
  ('${HH}', '${FIN.batch}', 'ledger-it.xls', 'caixabank', 1, 0);

INSERT INTO app.finance_transactions
  (household_id, id, account_id, batch_id, op_date, concept, provider, provider_norm,
   amount_cents, category_id, status, transfer_group_id, dedup_hash, recurrence, recurrence_manual, raw, currency_code) VALUES
  ('${HH}', '${FIN.txImported}', '${FIN.accountA}', '${FIN.batch}', current_date - 5,
   'CARGO IMPORTADO IT', 'CARGO IT', 'cargo it', -9900, NULL, 'pendiente', NULL, 'it-led-0001', NULL, false, '{}'::jsonb, 'EUR');

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

describe.runIf(Boolean(adminUrl))("comandos de doble entrada de finanzas (manuales, inversión, transferencias) sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let manualId: string;
  let investGroup: string;

  async function run(principal: AuthenticatedPrincipal, payload: unknown): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [envelope(payload)], {
      finance: financeCommandHandler,
    });
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function txRow(id: string): Promise<{ status: string; category_id: string | null }> {
    return withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select status, category_id from app.finance_transactions where household_id = $1 and id = $2`,
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

  it("crea un manual, con dedup manual- y estado confirmada", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.manual.create",
      accountId: FIN.accountA,
      opDate: "2026-08-10",
      concept: "Fruta del mercado IT",
      provider: "Mercado IT",
      amountCents: "-1500",
      categoryId: FIN.catGasto,
    });
    expect(ack.status).toBe("accepted");
    manualId = ack.resourceId as string;
    const row = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select status, dedup_hash, batch_id, provider_norm from app.finance_transactions where household_id = $1 and id = $2`,
        [HH, manualId],
      );
      return loaded.rows[0];
    });
    expect(row.status).toBe("confirmada");
    expect(row.batch_id).toBeNull();
    expect(row.dedup_hash.startsWith("manual-")).toBe(true);
    // normText (@housekeeper/domain/finance) normaliza en MAYÚSCULAS (misma
    // convención que pipeline.ts y matchingFinanceTxIds): no en minúsculas.
    expect(row.provider_norm).toBe("MERCADO IT");
  });

  it("borra un manual; un importado no se puede borrar", async () => {
    expect((await run(ADMIN, { kind: "finance.transaction.manual.delete", transactionId: manualId })).status).toBe("accepted");
    const gone = await run(ADMIN, { kind: "finance.transaction.manual.delete", transactionId: manualId });
    expect(gone).toMatchObject({ status: "rejected", errorCode: "finance_transaction_not_found" });
    const imported = await run(ADMIN, { kind: "finance.transaction.manual.delete", transactionId: FIN.txImported });
    expect(imported).toMatchObject({ status: "rejected", errorCode: "finance_not_manual" });
  });

  it("un gasto manual en la cuenta Efectivo nace con su contrapartida cashpair-", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.transaction.manual.create",
      accountId: FIN.cash,
      opDate: "2026-08-12",
      concept: "Cañas del domingo IT",
      amountCents: "-1500",
      categoryId: FIN.catGasto,
    });
    expect(ack.status).toBe("accepted");
    const pair = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select account_id, amount_cents::text as amount_cents, status, recurrence_manual, batch_id, concept
           from app.finance_transactions
          where household_id = $1
            and dedup_hash = 'cashpair-' || (
              select dedup_hash from app.finance_transactions where household_id = $1 and id = $2)`,
        [HH, ack.resourceId],
      );
      return loaded.rows[0];
    });
    expect(pair).toMatchObject({
      account_id: FIN.cash,
      amount_cents: "1500",
      status: "confirmada",
      recurrence_manual: true,
      batch_id: null,
    });
    expect(pair.concept).toBe("Contrapartida efectivo — Cañas del domingo IT");
    // Y borrar el gasto se lleva su contrapartida por delante (cascada del Step 3).
    expect((await run(ADMIN, { kind: "finance.transaction.manual.delete", transactionId: ack.resourceId as string })).status).toBe("accepted");
    const left = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select count(*)::int as n from app.finance_transactions
          where household_id = $1 and dedup_hash like 'cashpair-%'`,
        [HH],
      );
      return loaded.rows[0].n as number;
    });
    expect(left).toBe(0);
  });

  it("marca un cargo como inversión creando la pata espejo invmirror-", async () => {
    const ack = await run(ADMIN, { kind: "finance.transaction.invest", transactionId: FIN.txImported, accountId: FIN.fund });
    expect(ack.status).toBe("accepted");
    const legs = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select account_id, amount_cents::text as amount_cents, status, dedup_hash
           from app.finance_transactions
          where household_id = $1 and transfer_group_id = $2 order by amount_cents`,
        [HH, ack.resourceId],
      );
      return loaded.rows;
    });
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ account_id: FIN.accountA, amount_cents: "-9900", status: "confirmada" });
    expect(legs[1]).toMatchObject({ account_id: FIN.fund, amount_cents: "9900" });
    expect(legs[1].dedup_hash).toBe("invmirror-it-led-0001");
    investGroup = ack.resourceId as string;
  });

  it("desvincular un grupo con espejo borra el espejo y devuelve la pata real a pendiente", async () => {
    expect((await run(ADMIN, { kind: "finance.transfers.unlink", transferGroupId: investGroup })).status).toBe("accepted");
    const row = await txRow(FIN.txImported);
    expect(row.status).toBe("pendiente");
    expect(row.category_id).toBeNull();
  });

  it("vincula dos manuales que suman cero y rechaza una selección que no suma cero", async () => {
    const cargo = await run(ADMIN, {
      kind: "finance.transaction.manual.create", accountId: FIN.accountA, opDate: "2026-08-11",
      concept: "Traspaso IT salida", amountCents: "-5000",
    });
    const abono = await run(ADMIN, {
      kind: "finance.transaction.manual.create", accountId: FIN.accountB, opDate: "2026-08-11",
      concept: "Traspaso IT entrada", amountCents: "5000",
    });
    const bad = await run(ADMIN, {
      kind: "finance.transfers.link",
      transactionIds: [cargo.resourceId as string, FIN.txImported],
    });
    expect(bad).toMatchObject({ status: "rejected", errorCode: "finance_transfer_sum_not_zero" });
    const good = await run(ADMIN, {
      kind: "finance.transfers.link",
      transactionIds: [cargo.resourceId as string, abono.resourceId as string],
    });
    expect(good.status).toBe("accepted");
    const unlink = await run(ADMIN, { kind: "finance.transfers.unlink", transferGroupId: good.resourceId as string });
    expect(unlink.status).toBe("accepted");
  });
});
