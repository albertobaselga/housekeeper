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
