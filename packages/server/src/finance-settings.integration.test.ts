import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandAckV1, type CommandEnvelopeV1 } from "@housekeeper/contracts";

import { financeCommandHandler } from "./commands/finance.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_housekeeper_app_login";

// Hogar dedicado (prefijo `ae…`, exclusivo de este fichero): con
// `fileParallelism: false` (vitest.config.ts) todas las suites de
// integración comparten una única base sin reset entre ficheros, así que esta
// suite no reutiliza ROBLE/OLIVO ni los hogares `ab…`/`ac…`/`ad…` de las
// otras suites de finanzas — siembra su propia cuenta, categoría, lote y
// transacciones para ejercer cuentas/categorías/reglas/deshacer de verdad.
const HH = "ae000000-0000-4000-8000-000000000001";
const ADMIN_USER = "fixture:finance-settings:admin";
const ADMIN_MEMBERSHIP = "ae010000-0000-4000-8000-000000000001";

const ADMIN: AuthenticatedPrincipal = { userId: ADMIN_USER };

const ACCOUNT = "ae100000-0000-4000-8000-000000000001";
const CAT_TRANSFER = "ae200000-0000-4000-8000-00000000000f";
const CAT_ROOT = "ae200000-0000-4000-8000-000000000001";
const BATCH = "ae500000-0000-4000-8000-000000000001";
const TX1 = "ae300000-0000-4000-8000-000000000001";
const TX2 = "ae300000-0000-4000-8000-000000000002";

// `normText` (domain/finance/text.ts) siempre normaliza a MAYÚSCULAS (mismo
// convenio que finance-events.integration.test.ts): el `provider_norm` real
// que escribiría el propio comando/pipeline es "TIENDA NORTE IT", nunca en
// minúsculas — así lo siembra esta fixture para que
// `finance.category.assignConcept` (que compara contra la columna
// ALMACENADA, sin recalcularla) encuentre las dos transacciones.
const PROVIDER_NORM = "TIENDA NORTE IT";

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.households (id, slug, display_name) VALUES
  ('${HH}', 'fixture-finance-settings-it', 'Fixture Ajustes Finanzas IT');

INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('${ADMIN_USER}', 'Fixture Admin Ajustes Finanzas IT');

INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('${ADMIN_MEMBERSHIP}', '${HH}', '${ADMIN_USER}', 'family_admin');

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${HH}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${HH}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id)
SELECT '${HH}', '${CAT_TRANSFER}', 'Transferencias IT', 'transferencia', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_categories
   WHERE household_id = '${HH}' AND kind = 'transferencia' AND parent_id IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id) VALUES
  ('${HH}', '${CAT_ROOT}', 'Hogar IT Ajustes', 'gasto', NULL);

