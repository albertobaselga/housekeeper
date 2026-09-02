/**
 * Datos de la gráfica por naturaleza y del resumen mensual de Analítica.
 * Port fiel de chartData.ts + monthsInRange/SUMMARY_ROWS del original
 * (home-finance/frontend/src/features/analytics), con céntimos bigint.
 * Puro: sin fetch, sin DOM, sin reloj.
 */
import { divideRoundHalfAwayFromZero } from '@housekeeper/domain';

import { MONTHS_SHORT } from './format';

/**
 * El servidor ya excluye las patas de transferencia antes de agregar filas
 * (son netas 0 y solo ruido): este tipo no lleva 'transferencia' para no
 * abrir una rama muerta en `buildNatureChartData`.
 */
export interface AnalyticsRowLike {
  kind: 'gasto' | 'ingreso' | 'inversion';
  monthly: Record<string, { totalCents: bigint; recCents: bigint; extCents: bigint }>;
}

export interface NatureChartPoint {
  month: string;
  gastosRecCents: bigint;
  gastosExtCents: bigint;
  gastosSinCents: bigint;
  ingresosRecCents: bigint;
  ingresosExtCents: bigint;
  ingresosSinCents: bigint;
  inversionCents: bigint;
  ahorroNetoCents: bigint;
  ahorroBrutoCents: bigint;
}

/**
 * Nº de meses COMPLETOS dentro de [from, to], para mensualizar sin diluir con
 * un mes en curso a medias. Un mes cuenta solo si el rango cubre su primer y
 * último día; si no hay ninguno completo se devuelve 1 (no dividir por cero).
 *
 * F6-M8: NO es el `monthsInRange` de `packages/server/src/finance/queries.ts`,
 * que con el mismo nombre devuelve la LISTA de meses del rango. Aquí se cuenta;
 * allí se enumera. Importar el que no es compila y da una cifra sin sentido.
 */
export function monthsInRange(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return 1;
  let startIdx = fy * 12 + (fm - 1);
  if (fd !== 1) startIdx += 1;
  let endIdx = ty * 12 + (tm - 1);
  const lastDay = new Date(ty, tm, 0).getDate();
  if (td !== lastDay) endIdx -= 1;
  return Math.max(1, endIdx - startIdx + 1);
}

/**
 * «2026-01» → «ene 2026» (mes corto de $lib/finance/format + año completo).
 *
 * F6-M8: distinto a propósito del `bucketLabel` de `format.ts`, que escribe
 * «ene 26». Las columnas del pivot y del resumen mensual pueden abarcar varios
 * años y se leen una junto a otra, así que llevan el año completo; los cubos
 * del flujo de caja del Dashboard son una serie corta y caben con dos cifras.
 * No se unifican: son dos decisiones tipográficas distintas, no un descuido.
 */
export function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${MONTHS_SHORT[Number(m) - 1] ?? month} ${year}`;
}

/**
 * Media mensual en céntimos, redondeada half-away-from-zero (no trunca: sigue
 * siendo dinero). Con 0 o menos meses no hay media que calcular: 0n.
 */
export function perMonth(cents: bigint, months: number): bigint {
  if (months <= 0) return 0n;
  return divideRoundHalfAwayFromZero(cents, BigInt(months));
}

/** Porcentaje redondeado |num|/|den|·100. Es un ratio, no dinero: Number es legítimo aquí. */
export function pctOf(num: bigint, den: bigint): number {
  if (den === 0n) return 0;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return Math.round((Number(abs(num)) * 100) / Number(abs(den)));
}

/**
 * La inversión alimenta su propia serie y NO cuenta como ingreso ni entra en
 * el ahorro neto. Ahorro neto = suma del mes (ingresos + gastos, gastos
 * negativos); bruto = ingresos + gastos recurrentes (negativos). Los gastos
 * salen en valor absoluto para apilar.
 */
export function buildNatureChartData(months: string[], rows: AnalyticsRowLike[]): NatureChartPoint[] {
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return months.map((month) => {
    let gRec = 0n, gExt = 0n, gSin = 0n, iRec = 0n, iExt = 0n, iSin = 0n, inv = 0n, totalMonth = 0n;
    for (const row of rows) {
      const e = row.monthly[month];
      if (!e) continue;
      if (row.kind === 'inversion') {
        inv += e.totalCents;
        continue;
      }
      const unclassified = e.totalCents - e.recCents - e.extCents;
      totalMonth += e.totalCents;
      if (row.kind === 'gasto') {
        gRec += e.recCents;
        gExt += e.extCents;
        gSin += unclassified;
      } else {
        iRec += e.recCents;
        iExt += e.extCents;
        iSin += unclassified;
      }
    }
    const iTotal = iRec + iExt + iSin;
    return {
      month,
      gastosRecCents: abs(gRec),
      gastosExtCents: abs(gExt),
      gastosSinCents: abs(gSin),
      ingresosRecCents: iRec,
      ingresosExtCents: iExt,
      ingresosSinCents: iSin,
      inversionCents: inv,
      ahorroNetoCents: totalMonth,
      ahorroBrutoCents: iTotal + gRec
    };
  });
}

export interface SummaryRowDef {
  label: string;
  cls: '' | 'pos' | 'neg';
  strong?: boolean;
  sep?: boolean;
  value(p: NatureChartPoint): bigint;
}

const totalIngresos = (p: NatureChartPoint) => p.ingresosRecCents + p.ingresosExtCents + p.ingresosSinCents;
const totalGastos = (p: NatureChartPoint) => p.gastosRecCents + p.gastosExtCents + p.gastosSinCents;

/** Filas fijas del resumen mensual transpuesto, en el orden del original. */
export const SUMMARY_ROWS: SummaryRowDef[] = [
  { label: 'Ingresos recurrentes', cls: 'pos', value: (p) => p.ingresosRecCents },
  { label: 'Ingresos extraordinarios', cls: 'pos', value: (p) => p.ingresosExtCents },
  { label: 'Ingresos sin clasificar', cls: 'pos', value: (p) => p.ingresosSinCents },
  { label: 'Total ingresos', cls: 'pos', strong: true, value: totalIngresos },
  { label: 'Gastos recurrentes', cls: 'neg', sep: true, value: (p) => p.gastosRecCents },
  { label: 'Gastos extraordinarios', cls: 'neg', value: (p) => p.gastosExtCents },
  { label: 'Gastos sin clasificar', cls: 'neg', value: (p) => p.gastosSinCents },
  { label: 'Total gastos', cls: 'neg', strong: true, value: totalGastos },
  { label: 'Inversión', cls: 'pos', sep: true, value: (p) => p.inversionCents },
  { label: 'Ahorro bruto', cls: '', strong: true, sep: true, value: (p) => p.ahorroBrutoCents },
  { label: 'Ahorro neto', cls: '', strong: true, value: (p) => p.ahorroNetoCents },
  { label: 'Free cash flow', cls: '', value: (p) => p.ahorroNetoCents - p.inversionCents },
  { label: 'Ops cash flow', cls: '', value: (p) => p.ahorroNetoCents }
];
