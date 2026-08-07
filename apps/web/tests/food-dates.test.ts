import { describe, expect, it } from 'vitest';

import { activeMenuDayIndex, addDays, mondayOf, weekDays } from '../src/lib/food/dates';

// Semana de referencia: lunes 2026-08-03 → domingo 2026-08-09 (hoy = viernes 7).
const WEEK = weekDays('2026-08-03');
const TODAY = '2026-08-07';

describe('día activo por defecto del menú', () => {
  it('abre en HOY cuando la semana visible lo contiene (no en lunes)', () => {
    expect(activeMenuDayIndex(WEEK, null, TODAY)).toBe(4);
    expect(WEEK[activeMenuDayIndex(WEEK, null, TODAY)]).toBe(TODAY);
  });

  it('respeta el día pedido explícitamente si pertenece a la semana', () => {
    expect(activeMenuDayIndex(WEEK, '2026-08-05', TODAY)).toBe(2);
    // La navegación de semanas arrastra el mismo día de la semana (+7).
    const nextWeek = weekDays('2026-08-10');
    expect(nextWeek[activeMenuDayIndex(nextWeek, addDays(TODAY, 7), TODAY)]).toBe('2026-08-14');
  });

  it('ignora un día pedido fuera de la semana y cae a hoy', () => {
    expect(activeMenuDayIndex(WEEK, '2026-09-01', TODAY)).toBe(4);
  });

  it('cae al lunes cuando ni el día pedido ni hoy están en la semana', () => {
    const otherWeek = weekDays('2026-08-10');
    expect(activeMenuDayIndex(otherWeek, null, TODAY)).toBe(0);
    expect(activeMenuDayIndex(otherWeek, 'no-es-fecha', TODAY)).toBe(0);
  });

  it('mondayOf sigue anclando la semana aunque el día activo sea otro', () => {
    expect(mondayOf(TODAY)).toBe('2026-08-03');
    expect(mondayOf('2026-08-03')).toBe('2026-08-03');
  });
});