INSERT INTO app.finance_accounts
  (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('${HH}', '${ACCOUNT}', 'Cuenta IT Ajustes', 'openbank', 'comun', 'familia', 'IT-AJU-0001', '[]'::jsonb, '[]'::jsonb);

INSERT INTO app.finance_import_batches (household_id, id, filename, bank, new_count, dup_count) VALUES
  ('${HH}', '${BATCH}', 'ajustes-it.xls', 'openbank', 2, 0);

INSERT INTO app.finance_transactions
  (household_id, id, account_id, batch_id, op_date, concept, provider, provider_norm,
   amount_cents, category_id, status, transfer_group_id, dedup_hash,
   recurrence, recurrence_manual, raw, currency_code) VALUES
  ('${HH}', '${TX1}', '${ACCOUNT}', '${BATCH}', current_date - 15,
   'COMPRA TIENDA NORTE IT UNO', 'TIENDA NORTE IT', '${PROVIDER_NORM}',
   -3200, NULL, 'pendiente', NULL, 'it-aju-0001', NULL, false, '{}'::jsonb, 'EUR'),
  ('${HH}', '${TX2}', '${ACCOUNT}', '${BATCH}', current_date - 5,
   'COMPRA TIENDA NORTE IT DOS', 'TIENDA NORTE IT', '${PROVIDER_NORM}',
   -1800, NULL, 'pendiente', NULL, 'it-aju-0002', NULL, false, '{}'::jsonb, 'EUR');

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

describe.runIf(Boolean(adminUrl))("comandos de ajustes del módulo de finanzas sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, payload: unknown): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [envelope(payload)], {
      finance: financeCommandHandler,
    });
    return result.acknowledgements[0] as CommandAckV1;
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

  it("actualiza una cuenta entera (nombre, tipo, titular, aliases, refs)", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.account.update", accountId: ACCOUNT, name: "Cuenta IT Renombrada",
      accountKind: "inversion", ownerLabel: "madre", ownerAliases: ["M. Demo IT"], transferRefs: ["REF-IT-1"],
    });
    expect(ack.status).toBe("accepted");
    const row = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select name, kind, owner_label, owner_aliases, transfer_refs
           from app.finance_accounts where household_id = $1 and id = $2`, [HH, ACCOUNT]);
      return loaded.rows[0];
    });
    expect(row).toMatchObject({ name: "Cuenta IT Renombrada", kind: "inversion", owner_label: "madre" });
    expect(row.owner_aliases).toEqual(["M. Demo IT"]);
    expect(row.transfer_refs).toEqual(["REF-IT-1"]);
  });

  it("crea una subcategoría heredando el kind del padre y la borra si está libre", async () => {
    const created = await run(ADMIN, {
      kind: "finance.category.create", name: "Menaje IT", categoryKind: "ingreso", parentId: CAT_ROOT,
    });
    expect(created.status).toBe("accepted");
    const kind = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select kind from app.finance_categories where household_id = $1 and id = $2`, [HH, created.resourceId]);
      return loaded.rows[0]?.kind;
    });
    expect(kind).toBe("gasto"); // hereda del padre aunque el payload dijera ingreso
    expect((await run(ADMIN, { kind: "finance.category.update", categoryId: created.resourceId, name: "Menaje IT 2" })).status).toBe("accepted");
    expect((await run(ADMIN, { kind: "finance.category.delete", categoryId: created.resourceId })).status).toBe("accepted");
  });

  it("no deja borrar una categoría en uso", async () => {
    await run(ADMIN, { kind: "finance.transaction.update", transactionId: TX1, categoryId: CAT_ROOT });
    const ack = await run(ADMIN, { kind: "finance.category.delete", categoryId: CAT_ROOT });
    expect(ack).toMatchObject({ status: "rejected", errorCode: "finance_category_in_use" });
  });

  it("category.assignConcept recategoriza en bloque, confirma y crea la regla", async () => {
    const ack = await run(ADMIN, {
      kind: "finance.category.assignConcept", provider: "TIENDA NORTE IT", categoryId: CAT_ROOT,
    });
    expect(ack.status).toBe("accepted");
    const rows = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select category_id, status from app.finance_transactions where household_id = $1 and id = any($2::uuid[])`,
        [HH, [TX1, TX2]]);
      return loaded.rows;
    });
    for (const row of rows) expect(row).toMatchObject({ category_id: CAT_ROOT, status: "confirmada" });
    const rule = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select rule_type, category_id, priority from app.finance_rules
          where household_id = $1 and pattern = 'TIENDA NORTE IT'`, [HH]);
      return loaded.rows[0];
    });
    expect(rule).toMatchObject({ rule_type: "proveedor_exacto", category_id: CAT_ROOT });
  });

  it("crea y borra reglas sueltas", async () => {
    const created = await run(ADMIN, {
      kind: "finance.rule.create", ruleType: "concepto_contiene", pattern: "PARKING IT", categoryId: CAT_ROOT,
    });
    expect(created.status).toBe("accepted");
    const priority = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select priority from app.finance_rules where household_id = $1 and id = $2`, [HH, created.resourceId]);
      return loaded.rows[0]?.priority;
    });
    expect(priority).toBe(100); // DEFAULT de la tabla: el payload no trajo priority
    expect((await run(ADMIN, { kind: "finance.rule.delete", ruleId: created.resourceId })).status).toBe("accepted");
    expect((await run(ADMIN, { kind: "finance.rule.delete", ruleId: created.resourceId }))).toMatchObject({
      status: "rejected", errorCode: "finance_rule_not_found",
    });
  });

  it("import.undo borra el lote y sus transacciones en cascada", async () => {
    const ack = await run(ADMIN, { kind: "finance.import.undo", batchId: BATCH });
    expect(ack.status).toBe("accepted");
    const left = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select count(*)::int as n from app.finance_transactions where household_id = $1 and batch_id = $2`, [HH, BATCH]);
      return loaded.rows[0].n;
    });
    expect(left).toBe(0);
    expect((await run(ADMIN, { kind: "finance.import.undo", batchId: BATCH }))).toMatchObject({
      status: "rejected", errorCode: "finance_batch_not_found",
    });
  });
});
