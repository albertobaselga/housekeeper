import { describe, expect, it } from 'vitest';

import {
  normalizeText, parseChips, rowMatchesChips, serializeChips, suggestChips,
  type SearchChip
} from '../src/lib/finance/pivot-state';

// Doble de `categoryPath` de la fase 4 (separador «›», el del repo).
const catPathOf = (id: string) => (id === 'c1' ? 'Ocio › Bares' : 'Otra');

const row = (partial: Partial<Parameters<typeof rowMatchesChips>[0]> & { totalCents?: bigint; count?: number } = {}) => ({
  cat: 'Ocio', sub: 'Bares', catId: 'c1', prov: 'Bar Manolo', concept: 'CAÑAS', event: null,
  totalCents: -1000n, count: 2, ...partial
});

describe('normalizeText', () => {
  it('quita tildes, baja a minúsculas y recorta', () => {
    expect(normalizeText('  Camión ')).toBe('camion');
  });
});

describe('suggestChips', () => {
  it('requiere 2 caracteres y agrupa por tipo con detalle', () => {
    expect(suggestChips([row()], catPathOf, 'b')).toEqual([]);
    const groups = suggestChips([row()], catPathOf, 'manolo');
    expect(groups.map((g) => g.group)).toEqual(['Proveedores']);
    expect(groups[0].items[0].chip).toEqual({ type: 'prov', value: 'Bar Manolo' });
    expect(groups[0].items[0].detail).toContain('2 movs');
  });
  it('sugiere categorías por su ruta completa', () => {
    const groups = suggestChips([row()], catPathOf, 'bares');
    const cats = groups.find((g) => g.group === 'Categorías')!;
    expect(cats.items[0].chip).toEqual({ type: 'cat', value: 'c1' });
    expect(cats.items[0].label).toBe('Ocio › Bares');
  });
});

describe('rowMatchesChips (AND entre chips)', () => {
  it('prov exacto, cat por id, free por cualquier campo', () => {
    expect(rowMatchesChips(row(), [{ type: 'prov', value: 'bar manolo' }], catPathOf)).toBe(true);
    expect(rowMatchesChips(row(), [{ type: 'cat', value: 'c1' }], catPathOf)).toBe(true);
    expect(rowMatchesChips(row(), [{ type: 'free', value: 'cañas' }], catPathOf)).toBe(true);
    expect(rowMatchesChips(row(), [{ type: 'prov', value: 'otro' }], catPathOf)).toBe(false);
    expect(
      rowMatchesChips(row(), [{ type: 'prov', value: 'bar manolo' }, { type: 'free', value: 'zzz' }], catPathOf)
    ).toBe(false);
  });
  it('concept con proveedor exige ambos', () => {
    const chip: SearchChip = { type: 'concept', value: 'CAÑAS', prov: 'Bar Manolo' };
    expect(rowMatchesChips(row(), [chip], catPathOf)).toBe(true);
    expect(rowMatchesChips(row({ prov: 'Otro' }), [chip], catPathOf)).toBe(false);
  });
});

describe('serializeChips / parseChips (?q=)', () => {
  it('ida y vuelta con URL-encoding y separador de proveedor', () => {
    const chips: SearchChip[] = [
      { type: 'prov', value: 'Bar Manolo' },
      { type: 'concept', value: 'CAÑAS Y TAPAS', prov: 'Bar Manolo' },
      { type: 'free', value: 'a|b' }
    ];
    expect(parseChips(serializeChips(chips))).toEqual(chips);
  });
  it('ignora entradas malformadas o de tipo desconocido', () => {
    expect(parseChips('zzz:1|sintipo|prov:Bar%20Manolo')).toEqual([{ type: 'prov', value: 'Bar Manolo' }]);
    expect(parseChips(null)).toEqual([]);
  });
});
