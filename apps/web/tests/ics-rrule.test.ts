import { describe, expect, it } from 'vitest';

import {
  nextOccurrenceOnOrAfter,
  occurrencesBetween,
  type RoutineRule
} from '@casa-clara/domain';

import { routineRrule } from '../src/lib/server/ics-rrule.server';
import { expandRrule } from './rrule-expand';

/**
 * La prueba de T8: que la `RRULE` emitida DIGA LO MISMO que el motor puro.
 *
 * La forma importa. Comparar la cadena emitida con otra cadena escrita a mano
 * aquí no probaría nada: solo que la misma persona escribió las dos igual. Lo
 * que se hace es expandir la regla emitida con un expansor independiente
 * (`rrule-expand.ts`, escrito desde la RFC 5545 y no desde el emisor) y
 * comprobar fecha a fecha contra `occurrencesBetween`.
 *
 * Y al revés para el caso que NO se puede expresar: para `month_day = 31` no
 * basta con afirmar que no hay RRULE, hay que enseñar POR QUÉ —qué haría la
 * RRULE que se habría emitido y en qué se aparta del motor—.
 */

/** Cuántas ocurrencias se comparan por cadencia. */
const N = 60;
/**
 * Horizonte de comparación deliberadamente absurdo: quien tiene que cortar la
 * lista es el tope de N ocurrencias, no la ventana. Si cortara la ventana, una
 * cadencia anual compararía cuatro fechas creyendo comparar sesenta.
 */
const HORIZON = '2400-12-31';

interface Caso {
  readonly nombre: string;
  readonly rule: RoutineRule;
  readonly rrule: string;
}

/**
 * Cadencias que sí se expresan. Los anclas están elegidos a mala idea: en
 * domingo (para que el lunes de la semana del ancla no resucite), a mitad de
 * semana, a mitad de mes y sobre un año bisiesto.
 */
const EXPRESABLES: readonly Caso[] = [
  {
    nombre: 'todos los días',
    rule: { pattern: 'every_n_days', anchorOn: '2026-08-11', repeatEvery: 1 },
    rrule: 'FREQ=DAILY'
  },
  {
    nombre: 'cada 3 días',
    rule: { pattern: 'every_n_days', anchorOn: '2026-08-11', repeatEvery: 3 },
    rrule: 'FREQ=DAILY;INTERVAL=3'
  },
  {
    nombre: 'cada 15 días sobre el cambio de hora de octubre',
    rule: { pattern: 'every_n_days', anchorOn: '2026-10-18', repeatEvery: 15 },
    rrule: 'FREQ=DAILY;INTERVAL=15'
  },
  {
    nombre: 'los lunes y los jueves',
    rule: { pattern: 'days_of_week', anchorOn: '2026-08-11', repeatEvery: 1, weekdays: [1, 4] },
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TH;WKST=MO'
  },
  {
    nombre: 'cada 2 semanas los martes, con ancla en domingo',
    rule: { pattern: 'days_of_week', anchorOn: '2026-08-16', repeatEvery: 2, weekdays: [2] },
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;WKST=MO'
  },
  {
    nombre: 'cada 3 semanas de viernes a domingo, con ancla a mitad de semana',
    rule: { pattern: 'days_of_week', anchorOn: '2026-08-12', repeatEvery: 3, weekdays: [5, 6, 7] },
    rrule: 'FREQ=WEEKLY;INTERVAL=3;BYDAY=FR,SA,SU;WKST=MO'
  },
  {
    nombre: 'el día 1 de cada mes',
    rule: { pattern: 'day_of_month', anchorOn: '2026-08-11', repeatEvery: 1, monthDay: 1 },
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=1'
  },
  {
    nombre: 'el día 28 cada 3 meses',
    rule: { pattern: 'day_of_month', anchorOn: '2026-08-11', repeatEvery: 3, monthDay: 28 },
    rrule: 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=28'
  },
  {
    nombre: 'el último día de cada mes',
    rule: { pattern: 'day_of_month', anchorOn: '2026-08-11', repeatEvery: 1, monthDay: -1 },
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1'
  },
  {
    nombre: 'el último día cada 36 meses (quarterly × 12)',
    rule: { pattern: 'day_of_month', anchorOn: '2026-02-10', repeatEvery: 36, monthDay: -1 },
    rrule: 'FREQ=MONTHLY;INTERVAL=36;BYMONTHDAY=-1'
  },
  {
    nombre: 'en junio y en diciembre (las temporadas)',
    rule: { pattern: 'months_of_year', anchorOn: '2026-08-11', months: [6, 12], monthDay: 1 },
    rrule: 'FREQ=YEARLY;BYMONTH=6,12;BYMONTHDAY=1'
  },
  {
    nombre: 'el último día de febrero, incluidos los bisiestos',
    rule: { pattern: 'months_of_year', anchorOn: '2026-08-11', months: [2], monthDay: -1 },
    rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1'
  },
  {
    nombre: 'las cuatro temporadas con fin de serie',
    rule: {
      pattern: 'months_of_year',
      anchorOn: '2026-08-11',
      months: [3, 6, 9, 12],
      monthDay: 1,
      endsOn: '2029-06-01'
    },
    rrule: 'FREQ=YEARLY;BYMONTH=3,6,9,12;BYMONTHDAY=1;UNTIL=20290601'
  },
  {
    nombre: 'cada semana con fin de serie',
    rule: {
      pattern: 'days_of_week',
      anchorOn: '2026-08-11',
      repeatEvery: 1,
      weekdays: [3],
      endsOn: '2026-12-30'
    },
    rrule: 'FREQ=WEEKLY;BYDAY=WE;WKST=MO;UNTIL=20261230'
  }
];

