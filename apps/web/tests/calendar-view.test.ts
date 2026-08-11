import { describe, expect, it } from 'vitest';

import {
  buildCalendarDays,
  buildCalendarYear,
  calendarNotices,
  monthGridRange,
  nextOccurrenceAfter,
  resolveAnchor,
  resolveScope,
  type CalendarCompletionView,
  type CalendarEventView,
  type CalendarRoutineView
} from '../src/lib/calendar/view';
import {
  calendarDayLabel,
  mapCalendarEvents,
  mapCalendarRoutines,
  scheduleFromRoutineRow,
  type RoutineRow
} from '../src/lib/server/calendar.server';

const SOURCE_LABEL = 'Cole de los niños';
const TODAY = '2026-08-12';

function eventRow(overrides: Partial<Parameters<typeof mapCalendarEvents>[0][number]> = {}) {
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

function routineRow(overrides: Partial<RoutineRow> = {}): RoutineRow {
  return {
    id: 'r1',
    title: 'Limpieza de baños',
    details: '',
    audience: 'employee',
    pattern: 'every_n_days',
    anchorOn: '2026-01-01',
    repeatEvery: 1,
    weekdays: null,
    monthDay: null,
    months: null,
    endsOn: null,
    overduePolicy: 'skip',
    ...overrides
  };
}

function routine(overrides: Partial<CalendarRoutineView> = {}): CalendarRoutineView {
  return {
    ...mapCalendarRoutines([routineRow()])[0]!,
    ...overrides
  };
}

function days(input: {
  routines?: CalendarRoutineView[];
  completions?: CalendarCompletionView[];
  events?: CalendarEventView[];
  fromISO?: string;
  toISO?: string;
  knownFromISO?: string;
  knownToISO?: string;
}) {
  return buildCalendarDays({
    routines: input.routines ?? [],
    completions: input.completions ?? [],
    events: input.events ?? [],
    fromISO: input.fromISO ?? '2026-08-10',
    toISO: input.toISO ?? '2026-08-16',
    todayISO: TODAY,
    knownFromISO: input.knownFromISO ?? '2026-07-27',
    knownToISO: input.knownToISO ?? '2026-09-06'
  });
}

describe('eventos del calendario enlazado', () => {
  it('etiqueta la hora de Madrid y conserva el día civil para agrupar', () => {
    const [event] = mapCalendarEvents([eventRow()]);
    // Agosto: Madrid es UTC+2.
    expect(event?.timeLabel).toBe('16:45');
    expect(event?.dateISO).toBe('2026-08-08');
    expect(event?.sourceLabel).toBe(SOURCE_LABEL);
  });

  it('un evento de día completo se etiqueta sin hora', () => {
    const [event] = mapCalendarEvents([eventRow({ allDay: true, summary: 'Excursión' })]);
    expect(event?.timeLabel).toBe('Todo el día');
    expect(event?.endLabel).toBeNull();
  });

  it('el fin solo se enseña cuando cae el mismo día local', () => {
    const [same] = mapCalendarEvents([
      eventRow({ endsAt: new Date('2026-08-08T15:45:00Z'), endDate: '2026-08-08' })
    ]);
    expect(same?.endLabel).toBe('17:45');
    const [across] = mapCalendarEvents([
      eventRow({ endsAt: new Date('2026-08-09T10:00:00Z'), endDate: '2026-08-09' })
    ]);
    expect(across?.endLabel).toBeNull();
  });

  it('calendarDayLabel capitaliza el día en español', () => {
    expect(calendarDayLabel('2026-08-10')).toBe('Lunes, 10 de agosto');
  });
});

describe('reglas de rutina leídas de la base', () => {
  it('reconstruye los cuatro patrones y su frase de cadencia', () => {
    const [daily, weekly, monthly, seasonal] = mapCalendarRoutines([
      routineRow(),
      routineRow({ id: 'r2', pattern: 'days_of_week', repeatEvery: 1, weekdays: [1, 4] }),
      routineRow({ id: 'r3', pattern: 'day_of_month', repeatEvery: 1, monthDay: -1 }),
      routineRow({
        id: 'r4',
        pattern: 'months_of_year',
        repeatEvery: null,
        months: [6, 12],
        monthDay: 1
      })
    ]);
    expect(daily?.cadence).toBe('todos los días');
    expect(weekly?.cadence).toBe('los lunes y los jueves');
    expect(monthly?.cadence).toBe('el último día de cada mes');
    expect(seasonal?.cadence).toBe('en verano y en invierno');
  });

  it('una rutina sin cadencia confirmada se lee como «sin día todavía»', () => {
    const [view] = mapCalendarRoutines([
      routineRow({ pattern: null, anchorOn: null, repeatEvery: null })
    ]);
    expect(view?.rule).toBeNull();
    expect(view?.cadence).toBe('sin día todavía');
  });

  it('una fila incoherente se lee como sin cadencia en vez de reventar la página', () => {
    // El camino de escritura rechaza el comando; el de lectura no puede caerse.
    expect(scheduleFromRoutineRow(routineRow({ pattern: 'days_of_week', weekdays: null }))).toBeNull();
    expect(scheduleFromRoutineRow(routineRow({ pattern: 'lo_que_sea' }))).toBeNull();
  });

  it('normaliza los smallint[] a números aunque el driver los dé como cadenas', () => {
    const rule = scheduleFromRoutineRow(
      routineRow({ pattern: 'days_of_week', weekdays: ['3', '1'] as unknown as number[] })
    );
    expect(rule).toMatchObject({ pattern: 'days_of_week', weekdays: [3, 1] });
  });
});

describe('la ventana descargada', () => {
  it('es la rejilla de seis semanas del mes del ancla', () => {
    // Agosto de 2026 empieza en sábado: la rejilla arranca el lunes 27 de julio.
    expect(monthGridRange('2026-08-12')).toEqual({ fromISO: '2026-07-27', toISO: '2026-09-06' });
    // Cualquier día del mes da la MISMA ventana: cambiar de semana dentro del
    // mes nunca pide red.
    expect(monthGridRange('2026-08-31')).toEqual(monthGridRange('2026-08-01'));
  });

  it('un alcance o una fecha inventados en la URL caen en semana y en hoy', () => {
    expect(resolveScope('trimestre')).toBe('semana');
    expect(resolveScope('mes')).toBe('mes');
    expect(resolveAnchor('2026-02-30', TODAY)).toBe(TODAY);
    expect(resolveAnchor('2026-02-28', TODAY)).toBe('2026-02-28');
  });
});

describe('los días con sus rutinas y sus eventos', () => {
  it('devuelve todos los días del rango, también los vacíos', () => {
    expect(days({}).map((day) => day.dateISO)).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16'
    ]);
  });

  it('«los lunes y los jueves» cae en sus dos días, no en uno', () => {
    const view = days({
      routines: [
        routine({
          rule: { pattern: 'days_of_week', anchorOn: '2026-01-01', repeatEvery: 1, weekdays: [1, 4], endsOn: null }
        })
      ]
    });
    expect(view.filter((day) => day.routines.length > 0).map((day) => day.dateISO)).toEqual([
      '2026-08-10',
      '2026-08-13'
    ]);
  });

  it('una rutina sin cadencia confirmada NO aparece en el calendario', () => {
    const view = days({ routines: [routine({ rule: null })] });
    expect(view.every((day) => day.routines.length === 0)).toBe(true);
  });

  it('clasifica hoy, el futuro, lo hecho y lo pasado sin marcar', () => {
    const view = days({
      routines: [routine()],
      completions: [
        { routineId: 'r1', dueOn: '2026-08-10', completedOn: '2026-08-10', byName: 'Ana' },
        { routineId: 'r1', dueOn: '2026-08-11', completedOn: '2026-08-13', byName: 'Ana' }
      ]
    });
    const state = (dateISO: string) =>
      view.find((day) => day.dateISO === dateISO)?.routines[0]?.state;
    expect(state('2026-08-10')).toBe('done');
    expect(state('2026-08-11')).toBe('done');
    expect(state('2026-08-12')).toBe('due');
    expect(state('2026-08-13')).toBe('upcoming');

    const late = view.find((day) => day.dateISO === '2026-08-11')?.routines[0];
    expect(late?.doneBy).toBe('Ana');
    expect(late?.doneLateDays).toBe(2);
  });

  it('lo pasado sin marcar es «missed» dentro de lo descargado y «unknown» fuera', () => {
    const inside = days({ routines: [routine()], fromISO: '2026-08-01', toISO: '2026-08-01' });
    expect(inside[0]?.routines[0]?.state).toBe('missed');

    // Misma ocurrencia, pero la ventana descargada no la cubre: no se sabe si
    // se hizo, y decir «sin marcar» sería inventar un incumplimiento.
    const outside = days({
      routines: [routine()],
      fromISO: '2026-06-01',
      toISO: '2026-06-01',
      knownFromISO: '2026-07-27',
      knownToISO: '2026-09-06'
    });
    expect(outside[0]?.known).toBe(false);
    expect(outside[0]?.routines[0]?.state).toBe('unknown');
    expect(outside[0]?.routines[0]?.canComplete).toBe(false);
  });

  it('marcar hecha solo se ofrece hoy y en lo atrasado que de verdad se arrastra', () => {
    const skip = days({ routines: [routine()], fromISO: '2026-08-01', toISO: '2026-08-16' });
    const can = (dateISO: string) =>
      skip.find((day) => day.dateISO === dateISO)?.routines[0]?.canComplete;
    expect(can('2026-08-12')).toBe(true); // hoy
    expect(can('2026-08-13')).toBe(false); // el futuro no se marca
    expect(can('2026-08-01')).toBe(false); // `skip`: caducó al acabar su día

    const carry = days({
      routines: [
        routine({
          overduePolicy: 'carry',
          rule: { pattern: 'day_of_month', anchorOn: '2026-01-01', repeatEvery: 1, monthDay: 1, endsOn: null }
        })
      ],
      fromISO: '2026-08-01',
      toISO: '2026-08-16'
    });
    expect(carry.find((day) => day.dateISO === '2026-08-01')?.routines[0]?.canComplete).toBe(true);
  });

  it('coloca cada evento en su día', () => {
    const [event] = mapCalendarEvents([eventRow({ onDate: '2026-08-13' })]);
    const view = days({ events: [event!] });
    expect(view.find((day) => day.dateISO === '2026-08-13')?.events).toHaveLength(1);
  });
});

