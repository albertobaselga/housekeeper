import { describe, expect, it } from 'vitest';

import {
  collectLeafItems, collectMovIdsByKey, isCategoryAggregateNode, isMovementLeaf, parentKeyOf,
  rangeBetween, resolveSelectionIds, selectableListAny, toAnySelectable, toCategorySelectable,
  toggleInMap, toMovementSelectable, toSelectable,
  type PivotNodeLike, type SelectableItem
} from '../src/lib/finance/pivot-state';

function node(partial: Partial<PivotNodeLike>): PivotNodeLike {
  return {
    key: 'k', label: 'l', depth: 0, count: 1, totalCents: 0n, avgCents: 0n, ticketCents: 0n,
    monthly: {}, catId: null, nat: null, provider: null, concept: null, movs: [], children: [],
    ...partial
  };
}

describe('parentKeyOf', () => {
  it('recorta el último segmento; raíz = ""', () => {
    expect(parentKeyOf('/prov:A/concept:B')).toBe('/prov:A');
    expect(parentKeyOf('/prov:A')).toBe('');
  });
});

describe('toSelectable / toCategorySelectable / toMovementSelectable / toAnySelectable', () => {
  it('sin proveedor único no hay ítem proveedor/concepto', () => {
    expect(toSelectable(node({ provider: null }))).toBeNull();
  });
  it('un nodo cat/sub con catId único es seleccionable como categoría entera', () => {
    const n = node({ key: '/cat:Ocio', catId: 'c1', label: 'Ocio', count: 9 });
    expect(isCategoryAggregateNode(n, ['cat', 'sub'])).toBe(true);
    expect(toCategorySelectable(n, ['cat', 'sub'])).toEqual({
      key: '/cat:Ocio', parentKey: '', provider: '', concept: null, count: 9, categoryId: 'c1', label: 'Ocio'
    });
    expect(isCategoryAggregateNode(node({ key: '/cat:Sin categorizar', catId: null }), ['cat', 'sub'])).toBe(false);
    expect(isCategoryAggregateNode(node({ key: '/nat:x', catId: 'c1' }), ['nat', 'cat'])).toBe(false);
  });
  it('una hoja de la dimensión movimiento se selecciona por txId', () => {
    const n = node({ key: '/cat:Ocio/movement:t1', depth: 1, label: '2026-01-02 · −12,00 €',
      movs: [{ id: 't1', date: '2026-01-02', cents: -1200n }] });
    expect(isMovementLeaf(n, ['cat', 'movement'])).toBe(true);
    expect(toMovementSelectable(n, ['cat', 'movement'])?.txId).toBe('t1');
    expect(isMovementLeaf(n, ['cat', 'prov'])).toBe(false);
  });
  it('toAnySelectable prefiere categoría en un nivel cat/sub, y proveedor en los demás', () => {
    expect(toAnySelectable(node({ key: '/prov:A', provider: 'A' }), ['prov'])?.provider).toBe('A');
    expect(toAnySelectable(node({ key: '/cat:O', catId: 'c1', label: 'O' }), ['cat'])?.categoryId).toBe('c1');
    const leaf = node({ key: '/cat:O/movement:t9', depth: 1, movs: [{ id: 't9', date: 'x', cents: -1n }] });
    expect(toAnySelectable(leaf, ['cat', 'movement'])?.txId).toBe('t9');
    expect(toAnySelectable(node({ key: '/nat:mix' }), ['nat'])).toBeNull();
  });

  it('F6-M6: una categoría con un ÚNICO proveedor sigue siendo seleccionable como categoría', () => {
    // El dominio pone `provider` en cualquier nodo cuyas filas compartan
    // proveedor, así que este nodo de nivel `cat` llega con los dos campos. Sin
    // la preferencia por categoría se arrastraba como proveedor y soltarlo
    // sobre otra categoría creaba una regla, mientras que la misma categoría
    // con dos proveedores se rechazaba: el gesto dependía de cuántos
    // proveedores hubiera dentro, que no se ve.
    const monoProveedor = node({ key: '/cat:O', catId: 'c1', label: 'Ocio', provider: 'Cine Ideal', count: 4 });
    const item = toAnySelectable(monoProveedor, ['cat', 'prov']);
    expect(item?.categoryId).toBe('c1');
    expect(item?.provider).toBe('');
    // En el nivel de proveedor (sin catId propio) manda el proveedor.
    const provNode = node({ key: '/cat:O/prov:Cine', depth: 1, provider: 'Cine Ideal', count: 4 });
    expect(toAnySelectable(provNode, ['cat', 'prov'])?.provider).toBe('Cine Ideal');
  });
});

