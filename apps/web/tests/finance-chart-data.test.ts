import { describe, expect, it } from 'vitest';

import {
  buildNatureChartData,
  monthLabel,
  monthsInRange,
  pctOf,
  perMonth,
  SUMMARY_ROWS,
  type AnalyticsRowLike
} from '../src/lib/finance/chart-data';

describe('monthsInRange (solo meses COMPLETOS dentro del rango)', () => {
  it('cuenta meses enteros de un rango exacto', () => {
    expect(monthsInRange('2026-01-01', '2026-03-31')).toBe(3);
  });
  it('descarta el mes final incompleto («año hasta hoy»)', () => {
    expect(monthsInRange('2026-01-01', '2026-07-10')).toBe(6);
  });
  it('descarta el mes inicial incompleto', () => {
    expect(monthsInRange('2026-01-15', '2026-03-31')).toBe(2);
  });
  it('nunca devuelve 0 (rango dentro de un solo mes → 1)', () => {
    expect(monthsInRange('2026-02-10', '2026-02-20')).toBe(1);
  });
});

describe('buildNatureChartData', () => {
  // Nota: el servidor ya excluye las patas de transferencia antes de que las
  // filas lleguen aquí (R19), por eso AnalyticsRowLike.kind no incluye
  // 'transferencia' y este módulo no le dedica ninguna rama.
  const rows: AnalyticsRowLike[] = [
    { kind: 'gasto', monthly: { '2026-01': { totalCents: -150000n, recCents: -100000n, extCents: -30000n } } },
    { kind: 'ingreso', monthly: { '2026-01': { totalCents: 300000n, recCents: 280000n, extCents: 0n } } },
    { kind: 'inversion', monthly: { '2026-01': { totalCents: 50000n, recCents: 0n, extCents: 0n } } }
  ];

  it('separa naturalezas y aparta la inversión', () => {
    const [p] = buildNatureChartData(['2026-01'], rows);
    expect(p.gastosRecCents).toBe(100000n); // valor absoluto
    expect(p.gastosExtCents).toBe(30000n);
    expect(p.gastosSinCents).toBe(20000n); // total − rec − ext
    expect(p.ingresosRecCents).toBe(280000n);
    expect(p.ingresosSinCents).toBe(20000n);
    expect(p.inversionCents).toBe(50000n);
  });

  it('ahorro neto = ingresos − gastos totales; bruto = ingresos − gastos recurrentes; sin inversión', () => {
    const [p] = buildNatureChartData(['2026-01'], rows);
    expect(p.ahorroNetoCents).toBe(150000n); // 300000 − 150000, la inversión no entra
    expect(p.ahorroBrutoCents).toBe(200000n); // 300000 − 100000
  });

  it('un mes sin filas produce ceros', () => {
    const [p] = buildNatureChartData(['2026-02'], rows);
    expect(p.ahorroNetoCents).toBe(0n);
    expect(p.inversionCents).toBe(0n);
  });
});

describe('SUMMARY_ROWS (resumen mensual transpuesto)', () => {
  it('tiene las 13 filas fijas en el orden del original', () => {
    expect(SUMMARY_ROWS.map((r) => r.label)).toEqual([
      'Ingresos recurrentes', 'Ingresos extraordinarios', 'Ingresos sin clasificar', 'Total ingresos',
      'Gastos recurrentes', 'Gastos extraordinarios', 'Gastos sin clasificar', 'Total gastos',
      'Inversión', 'Ahorro bruto', 'Ahorro neto', 'Free cash flow', 'Ops cash flow'
    ]);
  });
  it('free cash flow = ahorro neto − inversión; ops = ahorro neto', () => {
    const p = buildNatureChartData(['2026-01'], [
      { kind: 'ingreso', monthly: { '2026-01': { totalCents: 300000n, recCents: 300000n, extCents: 0n } } },
      { kind: 'inversion', monthly: { '2026-01': { totalCents: 50000n, recCents: 0n, extCents: 0n } } }
    ])[0];
    const row = (label: string) => SUMMARY_ROWS.find((r) => r.label === label)!;
    expect(row('Free cash flow').value(p)).toBe(250000n);
    expect(row('Ops cash flow').value(p)).toBe(300000n);
    expect(row('Total gastos').value(p)).toBe(0n);
  });
});

describe('utilidades de media y porcentaje', () => {
  it('perMonth divide céntimos bigint por meses con redondeo half-away-from-zero (no trunca)', () => {
    expect(perMonth(-62500n, 3)).toBe(-20833n);
    expect(perMonth(1000n, 3)).toBe(333n);
    expect(perMonth(1001n, 2)).toBe(501n); // 500.5 → 501 (half away from zero)
    expect(perMonth(-1001n, 2)).toBe(-501n);
  });
  it('pctOf es un porcentaje redondeado sobre valores absolutos, 0 con denominador 0', () => {
    expect(pctOf(-36000n, -62500n)).toBe(58);
    expect(pctOf(100n, 0n)).toBe(0);
  });
  it('monthLabel es «mes año» en español', () => {
    expect(monthLabel('2026-01')).toBe('ene 2026');
  });
});
