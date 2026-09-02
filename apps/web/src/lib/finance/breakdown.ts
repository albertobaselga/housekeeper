/**
 * Agrupación del desglose por categoría (porta groupByParent del origen,
 * CategoryBreakdown.tsx): solo gastos, agrupados por categoría padre,
 * ordenados del más gastado, con «(general)» para el importe del propio padre.
 * Los porcentajes de barra se calculan en bigint: sin floats sobre dinero.
 */
export interface BreakdownRowInput { categoryId: string | null; name: string; parentId: string | null; totalCents: string }

export interface BreakdownGroup {
  id: string | null;
  name: string;
  totalCents: bigint;
  /** Ancho de la barra: |total| del grupo sobre el |total| máximo, 0–100. */
  percent: number;
  subs: { name: string; totalCents: bigint; categoryId: string | null }[];
}

export function groupExpenseCategories(
  rows: readonly BreakdownRowInput[],
  categoryNameById: ReadonlyMap<string, string>
): BreakdownGroup[] {
  const groups = new Map<string | null, BreakdownGroup>();
  for (const row of rows) {
    const total = BigInt(row.totalCents);
    if (total >= 0n) continue; // solo gastos (contrato del original)
    const parentId = row.parentId ?? row.categoryId;
    const name = parentId === null ? 'Sin categorizar' : (categoryNameById.get(parentId) ?? '?');
    const group = groups.get(parentId) ?? { id: parentId, name, totalCents: 0n, percent: 0, subs: [] };
    group.totalCents += total;
    group.subs.push({
      name: row.parentId === null && row.categoryId !== null ? '(general)' : row.name,
      totalCents: total,
      categoryId: row.categoryId
    });
    groups.set(parentId, group);
  }
  const ascending = (left: bigint, right: bigint): number => (left < right ? -1 : left > right ? 1 : 0);
  const list = [...groups.values()].sort((a, b) => ascending(a.totalCents, b.totalCents));
  const maxAbs = list.reduce((acc, group) => {
    const abs = group.totalCents < 0n ? -group.totalCents : group.totalCents;
    return abs > acc ? abs : acc;
  }, 1n);
  return list.map((group) => ({
    ...group,
    // Porcentaje entero de presentación: el cociente en bigint se convierte a Number solo al final, para la barra.
    percent: Number(((group.totalCents < 0n ? -group.totalCents : group.totalCents) * 100n) / maxAbs),
    subs: [...group.subs].sort((a, b) => ascending(a.totalCents, b.totalCents))
  }));
}

/** 'Casa › Supermercado' para selects y chips (porta categoryPath del origen). */
export function categoryPath(
  categories: readonly { id: string; name: string; parentId: string | null }[],
  id: string
): string {
  const category = categories.find((candidate) => candidate.id === id);
  if (!category) return '?';
  if (category.parentId === null) return category.name;
  const parent = categories.find((candidate) => candidate.id === category.parentId);
  return parent ? `${parent.name} › ${category.name}` : category.name;
}
