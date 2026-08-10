import { describe, expect, it } from 'vitest';

import { cadencePhrase, type RoutineSchedule } from '@casa-clara/domain';
import {
  CADENCE_CHOICES,
  cadenceChoiceOf,
  cadenceFormIsComplete,
  cadenceSummary,
  emptyCadenceForm,
  formFromSchedule,
  groupByCadence,
  intervalUnitLabel,
  intervalUnitMax,
  scheduleFromForm,
  type CadenceForm
} from '../src/lib/food/cadence';

const TODAY = '2026-08-13';

function form(overrides: Partial<CadenceForm>): CadenceForm {
  return { ...emptyCadenceForm(TODAY), ...overrides };
}

// Los cinco literales de §4.5 no son decorativos: son el contrato de la
// pantalla con la especificación, y la lista los reutiliza como encabezados.
describe('CADENCE_CHOICES', () => {
  it('lleva las cinco opciones con los literales exactos de la especificación', () => {
    expect(CADENCE_CHOICES.map((choice) => choice.label)).toEqual([
      'Todos los días',
      'Días fijos de la semana',
      'Cada cierto tiempo',
      'Por temporada',
      'Todavía no lo sabemos'
    ]);
  });

  it('las ayudas de los subcontroles son las de la especificación', () => {
    const help = Object.fromEntries(CADENCE_CHOICES.map((choice) => [choice.value, choice.help]));
    expect(help.weekdays).toBe('Marca los días que toca.');
    expect(help.season).toBe('Te avisará el primer día de cada temporada que marques.');
    expect(help.unset).toBe(
      'Quedará apuntada en esta página. No aparecerá en Hoy hasta que le pongáis día.'
    );
    expect(help.daily).toBeNull();
    expect(help.interval).toBeNull();
  });
});

describe('intervalUnitLabel', () => {
  it('concuerda la unidad con la cifra: nada de «cada 1 semana(s)»', () => {
    expect(intervalUnitLabel('days', 1)).toBe('día');
    expect(intervalUnitLabel('days', 3)).toBe('días');
    expect(intervalUnitLabel('weeks', 1)).toBe('semana');
    expect(intervalUnitLabel('weeks', 2)).toBe('semanas');
    expect(intervalUnitLabel('months', 1)).toBe('mes');
    expect(intervalUnitLabel('months', 3)).toBe('meses');
  });

  it('«trimestre» ya no existe en el vocabulario del selector', () => {
    const vocabulary = (['days', 'weeks', 'months'] as const).flatMap((unit) => [
      intervalUnitLabel(unit, 1),
      intervalUnitLabel(unit, 2)
    ]);
    expect(vocabulary).not.toContain('trimestre');
    expect(vocabulary).not.toContain('trimestres');
  });

  it('los topes por unidad son los de la CHECK de la 0023', () => {
    expect(intervalUnitMax('days')).toBe(366);
    // 52 semanas son 364 días: cabe en `every_n_days`, que admite hasta 366.
    expect(intervalUnitMax('weeks') * 7).toBeLessThanOrEqual(366);
    // `day_of_month` admite hasta 36 meses (una `quarterly` heredada con 12).
    expect(intervalUnitMax('months')).toBe(36);
  });
});