/** La primera ocurrencia de la regla: es la que el feed pone como `DTSTART`. */
function dtStartDe(rule: RoutineRule): string {
  const first = nextOccurrenceOnOrAfter(rule, rule.anchorOn);
  expect(first).not.toBeNull();
  return first as string;
}

describe('la RRULE del feed ICS dice lo mismo que el motor puro', () => {
  for (const caso of EXPRESABLES) {
    it(`${caso.nombre}: las fechas de la RRULE son las del generador`, () => {
      const emitida = routineRrule(caso.rule);
      expect(emitida).toBe(caso.rrule);

      const dtStart = dtStartDe(caso.rule);
      const delMotor = occurrencesBetween(caso.rule, dtStart, HORIZON, { limit: N });
      const deLaRrule = expandRrule(emitida as string, dtStart, N);

      // Ni una fecha de más, ni una de menos, ni una desplazada.
      expect(deLaRrule).toEqual(delMotor);
      expect(delMotor.length).toBeGreaterThan(0);

      // `ends_on` es inclusivo y `UNTIL` también: el último día de la serie es
      // exactamente el que la rutina declara como final, no el anterior.
      if (caso.rule.endsOn != null) expect(delMotor.at(-1)).toBe(caso.rule.endsOn);
    });
  }

  /**
   * Barrido: la afirmación de T8 no es «estos catorce casos salen bien», sino
   * «toda RRULE que este emisor decida emitir reproduce el motor». Se recorren
   * los cuatro patrones con anclas incómodas (fin de mes, 29 de febrero,
   * domingo) y todos los días del mes, y de cada regla se exige una de dos
   * cosas: o no hay RRULE, o la RRULE da exactamente las mismas fechas.
   *
   * Es la prueba que se pone roja si alguien afloja el corte del día 29 «porque
   * casi siempre coincide»: no fallaría una aserción de `toBeNull`, fallaría la
   * comparación de fechas reales.
   */
  it('barrido: cuando hay RRULE, sus fechas son las del motor; si no, no hay RRULE', () => {
    const anclas = ['2024-02-29', '2026-01-31', '2026-02-15', '2026-08-11', '2026-08-16', '2026-12-31'];
    const diasDelMes = [-1, 1, 15, 28, 29, 30, 31];
    const reglas: RoutineRule[] = [];
    for (const anchorOn of anclas) {
      for (const repeatEvery of [1, 2, 3, 7, 15, 366]) {
        reglas.push({ pattern: 'every_n_days', anchorOn, repeatEvery });
      }
      for (const repeatEvery of [1, 2, 3, 12]) {
        for (const weekdays of [[1], [1, 4], [5, 6, 7], [1, 2, 3, 4, 5, 6, 7]]) {
          reglas.push({ pattern: 'days_of_week', anchorOn, repeatEvery, weekdays });
        }
      }
      for (const repeatEvery of [1, 2, 3, 36]) {
        for (const monthDay of diasDelMes) {
          reglas.push({ pattern: 'day_of_month', anchorOn, repeatEvery, monthDay });
        }
      }
      for (const months of [[1], [2], [6, 12], [3, 6, 9, 12]]) {
        for (const monthDay of diasDelMes) {
          reglas.push({ pattern: 'months_of_year', anchorOn, months, monthDay });
        }
      }
    }

    let conRrule = 0;
    let sinRrule = 0;
    for (const rule of reglas) {
      const emitida = routineRrule(rule);
      if (emitida === null) {
        sinRrule += 1;
        continue;
      }
      conRrule += 1;
      const dtStart = dtStartDe(rule);
      expect(
        expandRrule(emitida, dtStart, 24),
        `${emitida} desde ${dtStart} (${JSON.stringify(rule)})`
      ).toEqual(occurrencesBetween(rule, dtStart, HORIZON, { limit: 24 }));
    }
    // Que el barrido tenga las dos mitades: si un día se emitiera RRULE para
    // todo, o para nada, este par de números lo cantaría.
    expect(conRrule).toBeGreaterThan(0);
    expect(sinRrule).toBeGreaterThan(0);
    expect(conRrule + sinRrule).toBe(reglas.length);
  });

  it('la comparación es capaz de fallar: una RRULE torcida se nota', () => {
    // Contraprueba del método. Si expandir «los lunes y los jueves» diera lo
    // mismo que expandir «los lunes y los viernes», esta suite entera no
    // estaría midiendo nada.
    const rule: RoutineRule = {
      pattern: 'days_of_week',
      anchorOn: '2026-08-11',
      repeatEvery: 1,
      weekdays: [1, 4]
    };
    const dtStart = dtStartDe(rule);
    expect(expandRrule('FREQ=WEEKLY;BYDAY=MO,FR;WKST=MO', dtStart, N)).not.toEqual(
      occurrencesBetween(rule, dtStart, HORIZON, { limit: N })
    );
  });
});

