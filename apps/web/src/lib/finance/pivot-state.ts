/**
 * STUB del estado del pivot de Analítica. La fase 6 construye aquí las
 * dimensiones reordenables, la selección y el resto del estado; esta fase
 * solo fija el contrato de URL de la clave `dims` (CSV de dimensiones, del
 * doc de interfaces) para que filters.ts ya la conserve en el merge.
 */
import type { PivotDimension } from '@housekeeper/domain/finance';
import { normText } from '@housekeeper/domain/finance';

import { formatCents } from './format';

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
  // F6-I2 (R7): `node.catId!` compilaba apoyado en que `isCategoryAggregateNode`
  // comprueba `catId !== null`, pero el estrechamiento no cruza la llamada. Se
  // saca `catId` al cuerpo y se comprueba aquí: TS lo estrecha de verdad y, si
  // la guarda cambiara, esto deja de compilar en vez de colar `undefined`.
  const catId = node.catId;
  if (catId === null || !isCategoryAggregateNode(node, dims)) return null;
  return {
    key: node.key, parentKey: parentKeyOf(node.key), provider: '', concept: null,
    count: node.count, categoryId: catId, label: node.label
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
  // F6-M6: la CATEGORÍA manda en un nivel `cat`/`sub`. El dominio marca
  // `provider` en cualquier nodo cuyas filas compartan proveedor
  // (packages/domain/src/finance/pivot.ts), así que una categoría con un único
  // proveedor llegaba aquí con `provider` puesto y se arrastraba como
  // proveedor: soltarla sobre otra categoría creaba regla, mientras que la
  // misma categoría con dos proveedores se rechazaba. El gesto dependía de
  // cuántos proveedores hubiera dentro, que es invisible; ahora depende de la
  // dimensión del nivel, que sí se ve en la cabecera.
  return toCategorySelectable(node, dims) ?? toSelectable(node) ?? toMovementSelectable(node, dims);
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

// ── Buscador con chips tipados (?q=, contrato del doc de interfaces) ─────────
// R15: sin normalizador local reimplementado — `normalizeText` es un envoltorio
// fino sobre `normText` del dominio (misma semántica NFKD que el servidor;
// solo se añade `toLowerCase()` para presentación) usado a AMBOS lados de toda
// comparación de este módulo.

export type SearchChip = { type: 'prov' | 'concept' | 'event' | 'cat' | 'free'; value: string; prov?: string };

const CHIP_TYPES: readonly SearchChip['type'][] = ['prov', 'concept', 'event', 'cat', 'free'];

export interface SearchableRowLike {
  cat: string;
  sub: string | null;
  catId: string | null;
  prov: string;
  concept: string;
  event: string | null;
}

export interface SuggestGroup {
  group: string;
  items: { chip: SearchChip; label: string; detail: string }[];
}

/** Envoltorio de `normText` (dominio) para matching case-insensitive de presentación. */
export function normalizeText(s: string): string {
  return normText(s).toLowerCase();
}

export function suggestChips(
  rows: readonly (SearchableRowLike & { totalCents: bigint; count: number })[],
  catPathOf: (catId: string) => string,
  query: string
): SuggestGroup[] {
  const q = normalizeText(query);
  if (q.length < 2) return [];
  const abs = (v: bigint) => (v < 0n ? -v : v);
  /** R19: comparador total (total desc), con etiqueta asc como desempate — orden determinista aunque empate el total. */
  const byAbsTotalDesc = (a: bigint, b: bigint, labelA: string, labelB: string): number =>
    a === b ? labelA.localeCompare(labelB, 'es') : a > b ? -1 : 1;

  const provMap = new Map<string, { totalCents: bigint; count: number }>();
  const conceptMap = new Map<string, { concept: string; prov: string; count: number }>();
  const eventMap = new Map<string, { netCents: bigint }>();
  const catMap = new Map<string, { totalCents: bigint; count: number }>();

  for (const r of rows) {
    if (normalizeText(r.prov).includes(q)) {
      const e = provMap.get(r.prov) ?? { totalCents: 0n, count: 0 };
      e.totalCents += r.totalCents;
      e.count += r.count;
      provMap.set(r.prov, e);
    }
    if (normalizeText(r.concept).includes(q)) {
      // R23: separador imposible en texto de usuario (U+0000), NO un espacio:
      // con espacio, ('aa b', 'c') y ('aa', 'b c') colisionaban en la misma
      // clave 'aa b c' y se fusionaban perdiendo un par entero.
      const key = `${r.concept}\u0000${r.prov}`;
      const e = conceptMap.get(key) ?? { concept: r.concept, prov: r.prov, count: 0 };
      e.count += r.count;
      conceptMap.set(key, e);
    }
    if (r.event && normalizeText(r.event).includes(q)) {
      const e = eventMap.get(r.event) ?? { netCents: 0n };
      e.netCents += r.totalCents;
      eventMap.set(r.event, e);
    }
    if (r.catId !== null && normalizeText(catPathOf(r.catId)).includes(q)) {
      const e = catMap.get(r.catId) ?? { totalCents: 0n, count: 0 };
      e.totalCents += r.totalCents;
      e.count += r.count;
      catMap.set(r.catId, e);
    }
  }

  const groups: SuggestGroup[] = [
    {
      group: 'Proveedores',
      items: [...provMap.entries()]
        .sort((a, b) => byAbsTotalDesc(abs(a[1].totalCents), abs(b[1].totalCents), a[0], b[0]))
        .map(([prov, e]) => ({
          chip: { type: 'prov', value: prov },
          label: prov,
          detail: `${formatCents(e.totalCents)} · ${e.count} movs`
        }))
    },
    {
      group: 'Conceptos',
      items: [...conceptMap.values()]
        .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.concept.localeCompare(b.concept, 'es')))
        .map((e) => ({
          chip: { type: 'concept', value: e.concept, prov: e.prov },
          label: e.concept,
          detail: `${e.prov} · ${e.count} movs`
        }))
    },
    {
      group: 'Eventos',
      items: [...eventMap.entries()]
        .sort((a, b) => byAbsTotalDesc(abs(a[1].netCents), abs(b[1].netCents), a[0], b[0]))
        .map(([event, e]) => ({
          chip: { type: 'event', value: event },
          label: event,
          detail: `neto ${formatCents(e.netCents)}`
        }))
    },
    {
      group: 'Categorías',
      items: [...catMap.entries()]
        .sort((a, b) => byAbsTotalDesc(abs(a[1].totalCents), abs(b[1].totalCents), catPathOf(a[0]), catPathOf(b[0])))
        .map(([catId, e]) => ({
          chip: { type: 'cat', value: catId },
          label: catPathOf(catId),
          detail: `${formatCents(e.totalCents)} · ${e.count} movs`
        }))
    }
  ];
  return groups.filter((g) => g.items.length > 0);
}

