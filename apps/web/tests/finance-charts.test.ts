import { describe, expect, it } from 'vitest';

import { categoryPath, groupExpenseCategories } from '../src/lib/finance/breakdown';
import { cashflowLayout, niceCeil, sparklinePoints } from '../src/lib/finance/chart-geometry';

describe('sparkline: la geometría exacta del original (viewBox 100×32)', () => {
  it('dos valores: primero abajo (y=28), último arriba (y=4)', () => {
    expect(sparklinePoints([0, 1])).toBe('0,28 100,4');
  });
  it('con menos de dos valores no hay línea', () => {
    expect(sparklinePoints([5])).toBe('');
  });
});

describe('niceCeil: pasos redondos 1/2/5', () => {
  it('sube al siguiente valor bonito', () => {
    expect(niceCeil(870)).toBe(1000);
    expect(niceCeil(140)).toBe(200);
    expect(niceCeil(45)).toBe(50);
    expect(niceCeil(0)).toBe(1);
  });
});

describe('cashflowLayout: barras + línea de ahorro', () => {
  const buckets = [
    { bucket: '2026-01', incomeCents: 400000n, expenseCents: -300000n, savingsCents: 100000n },
    { bucket: '2026-02', incomeCents: 200000n, expenseCents: -150000n, savingsCents: 50000n }
  ];
  const layout = cashflowLayout(buckets);

  it('el gasto se pinta en valor absoluto y el ingreso doble mide el doble', () => {
    const [january, february] = layout.groups;
    expect(january!.expense.height).toBeGreaterThan(0);
    expect(january!.income.height / february!.income.height).toBeCloseTo(2, 5);
  });
  it('sin valores negativos, la línea de cero es el suelo del área de dibujo', () => {
    expect(layout.zeroY).toBeCloseTo(layout.plot.bottom, 5);
  });
  it('los ticks incluyen el cero y sus etiquetas son euros enteros', () => {
    expect(layout.ticks.some((tick) => tick.value === 0)).toBe(true);
    expect(layout.ticks.every((tick) => /€$/.test(tick.label))).toBe(true);
  });
  it('hay un punto de ahorro por cubo y los grupos avanzan en x', () => {
    expect(layout.savings).toHaveLength(2);
    expect(layout.groups[1]!.centerX).toBeGreaterThan(layout.groups[0]!.centerX);
    expect(layout.groups[0]!.label).toBe('ene 26');
  });
  it('sin cubos no lanza y no hay grupos ni puntos de ahorro', () => {
    const empty = cashflowLayout([]);
    expect(empty.groups).toEqual([]);
    expect(empty.savings).toEqual([]);
  });
  it('con ahorro negativo, el cero baja del suelo y aparecen ticks negativos', () => {
    const negative = cashflowLayout([
      { bucket: '2026-01', incomeCents: 200000n, expenseCents: -250000n, savingsCents: -50000n }
    ]);
    expect(negative.zeroY).toBeLessThan(negative.plot.bottom);
    expect(negative.ticks.some((tick) => tick.value < 0)).toBe(true);
    expect(negative.ticks.some((tick) => tick.label.startsWith('−'))).toBe(true);
    const expenseBar = negative.groups[0]!.expense;
    expect(expenseBar.height).toBeCloseTo(negative.zeroY - expenseBar.y, 5);
  });
});

describe('groupExpenseCategories: el groupByParent del original', () => {
  const names = new Map([['p1', 'Casa'], ['c1', 'Supermercado']]);
  it('solo gastos, agrupados por padre, ordenados del más gastado; (general) para el padre suelto', () => {
    const groups = groupExpenseCategories([
      { categoryId: 'c1', name: 'Supermercado', parentId: 'p1', totalCents: '-50000' },
      { categoryId: 'p1', name: 'Casa', parentId: null, totalCents: '-10000' },
      { categoryId: null, name: 'Sin categorizar', parentId: null, totalCents: '-70000' },
      { categoryId: 'c9', name: 'Nómina', parentId: null, totalCents: '425000' }
    ], names);
    expect(groups.map((group) => group.name)).toEqual(['Sin categorizar', 'Casa']);
    expect(groups[1]!.totalCents).toBe(-60000n);
    expect(groups[1]!.subs.map((sub) => sub.name)).toEqual(['Supermercado', '(general)']);
    expect(groups[0]!.percent).toBe(100);
  });
  it('el nombre del grupo se recupera de la fila del propio padre aunque falte del mapa', () => {
    const namesSinPadre = new Map([['c1', 'Supermercado']]); // simula categoría archivada / mapa filtrado
    const groups = groupExpenseCategories([
      { categoryId: 'c1', name: 'Supermercado', parentId: 'p1', totalCents: '-50000' },
      { categoryId: 'p1', name: 'Casa', parentId: null, totalCents: '-10000' }
    ], namesSinPadre);
    expect(groups[0]!.name).toBe('Casa');
  });
  it('un grupo minoritario conserva un suelo del 1% para no desaparecer de la barra', () => {
    const groups = groupExpenseCategories([
      { categoryId: 'p1', name: 'Casa', parentId: null, totalCents: '-100000' },
      { categoryId: 'p2', name: 'Ocio', parentId: null, totalCents: '-700' }
    ], new Map([['p1', 'Casa'], ['p2', 'Ocio']]));
    const minoritario = groups.find((group) => group.name === 'Ocio')!;
    expect(minoritario.percent).toBe(1);
  });
});

describe('categoryPath', () => {
  it('encadena padre e hija', () => {
    const categories = [
      { id: 'p1', name: 'Casa', parentId: null },
      { id: 'c1', name: 'Supermercado', parentId: 'p1' }
    ];
    expect(categoryPath(categories, 'c1')).toBe('Casa › Supermercado');
    expect(categoryPath(categories, 'p1')).toBe('Casa');
  });
});
