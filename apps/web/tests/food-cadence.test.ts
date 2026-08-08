import { describe, expect, it } from 'vitest';

import { routineCadenceLabel, routineUnitLabel } from '../src/lib/food/cadence';

// P2-2 / P3-1: concordancia natural, nada de «cada 1 semana(s)».
describe('routineCadenceLabel', () => {
  it('con intervalo 1 omite la cifra y usa el singular', () => {
    expect(routineCadenceLabel('daily', 1)).toBe('cada día');
    expect(routineCadenceLabel('weekly', 1)).toBe('cada semana');
    expect(routineCadenceLabel('monthly', 1)).toBe('cada mes');
    expect(routineCadenceLabel('quarterly', 1)).toBe('cada trimestre');
  });

  it('con intervalo > 1 usa la cifra y el plural correcto', () => {
    expect(routineCadenceLabel('daily', 3)).toBe('cada 3 días');
    expect(routineCadenceLabel('weekly', 2)).toBe('cada 2 semanas');
    expect(routineCadenceLabel('monthly', 6)).toBe('cada 6 meses');
    expect(routineCadenceLabel('quarterly', 2)).toBe('cada 2 trimestres');
  });
});

describe('routineUnitLabel', () => {
  it('concuerda la unidad del desplegable con la cifra elegida', () => {
    expect(routineUnitLabel('weekly', 1)).toBe('semana');
    expect(routineUnitLabel('weekly', 2)).toBe('semanas');
    expect(routineUnitLabel('monthly', 1)).toBe('mes');
    expect(routineUnitLabel('monthly', 12)).toBe('meses');
    expect(routineUnitLabel('daily', 1)).toBe('día');
    expect(routineUnitLabel('quarterly', 4)).toBe('trimestres');
  });
});
