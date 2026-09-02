import { describe, expect, it } from 'vitest';

import {
  buildDragPayload, dragGhostLabel, parseIdList, serializeIdList,
  summarizeCategoryDrop, summarizeEventDrop,
  type SelectableItem
} from '../src/lib/finance/pivot-state';

const item = (partial: Partial<SelectableItem>): SelectableItem =>
  ({ key: 'k', parentKey: '', provider: 'Prov', concept: null, count: 1, ...partial });

describe('buildDragPayload', () => {
  it('cuenta conceptos, suma movs y arrastra los omitidos', () => {
    const p = buildDragPayload([item({ count: 3 }), item({ key: 'k2', count: 4 })], 2);
    expect(p.concepts).toBe(2);
    expect(p.movs).toBe(7);
    expect(p.omitted).toBe(2);
  });
});

describe('dragGhostLabel', () => {
  it('«nombre (n movs)» para uno; el concepto manda sobre el proveedor', () => {
    expect(dragGhostLabel(buildDragPayload([item({ concept: 'compra online', count: 5 })]))).toBe('compra online (5 movs)');
    expect(dragGhostLabel(buildDragPayload([item({ provider: 'Mercadona', count: 2 })]))).toBe('Mercadona (2 movs)');
  });
  it('usa la etiqueta de categoría para un nodo agregado', () => {
    const p = buildDragPayload([item({ provider: '', categoryId: 'c1', label: 'Ocio', count: 9 })]);
    expect(dragGhostLabel(p)).toBe('Ocio (9 movs)');
  });
  it('«k conceptos (n movs)» para varios', () => {
    const p = buildDragPayload([item({ key: 'a', count: 3 }), item({ key: 'b', count: 4 })]);
    expect(dragGhostLabel(p)).toBe('2 conceptos (7 movs)');
  });
});

describe('resúmenes de drop (toast honesto)', () => {
  it('evento: singular/plural y nota de omitidos', () => {
    expect(summarizeEventDrop(1, 'Boda')).toBe('1 movimiento → Boda · regla creada');
    expect(summarizeEventDrop(4, 'Boda', 2)).toBe('4 movimientos → Boda · regla creada · 2 sin proveedor omitidos');
  });
  it('categoría: mensaje honesto cuando no se movió nada', () => {
    expect(summarizeCategoryDrop(0, 'Ocio')).toBe('Nada que mover (las categorías no pueden soltarse sobre otra categoría)');
    expect(summarizeCategoryDrop(0, 'Ocio', 3)).toContain('3 omitidos');
    expect(summarizeCategoryDrop(0, 'Ocio')).not.toContain('regla creada');
    expect(summarizeCategoryDrop(2, 'Ocio', 1)).toBe('2 movimientos → Ocio · regla creada · 1 omitido');
  });
});

describe('parseIdList / serializeIdList (?exev= y ?dupev=)', () => {
  it('CSV deduplicado, ignora vacíos', () => {
    expect(parseIdList('a,b,a,,c')).toEqual(['a', 'b', 'c']);
    expect(parseIdList(null)).toEqual([]);
    expect(serializeIdList(['a', 'b'])).toBe('a,b');
  });
});
