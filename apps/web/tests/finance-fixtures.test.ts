import { describe, expect, it, vi } from 'vitest';

import { getFinanceDashboardFixture, getFinanceEventosFixture, getFinanceMovimientosFixture } from '../src/lib/server/fixtures.server';

// Ruling R19: `demoOnly()` consulta `$env/dynamic/private` en cada llamada, y
// bajo vitest ese módulo lo sirve el plugin de SvelteKit desde `process.env`.
// Sin fijar el entorno, quien tenga DATABASE_URL exportada en su shell (para
// levantar la aplicación, por ejemplo) ve estos dos tests fallar en falso
// (mismo patrón que tests/search-offline.test.ts:18).
vi.mock('$env/dynamic/private', () => ({ env: {} }));

const FILTERS = { from: '2026-01-01', to: '2026-08-31', granularity: 'month' as const, accountIds: [], eventId: null };

describe('fixtures sintéticas de finanzas (modo demo)', () => {
  it('el resumen es aritméticamente coherente: ahorro = ingresos + gastos, desglose que suma', () => {
    const dashboard = getFinanceDashboardFixture(FILTERS);
    const summary = dashboard.summary;
    expect(BigInt(summary.savingsCents)).toBe(BigInt(summary.incomeCents) + BigInt(summary.expenseCents));
    expect(
      BigInt(summary.recurringExpenseCents) + BigInt(summary.extraordinaryExpenseCents) + BigInt(summary.unclassifiedExpenseCents)
    ).toBe(BigInt(summary.expenseCents));
    expect(summary.prev).not.toBeNull();
    expect(dashboard.series.length).toBeGreaterThanOrEqual(6);
    for (const point of dashboard.series) {
      expect(BigInt(point.savingsCents)).toBe(BigInt(point.incomeCents) + BigInt(point.expenseCents));
    }
    expect(dashboard.accounts.length).toBeGreaterThan(0);
    expect(dashboard.providers.length).toBeGreaterThan(0);
  });

  it('los movimientos demo traen raw para el panel «Datos del origen» y total veraz', () => {
    const movimientos = getFinanceMovimientosFixture(FILTERS);
    expect(movimientos.page.total).toBe(movimientos.page.rows.length);
    expect(movimientos.page.rows.some((row) => row.raw !== null)).toBe(true);
    const sum = movimientos.page.rows.reduce((acc, row) => acc + BigInt(row.amountCents), 0n);
    expect(BigInt(movimientos.page.sumCents)).toBe(sum);
    for (const row of movimientos.page.rows) expect(row.amountCents).toMatch(/^-?\d+$/);
  });

  it('los eventos demo cuadran: neto = ingreso + gasto y el evento abierto no viene sin desglose', () => {
    const eventos = getFinanceEventosFixture({ from: FILTERS.from, to: FILTERS.to });
    expect(eventos.summary.length).toBeGreaterThan(0);
    for (const row of eventos.summary) {
      expect(BigInt(row.netCents)).toBe(BigInt(row.incomeCents) + BigInt(row.expenseCents));
      // totalCount es el conteo SIN filtro de rango: nunca puede ser menor que
      // txCount (el del rango), que es un subconjunto.
      expect(row.totalCount).toBeGreaterThanOrEqual(row.txCount);
    }
    // Sin `open=`, la maqueta no ofrece un desglose que nadie pidió.
    expect(eventos.openId).toBeNull();
    expect(eventos.detail).toBeNull();
  });
});
