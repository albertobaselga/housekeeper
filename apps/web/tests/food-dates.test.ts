import { describe, expect, it } from 'vitest';

import {
  activeMenuDayIndex,
  addDays,
  addMonthsClamped,
  mondayOf,
  nextRoutineDue,
  weekDays
} from '../src/lib/food/dates';

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

describe('nextRoutineDue: réplica exacta de la recurrencia del servidor', () => {
  it('daily y weekly suman días multiplicando el intervalo', () => {
    expect(nextRoutineDue('2026-08-07', 'daily', 1)).toBe('2026-08-08');
    expect(nextRoutineDue('2026-08-07', 'daily', 3)).toBe('2026-08-10');
    expect(nextRoutineDue('2026-08-07', 'weekly', 1)).toBe('2026-08-14');
    expect(nextRoutineDue('2026-08-07', 'weekly', 2)).toBe('2026-08-21');
  });

  it('monthly y quarterly recortan al último día del mes destino (como Postgres)', () => {
    expect(nextRoutineDue('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(nextRoutineDue('2026-08-31', 'monthly', 1)).toBe('2026-09-30');
    expect(nextRoutineDue('2026-11-30', 'quarterly', 1)).toBe('2027-02-28');
    expect(nextRoutineDue('2026-08-07', 'quarterly', 2)).toBe('2027-02-07');
  });

  it('addMonthsClamped cruza años y conserva el día cuando cabe', () => {
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
  });
});