describe('lo que no se puede decir con fidelidad no se dice', () => {
  const cada31: RoutineRule = {
    pattern: 'day_of_month',
    anchorOn: '2026-01-31',
    repeatEvery: 1,
    monthDay: 31
  };

  it('el día 31 de cada mes NO emite RRULE', () => {
    expect(routineRrule(cada31)).toBeNull();
  });

  it('y no la emite porque BYMONTHDAY=31 se saltaría febrero, abril, junio…', () => {
    const dtStart = dtStartDe(cada31);
    const delMotor = occurrencesBetween(cada31, dtStart, HORIZON, { limit: 12 });
    const deLaRrule = expandRrule('FREQ=MONTHLY;BYMONTHDAY=31', dtStart, 12);

    // El motor RECORTA: enero 31 → febrero 28 → marzo 31 (§2.8).
    expect(delMotor.slice(0, 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    // La RFC SALTA: de enero se va derecho a marzo.
    expect(deLaRrule.slice(0, 3)).toEqual(['2026-01-31', '2026-03-31', '2026-05-31']);
    expect(deLaRrule).not.toEqual(delMotor);
  });

  it('el 29 y el 30 tampoco: febrero no los tiene todos los años', () => {
    const cada30: RoutineRule = {
      pattern: 'day_of_month',
      anchorOn: '2026-01-30',
      repeatEvery: 1,
      monthDay: 30
    };
    expect(routineRrule(cada30)).toBeNull();
    expect(expandRrule('FREQ=MONTHLY;BYMONTHDAY=30', '2026-01-30', 3)).not.toEqual(
      occurrencesBetween(cada30, '2026-01-30', HORIZON, { limit: 3 })
    );

    const cada29Febrero: RoutineRule = {
      pattern: 'months_of_year',
      anchorOn: '2026-01-01',
      months: [2],
      monthDay: 29
    };
    expect(routineRrule(cada29Febrero)).toBeNull();
    // El motor da un 28 de febrero cada año y un 29 en los bisiestos; la RFC
    // solo daría los bisiestos.
    expect(occurrencesBetween(cada29Febrero, '2026-01-01', HORIZON, { limit: 3 })).toEqual([
      '2026-02-28',
      '2027-02-28',
      '2028-02-29'
    ]);
    expect(expandRrule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2026-02-28', 3)).toEqual([
      '2028-02-29',
      '2032-02-29',
      '2036-02-29'
    ]);
  });

  it('el último día del mes sí se puede decir: BYMONTHDAY=-1 recorta igual', () => {
    // El vecino del 31, para que quede claro que el corte está en el 29 y no en
    // «todo lo que huela a fin de mes».
    const ultimo: RoutineRule = {
      pattern: 'day_of_month',
      anchorOn: '2026-01-31',
      repeatEvery: 1,
      monthDay: -1
    };
    const emitida = routineRrule(ultimo);
    expect(emitida).toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
    expect(expandRrule(emitida as string, '2026-01-31', 4)).toEqual(
      occurrencesBetween(ultimo, '2026-01-31', HORIZON, { limit: 4 })
    );
    expect(occurrencesBetween(ultimo, '2026-01-31', HORIZON, { limit: 4 })).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30'
    ]);
  });
});
