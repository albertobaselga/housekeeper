import { describe, expect, it } from 'vitest';

import {
  addQuantities,
  formatQuantityEs,
  fromHundredths,
  scaleQuantity,
  toHundredths
} from '../src/lib/food/quantities';

describe('aritmética decimal de cantidades (sin floats)', () => {
  it('toHundredths acepta punto o coma con hasta dos decimales', () => {
    expect(toHundredths('1')).toBe(100n);
    expect(toHundredths('1,5')).toBe(150n);
    expect(toHundredths('1.50')).toBe(150n);
    expect(toHundredths('0.05')).toBe(5n);
    expect(toHundredths('12345678.99')).toBe(1234567899n);
  });

  it('toHundredths rechaza cero, negativos, tres decimales y basura', () => {
    expect(toHundredths('0')).toBeNull();
    expect(toHundredths('0,00')).toBeNull();
    expect(toHundredths('-1')).toBeNull();
    expect(toHundredths('1.234')).toBeNull();
    expect(toHundredths('abc')).toBeNull();
    expect(toHundredths('')).toBeNull();
  });

  it('fromHundredths produce decimal canónico sin ceros de cola', () => {
    expect(fromHundredths(225n)).toBe('2.25');
    expect(fromHundredths(230n)).toBe('2.3');
    expect(fromHundredths(200n)).toBe('2');
    expect(fromHundredths(5n)).toBe('0.05');
  });

  it('escala 4→6 raciones de forma exacta (AC-22)', () => {
    expect(scaleQuantity('1.50', 6, 4)).toBe('2.25');
    expect(scaleQuantity('0.30', 6, 4)).toBe('0.45');
    expect(scaleQuantity('800', 6, 4)).toBe('1200');
    // Y de vuelta: 6→4 deshace el escalado sin arrastre.
    expect(scaleQuantity('2.25', 4, 6)).toBe('1.5');
  });

  it('escala con divisiones no exactas redondeando half-up a la centésima', () => {
    expect(scaleQuantity('1', 1, 3)).toBe('0.33');
    expect(scaleQuantity('0.10', 2, 3)).toBe('0.07');
    expect(scaleQuantity('1', 2, 3)).toBe('0.67');
  });

  it('rechaza raciones inválidas', () => {
    expect(scaleQuantity('1', 0, 4)).toBeNull();
    expect(scaleQuantity('1', 4, 0)).toBeNull();
    expect(scaleQuantity('1', 1.5, 4)).toBeNull();
    expect(scaleQuantity('x', 4, 4)).toBeNull();
  });

  it('agrega cantidades de dos recetas de forma exacta', () => {
    // 0.25 l + 1 l de leche: el clásico que en float sería 1.2500000000000002.
    expect(addQuantities('0.25', '1')).toBe('1.25');
    expect(addQuantities('0.1', '0.2')).toBe('0.3');
    expect(addQuantities('1,5', '0.75')).toBe('2.25');
    expect(addQuantities('1', 'x')).toBeNull();
  });

  it('formatea en español con coma decimal', () => {
    expect(formatQuantityEs('2.25')).toBe('2,25');
    expect(formatQuantityEs('3')).toBe('3');
  });
});
