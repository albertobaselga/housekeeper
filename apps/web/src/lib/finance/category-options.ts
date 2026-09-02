export interface FinanceCategoryOptionSource {
  id: string;
  name: string;
  parentId: string | null;
  kind: string;
}

export interface CategoryOptionGroup {
  parentId: string;
  label: string;
  options: Array<{ id: string; label: string }>;
}

/** Réplica del CategorySelect del origen: dos niveles, «(general)» para la raíz con hijas. */
export function categoryOptionGroups(categories: readonly FinanceCategoryOptionSource[]): CategoryOptionGroup[] {
  const roots = categories.filter((category) => category.parentId === null && category.kind !== 'transferencia');
  return roots.map((root) => {
    const children = categories.filter((category) => category.parentId === root.id);
    return {
      parentId: root.id,
      label: root.name,
      options:
        children.length === 0
          ? [{ id: root.id, label: root.name }]
          : [
              { id: root.id, label: `${root.name} / (general)` },
              ...children.map((child) => ({ id: child.id, label: `${root.name} / ${child.name}` }))
            ]
    };
  });
}
