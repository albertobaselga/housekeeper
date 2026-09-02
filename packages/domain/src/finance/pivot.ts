import { divideRoundHalfAwayFromZero, formatEuroCents, moneyCents } from "../money.js";
import type { FinanceRecurrence } from "./types.js";

export type PivotDimension = "cat" | "sub" | "nat" | "prov" | "concept" | "movement";
export type PivotSection = "INGRESOS" | "GASTOS" | "EVENTOS" | "INTERNAS" | "INVERSION";

export const ALL_DIMS: readonly PivotDimension[] = ["cat", "sub", "nat", "prov", "concept", "movement"];
export const DEFAULT_DIMS: readonly PivotDimension[] = ["cat", "sub"];
/** Dims FIJAS de INVERSIÓN: cuenta → concepto → movimiento. Ignoran las dims del
 * usuario, pero llegan hasta la hoja de movimiento, así que la tabla se puede
 * expandir y cada movimiento concreto es seleccionable. */
export const INVERSION_DIMS: readonly PivotDimension[] = ["cat", "concept", "movement"];
/** Dims FIJAS de INTERNAS: grupo → cuenta (pata) → concepto → movimiento.
 * Igual que INVERSION_DIMS pero con la pata (prov) intermedia. */
export const INTERNA_DIMS: readonly PivotDimension[] = ["cat", "prov", "concept", "movement"];

export interface PivotMov {
  id: string;
  date: string;
  cents: bigint;
}

export interface PivotSourceRow {
  cat: string;
  sub: string | null;
  catId: string | null;
  nat: FinanceRecurrence;
  prov: string;
  concept: string;
  event: string | null;
  eventId: string | null;
  kind: "gasto" | "ingreso" | "transferencia" | "inversion";
  month: string;
  totalCents: bigint;
  count: number;
  movs: readonly PivotMov[];
}

export interface PivotOptions {
  monthsCount: number;
  dupEventIds?: ReadonlySet<string>;
}

export interface PivotNode {
  key: string;
  label: string;
  depth: number;
  count: number;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
  catId: string | null;
  nat: FinanceRecurrence;
  provider: string | null;
  concept: string | null;
  /** Conceptos reales (distintos) de las filas bajo el nodo. Se usa para abrir el
   * panel de INTERNAS por conjunto de conceptos (donde `concept` puede ser null
   * al agregar varios). */
  concepts: string[];
  /** Movimientos (id/date/cents) de las filas bajo el nodo. En una hoja de dim
   * 'movement' es un único elemento; en el resto, la concatenación de los `movs`
   * de las filas del grupo (permite abrir el panel por ids). */
  movs: PivotMov[];
  children: PivotNode[];
}

export interface PivotSectionTotal {
  count: number;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
}

export interface PivotEventGroup {
  eventId: string;
  name: string;
  count: number;
  netCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
  children: PivotNode[];
}

export interface PivotTree {
  gastos: PivotNode[];
  ingresos: PivotNode[];
  internas: PivotNode[];
  inversiones: PivotNode[];
  eventos: PivotEventGroup[];
  subtotales: {
    gastos: PivotSectionTotal;
    eventos: PivotSectionTotal;
    ingresos: PivotSectionTotal;
    internas: PivotSectionTotal;
    inversiones: PivotSectionTotal;
    totalNeto: PivotSectionTotal;
  };
}

function dimValue(r: PivotSourceRow, dim: Exclude<PivotDimension, "movement">): string {
  switch (dim) {
    case "cat":
      return r.cat;
    case "sub":
      return r.sub ?? "(sin subcategoría)";
    case "nat":
      return r.nat === "recurrente"
        ? "♻ Recurrente"
        : r.nat === "extraordinario"
          ? "✦ Extraordinario"
          : "Sin clasificar";
    case "prov":
      return r.prov;
    case "concept":
      return r.concept;
  }
}

const natSortKey = (label: string): string =>
  label.startsWith("♻") ? "0" : label.startsWith("✦") ? "1" : "2";

function sortLabels(dim: PivotDimension, labels: string[]): string[] {
  if (dim === "nat") return [...labels].sort((a, b) => natSortKey(a).localeCompare(natSortKey(b)));
  return [...labels].sort((a, b) => a.localeCompare(b, "es"));
}

function uniqueOrNull<T>(values: readonly (T | null)[]): T | null {
  const set = new Set(values);
  if (set.size !== 1) return null;
  const [v] = set;
  return v ?? null;
}