describe('scheduleFromForm', () => {
  it('«Todos los días» escribe every_n_days con repetición 1', () => {
    expect(scheduleFromForm(form({ choice: 'daily' }))).toEqual({
      pattern: 'every_n_days',
      anchorOn: TODAY,
      repeatEvery: 1,
      endsOn: null
    });
  });

  it('«Días fijos de la semana» ordena los días y escribe days_of_week', () => {
    expect(scheduleFromForm(form({ choice: 'weekdays', weekdays: [4, 1] }))).toEqual({
      pattern: 'days_of_week',
      anchorOn: TODAY,
      repeatEvery: 1,
      weekdays: [1, 4],
      endsOn: null
    });
  });

  it('«Cada cierto tiempo» en semanas se guarda en días', () => {
    const schedule = scheduleFromForm(
      form({ choice: 'interval', intervalUnit: 'weeks', intervalCount: 2, anchorOn: '2026-08-17' })
    );
    expect(schedule).toEqual({
      pattern: 'every_n_days',
      anchorOn: '2026-08-17',
      repeatEvery: 14,
      endsOn: null
    });
  });

  it('«Cada cierto tiempo» en meses ancla el día del mes en la fecha visible', () => {
    expect(
      scheduleFromForm(
        form({ choice: 'interval', intervalUnit: 'months', intervalCount: 3, anchorOn: '2026-09-01' })
      )
    ).toEqual({
      pattern: 'day_of_month',
      anchorOn: '2026-09-01',
      repeatEvery: 3,
      monthDay: 1,
      endsOn: null
    });
  });

  it('«Por temporada» escribe months_of_year el día 1, con los meses meteorológicos', () => {
    expect(scheduleFromForm(form({ choice: 'season', months: [12, 6] }))).toEqual({
      pattern: 'months_of_year',
      anchorOn: TODAY,
      months: [6, 12],
      monthDay: 1,
      endsOn: null
    });
  });

  it('«Todavía no lo sabemos» es null, no un hueco', () => {
    expect(scheduleFromForm(form({ choice: 'unset' }))).toBeNull();
  });
});

describe('formFromSchedule', () => {
  it('reconoce cada patrón y vuelve a producir la misma regla', () => {
    const rules: RoutineSchedule[] = [
      { pattern: 'every_n_days', anchorOn: '2026-01-01', repeatEvery: 1, endsOn: null },
      { pattern: 'days_of_week', anchorOn: '2026-01-01', repeatEvery: 1, weekdays: [1, 4], endsOn: null },
      { pattern: 'months_of_year', anchorOn: '2026-01-01', months: [6, 12], monthDay: 1, endsOn: null }
    ];
    for (const rule of rules) {
      expect(scheduleFromForm(formFromSchedule(rule, { todayISO: TODAY }))).toEqual(rule);
    }
  });

  it('una rutina anclada el 31 no se degrada a 28 al pasar por el formulario', () => {
    // La deriva permanente 31/01 → 28/02 → 28/03 es justo lo que esta ola
    // arregla: editar el título no puede reintroducirla por la puerta de atrás.
    const rule: RoutineSchedule = {
      pattern: 'day_of_month',
      anchorOn: '2026-01-31',
      repeatEvery: 1,
      monthDay: 31,
      endsOn: null
    };
    const edited = formFromSchedule(rule, { todayISO: TODAY, nextOccurrenceOn: '2026-02-28' });
    expect(scheduleFromForm(edited)).toEqual({
      pattern: 'day_of_month',
      anchorOn: '2026-02-28',
      repeatEvery: 1,
      monthDay: 31,
      endsOn: null
    });
  });

  it('la compra quincenal no se vuelve semanal por abrirla en el formulario', () => {
    // `days_of_week` con repetición 2 (§6.2) no tiene control en fase 1; el
    // formulario lo conserva en vez de destruirlo en silencio.
    const rule: RoutineSchedule = {
      pattern: 'days_of_week',
      anchorOn: '2026-08-10',
      repeatEvery: 2,
      weekdays: [1],
      endsOn: null
    };
    expect(scheduleFromForm(formFromSchedule(rule, { todayISO: TODAY }))).toEqual(rule);
  });

  it('conserva `ends_on`, que no tiene control en la interfaz', () => {
    const rule: RoutineSchedule = {
      pattern: 'every_n_days',
      anchorOn: '2026-01-01',
      repeatEvery: 1,
      endsOn: '2026-12-31'
    };
    expect(scheduleFromForm(formFromSchedule(rule, { todayISO: TODAY }))).toEqual(rule);
  });

  it('«cada cierto tiempo» enseña la próxima ocurrencia, no un ancla de hace años', () => {
    const rule: RoutineSchedule = {
      pattern: 'every_n_days',
      anchorOn: '2019-03-04',
      repeatEvery: 14,
      endsOn: null
    };
    const edited = formFromSchedule(rule, { todayISO: TODAY, nextOccurrenceOn: '2026-08-17' });
    expect(edited.choice).toBe('interval');
    expect(edited.intervalUnit).toBe('weeks');
    expect(edited.intervalCount).toBe(2);
    expect(edited.anchorOn).toBe('2026-08-17');
  });
});

