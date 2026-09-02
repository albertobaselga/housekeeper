import { describe, expect, it } from 'vitest';

import { DEFAULT_DIMS, PIVOT_DIMENSIONS, parseDims, serializeDims } from '../src/lib/finance/pivot-state';

describe('pivot-state (stub, contrato de la clave dims)', () => {
  it('parsea el CSV descartando dimensiones desconocidas y duplicadas', () => {
    expect(parseDims('prov,cat,bogus,cat')).toEqual(['prov', 'cat']);
  });
  it('vacío o null caen al orden por defecto', () => {
    expect(parseDims(null)).toEqual([...DEFAULT_DIMS]);
    expect(parseDims('')).toEqual([...DEFAULT_DIMS]);
  });
  it('serializa a CSV y devuelve null para el orden por defecto (URL limpia)', () => {
    expect(serializeDims(['prov', 'cat'])).toBe('prov,cat');
    expect(serializeDims([...DEFAULT_DIMS])).toBeNull();
    expect(parseDims(serializeDims(['nat', 'concept']))).toEqual(['nat', 'concept']);
  });
  it('PIVOT_DIMENSIONS declara las seis dimensiones en el orden canónico', () => {
    expect(PIVOT_DIMENSIONS).toEqual(['cat', 'sub', 'nat', 'prov', 'concept', 'movement']);
  });
  it('un orden distinto del por defecto pero con las mismas dimensiones no colapsa a null', () => {
    expect(serializeDims(['sub', 'cat'])).toBe('sub,cat');
    expect(parseDims('sub,cat')).toEqual(['sub', 'cat']);
    expect(parseDims('sub,cat')).not.toEqual([...DEFAULT_DIMS]);
  });
});
