import { contractYear } from '@casa-clara/domain';
import { describe, expect, it } from 'vitest';

import {
  annualVacationDaysForContractYear,
  buildVacationPersonView,
  type VacationHistoryPeriodRow
} from '../src/lib/employment/vacation-history';
import { buildVacationNews } from '../src/lib/server/vacations.server';

// El contrato de referencia empezó el 5 de marzo de 2025, así que sus años van
// del 5 de marzo al 4 de marzo: primero 2025-2026, segundo 2026-2027.
const START = '2025-03-05';
const VERSIONS = [
  { effectiveFrom: '2025-03-05', annualVacationDays: 30 },
  { effectiveFrom: '2026-06-01', annualVacationDays: 32 }
];
const TREINTA = [{ effectiveFrom: '2025-03-05', annualVacationDays: 30 }];

function period(overrides: Partial<VacationHistoryPeriodRow> = {}): VacationHistoryPeriodRow {
  return {
    id: 'p-1',
    startsOn: '2026-08-01',
    endsOn: '2026-08-15',
    note: 'Quincena de agosto',
    status: 'recorded',
    voidReason: null,
    ...overrides
  };
}

function view(overrides: Partial<Parameters<typeof buildVacationPersonView>[0]> = {}) {
  return buildVacationPersonView({
    agreementId: 'a-1',
    employeeLabel: 'Empleada del hogar',
    own: true,
    agreementStartsOn: START,
    agreementEndsOn: null,
    versions: TREINTA,
    periods: [period()],
    today: '2026-09-01',
    ...overrides
  });
}

describe('derecho anual del año de contrato que se mira', () => {
  it('un año de contrato ya cerrado conserva el derecho que tuvo, no el de hoy', () => {
    // El primero acabó el 4 de marzo de 2026, antes de que el derecho subiera a 32.
    expect(annualVacationDaysForContractYear(VERSIONS, contractYear(START, 1), '2026-09-01')).toBe(
      30
    );
  });

  it('el año en curso usa la versión vigente hoy', () => {
    expect(annualVacationDaysForContractYear(VERSIONS, contractYear(START, 2), '2026-09-01')).toBe(
      32
    );
  });

  it('un año anterior a la primera versión visible no se queda a cero', () => {
    const tardias = [{ effectiveFrom: '2026-06-01', annualVacationDays: 32 }];
    expect(annualVacationDaysForContractYear(tardias, contractYear(START, 1), '2026-09-01')).toBe(
      32
    );
  });
});

