import { describe, expect, it } from 'vitest';

import { getFinanceAnaliticaFixture } from '../src/lib/server/fixtures.server';

describe('maqueta sintética de Analítica (modo demo, datos inventados)', () => {
  const demo = getFinanceAnaliticaFixture();

  it('cubre las cinco secciones del pivot y tres meses', () => {
    expect(demo.months).toEqual(['2026-01', '2026-02', '2026-03']);
    const kinds = new Set(demo.pivotRows.map((r) => r.kind));
    expect(kinds).toEqual(new Set(['gasto', 'ingreso', 'transferencia', 'inversion']));
    expect(demo.pivotRows.some((r) => r.eventId !== null)).toBe(true);
  });

  it('las internas de la maqueta suman 0 (invariante del subtotal)', () => {
    const internas = demo.pivotRows.filter((r) => r.kind === 'transferencia');
    expect(internas.reduce((s, r) => s + r.totalCents, 0n)).toBe(0n);
  });

  it('el resumen es coherente con las filas (ahorro = ingresos + gastos)', () => {
    expect(demo.summary.savingsCents).toBe(demo.summary.incomeCents + demo.summary.expenseCents);
  });

  it('cada movimiento tiene id propio (los usa la resolución por ids)', () => {
    const ids = demo.pivotRows.flatMap((r) => r.movs.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hay una categoría destino para el dnd distinta de las de origen y un evento vacío', () => {
    expect(demo.categories.some((c) => c.name === 'Restaurantes')).toBe(true);
    expect(demo.eventsSummary.some((e) => e.name === 'Cumple Leo' && e.txCount === 0)).toBe(true);
  });

  it('trae cuentas para la barra de filtros y al menos una de inversión', () => {
    expect(demo.accounts.length).toBeGreaterThan(0);
    expect(demo.accounts.some((acc) => acc.kind === 'inversion')).toBe(true);
    expect(demo.invAccounts).toEqual(
      demo.accounts.filter((acc) => acc.kind === 'inversion').map((acc) => ({ id: acc.id, name: acc.name }))
    );
  });
});