describe('selectableListAny / collectLeafItems', () => {
  it('lista hermanos seleccionables preservando el orden', () => {
    const nodes = [
      node({ key: '/cat:O', catId: 'c1', label: 'O' }),
      node({ key: '/cat:Sin categorizar' })
    ];
    expect(selectableListAny(nodes, ['cat']).map((s) => s.key)).toEqual(['/cat:O']);
  });
  it('recolecta hojas con proveedor y cuenta las omitidas', () => {
    const cat = node({
      key: '/cat:O',
      children: [
        node({ key: '/cat:O/prov:A', provider: 'A', count: 2 }),
        node({ key: '/cat:O/nat:mix' })
      ]
    });
    const r = collectLeafItems(cat);
    expect(r.items.map((i) => i.provider)).toEqual(['A']);
    expect(r.omitted).toBe(1);
  });
});

describe('rangeBetween / toggleInMap (Shift+clic)', () => {
  const siblings: SelectableItem[] = ['A', 'B', 'C', 'D'].map((p) => ({
    key: `/prov:${p}`, parentKey: '', provider: p, concept: null, count: 1
  }));
  it('rango inclusivo en ambos sentidos; null si cruzan grupos', () => {
    expect(rangeBetween(siblings, '/prov:A', '/prov:C')?.map((s) => s.provider)).toEqual(['A', 'B', 'C']);
    expect(rangeBetween(siblings, '/prov:C', '/prov:A')?.map((s) => s.provider)).toEqual(['A', 'B', 'C']);
    expect(rangeBetween(siblings, '/prov:A', '/prov:Z')).toBeNull();
  });
  it('toggleInMap añade/quita sin mutar', () => {
    const map = new Map<string, SelectableItem>();
    const next = toggleInMap(map, siblings[0]);
    expect(next.has('/prov:A')).toBe(true);
    expect(map.size).toBe(0);
    expect(toggleInMap(next, siblings[0]).has('/prov:A')).toBe(false);
  });
});

describe('collectMovIdsByKey / resolveSelectionIds', () => {
  const roots: PivotNodeLike[] = [
    node({
      key: '/cat:O', movs: [{ id: 't1', date: 'x', cents: -1n }, { id: 't2', date: 'y', cents: -2n }],
      children: [node({ key: '/cat:O/prov:A', provider: 'A', movs: [{ id: 't1', date: 'x', cents: -1n }] })]
    })
  ];
  it('mapea cada nodo (agregado y hoja) a los ids de sus movimientos', () => {
    const map = collectMovIdsByKey(roots);
    expect(map.get('/cat:O')).toEqual(['t1', 't2']);
    expect(map.get('/cat:O/prov:A')).toEqual(['t1']);
  });
  it('resuelve una selección mixta deduplicando ids', () => {
    const map = collectMovIdsByKey(roots);
    const items: SelectableItem[] = [
      { key: '/cat:O', parentKey: '', provider: '', concept: null, count: 2, categoryId: 'c1' },
      { key: '/cat:O/movement:t2', parentKey: '/cat:O', provider: '', concept: null, count: 1, txId: 't2' }
    ];
    expect(resolveSelectionIds(items, map).sort()).toEqual(['t1', 't2']);
    expect(resolveSelectionIds([{ key: 'missing', parentKey: '', provider: '', concept: null, count: 1 }], new Map())).toEqual([]);
  });
});
