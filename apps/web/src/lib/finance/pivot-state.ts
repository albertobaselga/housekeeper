/**
 * STUB del estado del pivot de Analítica. La fase 6 construye aquí las
 * dimensiones reordenables, la selección y el resto del estado; esta fase
 * solo fija el contrato de URL de la clave `dims` (CSV de dimensiones, del
 * doc de interfaces) para que filters.ts ya la conserve en el merge.
 */
import type { PivotDimension } from '@housekeeper/domain/finance';

export const PIVOT_DIMENSIONS: readonly PivotDimension[] = ['cat', 'sub', 'nat', 'prov', 'concept', 'movement'];

export const DEFAULT_DIMS: readonly PivotDimension[] = ['cat', 'sub'];

export function parseDims(value: string | null): PivotDimension[] {
  const parsed = (value ?? '')
    .split(',')
    .map((piece) => piece.trim())
    .filter((piece): piece is PivotDimension => (PIVOT_DIMENSIONS as readonly string[]).includes(piece));
  const unique = [...new Set(parsed)];
  return unique.length > 0 ? unique : [...DEFAULT_DIMS];
}

export function serializeDims(dims: readonly PivotDimension[]): string | null {
  if (dims.length === DEFAULT_DIMS.length && dims.every((dim, index) => dim === DEFAULT_DIMS[index])) return null;
  return dims.join(',');
}

// ── Etiquetas y reordenación de dimensiones (fase 6) ─────────────────────────

export const DIM_LABELS: Record<PivotDimension, string> = {
  cat: 'Categoría',
  sub: 'Subcategoría',
  nat: 'Naturaleza',
  prov: 'Proveedor',
  concept: 'Concepto',
  movement: 'Movimiento'
};

export function moveDim(dims: readonly PivotDimension[], index: number, dir: -1 | 1): PivotDimension[] {
  const next = [...dims];
  const j = index + dir;
  if (index < 0 || index >= next.length || j < 0 || j >= next.length) return next;
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

export function removeDim(dims: readonly PivotDimension[], dim: PivotDimension): PivotDimension[] {
  return dims.length <= 1 ? [...dims] : dims.filter((d) => d !== dim);
}

export function addDim(dims: readonly PivotDimension[], dim: PivotDimension): PivotDimension[] {
  return dims.includes(dim) ? [...dims] : [...dims, dim];
}

// ── Orden de columnas (Acumulado/Promedio/Ticket/mes, recursivo) ─────────────
// `packages/domain/src/finance/pivot.ts` exporta `sortPivotTree`, pero ordena
// un `PivotTree` completo (gastos/ingresos/eventos); aquí se necesita ordenar
// una lista genérica de nodos (selección, buscador), así que no se reutiliza.

export type PivotSortKey = 'label' | 'total' | 'avg' | 'ticket' | { month: string };
export type SortDir = 'asc' | 'desc';

export interface SortableNodeLike {
  label: string;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
}

export function sameSortKey(a: PivotSortKey, b: PivotSortKey): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.month === b.month;
}

function sortValue(key: PivotSortKey, item: SortableNodeLike): bigint | string {
  if (key === 'label') return item.label;
  if (key === 'total') return item.totalCents;
  if (key === 'avg') return item.avgCents;
  if (key === 'ticket') return item.ticketCents;
  return item.monthly[key.month] ?? 0n;
}

function compareSortValues(a: bigint | string, b: bigint | string, dir: SortDir): number {
  const cmp =
    typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'es') : a < b ? -1 : a > b ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

/** Reordena hermanos en cada nivel sin mutar la entrada. Los subtotales no pasan por aquí. */
export function sortTree<T extends SortableNodeLike & { children: T[] }>(
  nodes: readonly T[],
  key: PivotSortKey,
  dir: SortDir
): T[] {
  return nodes
    .map((n) => ({ ...n, children: sortTree(n.children, key, dir) }))
    .sort((a, b) => compareSortValues(sortValue(key, a), sortValue(key, b), dir));
}