describe('historial de vacaciones de una persona', () => {
  it('enseña todos los años de contrato, del más reciente al primero', () => {
    const person = view();
    expect(person.years.map((year) => year.index)).toEqual([2, 1]);
    expect(person.years[0]?.current).toBe(true);
  });

  it('el año se dice con sus fechas: un ordinal a secas no significa nada', () => {
    const person = view();
    expect(person.years[0]?.label).toBe('Segundo año · 5 mar 2026 – 4 mar 2027');
    expect(person.years[1]?.label).toBe('Primer año · 5 mar 2025 – 4 mar 2026');
    expect(person.years[0]?.startsOn).toBe('2026-03-05');
    expect(person.years[0]?.endsOn).toBe('2027-03-04');
  });

  it('el año sin nada apuntado lo dice, en vez de desaparecer del historial', () => {
    const primero = view().years.find((year) => year.index === 1);
    expect(primero?.periods).toHaveLength(0);
    expect(primero?.takenDays).toBe(0);
    expect(primero?.headline).toContain('todavía no has disfrutado ninguno');
  });

  it('habla de tú a la empleada y de ella a quien administra', () => {
    expect(view({ own: true }).years[0]?.headline).toBe(
      'De los 30 días que te tocan en el segundo año, has disfrutado 15. Te quedan 15.'
    );
    expect(view({ own: false }).years[0]?.headline).toBe(
      'De los 30 días que le tocan en el segundo año, ha disfrutado 15. Le quedan 15.'
    );
  });

  it('el exceso se cuenta en días, sin porcentajes ni juicios', () => {
    const person = view({
      own: false,
      periods: [
        period({ id: 'p-1', startsOn: '2026-03-05', endsOn: '2026-04-15' })
      ]
    });
    expect(person.years[0]?.remainingDays).toBe(-12);
    expect(person.years[0]?.headline).toBe(
      'En el segundo año ha disfrutado 42 días y el contrato reconoce 30 días: hay 12 días de más.'
    );
    expect(person.years[0]?.excessNote).toContain('Casa Clara no lo corrige sola');
    expect(person.years[0]?.headline).not.toMatch(/%/);
    // El exceso ya lo cuenta todo: la nota del adelanto sería un segundo aviso
    // diciendo lo mismo con otras palabras.
    expect(person.years[0]?.advanceNote).toBeNull();
  });

  it('lo anulado sigue en la lista, marcado como anulado y sin sumar', () => {
    const person = view({
      periods: [
        period({
          id: 'p-anulado',
          startsOn: '2026-03-06',
          endsOn: '2026-03-10',
          status: 'voided',
          voidReason: 'Las fechas eran otras'
        })
      ]
    });
    const [first] = person.years[0]?.periods ?? [];
    expect(first?.state).toBe('voided');
    expect(first?.stateLabel).toBe('Anuladas');
    expect(first?.daysLabel).toBe('—');
    expect(first?.detail).toBe('Eran 5 días. Anuladas: Las fechas eran otras');
    expect(person.years[0]?.takenDays).toBe(0);
  });

  it('distingue lo ya disfrutado, lo que está pasando y lo que viene', () => {
    const person = view({
      periods: [
        period({ id: 'p-pasado', startsOn: '2026-04-02', endsOn: '2026-04-06' }),
        period({ id: 'p-ahora', startsOn: '2026-08-25', endsOn: '2026-09-05' }),
        period({ id: 'p-futuro', startsOn: '2026-12-24', endsOn: '2026-12-31' })
      ]
    });
    const states = Object.fromEntries(
      (person.years[0]?.periods ?? []).map((entry) => [entry.id, entry.state])
    );
    expect(states).toEqual({ 'p-pasado': 'past', 'p-ahora': 'current', 'p-futuro': 'future' });
  });

  it('un periodo a caballo de dos años de contrato dice cuántos días caen en cada uno', () => {
    // Del 1 al 10 de marzo de 2027, con el aniversario el día 5: cuatro días
    // gastan el segundo año y seis el tercero.
    const person = view({
      periods: [
        period({ id: 'p-marzo', startsOn: '2027-03-01', endsOn: '2027-03-10' })
      ]
    });
    const segundo = person.years.find((year) => year.index === 2);
    const tercero = person.years.find((year) => year.index === 3);
    expect(segundo?.takenDays).toBe(4);
    expect(segundo?.periods[0]?.splitLabel).toBe('4 días de estas caen en el segundo año');
    expect(tercero?.takenDays).toBe(6);
    expect(tercero?.periods[0]?.splitLabel).toBe('6 días de estas caen en el tercer año');
  });

  it('un periodo que cabe entero en su año no lleva coletilla de reparto', () => {
    expect(view().years[0]?.periods[0]?.splitLabel).toBeNull();
  });

  it('sin ver los términos no se inventa un derecho de cero días', () => {
    const person = view({
      own: false,
      // Lo que la RLS le devuelve a la familia no administradora: los periodos
      // sí, las versiones del contrato no.
      versions: []
    });
    expect(person.years[0]?.entitledDays).toBeNull();
    expect(person.years[0]?.remainingDays).toBeNull();
    expect(person.years[0]?.accruedDays).toBeNull();
    expect(person.years[0]?.takenDays).toBe(15);
    expect(person.years[0]?.headline).toBe('En el segundo año constan 15 días de vacaciones.');
    expect(person.years[0]?.accruedNote).toBeNull();
    expect(person.entitlementNote).toContain('solo lo ven quien administra');
  });

  it('el primer año ya no se prorratea: empieza el día del contrato', () => {
    const person = view({ periods: [] });
    const primero = person.years.find((year) => year.index === 1);
    expect(primero?.entitledDays).toBe(30);
    expect(primero?.prorationNote).toBeNull();
  });

  it('un contrato terminado no inventa años posteriores, y prorratea el último', () => {
    const person = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: false,
      agreementStartsOn: '2024-01-01',
      agreementEndsOn: '2025-06-30',
      versions: [{ effectiveFrom: '2024-01-01', annualVacationDays: 30 }],
      periods: [],
      today: '2026-08-11'
    });
    expect(person.years.map((year) => year.index)).toEqual([2, 1]);
    // Medio año de contrato cubierto, medio derecho: 30 × 181 / 365 = 14,88 → 15.
    expect(person.years[0]?.entitledDays).toBe(15);
    expect(person.years[0]?.prorationNote).toBe(
      'El contrato termina dentro del segundo año: cubre 181 días de los 365, así que de los ' +
        '30 días del año le tocan 15.'
    );
    // Ningún año está en curso: el contrato acabó hace más de un año.
    expect(person.years.every((year) => year.accruedNote === null)).toBe(true);
  });

  it('el último año prorrateado con días repartidos: el cruce de las tres reglas', () => {
    // Contrato que acaba el 30 de junio de 2026 y unas vacaciones del 1 al 10
    // de marzo, justo encima del aniversario. Aquí se tocan a la vez el
    // prorrateo del último año, el reparto entre dos años y el devengo a fecha.
    const person = view({
      agreementEndsOn: '2026-06-30',
      periods: [period({ id: 'p-marzo', startsOn: '2026-03-01', endsOn: '2026-03-10' })],
      today: '2026-05-01'
    });
    const primero = person.years.find((year) => year.index === 1);
    const segundo = person.years.find((year) => year.index === 2);

    // 118 días cubiertos de 365: de los 30 del año le tocan 10.
    expect(segundo?.entitledDays).toBe(10);
    expect(segundo?.prorationNote).toBe(
      'El contrato termina dentro del segundo año: cubre 118 días de los 365, así que de los ' +
        '30 días del año te tocan 10.'
    );
    // Los diez días del periodo, repartidos sin perder ni duplicar ninguno.
    expect(primero?.takenDays).toBe(4);
    expect(segundo?.takenDays).toBe(6);
    expect((primero?.takenDays ?? 0) + (segundo?.takenDays ?? 0)).toBe(10);
    expect(primero?.periods[0]?.splitLabel).toBe('4 días de estas caen en el primer año');
    expect(segundo?.periods[0]?.splitLabel).toBe('6 días de estas caen en el segundo año');
    // Y el mismo periodo se lista en los dos años, con sus fechas enteras.
    expect(primero?.periods[0]?.daysLabel).toBe('10 días');
    expect(segundo?.periods[0]?.daysLabel).toBe('10 días');
    // Devengado 5 de los 10 a 1 de mayo, con 6 cogidos: uno por delante.
    expect(segundo?.accruedDays).toBe(5);
    expect(segundo?.availableNowDays).toBe(-1);
    expect(segundo?.advanceNote).toContain('Has disfrutado 1 día por delante de lo devengado');
    expect(segundo?.excessNote).toBeNull();
  });

  it('los días se cuentan de las fechas, no de un número que venga en la fila', () => {
    const [único] = view({
      periods: [period({ startsOn: '2026-08-01', endsOn: '2026-08-15' })]
    }).years[0]?.periods ?? [];
    expect(único?.daysLabel).toBe('15 días');
  });
});