function matchesChip(row: SearchableRowLike, chip: SearchChip, catPathOf: (catId: string) => string): boolean {
  const q = normalizeText(chip.value);
  switch (chip.type) {
    case 'prov':
      return normalizeText(row.prov) === q;
    case 'concept':
      return normalizeText(row.concept) === q && (!chip.prov || normalizeText(row.prov) === normalizeText(chip.prov));
    case 'event':
      return row.event != null && normalizeText(row.event) === q;
    case 'cat':
      return row.catId !== null && row.catId === chip.value;
    case 'free': {
      const fields = [row.prov, row.concept, row.event, row.cat, row.sub, row.catId !== null ? catPathOf(row.catId) : null];
      return fields.some((f) => f != null && normalizeText(f).includes(q));
    }
  }
}

/** AND entre chips: la fila debe casar con todos los chips activos. */
export function rowMatchesChips(
  row: SearchableRowLike,
  chips: readonly SearchChip[],
  catPathOf: (catId: string) => string
): boolean {
  return chips.every((chip) => matchesChip(row, chip, catPathOf));
}

export function serializeChips(chips: readonly SearchChip[]): string {
  return chips
    .map((c) =>
      c.type === 'concept' && c.prov
        ? `concept:${encodeURIComponent(c.prov)}~~${encodeURIComponent(c.value)}`
        : `${c.type}:${encodeURIComponent(c.value)}`
    )
    .join('|');
}