const sumCount = (rows: readonly PivotSourceRow[]): number => rows.reduce((s, r) => s + r.count, 0);
const sumTotal = (rows: readonly PivotSourceRow[]): bigint =>
  rows.reduce((s, r) => s + r.totalCents, 0n);
const ticketOf = (total: bigint, count: number): bigint =>
  count === 0 ? 0n : divideRoundHalfAwayFromZero(total, BigInt(count));
const avgOf = (total: bigint, monthsCount: number): bigint =>
  monthsCount === 0 ? 0n : divideRoundHalfAwayFromZero(total, BigInt(monthsCount));

function monthlyOf(rows: readonly PivotSourceRow[]): Record<string, bigint> {
  const monthly: Record<string, bigint> = {};
  for (const r of rows) monthly[r.month] = (monthly[r.month] ?? 0n) + r.totalCents;
  return monthly;
}

/** Agrupa filas de pivot en un árbol según las dimensiones activas (en orden).
 * El total de cada nodo es la suma de sus hojas. */
function buildLevel(
  rows: readonly PivotSourceRow[],
  dims: readonly PivotDimension[],
  parentKey: string,
  depth: number,
  monthsCount: number,
): PivotNode[] {
  if (dims.length === 0) return [];
  const [dim, ...rest] = dims as [PivotDimension, ...PivotDimension[]];

  // 'movement' es terminal: una hoja por movimiento (ignora las dims siguientes),
  // no se agrupa por valor.
  if (dim === "movement") {
    return rows
      .flatMap((r) => r.movs)
      .map((mov) => ({
        key: `${parentKey}/movement:${mov.id}`,
        label: `${mov.date} · ${formatEuroCents(moneyCents(mov.cents))}`,
        depth,
        count: 1,
        totalCents: mov.cents,
        avgCents: avgOf(mov.cents, monthsCount),
        ticketCents: ticketOf(mov.cents, 1),
        monthly: { [mov.date.slice(0, 7)]: mov.cents },
        catId: null,
        nat: null,
        provider: null,
        concept: null,
        concepts: [],
        movs: [mov],
        children: [],
      }));
  }

  const groups = new Map<string, PivotSourceRow[]>();
  for (const r of rows) {
    const v = dimValue(r, dim);
    const list = groups.get(v) ?? [];
    list.push(r);
    groups.set(v, list);
  }
  return sortLabels(dim, [...groups.keys()]).map((label) => {
    const groupRows = groups.get(label) as PivotSourceRow[];
    const key = `${parentKey}/${dim}:${label}`;
    const count = sumCount(groupRows);
    const total = sumTotal(groupRows);
    return {
      key,
      label,
      depth,
      count,
      totalCents: total,
      avgCents: avgOf(total, monthsCount),
      ticketCents: ticketOf(total, count),
      monthly: monthlyOf(groupRows),
      catId: uniqueOrNull(groupRows.map((r) => r.catId)),
      nat: uniqueOrNull(groupRows.map((r) => r.nat)),
      provider: uniqueOrNull<string>(groupRows.map((r) => r.prov)),
      concept: uniqueOrNull<string>(groupRows.map((r) => r.concept)),
      concepts: [...new Set(groupRows.map((r) => r.concept))],
      movs: groupRows.flatMap((r) => [...r.movs]),
      children: buildLevel(groupRows, rest, key, depth + 1, monthsCount),
    };
  });
}

/** `sectionKey` cualifica la raíz de cada sección («gastos», «evento:ev1»…): sin
 * él, la misma categoría en GASTOS y en un evento compartiría `key` y
 * `collectNodeMovIds` machacaría una entrada con la otra (fallo del original). */
function buildTreeNodes(
  rows: readonly PivotSourceRow[],
  dims: readonly PivotDimension[],
  monthsCount: number,
  sectionKey: string,
): PivotNode[] {
  if (rows.length === 0 || dims.length === 0) return [];
  return buildLevel(rows, dims, sectionKey, 0, monthsCount);
}

function sectionTotal(rows: readonly PivotSourceRow[], monthsCount: number): PivotSectionTotal {
  const count = sumCount(rows);
  const total = sumTotal(rows);
  return {
    count,
    totalCents: total,
    avgCents: avgOf(total, monthsCount),
    ticketCents: ticketOf(total, count),
    monthly: monthlyOf(rows),
  };
}

