import { describe, expect, it } from 'vitest';

import {
  annualVacationDaysForYear,
  buildVacationPersonView,
  type VacationHistoryPeriodRow
} from '../src/lib/employment/vacation-history';
import { buildVacationNews } from '../src/lib/server/vacations.server';

const VERSIONS = [
  { effectiveFrom: '2025-02-03', annualVacationDays: 30 },
  { effectiveFrom: '2026-01-01', annualVacationDays: 32 }
];

function period(overrides: Partial<VacationHistoryPeriodRow> = {}): VacationHistoryPeriodRow {
  return {
    id: 'p-1',
    startsOn: '2026-08-01',
    endsOn: '2026-08-15',
    calendarDays: 15,
    note: 'Quincena de agosto',
    status: 'recorded',
    voidReason: null,
    ...overrides
  };
}

describe('derecho anual del año que se mira', () => {
  it('un año ya cerrado conserva el derecho que tuvo, no el de hoy', () => {
    expect(annualVacationDaysForYear(VERSIONS, 2025, '2026-08-11')).toBe(30);
  });

  it('el año en curso usa la versión vigente hoy', () => {
    expect(annualVacationDaysForYear(VERSIONS, 2026, '2026-08-11')).toBe(32);
  });

  it('un año anterior a la primera versión no se queda a cero', () => {
    expect(annualVacationDaysForYear(VERSIONS, 2024, '2026-08-11')).toBe(30);
  });
});

