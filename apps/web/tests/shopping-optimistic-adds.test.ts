import { describe, expect, it } from 'vitest';

import {
  collapseOptimisticAdds,
  normalizeAdditionName,
  type OptimisticAddition
} from '../src/lib/food/optimistic-adds';

function addition(overrides: Partial<OptimisticAddition> = {}): OptimisticAddition {
  return {
    operationId: '99999999-0000-4000-8000-000000000001',
    name: 'Servilletas',
    quantity: '2',
    unit: 'paquetes',
    listKind: 'casa',
    ...overrides
  };
}

describe('dedupe visual de añadidos optimistas de la compra', () => {
  it('dos taps rápidos del mismo artículo pintan UNA línea provisional', () => {
    const collapsed = collapseOptimisticAdds(
      [
        addition({ operationId: '99999999-0000-4000-8000-000000000001' }),
        addition({ operationId: '99999999-0000-4000-8000-000000000002' })
      ],
      new Set()
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({ name: 'Servilletas', times: 2 });
    // La clave de lista es la del primer añadido: la fila no salta de sitio.
    expect(collapsed[0]!.operationId).toBe('99999999-0000-4000-8000-000000000001');
  });

  it('agrupa sin distinguir mayúsculas ni espacios de más', () => {
    const collapsed = collapseOptimisticAdds(
      [addition({ name: '  Servilletas ' }), addition({ name: 'SERVILLETAS' })],
      new Set()
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.times).toBe(2);
  });

  it('no mezcla artículos distintos ni cantidades distintas', () => {
    const collapsed = collapseOptimisticAdds(
      [
        addition(),
        addition({ name: 'Lejía' }),
        addition({ quantity: '3' }),
        addition({ unit: 'rollos' })
      ],
      new Set()
    );
    expect(collapsed.map((entry) => [entry.name, entry.quantity, entry.unit, entry.times])).toEqual([
      ['Servilletas', '2', 'paquetes', 1],
      ['Lejía', '2', 'paquetes', 1],
      ['Servilletas', '3', 'paquetes', 1],
      ['Servilletas', '2', 'rollos', 1]
    ]);
  });

  it('cada lista tiene su propia línea provisional', () => {
    const collapsed = collapseOptimisticAdds(
      [addition({ name: 'Champú' }), addition({ name: 'Champú', listKind: 'personal' })],
      new Set()
    );
    expect(collapsed.map((entry) => entry.listKind)).toEqual(['casa', 'personal']);
  });

  it('en cuanto el servidor ya lo lista, la fila provisional desaparece', () => {
    const collapsed = collapseOptimisticAdds(
      [addition(), addition({ name: 'Lejía' })],
      new Set([normalizeAdditionName('  SERVILLETAS ')])
    );
    expect(collapsed.map((entry) => entry.name)).toEqual(['Lejía']);
  });
});