describe('ningún periodo apuntado desaparece de la pantalla', () => {
  it('uno posterior al fin del contrato se enseña, y su año dice que no lo reconoce', () => {
    // El día que una baja fije el fin del contrato hacia atrás, esto deja de
    // ser hipotético: los periodos ya apuntados caerían fuera de todos los años.
    const person = view({
      own: false,
      agreementEndsOn: '2026-06-30',
      periods: [period({ id: 'p-fuera', startsOn: '2027-05-01', endsOn: '2027-05-05' })],
      today: '2026-08-01'
    });
    const tercero = person.years.find((year) => year.index === 3);
    expect(tercero?.periods.map((entry) => entry.id)).toEqual(['p-fuera']);
    expect(tercero?.entitledDays).toBe(0);
    expect(tercero?.headline).toBe(
      'En el tercer año ha disfrutado 5 días y el contrato reconoce 0 días: hay 5 días de más.'
    );
    expect(tercero?.excessNote).toContain('Casa Clara no lo corrige sola');
    expect(person.empty).toBe(false);
  });

  it('uno anterior al inicio del contrato se recoge en el primer año', () => {
    const person = view({
      periods: [period({ id: 'p-antes', startsOn: '2025-01-10', endsOn: '2025-01-15' })]
    });
    const primero = person.years.find((year) => year.index === 1);
    expect(primero?.periods.map((entry) => entry.id)).toEqual(['p-antes']);
    expect(primero?.takenDays).toBe(0);
    expect(primero?.periods[0]?.splitLabel).toBe('0 días de estas caen en el primer año');
  });

  it('sin ningún periodo el estado vacío dice la verdad', () => {
    expect(view({ periods: [] }).empty).toBe(true);
  });
});

