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
// `sortPivotTree` de packages/domain/src/finance/pivot.ts ordena un PivotTree
// completo (gastos/ingresos/eventos), no una lista de nodos: no se reutiliza.

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

/** Comparador total: clave primero, etiqueta como desempate (orden determinista aunque empate la clave). */
function compareSortValues(a: SortableNodeLike, b: SortableNodeLike, key: PivotSortKey, dir: SortDir): number {
  const va = sortValue(key, a);
  const vb = sortValue(key, b);
  const keyCmp =
    typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb, 'es') : va < vb ? -1 : va > vb ? 1 : 0;
  const cmp = keyCmp !== 0 ? keyCmp : a.label.localeCompare(b.label, 'es');
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
    .sort((a, b) => compareSortValues(a, b, key, dir));
}

// ── Selección (checkbox, Shift+clic, resolución a tx_id) ─────────────────────
// Tipado ESTRUCTURAL sobre la forma del nodo del pivot del dominio (fase 2):
// si el dominio nombra distinto alguna propiedad (p. ej. total en vez de
// totalCents), ajusta PivotNodeLike aquí — los nombres del dominio mandan.

export interface PivotMovLike {
  id: string;
  date: string;
  cents: bigint;
}

export interface PivotNodeLike extends SortableNodeLike {
  key: string;
  depth: number;
  count: number;
  catId: string | null;
  nat: 'recurrente' | 'extraordinario' | null;
  provider: string | null;
  concept: string | null;
  movs: PivotMovLike[];
  children: PivotNodeLike[];
}

export interface SelectableItem {
  key: string;
  parentKey: string;
  provider: string;
  concept: string | null;
  count: number;
  /** Nodo categoría/subcategoría agregado: el gesto vincula la categoría entera. */
  categoryId?: string;
  label?: string;
  /** Hoja de la dimensión Movimiento: la identidad es el id exacto. */
  txId?: string;
}

export function parentKeyOf(key: string): string {
  const idx = key.lastIndexOf('/');
  return idx <= 0 ? '' : key.slice(0, idx);
}

export function toSelectable(node: PivotNodeLike): SelectableItem | null {
  if (node.provider === null) return null;
  return { key: node.key, parentKey: parentKeyOf(node.key), provider: node.provider, concept: node.concept, count: node.count };
}

export function isCategoryAggregateNode(node: PivotNodeLike, dims: readonly PivotDimension[]): boolean {
  const dim = dims[node.depth];
  return (dim === 'cat' || dim === 'sub') && node.catId !== null;
}

export function toCategorySelectable(node: PivotNodeLike, dims: readonly PivotDimension[]): SelectableItem | null {
  if (!isCategoryAggregateNode(node, dims)) return null;
  return {
    key: node.key, parentKey: parentKeyOf(node.key), provider: '', concept: null,
    count: node.count, categoryId: node.catId!, label: node.label
  };
}

export function isMovementLeaf(node: PivotNodeLike, dims: readonly PivotDimension[]): boolean {
  return dims[node.depth] === 'movement' && node.movs.length === 1;
}

export function toMovementSelectable(node: PivotNodeLike, dims: readonly PivotDimension[]): SelectableItem | null {
  if (!isMovementLeaf(node, dims)) return null;
  return {
    key: node.key, parentKey: parentKeyOf(node.key), provider: '', concept: null,
    count: 1, txId: node.movs[0].id, label: node.label
  };
}

export function toAnySelectable(node: PivotNodeLike, dims: readonly PivotDimension[]): SelectableItem | null {
  return toSelectable(node) ?? toCategorySelectable(node, dims) ?? toMovementSelectable(node, dims);
}

export function selectableListAny(nodes: readonly PivotNodeLike[], dims: readonly PivotDimension[]): SelectableItem[] {
  return nodes.map((n) => toAnySelectable(n, dims)).filter((s): s is SelectableItem => s !== null);
}

/** Hojas proveedor/concepto del subárbol; `omitted` = hojas sin proveedor único. */
export function collectLeafItems(node: PivotNodeLike): { items: SelectableItem[]; omitted: number } {
  if (node.children.length === 0) {
    const item = toSelectable(node);
    return item ? { items: [item], omitted: 0 } : { items: [], omitted: 1 };
  }
  const items: SelectableItem[] = [];
  let omitted = 0;
  for (const child of node.children) {
    const r = collectLeafItems(child);
    items.push(...r.items);
    omitted += r.omitted;
  }
  return { items, omitted };
}

export function rangeBetween(
  siblings: readonly SelectableItem[],
  fromKey: string,
  toKey: string
): SelectableItem[] | null {
  const i = siblings.findIndex((s) => s.key === fromKey);
  const j = siblings.findIndex((s) => s.key === toKey);
  if (i === -1 || j === -1) return null;
  const [lo, hi] = i <= j ? [i, j] : [j, i];
  return siblings.slice(lo, hi + 1);
}

export function toggleInMap(map: ReadonlyMap<string, SelectableItem>, item: SelectableItem): Map<string, SelectableItem> {
  const next = new Map(map);
  if (next.has(item.key)) next.delete(item.key);
  else next.set(item.key, item);
  return next;
}

/**
 * Mapa key→ids recorriendo una LISTA de raíces (recursivo). NO delega en el
 * `collectNodeMovIds(tree)` del dominio (R15) porque su firma exige un
 * `PivotTree` completo (secciones `gastos`/`ingresos`/`internas`/`inversiones`/
 * `eventos`, con nodos `PivotNode` que llevan además `concepts: string[]`),
 * mientras que aquí solo hay una LISTA de raíces ya filtrada/ordenada por
 * sección y con el tipo estructural `PivotNodeLike` (sin `concepts`, con
 * `nat` nullable) — envolver exigiría o bien fabricar un `PivotTree` falso, o
 * bien un cast sobre los datos, ambos peores que este espejo mínimo de la
 * misma lógica recursiva. Las claves ya llegan cualificadas por sección
 * (prefijo `gastos/`, `evento:<id>/`, …) porque así las construye
 * `buildTreeNodes` en el dominio, así que no hace falta recualificarlas aquí.
 */
export function collectMovIdsByKey(roots: readonly PivotNodeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const walk = (n: PivotNodeLike): void => {
    map.set(n.key, n.movs.map((m) => m.id));
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return map;
}

export function resolveSelectionIds(
  items: readonly SelectableItem[],
  movIdsByKey: ReadonlyMap<string, string[]>
): string[] {
  return [...new Set(items.flatMap((i) => (i.txId != null ? [i.txId] : (movIdsByKey.get(i.key) ?? []))))];
}