function mergeMonthly(sections: readonly PivotSectionTotal[]): Record<string, bigint> {
  const monthly: Record<string, bigint> = {};
  for (const s of sections) {
    for (const [k, v] of Object.entries(s.monthly)) monthly[k] = (monthly[k] ?? 0n) + v;
  }
  return monthly;
}

/** Port de pivotTree.buildPivotSections: construye las cinco secciones del pivot
 * (gastos, eventos, ingresos, internas, inversiones) con subtotales y TOTAL NETO.
 * Partición exhaustiva de `rows` por `kind` — ninguna fila se pierde en silencio:
 * transferencia → internas, inversion → inversiones, y el resto (gasto/ingreso) se
 * reparte entre eventos (si tiene `eventId`) y gastos/ingresos según `kind`.
 * INTERNAS e INVERSIONES usan dims FIJAS (ignoran las `dims` del usuario) que bajan
 * hasta la hoja de movimiento, así se pueden expandir y seleccionar un movimiento
 * concreto: INTERNAS agrupa grupo → pata → concepto → movimiento (`INTERNA_DIMS`,
 * cat = etiqueta de grupo, prov = cuenta de la pata); INVERSIONES agrupa cuenta →
 * concepto → movimiento (`INVERSION_DIMS`, cat = nombre de cuenta). Dentro de
 * gastos/ingresos/eventos se aplica la jerarquía de `dims` normal. `totalNeto` NO
 * incluye internas ni inversiones.
 *
 * `dupEventIds`: conjunto de IDs de evento cuyos movimientos aparecen TAMBIÉN bajo
 * su categoría en GASTOS/INGRESOS (para analizar totales/subtotales completos),
 * además de en la sección EVENTOS. El TOTAL NETO sigue contando cada movimiento una
 * sola vez (un evento duplicado se cuenta vía gastos/ingresos, no vía EVENTOS). */