describe('cadenceChoiceOf y groupByCadence', () => {
  it('clasifica en las cinco clases de ritmo del formulario', () => {
    expect(cadenceChoiceOf({ pattern: 'every_n_days', anchorOn: TODAY, repeatEvery: 1 })).toBe('daily');
    expect(cadenceChoiceOf({ pattern: 'every_n_days', anchorOn: TODAY, repeatEvery: 3 })).toBe('interval');
    expect(cadenceChoiceOf({ pattern: 'days_of_week', anchorOn: TODAY, repeatEvery: 1, weekdays: [1] })).toBe('weekdays');
    expect(cadenceChoiceOf({ pattern: 'day_of_month', anchorOn: TODAY, repeatEvery: 1, monthDay: 1 })).toBe('interval');
    expect(cadenceChoiceOf({ pattern: 'months_of_year', anchorOn: TODAY, months: [6], monthDay: 1 })).toBe('season');
    expect(cadenceChoiceOf(null)).toBe('unset');
  });

  it('agrupa en el orden de las opciones y sin grupos vacíos', () => {
    const groups = groupByCadence([
      { schedule: null },
      { schedule: { pattern: 'days_of_week', anchorOn: TODAY, repeatEvery: 1, weekdays: [1, 4] } },
      { schedule: { pattern: 'every_n_days', anchorOn: TODAY, repeatEvery: 1 } },
      { schedule: null }
    ]);
    expect(groups.map((group) => group.title)).toEqual([
      'Todos los días',
      'Días fijos de la semana',
      'Todavía no lo sabemos'
    ]);
    expect(groups.map((group) => group.items.length)).toEqual([1, 1, 2]);
  });
});

describe('cadenceSummary', () => {
  it('la lista se lee igual que la frase del formulario', () => {
    const rule: RoutineSchedule = {
      pattern: 'days_of_week',
      anchorOn: '2026-08-10',
      repeatEvery: 1,
      weekdays: [1, 4]
    };
    expect(cadenceSummary(rule, '2026-08-13')).toBe(
      'los lunes y los jueves · la próxima, el jueves 13 de agosto'
    );
    expect(cadencePhrase(rule)).toBe('Toca los lunes y los jueves.');
  });

  it('«todos los días» no promete próxima fecha: es hoy, siempre', () => {
    expect(cadenceSummary({ pattern: 'every_n_days', anchorOn: TODAY, repeatEvery: 1 }, TODAY)).toBe(
      'todos los días'
    );
  });

  it('las temporadas dan la fecha sin día de la semana', () => {
    expect(
      cadenceSummary({ pattern: 'months_of_year', anchorOn: TODAY, months: [6, 12], monthDay: 1 }, '2026-12-01')
    ).toBe('en verano y en invierno · la próxima, el 1 de diciembre');
  });

  it('una rutina sin cadencia lo dice y no inventa fecha', () => {
    expect(cadenceSummary(null, null)).toBe('sin día todavía');
  });
});

describe('cadenceFormIsComplete', () => {
  it('exige al menos un día marcado y al menos una temporada marcada', () => {
    expect(cadenceFormIsComplete(form({ choice: 'weekdays', weekdays: [] }))).toBe(false);
    expect(cadenceFormIsComplete(form({ choice: 'weekdays', weekdays: [1] }))).toBe(true);
    expect(cadenceFormIsComplete(form({ choice: 'season', months: [] }))).toBe(false);
    expect(cadenceFormIsComplete(form({ choice: 'season', months: [6] }))).toBe(true);
  });

  it('«Todos los días» y «Todavía no lo sabemos» no piden nada más', () => {
    expect(cadenceFormIsComplete(form({ choice: 'daily' }))).toBe(true);
    expect(cadenceFormIsComplete(form({ choice: 'unset' }))).toBe(true);
  });
});