describe('el año: densidad y lo señalado', () => {
  const seasonal = routine({
    id: 'estacional',
    title: 'Cambio de armarios',
    rule: {
      pattern: 'months_of_year',
      anchorOn: '2026-01-01',
      months: [6, 12],
      monthDay: 1,
      endsOn: null
    }
  });
  const daily = routine({ id: 'diaria', title: 'Hacer las camas' });

  it('marca los días con algo y destaca solo lo poco frecuente', () => {
    const months = buildCalendarYear(2026, [seasonal, daily], ['2026-04-09']);
    const june = months[5]!;
    expect(june.routineDays[0]).toBe(true);
    // La diaria marca todos los días pero NO entra en «lo señalado»: a escala de
    // año repetirla 365 veces no contesta «¿cuándo toca lo estacional?».
    expect(june.highlights.map((item) => item.title)).toEqual(['Cambio de armarios']);
    expect(months[11]!.highlights.map((item) => item.title)).toEqual(['Cambio de armarios']);
    expect(months[0]!.highlights).toEqual([]);
    expect(months[3]!.eventDays[8]).toBe(true);
  });

  it('cuenta los días ocupados de cada mes, nunca cuántas se hicieron', () => {
    const months = buildCalendarYear(2026, [seasonal], []);
    expect(months[5]!.busyDays).toBe(1);
    expect(months[0]!.busyDays).toBe(0);
  });

  it('un año bisiesto tiene 29 celdas en febrero', () => {
    expect(buildCalendarYear(2028, [], [])[1]!.routineDays).toHaveLength(29);
    expect(buildCalendarYear(2026, [], [])[1]!.routineDays).toHaveLength(28);
  });
});

