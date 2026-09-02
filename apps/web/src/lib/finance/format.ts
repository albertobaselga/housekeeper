/**
 * Formato del módulo Finanzas. `formatCents` NO se reescribe: se reexporta el
 * de la casa ($lib/employment/model), que ya formatea céntimos-string es-ES
 * sin pasar jamás por Number. Aquí solo vive lo específico de finanzas.
 */
export { formatCents, dateLabel } from '$lib/employment/model';

export const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'] as const;
export const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

/**
 * Etiqueta visible del estado de un movimiento. Única definición (Ruling R12
 * de la Task 11): el ledger y el panel de detalle la importan de aquí en vez
 * de declarar cada uno la suya, que divergirían en la primera corrección.
 */
export const STATUS_LABEL: Record<string, string> = {
  pendiente: 'pendiente',
  sugerida_regla: 'regla',
  sugerida_agente: 'agente',
  confirmada: 'confirmada'
};

export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString('es-ES')} %`;
}

/** Etiqueta de cubo temporal (portada de home-finance format.ts). */
export function bucketLabel(bucket: string): string {
  if (/^\d{4}$/.test(bucket)) return bucket;
  if (bucket.includes('-T')) return bucket.replace('-', ' ');
  const [year, month] = bucket.split('-');
  // índice de mes, no dinero
  return `${MONTHS_SHORT[Number(month) - 1]} ${year!.slice(2)}`;
}

/**
 * Variación porcentual contra el periodo anterior. La división es la única
 * operación que pasa por Number: es un porcentaje redondeado para un chip,
 * no dinero, y las magnitudes de un hogar caben de sobra en un double.
 */
export function deltaPct(now: bigint, prev: bigint): number | null {
  if (prev === 0n) return null;
  return Math.round((Number(now - prev) / Math.abs(Number(prev))) * 100);
}

/** Euros enteros para ejes de gráfica: '1.200 €' (los ticks caen en euros redondos). */
export function axisEuro(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const units = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '−' : ''}${units} €`;
}

/** Cifras de cabecera del panel de detalle: n movimientos · total · ticket. */
export function summarizeTxs(
  rows: readonly { amountCents: string }[]
): { count: number; totalCents: bigint; ticketCents: bigint } {
  const totalCents = rows.reduce((acc, row) => acc + BigInt(row.amountCents), 0n);
  const count = rows.length;
  return { count, totalCents, ticketCents: count === 0 ? 0n : totalCents / BigInt(count) };
}
