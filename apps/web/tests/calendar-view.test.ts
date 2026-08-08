import { describe, expect, it } from 'vitest';

import { calendarDayLabel, groupCalendarDays } from '../src/lib/server/calendar.server';

const SOURCE_LABEL = 'Cole de los niños';

function row(overrides: Partial<Parameters<typeof groupCalendarDays>[0][number]> = {}) {
  return {
    id: crypto.randomUUID(),
    onDate: '2026-08-08',
    startsAt: new Date('2026-08-08T14:45:00Z'),
    endsAt: null,
    endDate: null,
    allDay: false,
    summary: 'Natación',
    location: null,
    sourceLabel: SOURCE_LABEL,
    ...overrides
  };
}

describe('agenda del calendario (agrupación pura)', () => {
  it('agrupa por día local, marca hoy y etiqueta con la hora de Madrid', () => {
    const days = groupCalendarDays(
      [
        row({ summary: 'Natación' }),
        row({ summary: 'Cena con abuelos', startsAt: new Date('2026-08-08T18:00:00Z') }),
        row({ onDate: '2026-08-10', startsAt: new Date('2026-08-10T07:30:00Z'), summary: 'Revisión caldera' })
      ],
      '2026-08-08'
    );
    expect(days.map((day) => day.dateISO)).toEqual(['2026-08-08', '2026-08-10']);
    expect(days[0]?.isToday).toBe(true);
    expect(days[1]?.isToday).toBe(false);
    expect(days[0]?.label).toBe('Sábado, 8 de agosto');
    expect(days[0]?.events.map((event) => event.title)).toEqual(['Natación', 'Cena con abuelos']);
    // Agosto: Madrid es UTC+2.
    expect(days[0]?.events[0]?.timeLabel).toBe('16:45');
    expect(days[0]?.events[0]?.sourceLabel).toBe(SOURCE_LABEL);
  });

  it('un evento de día completo se etiqueta sin hora', () => {
    const days = groupCalendarDays([row({ allDay: true, summary: 'Excursión' })], '2026-08-08');
    expect(days[0]?.events[0]?.timeLabel).toBe('Todo el día');
    expect(days[0]?.events[0]?.endLabel).toBeNull();
  });

  it('el fin solo se enseña cuando cae el mismo día local', () => {
    const sameDay = groupCalendarDays(
      [row({ endsAt: new Date('2026-08-08T15:45:00Z'), endDate: '2026-08-08' })],
      '2026-08-08'
    );
    expect(sameDay[0]?.events[0]?.endLabel).toBe('17:45');

    const multiDay = groupCalendarDays(
      [row({ endsAt: new Date('2026-08-09T10:00:00Z'), endDate: '2026-08-09' })],
      '2026-08-08'
    );
    expect(multiDay[0]?.events[0]?.endLabel).toBeNull();
  });

  it('calendarDayLabel capitaliza el día en español', () => {
    expect(calendarDayLabel('2026-08-10')).toBe('Lunes, 10 de agosto');
  });
});