describe('las bandas honestas', () => {
  const label = '11 ago, 08:30';

  it('con red y dentro de lo descargado no hay nada que confesar', () => {
    expect(calendarNotices({ online: true, outsideWindow: false, loadedAtLabel: label })).toEqual([]);
  });

  it('sin red dice que las rutinas se calculan igual y de cuándo son los eventos', () => {
    const [notice] = calendarNotices({ online: false, outsideWindow: false, loadedAtLabel: label });
    expect(notice).toBe(
      `Sin conexión. Las rutinas se calculan igual; los eventos son los de la última descarga (${label}).`
    );
  });

  it('fuera de lo descargado avisa de que no sabe quién marcó qué', () => {
    // Es la banda que impide el peor malentendido: un día pasado sin datos NO
    // es un día en que no se hizo nada.
    const notices = calendarNotices({ online: true, outsideWindow: true, loadedAtLabel: label });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('quién marcó cada cosa necesitan conexión');
  });

  it('sin red y fuera de lo descargado son dos hechos distintos, y se dicen los dos', () => {
    expect(calendarNotices({ online: false, outsideWindow: true, loadedAtLabel: label })).toHaveLength(2);
  });
});

describe('la próxima ocurrencia para el chip optimista', () => {
  it('es la siguiente de la regla, no «hoy más el intervalo»', () => {
    const rule = {
      pattern: 'days_of_week',
      anchorOn: '2026-01-01',
      repeatEvery: 1,
      weekdays: [1, 4],
      endsOn: null
    } as const;
    // Marcar el lunes deja el JUEVES pendiente, en la misma semana.
    expect(nextOccurrenceAfter(rule, '2026-08-10')).toBe('2026-08-13');
  });

  it('sin cadencia confirmada no promete ninguna fecha', () => {
    expect(nextOccurrenceAfter(null, '2026-08-10')).toBeNull();
  });
});