/** Type guard (sin `as` sobre el dato parseado): estrecha `type` al union de `SearchChip`. */
function isChipType(type: string): type is SearchChip['type'] {
  return (CHIP_TYPES as readonly string[]).includes(type);
}

export function parseChips(q: string | null): SearchChip[] {
  if (!q) return [];
  const chips: SearchChip[] = [];
  for (const part of q.split('|')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const type = part.slice(0, idx);
    const rawValue = part.slice(idx + 1);
    if (!isChipType(type)) continue;
    try {
      if (type === 'concept' && rawValue.includes('~~')) {
        const sep = rawValue.indexOf('~~');
        chips.push({
          type: 'concept',
          value: decodeURIComponent(rawValue.slice(sep + 2)),
          prov: decodeURIComponent(rawValue.slice(0, sep))
        });
      } else {
        chips.push({ type, value: decodeURIComponent(rawValue) });
      }
    } catch {
      continue;
    }
  }
  return chips;
}

// ── Drag and drop: payload, ghost y resúmenes; codecs exev/dupev ─────────────

export interface DragPayload {
  items: SelectableItem[];
  concepts: number;
  movs: number;
  /** Hojas descartadas por no tener proveedor único (arrastre en bloque). */
  omitted: number;
}

export function buildDragPayload(items: SelectableItem[], omitted = 0): DragPayload {
  return { items, concepts: items.length, movs: items.reduce((s, i) => s + i.count, 0), omitted };
}

export function dragGhostLabel(payload: DragPayload): string {
  if (payload.items.length === 1) {
    const it = payload.items[0];
    return `${it.label ?? it.concept ?? it.provider} (${it.count} movs)`;
  }
  return `${payload.concepts} conceptos (${payload.movs} movs)`;
}

/**
 * Elemento offscreen para setDragImage; se elimina en el siguiente tick (el
 * navegador ya habrá tomado la instantánea). El estilo vive en la clase GLOBAL
 * `pivot-drag-ghost` (PivotTable.svelte) para pasar el linter de tokens.
 */
export function createDragGhostElement(label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = label;
  el.className = 'pivot-drag-ghost';
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 0);
  return el;
}

const plural = (n: number, s: string, p: string) => (n === 1 ? s : p);

export function summarizeEventDrop(movs: number, eventName: string, omitted = 0): string {
  const base = `${movs} ${plural(movs, 'movimiento', 'movimientos')} → ${eventName} · regla creada`;
  return omitted > 0 ? `${base} · ${omitted} sin proveedor ${plural(omitted, 'omitido', 'omitidos')}` : base;
}

export function summarizeCategoryDrop(movs: number, categoryPath: string, omitted = 0): string {
  const suffix = omitted > 0 ? ` · ${omitted} ${plural(omitted, 'omitido', 'omitidos')}` : '';
  if (movs === 0) return `Nada que mover (las categorías no pueden soltarse sobre otra categoría)${suffix}`;
  return `${movs} ${plural(movs, 'movimiento', 'movimientos')} → ${categoryPath} · regla creada${suffix}`;
}

// exev (partidas excluidas de KPIs/gráfica) y dupev (eventos duplicados en
// GASTOS/INGRESOS): CSV de ids en la URL, merge no destructivo como dims/q.
export function parseIdList(raw: string | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').filter((s) => s.length > 0))];
}

export function serializeIdList(ids: readonly string[]): string {
  return ids.join(',');
}
