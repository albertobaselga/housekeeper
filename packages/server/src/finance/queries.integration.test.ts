import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, withAuthorizedTransaction } from "../database.js";
import {
  readFinanceAccounts,
  readFinanceCategories,
  readFinanceEvents,
  readFinanceTransactions,
  type FinanceTransactionsQuery,
} from "./queries.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
// El rol de login sin BYPASSRLS lo crea el global setup del paquete
// (test-support/global-setup.mjs, INTEGRATION_APP_LOGIN): es housekeeper, no
// casa_clara — el prototipo de ese nombre ya no vive en este repo.
const APP_LOGIN = "it_housekeeper_app_login";
const ROBLE = "10000000-0000-4000-8000-000000000001";
const OLIVO = "20000000-0000-4000-8000-000000000001";

// Fixture (002_finance.sql): TX1 está enlazada al evento EVENT1 y su
// `provider_norm` tiene alias; TX2 no tiene evento ni alias.
const TX1 = "f1e00000-0000-4000-8000-000000000001";
const TX2 = "f1e00000-0000-4000-8000-000000000002";
const EVENT1 = "f1f00000-0000-4000-8000-000000000001";

const WIDE: FinanceTransactionsQuery = {
  from: "2020-01-01", to: "2030-12-31", accountIds: [], eventId: null, excludeEventIds: [],
  q: null, categoryId: null, recurrence: null, status: null, ids: [], groupIds: [],
  limit: 1000, offset: 0,
};

describe.runIf(Boolean(adminUrl))("lecturas de finanzas bajo RLS (fase 4, doble cerrojo de §4)", () => {
  let appPool: pg.Pool;

  beforeAll(() => {
    const url = new URL(adminUrl!);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
  });

  const as = <T>(userId: string, householdId: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> =>
    withAuthorizedTransaction(appPool, { userId }, householdId, (client) => fn(client));

  it("el admin de roble CON concesión ve cuentas y movimientos de su hogar", async () => {
    const accounts = await as("fixture:roble:admin", ROBLE, (client) => readFinanceAccounts(client, ROBLE));
    expect(accounts.length).toBeGreaterThan(0);
    const page = await as("fixture:roble:admin", ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
    expect(page.total).toBeGreaterThan(0);
    for (const row of page.rows) {
      expect(row.amountCents).toMatch(/^-?\d+$/);
      expect(row.accountName.length).toBeGreaterThan(0);
    }
  });

  it("la paginación explícita conserva el total: nunca truncar en silencio", async () => {
    const all = await as("fixture:roble:admin", ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
    const second = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, limit: 1, offset: 1 }));
    expect(second.total).toBe(all.total);
    expect(second.sumCents).toBe(all.sumCents);
    if (all.total > 1) {
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]!.id).toBe(all.rows[1]!.id);
    }
    const beyond = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, offset: all.total + 100 }));
    expect(beyond.rows).toHaveLength(0);
    expect(beyond.total).toBe(all.total);
  });

  it("eventIds y providerDisplay llegan poblados desde las tablas de apoyo", async () => {
    const page = await as("fixture:roble:admin", ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
    const tx1 = page.rows.find((row) => row.id === TX1);
    const tx2 = page.rows.find((row) => row.id === TX2);
    expect(tx1?.eventIds).toEqual([EVENT1]);
    expect(tx1?.providerDisplay).toBe("Mercado Ejemplo");
    expect(tx2?.eventIds).toEqual([]);
    expect(tx2?.providerDisplay).toBe("Empresa Fixture");
  });

  it("eventId y excludeEventIds filtran conjuntos complementarios ($n no se desplaza)", async () => {
    const withEvent = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, eventId: EVENT1 }));
    expect(withEvent.rows.map((row) => row.id)).toEqual([TX1]);

    const withoutEvent = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, excludeEventIds: [EVENT1] }));
    const withoutEventIds = withoutEvent.rows.map((row) => row.id);
    expect(withoutEventIds).not.toContain(TX1);
    expect(withoutEventIds).toContain(TX2);

    const all = await as("fixture:roble:admin", ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
    expect(withEvent.total + withoutEvent.total).toBe(all.total);
  });

  it("q busca por concepto/proveedor/alias, y la petición exacta por ids toma la rama de $n distinta", async () => {
    const byAlias = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, q: "mercado" }));
    expect(byAlias.rows.map((row) => row.id)).toEqual([TX1]);

    const byIds = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceTransactions(client, ROBLE, { ...WIDE, ids: [TX1], groupIds: [] }));
    expect(byIds.rows.map((row) => row.id)).toEqual([TX1]);
  });

  it("readFinanceCategories y readFinanceEvents devuelven los catálogos del hogar", async () => {
    const categories = await as("fixture:roble:admin", ROBLE, (client) => readFinanceCategories(client, ROBLE));
    expect(categories.some((c) => c.name === "Casa" && c.parentId === null)).toBe(true);
    expect(categories.some((c) => c.name === "Supermercado" && c.parentId !== null)).toBe(true);

    const events = await as("fixture:roble:admin", ROBLE, (client) => readFinanceEvents(client, ROBLE));
    expect(events).toEqual([{ id: EVENT1, name: "Semana Santa 2026" }]);
  });

  it("el admin de olivo SIN concesión ve cero filas aunque su hogar tiene datos", async () => {
    const accounts = await as("fixture:olivo:admin", OLIVO, (client) => readFinanceAccounts(client, OLIVO));
    expect(accounts).toEqual([]);
    const page = await as("fixture:olivo:admin", OLIVO, (client) => readFinanceTransactions(client, OLIVO, WIDE));
    expect(page.total).toBe(0);
  });

  it("empleada, apoyo y visor de roble ven cero filas por rol", async () => {
    for (const userId of ["fixture:roble:employee", "fixture:roble:helper", "fixture:roble:viewer"]) {
      const page = await as(userId, ROBLE, (client) => readFinanceTransactions(client, ROBLE, WIDE));
      expect(page.total).toBe(0);
    }
  });

  it("cruzar de hogar sin membresía es AuthorizationError, no un hogar vacío", async () => {
    await expect(
      as("fixture:roble:admin", OLIVO, (client) => readFinanceAccounts(client, OLIVO)),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
