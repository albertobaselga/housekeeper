import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, withAuthorizedTransaction } from "../database.js";
import {
  readFinanceAccounts,
  readFinanceAnalytics,
  readFinanceBreakdown,
  readFinanceCategories,
  readFinanceEventDetail,
  readFinanceEvents,
  readFinanceEventsSummary,
  readFinancePivot,
  readFinanceProviders,
  readFinanceSeries,
  readFinanceSummary,
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

  const RANGE = { from: "2020-01-01", to: "2030-12-31", accountIds: [], eventId: null, excludeEventIds: [] };

  it("summary: ahorro = ingresos + gastos, con periodo anterior y pendientes", async () => {
    const summary = await as("fixture:roble:admin", ROBLE, (client) => readFinanceSummary(client, ROBLE, RANGE));
    expect(BigInt(summary.savingsCents)).toBe(BigInt(summary.incomeCents) + BigInt(summary.expenseCents));
    expect(
      BigInt(summary.recurringExpenseCents) + BigInt(summary.extraordinaryExpenseCents) + BigInt(summary.unclassifiedExpenseCents),
    ).toBe(BigInt(summary.expenseCents));
    expect(summary.prev).not.toBeNull();
    expect(summary.pendingCount).toBeGreaterThanOrEqual(0);
    // Valores dorados del fixture (002_finance.sql): roble tiene EXACTAMENTE dos
    // movimientos en rango — TX1 -2350 (Supermercado, confirmada) y TX2 +180000
    // (sin categoría, pendiente, recurrence NULL). Sin esto, un resultado vacío
    // (join mal escrito, filtro de más) satisface igual las aserciones de arriba.
    expect(summary.incomeCents).toBe("180000");
    expect(summary.expenseCents).toBe("-2350");
    expect(summary.unclassifiedExpenseCents).toBe("-2350");
    expect(summary.pendingCount).toBe(1);
  });

  it("series: cubos ordenados, ahorro coherente por cubo", async () => {
    const series = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceSeries(client, ROBLE, RANGE, "month", 120));
    expect(series.length).toBeGreaterThan(0);
    for (const point of series) {
      expect(BigInt(point.savingsCents)).toBe(BigInt(point.incomeCents) + BigInt(point.expenseCents));
    }
    expect([...series.map((point) => point.bucket)].sort()).toEqual(series.map((point) => point.bucket));
  });

  it("breakdown: ordenado del gasto mayor (más negativo) al menor", async () => {
    const rows = await as("fixture:roble:admin", ROBLE, (client) => readFinanceBreakdown(client, ROBLE, RANGE));
    const totals = rows.map((row) => BigInt(row.totalCents));
    expect([...totals].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(totals);
    // Dorado: una fila «Supermercado» (-2350) y una «Sin categorizar» (+180000,
    // TX2 sin category_id) — dos filas exactas, no «como mucho dos».
    expect(rows.length).toBe(2);
  });

  it("providers: solo gasto, respeta el limit", async () => {
    const rows = await as("fixture:roble:admin", ROBLE, (client) => readFinanceProviders(client, ROBLE, RANGE, 3));
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const row of rows) {
      expect(BigInt(row.totalCents)).toBeLessThan(0n);
      expect(row.providerDisplay.length).toBeGreaterThan(0);
    }
    // Dorado: el único gasto con proveedor en el fixture es TX1, «Mercado Ejemplo».
    expect(rows.length).toBe(1);
    expect(rows[0]?.providerDisplay).toBe("Mercado Ejemplo");
    expect(rows[0]?.totalCents).toBe("-2350");
  });

  it("providers: un limit no numérico (Number(param ausente) = NaN) no revienta la consulta", async () => {
    const rows = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceProviders(client, ROBLE, RANGE, Number("no-numerico")));
    expect(rows.length).toBe(1);
  });

  it("events-summary: net = income + expense; event-detail inexistente → null", async () => {
    const events = await as("fixture:roble:admin", ROBLE, (client) => readFinanceEventsSummary(client, ROBLE, RANGE));
    for (const event of events) {
      expect(BigInt(event.netCents)).toBe(BigInt(event.incomeCents) + BigInt(event.expenseCents));
    }
    const missing = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinanceEventDetail(client, ROBLE, "00000000-0000-4000-8000-00000000dead", RANGE));
    expect(missing).toBeNull();
    // Dorado: el fixture solo tiene un evento («Semana Santa 2026»), enlazado a
    // TX1 (-2350, gasto) y nada más — un resultado vacío no puede pasar esto.
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      id: EVENT1, name: "Semana Santa 2026", incomeCents: "0", expenseCents: "-2350", txCount: 1,
    });
  });

  it("analytics: las tres naturalezas y, en cada mes, |recurrente| + |extraordinario| ≤ |total|", async () => {
    const abs = (value: string): bigint => (BigInt(value) < 0n ? -BigInt(value) : BigInt(value));
    const { rows } = await as("fixture:roble:admin", ROBLE, (client) => readFinanceAnalytics(client, ROBLE, RANGE));
    expect(rows.map((row) => row.kind)).toEqual(["ingreso", "gasto", "inversion"]);
    for (const row of rows) {
      for (const [month, totals] of Object.entries(row.monthly)) {
        expect(month).toMatch(/^\d{4}-\d{2}$/);
        // El resto hasta el total es «sin clasificar»: nunca puede ser negativo.
        expect(abs(totals.recCents) + abs(totals.extCents) <= abs(totals.totalCents)).toBe(true);
      }
    }
    // Dorado: enero-2026 es el único mes con movimientos del roble — TX2
    // (+180000, ingreso) y TX1 (-2350, gasto); ninguna cuenta de inversión
    // tiene movimientos, así que esa banda queda vacía.
    const [ingreso, gasto, inversion] = rows;
    expect(ingreso?.monthly["2026-01"]).toEqual({ totalCents: "180000", recCents: "0", extCents: "0" });
    expect(gasto?.monthly["2026-01"]).toEqual({ totalCents: "-2350", recCents: "0", extCents: "0" });
    expect(Object.keys(inversion?.monthly ?? { x: 1 })).toEqual([]);
  });

  it("pivot: meses de calendario completos y filas con la forma de PivotSourceRow", async () => {
    const { months, rows } = await as("fixture:roble:admin", ROBLE, (client) =>
      readFinancePivot(client, ROBLE, { ...RANGE, from: "2026-01-01", to: "2026-03-31" }));
    expect(months).toEqual(["2026-01", "2026-02", "2026-03"]);
    for (const row of rows) {
      expect(months).toContain(row.month);
      expect(typeof row.totalCents).toBe("bigint");
      expect(row.cat.length).toBeGreaterThan(0);
      expect(["gasto", "ingreso", "transferencia", "inversion"]).toContain(row.kind);
      expect(row.movs.length).toBe(row.count);
      expect(row.movs.reduce((acc, mov) => acc + mov.cents, 0n)).toBe(row.totalCents);
    }
    // Dorado: TX1 (Casa/Supermercado, gasto) y TX2 (Sin categorizar, ingreso) —
    // dos filas de enero-2026, ninguna más allá aunque el rango cubra tres meses.
    expect(rows.length).toBe(2);
  });

  it("pivot y analytics del admin de olivo sin concesión: sin filas", async () => {
    const analytics = await as("fixture:olivo:admin", OLIVO, (client) => readFinanceAnalytics(client, OLIVO, RANGE));
    for (const row of analytics.rows) expect(Object.keys(row.monthly)).toEqual([]);
    const pivot = await as("fixture:olivo:admin", OLIVO, (client) => readFinancePivot(client, OLIVO, RANGE));
    expect(pivot.rows).toEqual([]);
  });

  it("summary para el admin de olivo sin concesión: todo a cero", async () => {
    const summary = await as("fixture:olivo:admin", OLIVO, (client) => readFinanceSummary(client, OLIVO, RANGE));
    expect(summary.incomeCents).toBe("0");
    expect(summary.expenseCents).toBe("0");
    expect(summary.pendingCount).toBe(0);
  });
});
