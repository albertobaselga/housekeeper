import { describe, expect, it } from 'vitest';

import {
  addDim, DEFAULT_DIMS, DIM_LABELS, moveDim, parseDims, PIVOT_DIMENSIONS, removeDim, sameSortKey,
  serializeDims, sortTree, type SortableNodeLike
} from '../src/lib/finance/pivot-state';

type Node = SortableNodeLike & { children: Node[] };
const node = (label: string, totalCents: bigint, children: Node[] = [], monthly: Record<string, bigint> = {}): Node =>
  ({ label, totalCents, avgCents: totalCents, ticketCents: totalCents, monthly, children });

describe('contrato heredado del stub de la fase 4 (no se renombra ni se cambia)', () => {
  it('parseDims sin parámetro devuelve las dims por defecto', () => {
    expect(parseDims(null)).toEqual([...DEFAULT_DIMS]);
  });
  it('serializeDims devuelve null para el orden por defecto (URL limpia) y CSV para el resto', () => {
    expect(serializeDims([...DEFAULT_DIMS])).toBeNull();
    expect(serializeDims(['sub', 'cat'])).toBe('sub,cat');
  });
  it('hay una etiqueta en español para cada dimensión publicada', () => {
    for (const dim of PIVOT_DIMENSIONS) expect(DIM_LABELS[dim].length).toBeGreaterThan(0);
  });
});

describe('moveDim / removeDim / addDim', () => {
  it('intercambia posiciones adyacentes y respeta los bordes', () => {
    expect(moveDim(['cat', 'sub'], 0, 1)).toEqual(['sub', 'cat']);
    expect(moveDim(['cat', 'sub'], 0, -1)).toEqual(['cat', 'sub']);
  });
  it('nunca deja la lista vacía y no duplica al añadir', () => {
    expect(removeDim(['cat'], 'cat')).toEqual(['cat']);
    expect(removeDim(['cat', 'sub'], 'cat')).toEqual(['sub']);
    expect(addDim(['cat'], 'cat')).toEqual(['cat']);
    expect(addDim(['cat'], 'nat')).toEqual(['cat', 'nat']);
  });
});

describe('sortTree (recursivo, sin mutar la entrada)', () => {
  const roots = [
    node('Zeta', -600n, [node('a', -100n), node('b', -500n)]),
    node('Alfa', -350n, [node('x', -50n, [], { '2026-02': -50n }), node('y', -300n)])
  ];
  it('ordena por label alfabético asc/desc', () => {
    expect(sortTree(roots, 'label', 'asc').map((n) => n.label)).toEqual(['Alfa', 'Zeta']);
    expect(sortTree(roots, 'label', 'desc').map((n) => n.label)).toEqual(['Zeta', 'Alfa']);
  });
  it('por total ascendente el gasto más negativo va primero, también en los hijos', () => {
    const sorted = sortTree(roots, 'total', 'asc');
    expect(sorted.map((n) => n.label)).toEqual(['Zeta', 'Alfa']);
    expect(sorted[0].children.map((c) => c.label)).toEqual(['b', 'a']);
    expect(sorted[1].children.map((c) => c.label)).toEqual(['y', 'x']);
  });
  it('ordena por una clave de mes (ausente = 0n)', () => {
    const sorted = sortTree(roots[1].children, { month: '2026-02' }, 'asc');
    expect(sorted.map((n) => n.label)).toEqual(['x', 'y']);
  });
  it('no muta la entrada', () => {
    const before = roots.map((n) => n.label);
    sortTree(roots, 'total', 'asc');
    expect(roots.map((n) => n.label)).toEqual(before);
  });
  it('cuando la clave empata, desempata por etiqueta (comparador total y determinista)', () => {
    const tied = [node('Beta', -100n), node('Alfa', -100n)];
    expect(sortTree(tied, 'total', 'asc').map((n) => n.label)).toEqual(['Alfa', 'Beta']);
    expect(sortTree(tied, 'total', 'desc').map((n) => n.label)).toEqual(['Beta', 'Alfa']);
  });
});

describe('sameSortKey', () => {
  it('compara claves simples y de mes', () => {
    expect(sameSortKey('total', 'total')).toBe(true);
    expect(sameSortKey({ month: '2026-01' }, { month: '2026-01' })).toBe(true);
    expect(sameSortKey({ month: '2026-01' }, 'total')).toBe(false);
  });
});
