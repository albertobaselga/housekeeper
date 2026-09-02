/**
 * Geometría PURA de las gráficas SVG artesanales (§8: sin librería de charts).
 * Porta las proporciones de los componentes recharts del origen: CashflowChart
 * (alto 280, eje Y de 70 px, barras agrupadas) y el Sparkline de ui.tsx
 * (viewBox 100×32). Los céntimos solo se convierten a Number para calcular
 * PÍXELES; el dinero de verdad nunca sale de bigint.
 */
import { axisEuro, bucketLabel } from './format';

export interface ChartBar { x: number; y: number; width: number; height: number }

// Geometría de píxeles: recibe euros ya convertidos por el llamante (la Task 10
// es quien debe justificar ahí su propio Number sobre céntimos, no esta función).
export function sparklinePoints(values: readonly number[]): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / range) * 24}`)
    .join(' ');
}

/**
 * El siguiente «valor bonito» (1/2/5 × 10^n) por encima de value.
 * Trabaja en Number porque `value` ya es un euro de geometría (paso de eje), no céntimos.
 */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const multiplier of [1, 2, 5, 10]) {
    if (multiplier * power >= value) return multiplier * power;
  }
  return 10 * power;
}

// Geometría de píxeles: convierte céntimos a euros solo para calcular posiciones y rótulos de eje.
const eurosOf = (cents: bigint): number => Number(cents) / 100;

interface Frame {
  width: number; height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  ticks: { value: number; y: number; label: string }[];
  zeroY: number;
  y: (value: number) => number;
  slot: number;
  /** Centro en x del cubo `index`: única fuente de verdad para barras, etiqueta y ahorro. */
  centerX: (index: number) => number;
}

// Geometría de píxeles: los cálculos de escala y tamaño de paso son presentación, no dinero.
function frameFor(values: number[], bucketCount: number, size: { width?: number; height?: number }): Frame {
  const width = size.width ?? 720;
  const height = size.height ?? 280;
  const plot = { left: 70, right: width - 8, top: 8, bottom: height - 24 };
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  // Suelo de un euro por paso: con datos vacíos o todo a cero, evita pasos fraccionarios
  // que producen ticks distintos redondeando a la misma etiqueta en euros enteros.
  const step = Math.max(1, niceCeil(Math.max(rawMax - rawMin, 1) / 4));
  const max = Math.ceil(rawMax / step) * step || step;
  const min = Math.floor(rawMin / step) * step;
  const y = (value: number): number => plot.top + ((max - value) / (max - min)) * (plot.bottom - plot.top);
  const ticks: Frame['ticks'] = [];
  for (let value = min; value <= max; value += step) {
    ticks.push({ value, y: y(value), label: axisEuro(BigInt(Math.round(value)) * 100n) });
  }
  const slot = (plot.right - plot.left) / Math.max(bucketCount, 1);
  return {
    width, height, plot, ticks, zeroY: y(0), y, slot,
    centerX: (index: number) => plot.left + slot * (index + 0.5)
  };
}

// Línea de ahorro: compartida por ambos layouts, un punto por cubo sobre el mismo frame.
const savingsLine = (
  buckets: readonly { savingsCents: bigint }[],
  frame: Frame
): { x: number; y: number }[] =>
  buckets.map((bucket, index) => ({ x: frame.centerX(index), y: frame.y(eurosOf(bucket.savingsCents)) }));

export interface CashflowBucketInput { bucket: string; incomeCents: bigint; expenseCents: bigint; savingsCents: bigint }
export interface CashflowLayout {
  width: number; height: number;
  plot: Frame['plot']; ticks: Frame['ticks']; zeroY: number;
  groups: { label: string; centerX: number; income: ChartBar; expense: ChartBar }[];
  savings: { x: number; y: number }[];
}

export function cashflowLayout(
  buckets: readonly CashflowBucketInput[],
  size: { width?: number; height?: number } = {}
): CashflowLayout {
  const values = buckets.flatMap((bucket) => [
    eurosOf(bucket.incomeCents), Math.abs(eurosOf(bucket.expenseCents)), eurosOf(bucket.savingsCents)
  ]);
  const frame = frameFor(values, buckets.length, size);
  const barWidth = Math.max((frame.slot * 0.6 - 2) / 2, 2);
  const bar = (centerOffset: number, index: number, euros: number): ChartBar => {
    const centerX = frame.centerX(index);
    const top = frame.y(Math.abs(euros));
    return { x: centerX + centerOffset, y: top, width: barWidth, height: frame.zeroY - top };
  };
  return {
    width: frame.width, height: frame.height, plot: frame.plot, ticks: frame.ticks, zeroY: frame.zeroY,
    groups: buckets.map((bucket, index) => ({
      label: bucketLabel(bucket.bucket),
      centerX: frame.centerX(index),
      income: bar(-barWidth - 1, index, eurosOf(bucket.incomeCents)),
      expense: bar(1, index, eurosOf(bucket.expenseCents))
    })),
    savings: savingsLine(buckets, frame)
  };
}

export interface NatureBucketInput { bucket: string; recurringCents: bigint; extraordinaryCents: bigint; unclassifiedCents: bigint; savingsCents: bigint }
export interface NatureStackLayout {
  width: number; height: number; plot: Frame['plot']; ticks: Frame['ticks']; zeroY: number;
  groups: { label: string; centerX: number; segments: { nature: 'recurrente' | 'extraordinario' | 'sin'; bar: ChartBar }[] }[];
  savings: { x: number; y: number }[];
}

/** Gasto apilado por naturaleza (♻/✦/—) + línea de ahorro, para Analítica (fase 6). */
export function natureStackLayout(
  buckets: readonly NatureBucketInput[],
  size: { width?: number; height?: number } = {}
): NatureStackLayout {
  const totals = buckets.map((bucket) =>
    Math.abs(eurosOf(bucket.recurringCents)) + Math.abs(eurosOf(bucket.extraordinaryCents)) + Math.abs(eurosOf(bucket.unclassifiedCents)));
  const frame = frameFor(
    [...totals, ...buckets.map((bucket) => eurosOf(bucket.savingsCents))],
    buckets.length, size
  );
  const barWidth = Math.max(frame.slot * 0.5, 4);
  return {
    width: frame.width, height: frame.height, plot: frame.plot, ticks: frame.ticks, zeroY: frame.zeroY,
    groups: buckets.map((bucket, index) => {
      const centerX = frame.centerX(index);
      const pieces: [NatureStackLayout['groups'][number]['segments'][number]['nature'], number][] = [
        ['recurrente', Math.abs(eurosOf(bucket.recurringCents))],
        ['extraordinario', Math.abs(eurosOf(bucket.extraordinaryCents))],
        ['sin', Math.abs(eurosOf(bucket.unclassifiedCents))]
      ];
      let floor = frame.zeroY;
      const segments = pieces.map(([nature, euros]) => {
        const height = frame.zeroY - frame.y(euros);
        floor -= height;
        return { nature, bar: { x: centerX - barWidth / 2, y: floor, width: barWidth, height } };
      });
      return { label: bucketLabel(bucket.bucket), centerX, segments };
    }),
    savings: savingsLine(buckets, frame)
  };
}
