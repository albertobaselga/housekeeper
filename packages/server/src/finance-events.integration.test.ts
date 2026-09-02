import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_VERSION, type CommandAckV1, type CommandEnvelopeV1 } from "@housekeeper/contracts";

import { financeCommandHandler } from "./commands/finance.js";
import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { processSyncBatch } from "./sync.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_housekeeper_app_login";

// Hogar dedicado (prefijo `ad…`, exclusivo de este fichero): con
// `fileParallelism: false` (vitest.config.ts) todas las suites de
// integración comparten una única base sin reset entre ficheros, así que
// esta suite NO reutiliza ROBLE/OLIVO ni los hogares `ab…`/`ac…` de las
// otras suites de finanzas — siembra su propia cuenta, categoría y
// transacciones para ejercer eventos/reglas/alias de verdad.
const HH = "ad000000-0000-4000-8000-000000000001";
const ADMIN_USER = "fixture:finance-events:admin";
const ADMIN_MEMBERSHIP = "ad010000-0000-4000-8000-000000000001";

const ADMIN: AuthenticatedPrincipal = { userId: ADMIN_USER };

const FIN = {
  account: "ad100000-0000-4000-8000-000000000001",
  category: "ad200000-0000-4000-8000-000000000001",
  tx1: "ad300000-0000-4000-8000-000000000001",
  tx2: "ad300000-0000-4000-8000-000000000002",
} as const;

// `normText` (domain/finance/text.ts) siempre normaliza a MAYÚSCULAS: el
// `provider_norm` real que escriben tanto esta fixture como el propio
// comando es "VIAJES SOL IT", nunca en minúsculas.
const PROVIDER_NORM = "VIAJES SOL IT";

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.households (id, slug, display_name) VALUES
  ('${HH}', 'fixture-finance-events-it', 'Fixture Eventos Finanzas IT');

INSERT INTO app.user_profiles (user_id, display_name) VALUES
  ('${ADMIN_USER}', 'Fixture Admin Eventos Finanzas IT');

INSERT INTO app.household_memberships (id, household_id, user_id, role) VALUES
  ('${ADMIN_MEMBERSHIP}', '${HH}', '${ADMIN_USER}', 'family_admin');

INSERT INTO app.finance_module_grants (household_id, membership_id, granted_by_membership_id)
SELECT '${HH}', '${ADMIN_MEMBERSHIP}', '${ADMIN_MEMBERSHIP}'
WHERE NOT EXISTS (
  SELECT 1 FROM app.finance_module_grants
   WHERE household_id = '${HH}' AND membership_id = '${ADMIN_MEMBERSHIP}' AND revoked_at IS NULL);

INSERT INTO app.finance_categories (household_id, id, name, kind, parent_id) VALUES
  ('${HH}', '${FIN.category}', 'Viajes IT Eventos', 'gasto', NULL);

INSERT INTO app.finance_accounts
  (household_id, id, name, bank, kind, owner_label, bank_ref, owner_aliases, transfer_refs) VALUES
  ('${HH}', '${FIN.account}', 'Cuenta IT Eventos', 'openbank', 'comun', 'familia', 'IT-EVT-0001', '[]'::jsonb, '[]'::jsonb);

INSERT INTO app.finance_transactions
  (household_id, id, account_id, batch_id, op_date, value_date, concept, provider, provider_norm,
   amount_cents, balance_cents, category_id, status, transfer_group_id, dedup_hash,
   recurrence, recurrence_manual, raw, currency_code) VALUES
  ('${HH}', '${FIN.tx1}', '${FIN.account}', NULL, current_date - 15, NULL,
   'VIAJES SOL IT BILLETE', 'VIAJES SOL IT', '${PROVIDER_NORM}',
   -10000, NULL, '${FIN.category}', 'pendiente', NULL, 'it-evt-0001', NULL, false, '{}'::jsonb, 'EUR'),
  ('${HH}', '${FIN.tx2}', '${FIN.account}', NULL, current_date - 5, NULL,
   'VIAJES SOL IT HOTEL', 'VIAJES SOL IT', '${PROVIDER_NORM}',
   -20000, NULL, '${FIN.category}', 'pendiente', NULL, 'it-evt-0002', NULL, false, '{}'::jsonb, 'EUR');

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