describe('los días devengados a día de hoy', () => {
  it('lo dice con la fecha, porque un devengo sin fecha no significa nada', () => {
    // Del 5 de marzo al 1 de septiembre de 2026 van 181 días de los 365 del
    // segundo año: 30 × 181 / 365 = 14,88 → 15.
    const person = view({ periods: [] });
    expect(person.years[0]?.accruedDays).toBe(15);
    expect(person.years[0]?.accruedNote).toBe(
      'A 1 sep 2026 llevas devengados 15 de los 30 días del año.'
    );
  });

  it('quien administra lo lee en tercera persona', () => {
    expect(view({ own: false, periods: [] }).years[0]?.accruedNote).toBe(
      'A 1 sep 2026 lleva devengados 15 de los 30 días del año.'
    );
  });

  it('un año ya cerrado no repite el devengo: está entero por definición', () => {
    const person = view({ periods: [] });
    const primero = person.years.find((year) => year.index === 1);
    expect(primero?.accruedDays).toBe(30);
    expect(primero?.accruedNote).toBeNull();
  });

  it('lo devengado y lo que queda son dos cifras distintas', () => {
    const person = view({
      periods: [
        period({ id: 'p-agosto', startsOn: '2026-08-01', endsOn: '2026-08-20' })
      ]
    });
    expect(person.years[0]?.remainingDays).toBe(10);
    expect(person.years[0]?.accruedDays).toBe(15);
    expect(person.years[0]?.availableNowDays).toBe(-5);
  });

  it('los días cogidos por delante de lo devengado se explican sin acusar a nadie', () => {
    const cogidos = [
      period({ id: 'p-agosto', startsOn: '2026-08-01', endsOn: '2026-08-20' })
    ];
    expect(view({ periods: cogidos }).years[0]?.advanceNote).toBe(
      'Has disfrutado 5 días por delante de lo devengado a día de hoy. Es lo corriente cuando ' +
        'las vacaciones se cogen antes de que acabe el año de contrato; no hay nada que corregir.'
    );
    expect(view({ own: false, periods: cogidos }).years[0]?.advanceNote).toContain('Ha disfrutado');
  });

  it('sin adelanto no se pinta la línea: la pantalla no se llena de nada', () => {
    expect(view().years[0]?.availableNowDays).toBe(0);
    expect(view().years[0]?.advanceNote).toBeNull();
  });
});

describe('la frase de lo que todavía no ha visto', () => {
  const evento = (
    startsOn: string,
    endsOn: string,
    recordedAt: string,
    voidedAt: string | null = null
  ) => ({
    startsOn,
    endsOn,
    status: (voidedAt === null ? 'recorded' : 'voided') as 'recorded' | 'voided',
    recordedAt,
    voidedAt
  });

  it('un solo periodo se nombra entero', () => {
    const news = buildVacationNews(
      [evento('2026-08-01', '2026-08-15', '2026-07-20T10:00:00Z')],
      null
    );
    expect(news?.count).toBe(1);
    expect(news?.headline).toBe('Te han apuntado vacaciones: del 1 al 15 ago 2026');
  });

  it('varios se cuentan, porque una lista de rangos en Hoy no es un aviso', () => {
    const news = buildVacationNews(
      [
        evento('2026-08-01', '2026-08-15', '2026-07-20T10:00:00Z'),
        evento('2026-12-24', '2026-12-31', '2026-07-21T10:00:00Z')
      ],
      null
    );
    expect(news?.headline).toBe('Te han apuntado vacaciones nuevas: 2 periodos');
  });

  it('una anulación posterior a su mirada se dice sin rodeos', () => {
    const news = buildVacationNews(
      [evento('2026-03-02', '2026-03-06', '2026-02-01T10:00:00Z', '2026-08-05T12:00:00Z')],
      '2026-08-01T00:00:00Z'
    );
    expect(news?.headline).toBe(
      'Se han anulado unas vacaciones que tenías apuntadas: del 2 al 6 mar 2026'
    );
  });

  it('sin nada nuevo no hay aviso que dar', () => {
    expect(
      buildVacationNews(
        [evento('2026-08-01', '2026-08-15', '2026-07-20T10:00:00Z')],
        '2026-07-21T00:00:00Z'
      )
    ).toBeNull();
  });

  it('la marca que se propone guardar es la del último sello enseñado', () => {
    const news = buildVacationNews(
      [
        evento('2026-08-01', '2026-08-15', '2026-07-20T10:00:00Z'),
        evento('2026-12-24', '2026-12-31', '2026-07-25T10:00:00Z')
      ],
      null
    );
    expect(news?.seenThrough).toBe('2026-07-25T10:00:00Z');
  });
});