describe('historial de vacaciones de una persona', () => {
  it('enseña todos los años del contrato, del más reciente al más antiguo', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: true,
      agreementStartsOn: '2025-02-03',
      agreementEndsOn: null,
      versions: VERSIONS,
      periods: [period()],
      today: '2026-08-11'
    });
    expect(view.years.map((year) => year.year)).toEqual([2026, 2025]);
    expect(view.years[0]?.current).toBe(true);
  });

  it('el año sin nada apuntado lo dice, en vez de desaparecer del historial', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: true,
      agreementStartsOn: '2025-02-03',
      agreementEndsOn: null,
      versions: VERSIONS,
      periods: [period()],
      today: '2026-08-11'
    });
    const twentyFive = view.years.find((year) => year.year === 2025);
    expect(twentyFive?.periods).toHaveLength(0);
    expect(twentyFive?.takenDays).toBe(0);
    expect(twentyFive?.headline).toContain('todavía no has disfrutado ninguno');
  });

  it('habla de tú a la empleada y de ella a quien administra', () => {
    const common = {
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      agreementStartsOn: '2025-01-01',
      agreementEndsOn: null,
      versions: [{ effectiveFrom: '2025-01-01', annualVacationDays: 30 }],
      periods: [period()],
      today: '2026-08-20'
    };
    const own = buildVacationPersonView({ ...common, own: true });
    const other = buildVacationPersonView({ ...common, own: false });
    expect(own.years[0]?.headline).toBe(
      'De los 30 días que te tocan en 2026, has disfrutado 15. Te quedan 15.'
    );
    expect(other.years[0]?.headline).toBe(
      'De los 30 días que le tocan en 2026, ha disfrutado 15. Le quedan 15.'
    );
  });

  it('el exceso se cuenta en días, sin porcentajes ni juicios', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: false,
      agreementStartsOn: '2025-01-01',
      agreementEndsOn: null,
      versions: [{ effectiveFrom: '2025-01-01', annualVacationDays: 30 }],
      periods: [
        period({ id: 'p-1', startsOn: '2026-01-01', endsOn: '2026-02-11', calendarDays: 42 })
      ],
      today: '2026-08-20'
    });
    expect(view.years[0]?.remainingDays).toBe(-12);
    expect(view.years[0]?.headline).toBe(
      'En 2026 ha disfrutado 42 días y el contrato reconoce 30 días: hay 12 días de más.'
    );
    expect(view.years[0]?.excessNote).toContain('La aplicación no lo corrige sola');
    expect(view.years[0]?.headline).not.toMatch(/%/);
  });

  it('lo anulado sigue en la lista, marcado como anulado y sin sumar', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: true,
      agreementStartsOn: '2025-01-01',
      agreementEndsOn: null,
      versions: [{ effectiveFrom: '2025-01-01', annualVacationDays: 30 }],
      periods: [
        period({
          id: 'p-anulado',
          startsOn: '2026-03-02',
          endsOn: '2026-03-06',
          calendarDays: 5,
          status: 'voided',
          voidReason: 'Las fechas eran otras'
        })
      ],
      today: '2026-08-20'
    });
    const [first] = view.years[0]?.periods ?? [];
    expect(first?.state).toBe('voided');
    expect(first?.stateLabel).toBe('Anuladas');
    expect(first?.daysLabel).toBe('—');
    expect(first?.detail).toBe('Eran 5 días. Anuladas: Las fechas eran otras');
    expect(view.years[0]?.takenDays).toBe(0);
  });

  it('distingue lo ya disfrutado, lo que está pasando y lo que viene', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: true,
      agreementStartsOn: '2025-01-01',
      agreementEndsOn: null,
      versions: [{ effectiveFrom: '2025-01-01', annualVacationDays: 30 }],
      periods: [
        period({ id: 'p-pasado', startsOn: '2026-03-02', endsOn: '2026-03-06', calendarDays: 5 }),
        period({ id: 'p-ahora', startsOn: '2026-08-01', endsOn: '2026-08-15', calendarDays: 15 }),
        period({ id: 'p-futuro', startsOn: '2026-12-24', endsOn: '2026-12-31', calendarDays: 8 })
      ],
      today: '2026-08-11'
    });
    const states = Object.fromEntries(
      (view.years[0]?.periods ?? []).map((entry) => [entry.id, entry.state])
    );
    expect(states).toEqual({ 'p-pasado': 'past', 'p-ahora': 'current', 'p-futuro': 'future' });
  });

  it('un periodo a caballo del fin de año dice cuántos días caen en cada uno', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: true,
      agreementStartsOn: '2025-01-01',
      agreementEndsOn: null,
      versions: [{ effectiveFrom: '2025-01-01', annualVacationDays: 30 }],
      periods: [
        period({ id: 'p-navidad', startsOn: '2026-12-24', endsOn: '2027-01-05', calendarDays: 13 })
      ],
      today: '2026-08-11'
    });
    const twentySix = view.years.find((year) => year.year === 2026);
    const twentySeven = view.years.find((year) => year.year === 2027);
    expect(twentySix?.takenDays).toBe(8);
    expect(twentySix?.periods[0]?.splitLabel).toBe('8 días de estas caen en 2026');
    expect(twentySeven?.takenDays).toBe(5);
  });

  it('sin ver los términos no se inventa un derecho de cero días', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: false,
      agreementStartsOn: '2025-01-01',
      agreementEndsOn: null,
      // Lo que la RLS le devuelve a la familia no administradora: los periodos
      // sí, las versiones del contrato no.
      versions: [],
      periods: [period()],
      today: '2026-08-20'
    });
    expect(view.years[0]?.entitledDays).toBeNull();
    expect(view.years[0]?.remainingDays).toBeNull();
    expect(view.years[0]?.takenDays).toBe(15);
    expect(view.years[0]?.headline).toBe('En 2026 constan 15 días de vacaciones.');
    expect(view.entitlementNote).toContain('solo lo ven quien administra');
  });

  it('un contrato terminado no inventa años posteriores a su último día', () => {
    const view = buildVacationPersonView({
      agreementId: 'a-1',
      employeeLabel: 'Empleada del hogar',
      own: false,
      agreementStartsOn: '2024-01-01',
      agreementEndsOn: '2025-06-30',
      versions: [{ effectiveFrom: '2024-01-01', annualVacationDays: 30 }],
      periods: [],
      today: '2026-08-11'
    });
    expect(view.years.map((year) => year.year)).toEqual([2025, 2024]);
    // El último año va prorrateado: medio contrato, medio derecho.
    expect(view.years[0]?.entitledDays).toBe(15);
    expect(view.years[0]?.prorationNote).toContain('El contrato cubre 181 días de 2025');
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