describe.runIf(Boolean(adminUrl))("comandos de eventos y alias de proveedores de finanzas sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let eventId: string;
  let otherId: string;
  let categoryEventId: string;

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

  async function linkCount(id: string): Promise<number> {
    return withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select count(*)::int as n from app.finance_transaction_events where household_id = $1 and event_id = $2`,
        [HH, id],
      );
      return loaded.rows[0].n as number;
    });
  }

  async function ruleCountForEvent(id: string): Promise<number> {
    return withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select count(*)::int as n from app.finance_event_rules where household_id = $1 and event_id = $2`,
        [HH, id],
      );
      return loaded.rows[0].n as number;
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

  it("crea, renombra y rechaza nombres duplicados (case-insensitive)", async () => {
    const created = await run(ADMIN, { kind: "finance.event.create", name: "Semana Santa IT" });
    expect(created.status).toBe("accepted");
    eventId = created.resourceId as string;
    const dup = await run(ADMIN, { kind: "finance.event.create", name: "semana santa it" });
    expect(dup).toMatchObject({ status: "rejected", errorCode: "finance_event_name_taken" });
    const renamed = await run(ADMIN, { kind: "finance.event.update", eventId, name: "Semana Santa IT 2026" });
    expect(renamed.status).toBe("accepted");
  });

  it("asigna y quita transacciones en bloque", async () => {
    const add = await run(ADMIN, {
      kind: "finance.event.assignTransactions",
      eventId,
      transactionIds: [FIN.tx1, FIN.tx2],
      action: "add",
    });
    expect(add.status).toBe("accepted");
    expect(await linkCount(eventId)).toBe(2);
    const remove = await run(ADMIN, {
      kind: "finance.event.assignTransactions",
      eventId,
      transactionIds: [FIN.tx2],
      action: "remove",
    });
    expect(remove.status).toBe("accepted");
    expect(await linkCount(eventId)).toBe(1);
  });

  it("assignConcept por proveedor crea la regla y asigna en exclusiva", async () => {
    const other = await run(ADMIN, { kind: "finance.event.create", name: "Otro IT" });
    const ack = await run(ADMIN, {
      kind: "finance.event.assignConcept",
      provider: "VIAJES SOL IT",
      eventId: other.resourceId,
    });
    expect(ack.status).toBe("accepted");
    // exclusivo: TX1 estaba en eventId y ahora SOLO está en el otro
    expect(await linkCount(eventId)).toBe(0);
    expect(await linkCount(other.resourceId as string)).toBe(2);
    const rule = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select event_id from app.finance_event_rules where household_id = $1 and provider_norm = $2`,
        [HH, PROVIDER_NORM],
      );
      return loaded.rows[0];
    });
    expect(rule).toMatchObject({ event_id: other.resourceId });
    otherId = other.resourceId as string;
  });

  it("assignConcept sin evento borra la regla y los vínculos", async () => {
    const ack = await run(ADMIN, { kind: "finance.event.assignConcept", provider: "VIAJES SOL IT", eventId: null });
    expect(ack.status).toBe("accepted");
    expect(await linkCount(otherId)).toBe(0);
  });

  it("alias: upsert y borrado con alias vacío", async () => {
    expect(
      (await run(ADMIN, { kind: "finance.alias.update", provider: "VIAJES SOL IT", alias: "Sol Viajes" })).status,
    ).toBe("accepted");
    const display = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select display from app.finance_provider_aliases where household_id = $1 and provider_norm = $2`,
        [HH, PROVIDER_NORM],
      );
      return loaded.rows[0]?.display;
    });
    expect(display).toBe("Sol Viajes");
    expect((await run(ADMIN, { kind: "finance.alias.update", provider: "VIAJES SOL IT", alias: "" })).status).toBe(
      "accepted",
    );
  });

  it("borrar un evento desvincula sin borrar movimientos", async () => {
    await run(ADMIN, {
      kind: "finance.event.assignTransactions",
      eventId,
      transactionIds: [FIN.tx1],
      action: "add",
    });
    const ack = await run(ADMIN, { kind: "finance.event.delete", eventId });
    expect(ack.status).toBe("accepted");
    const tx = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(`select 1 from app.finance_transactions where household_id = $1 and id = $2`, [
        HH,
        FIN.tx1,
      ]);
      return loaded.rowCount;
    });
    expect(tx).toBe(1);
    // El CASCADE de 0036 sobre event_id debe haberse llevado por delante los
    // vínculos y las reglas de este evento: lo comprobamos explícitamente en
    // vez de confiar en que el propio nombre del test lo garantiza.
    expect(await linkCount(eventId)).toBe(0);
    expect(await ruleCountForEvent(eventId)).toBe(0);
  });

  it("assignConcept por categoría asigna en exclusiva y guarda la regla por category_id", async () => {
    const catEvent = await run(ADMIN, { kind: "finance.event.create", name: "Categoria IT Eventos" });
    expect(catEvent.status).toBe("accepted");
    categoryEventId = catEvent.resourceId as string;
    // FIN.tx1 y FIN.tx2 siguen ambos en FIN.category (ningún test previo les
    // cambió la categoría): el selector por categoría debe casar los dos.
    const ack = await run(ADMIN, {
      kind: "finance.event.assignConcept",
      categoryId: FIN.category,
      eventId: categoryEventId,
    });
    expect(ack).toMatchObject({ status: "accepted", resourceId: categoryEventId });
    expect(await linkCount(categoryEventId)).toBe(2);
    const rule = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select event_id, provider_norm, concept_norm
           from app.finance_event_rules
          where household_id = $1 and category_id = $2`,
        [HH, FIN.category],
      );
      return loaded.rows[0];
    });
    expect(rule).toMatchObject({ event_id: categoryEventId, provider_norm: null, concept_norm: null });
  });

  it("assignConcept con provider+concept y newEventName crea el evento implícito y guarda concept_norm", async () => {
    // FIN.tx1 tiene concepto "VIAJES SOL IT BILLETE"; FIN.tx2 "VIAJES SOL IT
    // HOTEL" — el filtro por concepto es una igualdad exacta tras
    // normText(normalizeConcept(...)) (domain/finance/event-rules.ts), así
    // que este selector debe casar SOLO tx1, aunque ambos compartan proveedor.
    const ack = await run(ADMIN, {
      kind: "finance.event.assignConcept",
      provider: "VIAJES SOL IT",
      concept: "VIAJES SOL IT BILLETE",
      newEventName: "Evento Implicito IT",
    });
    expect(ack.status).toBe("accepted");
    const newEventId = ack.resourceId as string;
    expect(newEventId).toBeTruthy();
    // Exclusivo: tx1 sale de categoryEventId (donde había entrado por
    // categoría en el test anterior) y entra SOLO en el evento nuevo; tx2 no
    // casa por concepto y se queda donde estaba.
    expect(await linkCount(newEventId)).toBe(1);
    expect(await linkCount(categoryEventId)).toBe(1);
    const rule = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(
        `select event_id, concept_norm from app.finance_event_rules where household_id = $1 and provider_norm = $2`,
        [HH, PROVIDER_NORM],
      );
      return loaded.rows[0];
    });
    expect(rule).toMatchObject({ event_id: newEventId, concept_norm: "VIAJES SOL IT BILLETE" });
    const createdEvent = await withAuthorizedTransaction(appPool, ADMIN, HH, async (client) => {
      const loaded = await client.query(`select name from app.finance_events where household_id = $1 and id = $2`, [
        HH,
        newEventId,
      ]);
      return loaded.rows[0]?.name;
    });
    expect(createdEvent).toBe("Evento Implicito IT");
  });

  // F5-I4: la restricción global de la rama dice que un id de otro hogar (o ya
  // borrado) se RECHAZA, nunca se ignora en silencio. Misma semántica de todo o
  // nada que `finance.transactions.bulk`, y en los dos sentidos: añadir y quitar.
  it("assignTransactions rechaza un id que no existe en el hogar sin escribir ni borrar nada", async () => {
    const missingTx = "ad300000-0000-4000-8000-0000000000ff";
    const target = await run(ADMIN, { kind: "finance.event.create", name: "Todo o Nada IT" });
    expect(target.status).toBe("accepted");
    const targetId = target.resourceId as string;

    const addBad = await run(ADMIN, {
      kind: "finance.event.assignTransactions",
      eventId: targetId,
      transactionIds: [FIN.tx1, missingTx],
      action: "add",
    });
    expect(addBad).toMatchObject({ status: "rejected", errorCode: "finance_transaction_not_found" });
    // Ni siquiera el id válido de la selección quedó asignado.
    expect(await linkCount(targetId)).toBe(0);

    const addGood = await run(ADMIN, {
      kind: "finance.event.assignTransactions",
      eventId: targetId,
      transactionIds: [FIN.tx1],
      action: "add",
    });
    expect(addGood.status).toBe("accepted");
    expect(await linkCount(targetId)).toBe(1);

    // En el camino `remove` el rowCount del delete no sirve de comprobación (un
    // movimiento existente puede no estar asignado): la existencia se comprueba
    // ANTES, y el vínculo bueno sobrevive al rechazo.
    const removeBad = await run(ADMIN, {
      kind: "finance.event.assignTransactions",
      eventId: targetId,
      transactionIds: [FIN.tx1, missingTx],
      action: "remove",
    });
    expect(removeBad).toMatchObject({ status: "rejected", errorCode: "finance_transaction_not_found" });
    expect(await linkCount(targetId)).toBe(1);
  });

  it("assignConcept rechaza un categoryId que no existe en el hogar sin borrar la regla previa", async () => {
    const missingCategory = "ad200000-0000-4000-8000-0000000000ff";
    const linksBefore = await linkCount(categoryEventId);
    const rulesBefore = await ruleCountForEvent(categoryEventId);

    // Desasignar (eventId: null) con una categoría ajena: hoy el selector no
    // casa con nada y el comando se acusaba `ok` sin haber validado nada.
    const unassign = await run(ADMIN, {
      kind: "finance.event.assignConcept",
      categoryId: missingCategory,
      eventId: null,
    });
    expect(unassign).toMatchObject({ status: "rejected", errorCode: "finance_category_not_found" });

    // Y asignando a un evento real: se rechaza igual, y sin haber borrado antes
    // la regla del evento (la guarda va POR DELANTE del delete).
    const assign = await run(ADMIN, {
      kind: "finance.event.assignConcept",
      categoryId: missingCategory,
      eventId: categoryEventId,
    });
    expect(assign).toMatchObject({ status: "rejected", errorCode: "finance_category_not_found" });

    expect(await linkCount(categoryEventId)).toBe(linksBefore);
    expect(await ruleCountForEvent(categoryEventId)).toBe(rulesBefore);
  });
});