export function buildPivotTree(
  rows: readonly PivotSourceRow[],
  dims: readonly PivotDimension[],
  opts: PivotOptions,
): PivotTree {
  const { monthsCount } = opts;
  const dupEventIds = opts.dupEventIds ?? new Set<string>();
  const internaRows = rows.filter((r) => r.kind === "transferencia");
  const inversionRows = rows.filter((r) => r.kind === "inversion");
  const cashflowRows = rows.filter((r) => r.kind === "gasto" || r.kind === "ingreso");
  const eventRows = cashflowRows.filter((r) => r.eventId !== null);
  const isDup = (r: PivotSourceRow): boolean => r.eventId !== null && dupEventIds.has(r.eventId);
  const inFlow = (r: PivotSourceRow): boolean => r.eventId === null || isDup(r); // cuelga de gastos/ingresos
  const gastoRows = cashflowRows.filter((r) => r.kind === "gasto" && inFlow(r));
  const ingresoRows = cashflowRows.filter((r) => r.kind === "ingreso" && inFlow(r));

  const eventGroups = new Map<string, PivotSourceRow[]>();
  for (const r of eventRows) {
    const list = eventGroups.get(r.eventId as string) ?? [];
    list.push(r);
    eventGroups.set(r.eventId as string, list);
  }
  const eventos = [...eventGroups.entries()]
    .map(([eventId, groupRows]) => {
      const count = sumCount(groupRows);
      const net = sumTotal(groupRows);
      return {
        eventId,
        name: groupRows[0]?.event ?? "",
        count,
        netCents: net,
        avgCents: avgOf(net, monthsCount),
        ticketCents: ticketOf(net, count),
        monthly: monthlyOf(groupRows),
        children: buildTreeNodes(groupRows, dims, monthsCount, `evento:${eventId}`),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  const gastosTotal = sectionTotal(gastoRows, monthsCount);
  const eventosTotal = sectionTotal(eventRows, monthsCount);
  const ingresosTotal = sectionTotal(ingresoRows, monthsCount);
  // El TOTAL NETO cuenta cada movimiento UNA sola vez: los eventos duplicados ya
  // están en gastos/ingresos, así que solo se suman los NO duplicados por EVENTOS.
  const eventNet = sectionTotal(eventRows.filter((r) => !isDup(r)), monthsCount);
  const totalNetoCount = gastosTotal.count + eventNet.count + ingresosTotal.count;
  const totalNetoTotal = gastosTotal.totalCents + eventNet.totalCents + ingresosTotal.totalCents;

  return {
    gastos: buildTreeNodes(gastoRows, dims, monthsCount, "gastos"),
    ingresos: buildTreeNodes(ingresoRows, dims, monthsCount, "ingresos"),
    internas: buildTreeNodes(internaRows, INTERNA_DIMS, monthsCount, "internas"),
    inversiones: buildTreeNodes(inversionRows, INVERSION_DIMS, monthsCount, "inversiones"),
    eventos,
    subtotales: {
      gastos: gastosTotal,
      eventos: eventosTotal,
      ingresos: ingresosTotal,
      internas: sectionTotal(internaRows, monthsCount),
      inversiones: sectionTotal(inversionRows, monthsCount),
      totalNeto: {
        count: totalNetoCount,
        totalCents: totalNetoTotal,
        avgCents: avgOf(totalNetoTotal, monthsCount),
        ticketCents: ticketOf(totalNetoTotal, totalNetoCount),
        monthly: mergeMonthly([gastosTotal, eventNet, ingresosTotal]),
      },
    },
  };
}

/** Mapa key → ids de movimiento de todos los nodos (recursivo, eventos incluidos).
 * Permite resolver una selección —hojas o nodos agregados— a sus ids exactos para
 * abrir el panel por ids (unión) sin re-buscar por texto. */
export function collectNodeMovIds(tree: PivotTree): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const walk = (n: PivotNode): void => {
    map.set(n.key, n.movs.map((mv) => mv.id));
    n.children.forEach(walk);
  };
  tree.gastos.forEach(walk);
  tree.ingresos.forEach(walk);
  tree.internas.forEach(walk);
  tree.inversiones.forEach(walk);
  tree.eventos.forEach((ev) => ev.children.forEach(walk));
  return map;
}

export type SortKey = "label" | "total" | "avg" | "ticket" | { month: string };

interface Sortable {
  label: string;
  totalCents: bigint;
  avgCents: bigint;
  ticketCents: bigint;
  monthly: Record<string, bigint>;
}

function sortValue(key: SortKey, item: Sortable): bigint | string {
  if (key === "label") return item.label;
  if (key === "total") return item.totalCents;
  if (key === "avg") return item.avgCents;
  if (key === "ticket") return item.ticketCents;
  return item.monthly[key.month] ?? 0n;
}

function compareValues(a: bigint | string, b: bigint | string, dir: "asc" | "desc"): number {
  const cmp =
    typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b, "es")
      : a < b
        ? -1
        : a > b
          ? 1
          : 0;
  return dir === "asc" ? cmp : -cmp;
}

function sortNodes(nodes: PivotNode[], key: SortKey, dir: "asc" | "desc"): PivotNode[] {
  return nodes
    .map((n) => ({ ...n, children: sortNodes(n.children, key, dir) }))
    .sort((a, b) => compareValues(sortValue(key, a), sortValue(key, b), dir));
}

/** Reordena los hermanos en cada nivel de gastos/ingresos/eventos (y los hijos de
 * cada evento) según `key`/`dir`. Los subtotales no se mueven ni se recalculan.
 * `internas`/`inversiones` conservan su orden fijo: el spread las pasa tal cual. */
export function sortPivotTree(tree: PivotTree, key: SortKey, dir: "asc" | "desc"): PivotTree {
  return {
    ...tree,
    gastos: sortNodes(tree.gastos, key, dir),
    ingresos: sortNodes(tree.ingresos, key, dir),
    eventos: tree.eventos
      .map((e) => ({ ...e, children: sortNodes(e.children, key, dir) }))
      .sort((a, b) =>
        compareValues(
          sortValue(key, { label: a.name, totalCents: a.netCents, avgCents: a.avgCents, ticketCents: a.ticketCents, monthly: a.monthly }),
          sortValue(key, { label: b.name, totalCents: b.netCents, avgCents: b.avgCents, ticketCents: b.ticketCents, monthly: b.monthly }),
          dir,
        ),
      ),
  };
}

export function parseDims(raw: string | null): PivotDimension[] {
  if (raw === null || raw === "") return [...DEFAULT_DIMS];
  const parsed = raw.split(",").filter((d): d is PivotDimension => (ALL_DIMS as string[]).includes(d));
  const deduped = [...new Set(parsed)];
  return deduped.length > 0 ? deduped : [...DEFAULT_DIMS];
}
