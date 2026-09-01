import { describe, expect, it } from 'vitest';

import { parseEuroInput } from '../src/lib/employment/commands';
import {
  buildAccrual,
  buildPortadaView,
  centsToEuroInput,
  buildAdvanceBalanceViews,
  buildAgreementOptionViews,
  buildAgreementTermsView,
  buildAgreementVersionViews,
  buildCompensationBalanceViews,
  buildManualAdjustmentViews,
  buildPendingExpenseViews,
  buildPendingExtraViews,
  buildScheduleView,
  buildSettlementViews,
  buildVacationView,
  annualVacationDaysInForce,
  currentLocalDate,
  currentPeriod,
  employmentTabHref,
  formatCents,
  formatMinutes,
  lastMeaningfulSettlement,
  parseCents,
  periodLabel,
  readVacationCarryoverExpiry,
  scheduleMismatchLabel,
  sourceAnchor,
  vacationCarryoverExpiryLabel,
  vacationRangeLabel,
  type AgreementVersionRow,
  type ManualAdjustmentRow,
  type ScheduleDayRow,
  type ScheduleRow,
  type SettlementLineRow,
  type SettlementRow
} from '../src/lib/employment/model';

const VERSIONS: AgreementVersionRow[] = [
  {
    id: 'v1',
    versionNumber: 1,
    effectiveFrom: '2025-02-03',
    monthlySalaryCents: '140000',
    contractedWeeklyMinutes: 2400,
    annualVacationDays: 30,
    reason: 'Acuerdo inicial'
  },
  {
    id: 'v2',
    versionNumber: 2,
    effectiveFrom: '2025-04-01',
    monthlySalaryCents: '150000',
    contractedWeeklyMinutes: 2400,
    annualVacationDays: 32,
    reason: 'Subida pactada'
  }
];

describe('dinero como cadenas de céntimos', () => {
  it('formatea sin pasar por Number, incluso por encima de 2^53', () => {
    expect(formatCents('145330')).toBe('1.453,30 €');
    expect(formatCents('-10000')).toBe('−100,00 €');
    expect(formatCents('3600', { signed: true })).toBe('+36,00 €');
    expect(formatCents('0')).toBe('0,00 €');
    expect(formatCents('900719925474099312')).toBe('9.007.199.254.740.993,12 €');
  });

  it('convierte céntimos en un importe editable que parseEuroInput acepta (prellenado de «Registrar pago»)', () => {
    // Default del formulario de pago: el pendiente llega prellenado, sin reteclear.
    expect(centsToEuroInput('152175')).toBe('1.521,75');
    expect(centsToEuroInput('2175')).toBe('21,75');
    expect(centsToEuroInput('100000')).toBe('1.000,00');
    // Ida y vuelta exacta con el parser del formulario.
    expect(parseEuroInput(centsToEuroInput('152175'))).toBe('152175');
    expect(parseEuroInput(centsToEuroInput('2175'))).toBe('2175');
  });

  it('rechaza importes que no sean enteros en céntimos', () => {
    expect(() => parseCents('12.5')).toThrow(TypeError);
    expect(() => parseCents('1e3')).toThrow(TypeError);
  });

  it('formatea minutos como duración con días permanentes', () => {
    expect(formatMinutes('1440')).toBe('1 día');
    expect(formatMinutes(150)).toBe('2 h 30 min');
    expect(formatMinutes(0)).toBe('0 min');
  });

  it('etiqueta periodos y calcula el periodo en curso en Europe/Madrid', () => {
    expect(periodLabel('2026-08')).toBe('Agosto 2026');
    expect(currentPeriod(new Date('2026-08-07T12:00:00Z'))).toBe('2026-08');
    // La medianoche UTC del día 1 ya es el mes nuevo en Madrid.
    expect(currentPeriod(new Date('2026-08-31T23:30:00Z'))).toBe('2026-09');
  });
});

describe('versiones del acuerdo', () => {
  it('marca vigente/futura/histórica y calcula el diff salarial', () => {
    const views = buildAgreementVersionViews(VERSIONS, '2025-03-01');
    expect(views.map((view) => view.state)).toEqual(['vigente', 'futura']);
    expect(views[0]!.effectiveTo).toBe('2025-03-31');
    expect(views[0]!.salaryDiffCents).toBeNull();
    expect(views[1]!.salaryDiffCents).toBe('10000');
    expect(views[1]!.salaryDiffLabel).toBe('+100,00 €');

    const later = buildAgreementVersionViews(VERSIONS, '2026-08-01');
    expect(later.map((view) => view.state)).toEqual(['historica', 'vigente']);
  });

  it('enseña el derecho de vacaciones de cada versión y marca cuándo cambió', () => {
    const views = buildAgreementVersionViews(VERSIONS, '2025-03-01');
    expect(views[0]!.vacationDaysLabel).toBe('30 días naturales al año');
    // La primera versión no cambia nada: no hay diferencia que enseñar.
    expect(views[0]!.vacationDiffLabel).toBeNull();
    expect(views[1]!.vacationDiffLabel).toBe('+2 días');
  });

  it('el derecho en vigor es el de la última versión ya aplicada', () => {
    expect(annualVacationDaysInForce(VERSIONS, '2025-03-01')).toBe(30);
    expect(annualVacationDaysInForce(VERSIONS, '2025-04-01')).toBe(32);
    // Antes de la primera versión se cae a la primera, no a cero: cero mentiría.
    expect(annualVacationDaysInForce(VERSIONS, '2024-01-01')).toBe(30);
    expect(annualVacationDaysInForce([], '2025-04-01')).toBe(0);
  });
});

describe('horario del contrato', () => {
  const SCHEDULE: ScheduleRow = {
    id: 'h1',
    agreementVersionId: 'v2',
    startsAt: '08:00',
    endsAt: '16:30',
    longBreakMinutes: 90,
    note: 'El descanso se toma al mediodía.'
  };
  const DAYS: ScheduleDayRow[] = [
    {
      id: 'd1',
      scheduleId: 'h1',
      weekday: 6,
      works: true,
      startsAt: null,
      endsAt: '14:30',
      longBreakMinutes: null,
      note: ''
    },
    {
      id: 'd2',
      scheduleId: 'h1',
      weekday: 7,
      works: false,
      startsAt: null,
      endsAt: null,
      longBreakMinutes: null,
      note: ''
    }
  ];

  it('redacta la frase, resuelve los siete días y suma la semana', () => {
    const view = buildScheduleView({
      schedule: SCHEDULE,
      days: DAYS,
      contractedWeeklyMinutes: 2400
    });
    expect(view.sentence).toBe(
      'De 8:00 a 16:30, con hora y media de descanso al mediodía. Sábado hasta las 14:30. Domingo libre.'
    );
    expect(view.days).toHaveLength(7);
    expect(view.days[0]).toMatchObject({
      weekdayLabel: 'Lunes',
      hoursLabel: '8:00 a 16:30',
      breakLabel: 'hora y media',
      effectiveLabel: '7 h',
      differs: false
    });
    // Un día libre no tiene descanso que anunciar.
    expect(view.days[6]!.breakLabel).toBeNull();
    expect(view.days[0]!.detailLabel).toBe('8:00 a 16:30 · hora y media de descanso');
    expect(view.days[5]).toMatchObject({ weekdayLabel: 'Sábado', hoursLabel: '8:00 a 14:30' });
    expect(view.days[6]).toMatchObject({
      weekdayLabel: 'Domingo',
      hoursLabel: 'Libra',
      effectiveLabel: '—',
      detailLabel: 'Libra'
    });
    expect(view.restDayLabels).toEqual(['Domingo']);
    expect(view.weeklyLabel).toBe('40 h a la semana');
    expect(view.breakLabel).toBe('hora y media');
  });

  it('calla cuando el horario cuadra con la jornada contratada', () => {
    const view = buildScheduleView({ schedule: SCHEDULE, days: DAYS, contractedWeeklyMinutes: 2400 });
    expect(view.matchesContract).toBe(true);
    expect(view.mismatchLabel).toBeNull();
  });

  it('lo dice sin rodeos cuando no cuadra, en las dos direcciones', () => {
    const sobra = buildScheduleView({ schedule: SCHEDULE, days: DAYS, contractedWeeklyMinutes: 2100 });
    expect(sobra.matchesContract).toBe(false);
    expect(sobra.mismatchLabel).toBe(
      'El horario suma 40 h a la semana y la jornada contratada dice 35 h: sobran 5 h.'
    );

    const falta = buildScheduleView({ schedule: SCHEDULE, days: DAYS, contractedWeeklyMinutes: 2700 });
    expect(falta.mismatchLabel).toBe(
      'El horario suma 40 h a la semana y la jornada contratada dice 45 h: faltan 5 h.'
    );
  });

  it('una diferencia de menos de una hora se dice en minutos, no en «0 h»', () => {
    // Lo escribe una sola función porque la escriben dos sitios —el servidor y
    // el editor mientras se teclea—: cuando estaba duplicada, uno de los dos
    // decía «sobran 0 h 30 min».
    expect(scheduleMismatchLabel(2430, 2400)).toBe(
      'El horario suma 40 h 30 min a la semana y la jornada contratada dice 40 h: sobran 30 min.'
    );
    expect(scheduleMismatchLabel(2400, 2430)).toBe(
      'El horario suma 40 h a la semana y la jornada contratada dice 40 h 30 min: faltan 30 min.'
    );
    expect(scheduleMismatchLabel(2400, 2400)).toBeNull();
  });

  it('solo toma los días de SU horario, no los de otra versión', () => {
    const otro: ScheduleDayRow = { ...DAYS[0]!, id: 'd9', scheduleId: 'otro-horario', weekday: 3 };
    const view = buildScheduleView({
      schedule: SCHEDULE,
      days: [...DAYS, otro],
      contractedWeeklyMinutes: 2400
    });
    expect(view.days[2]!.differs).toBe(false);
    expect(view.weeklyMinutes).toBe(2400);
  });

  it('«si aplica»: sin fila de horario, las condiciones no traen ninguna', () => {
    const version: AgreementVersionRow = VERSIONS[1]!;
    // Con horario de SU versión: viaja.
    expect(
      buildAgreementTermsView({
        version,
        types: [],
        supplements: [],
        schedules: [SCHEDULE],
        scheduleDays: DAYS
      }).schedule
    ).not.toBeNull();

    // Sin horario ninguno: null, y la plantilla no pinta sección.
    expect(
      buildAgreementTermsView({ version, types: [], supplements: [] }).schedule
    ).toBeNull();

    // Con horario de OTRA versión: tampoco. El «si aplica» es por versión, no
    // por contrato: una versión vieja con horario no se lo presta a la vigente.
    expect(
      buildAgreementTermsView({
        version: VERSIONS[0]!,
        types: [],
        supplements: [],
        schedules: [SCHEDULE],
        scheduleDays: DAYS
      }).schedule
    ).toBeNull();
  });
});

describe('vacaciones del año de contrato en curso', () => {
  const PERIODS = [
    {
      id: 'p1',
      startsOn: '2026-08-01',
      endsOn: '2026-08-15',
      calendarDays: 15,
      note: 'Quincena de agosto',
      status: 'recorded' as const,
      voidReason: null
    },
    {
      id: 'p2',
      startsOn: '2026-03-02',
      endsOn: '2026-03-06',
      calendarDays: 5,
      note: 'Apuntado por error',
      status: 'voided' as const,
      voidReason: 'Las fechas eran otras'
    }
  ];

  it('resume el saldo en lenguaje llano y no cuenta lo anulado', () => {
    const view = buildVacationView({
      today: '2026-08-20',
      annualVacationDays: 30,
      agreementStartsOn: '2020-01-01',
      agreementEndsOn: null,
      periods: PERIODS
    });
    expect(view.takenDays).toBe(15);
    expect(view.remainingDays).toBe(15);
    expect(view.summaryLabel).toBe('15 de 30 días disfrutados · quedan 15');
    // El año se dice con sus fechas: un contrato de 2020 tiene su séptimo año
    // en 2026, y sin las fechas el ordinal no le diría nada a nadie.
    expect(view.yearLabel).toBe('Séptimo año · 1 ene 2026 – 31 dic 2026');
    expect(view.prorationNote).toBeNull();
    // Lo anulado se LISTA (para entender por qué el saldo es el que es) pero
    // no suma.
    expect(view.periods.map((period) => period.voided)).toEqual([false, true]);
    expect(view.periods[1]!.voidReason).toBe('Las fechas eran otras');
  });

  it('ordena del más reciente al más antiguo y nombra bien un solo día', () => {
    const view = buildVacationView({
      today: '2026-08-20',
      annualVacationDays: 30,
      agreementStartsOn: '2020-01-01',
      agreementEndsOn: null,
      periods: [
        ...PERIODS,
        {
          id: 'p3',
          startsOn: '2026-12-24',
          endsOn: '2026-12-24',
          calendarDays: 1,
          note: '',
          status: 'recorded' as const,
          voidReason: null
        }
      ]
    });
    expect(view.periods.map((period) => period.id)).toEqual(['p3', 'p1', 'p2']);
    expect(view.periods[0]!.rangeLabel).toBe('El 24 dic 2026');
    expect(view.periods[0]!.daysLabel).toBe('1 día');
    // Dentro del mismo mes el rango no repite mes ni año.
    expect(view.periods[1]!.rangeLabel).toBe('Del 1 al 15 ago 2026');
  });

  it('el rango no repite lo que ya ha dicho', () => {
    expect(vacationRangeLabel('2026-08-03', '2026-08-03')).toBe('El 3 ago 2026');
    expect(vacationRangeLabel('2026-11-02', '2026-11-08')).toBe('Del 2 al 8 nov 2026');
    expect(vacationRangeLabel('2026-11-20', '2026-12-05')).toBe('Del 20 nov al 5 dic 2026');
    // Cruzando el fin de año sí hacen falta los dos años.
    expect(vacationRangeLabel('2026-12-24', '2027-01-05')).toBe('Del 24 dic 2026 al 5 ene 2027');
  });

  it('el exceso se dice, no se esconde', () => {
    const view = buildVacationView({
      today: '2026-08-20',
      annualVacationDays: 30,
      agreementStartsOn: '2020-01-01',
      agreementEndsOn: null,
      periods: [
        {
          id: 'p1',
          startsOn: '2026-06-01',
          endsOn: '2026-07-05',
          calendarDays: 35,
          note: '',
          status: 'recorded' as const,
          voidReason: null
        }
      ]
    });
    expect(view.remainingDays).toBe(-5);
    expect(view.summaryLabel).toBe('35 de 30 días disfrutados · 5 días de más');
  });

  it('el primer año ya no se prorratea: empieza el día del contrato', () => {
    // Antes, con el año natural, un contrato de febrero enseñaba 28 de 30 días
    // en su primer año. Con el año de contrato eso desaparece por construcción:
    // los doce meses empiezan el 3 de febrero, así que se devenga entero.
    const view = buildVacationView({
      today: '2026-08-20',
      annualVacationDays: 30,
      agreementStartsOn: '2026-02-03',
      agreementEndsOn: null,
      periods: []
    });
    expect(view.yearLabel).toBe('Primer año · 3 feb 2026 – 2 feb 2027');
    expect(view.prorated).toBe(false);
    expect(view.entitledDays).toBe(30);
    expect(view.prorationNote).toBeNull();
  });

  it('el que sí se prorratea es el último, cuando el contrato termina a media anualidad', () => {
    const view = buildVacationView({
      today: '2026-08-20',
      annualVacationDays: 30,
      agreementStartsOn: '2026-02-03',
      agreementEndsOn: '2026-12-31',
      periods: []
    });
    expect(view.prorated).toBe(true);
    // Los días parciales se redondean hacia arriba: la duda favorece a quien
    // descansa, no a quien paga.
    expect(view.entitledDays).toBe(28);
    expect(view.summaryLabel).toBe('0 de 28 días disfrutados · quedan 28');
    expect(view.prorationNote).toBe(
      'El contrato termina el 31 dic 2026 y cubre 332 días de los 365 de este año, ' +
        'así que de los 30 días pactados le tocan 28.'
    );
  });

  it('un periodo a caballo del aniversario solo gasta sus días de este año', () => {
    const periods = [
      {
        id: 'p1',
        startsOn: '2026-12-24',
        endsOn: '2027-01-05',
        calendarDays: 13,
        note: '',
        status: 'recorded' as const,
        voidReason: null
      }
    ];
    // El contrato empezó un 1 de enero, así que su año de contrato coincide con
    // el natural: el corte sigue cayendo el 31 de diciembre.
    expect(
      buildVacationView({
        today: '2026-12-28',
        annualVacationDays: 30,
        agreementStartsOn: '2020-01-01',
        agreementEndsOn: null,
        periods
      }).takenDays
    ).toBe(8);
    expect(
      buildVacationView({
        today: '2027-01-03',
        annualVacationDays: 30,
        agreementStartsOn: '2020-01-01',
        agreementEndsOn: null,
        periods
      }).takenDays
    ).toBe(5);
  });

  it('la fecha de hoy se lee en la zona del hogar, no en la del proceso', () => {
    // 31 de diciembre a las 23:30 UTC ya es 1 de enero en Madrid, y de esa
    // fecha sale en qué año de contrato se está.
    expect(currentLocalDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(currentLocalDate(new Date('2026-06-15T10:00:00Z'))).toBe('2026-06-15');
  });
});

describe('devengo del periodo en curso', () => {
  it('proyecta salario vigente, extras del mes, cuota de anticipo y gastos aprobados', () => {
    const accrual = buildAccrual({
      period: '2026-08',
      versions: VERSIONS,
      extras: [
        {
          id: 'e1',
          kind: 'overtime',
          typeName: null,
          workedOn: '2026-08-03',
          durationMinutes: 120,
          note: 'Cena tardía',
          origin: 'employee_report',
          resolution: 'money',
          frozenUnitRateCents: '1400',
          frozenAmountCents: '2800',
          balanceMinutes: 0
        },
        {
          id: 'e2',
          kind: 'worked_rest_day',
          typeName: null,
          workedOn: '2026-08-09',
          durationMinutes: 480,
          note: '',
          // Esta la apuntó la familia a su nombre: el devengo tiene que poder
          // decirlo sin cambiar ni un céntimo del cálculo.
          origin: 'family_request',
          resolution: 'time_off',
          frozenUnitRateCents: '8000',
          frozenAmountCents: '0',
          balanceMinutes: 1440
        }
      ],
      advances: [
        {
          id: 'a1',
          status: 'active',
          issuedOn: '2025-01-01',
          principalCents: '40000',
          repaymentCents: '10000',
          outstandingCents: '20000'
        }
      ],
      expenses: [{ id: 'g1', incurredOn: '2026-08-05', description: 'Farmacia', amountCents: '1850' }]
    });

    expect(accrual).not.toBeNull();
    expect(accrual!.period).toBe('2026-08');
    expect(accrual!.agreementVersionId).toBe('v2');
    expect(accrual!.salaryCents).toBe((150000 + 2800 - 10000).toString());
    expect(accrual!.reimbursementCents).toBe('1850');
    expect(accrual!.transferTotalCents).toBe('144650');
    expect(accrual!.permanentCreditMinutes).toBe(1440);

    const kinds = accrual!.lines.map((line) => line.kind);
    expect(kinds).toEqual([
      'base_salary',
      'extra_work',
      'extra_work',
      'advance_deduction',
      'expense_reimbursement'
    ]);
    // Origen navegable dentro de la página.
    expect(accrual!.lines[0]!.href).toBe('#version-v2');
    expect(accrual!.lines[1]!.href).toBe('#extra-e1');
    expect(accrual!.lines[3]!.href).toBe('#anticipo-a1');
    expect(accrual!.lines[3]!.amountLabel).toBe('−100,00 €');
    expect(accrual!.lines[1]!.detail).toBe('2 h × 14,00 €');
    // El origen viaja con la línea de la jornada y solo con ella: el salario,
    // el anticipo y el gasto no tienen a quién atribuirse.
    expect(accrual!.lines[1]!.originLabel).toBe('La apuntó la empleada');
    expect(accrual!.lines[2]!.originLabel).toBe('La apuntó la familia');
    expect(accrual!.lines.map((line) => line.originLabel)).toEqual([
      null,
      'La apuntó la empleada',
      'La apuntó la familia',
      null,
      null
    ]);
  });

  it('limita la cuota del anticipo al saldo pendiente y omite anticipos saldados', () => {
    const accrual = buildAccrual({
      period: '2026-08',
      versions: VERSIONS,
      extras: [],
      advances: [
        { id: 'a1', status: 'active', issuedOn: '2025-01-01', principalCents: '40000', repaymentCents: '10000', outstandingCents: '4000' },
        { id: 'a2', status: 'settled', issuedOn: '2024-01-01', principalCents: '10000', repaymentCents: '5000', outstandingCents: '0' }
      ],
      expenses: []
    });
    const deductions = accrual!.lines.filter((line) => line.kind === 'advance_deduction');
    expect(deductions).toHaveLength(1);
    expect(deductions[0]!.amountCents).toBe('-4000');
  });

  it('devuelve null cuando no hay versión vigente en el periodo', () => {
    expect(
      buildAccrual({ period: '2025-01', versions: VERSIONS, extras: [], advances: [], expenses: [] })
    ).toBeNull();
    expect(buildAccrual({ period: '2026-08', versions: [], extras: [], advances: [], expenses: [] })).toBeNull();
  });
});

describe('liquidaciones y saldos', () => {
  const settlement: SettlementRow = {
    id: 's1',
    periodStart: '2025-03-01',
    periodEnd: '2025-03-31',
    dueOn: '2025-03-31',
    status: 'closed',
    salaryTotalCents: '140600',
    reimbursementTotalCents: '4730',
    transferTotalCents: '145330',
    paidCents: '145330',
    pendingCents: '0',
    receiptConfirmedAt: '2025-03-31 18:42:00+00',
    receiptNote: 'Recibido'
  };
  const lines: SettlementLineRow[] = [
    {
      settlementId: 's1',
      lineNumber: 1,
      section: 'salary',
      kind: 'base_salary',
      occurredOn: '2025-03-01',
      concept: 'Salario base',
      amountCents: '140000',
      agreementVersionId: 'v1',
      extraWorkEventId: null,
      advanceId: null,
      expenseId: null
    },
    {
      settlementId: 's1',
      lineNumber: 2,
      section: 'salary',
      kind: 'advance_deduction',
      occurredOn: '2025-03-31',
      concept: 'Cuota anticipo',
      amountCents: '-10000',
      agreementVersionId: null,
      extraWorkEventId: null,
      advanceId: 'a1',
      expenseId: null
    }
  ];

  it('combina totales de la vista de pagos, confirmación y origen por línea', () => {
    const views = buildSettlementViews(
      [settlement],
      lines,
      [{ id: 'p1', settlementId: 's1', amountCents: '145330', method: 'bank_transfer', valueOn: '2025-03-29', reference: 'ref' }]
    );
    const view = views[0]!;
    expect(view.periodLabel).toBe('Marzo 2025');
    expect(view.transferTotalLabel).toBe('1.453,30 €');
    expect(view.fullyPaid).toBe(true);
    expect(view.receiptConfirmed).toBe(true);
    expect(view.paymentStateLabel).toBe('Pagada y cobro confirmado');
    expect(view.lines[0]!.href).toBe('#version-v1');
    expect(view.lines[1]!.href).toBe('#anticipo-a1');
    expect(view.payments[0]!.methodLabel).toBe('Transferencia');
  });

  it('distingue pago parcial y cobro sin confirmar', () => {
    const partial = buildSettlementViews(
      [{ ...settlement, paidCents: '80000', pendingCents: '65330', receiptConfirmedAt: null, receiptNote: null }],
      [],
      []
    )[0]!;
    expect(partial.fullyPaid).toBe(false);
    expect(partial.paymentStateLabel).toBe('Pendiente de pago');

    const unconfirmed = buildSettlementViews(
      [{ ...settlement, receiptConfirmedAt: null, receiptNote: null }],
      [],
      []
    )[0]!;
    expect(unconfirmed.paymentStateLabel).toBe('Pagada · cobro sin confirmar');
  });

  it('un mes cerrado sin importe no anuncia un pago pendiente que no existe', () => {
    const vacia = buildSettlementViews(
      [
        {
          ...settlement,
          salaryTotalCents: '0',
          reimbursementTotalCents: '0',
          transferTotalCents: '0',
          paidCents: '0',
          pendingCents: '0',
          receiptConfirmedAt: null,
          receiptNote: null
        }
      ],
      [],
      []
    )[0]!;
    // `fullyPaid` sigue siendo false a propósito: una cuenta sin un euro no se
    // ha «pagado». Lo que no puede es leerse como una deuda, y desde que Pagos
    // pliega cada mes en una fila esta frase es lo único que se ve del estado.
    expect(vacia.fullyPaid).toBe(false);
    expect(vacia.paymentStateLabel).toBe('Cerrada · nada que pagar');
  });

  it('presenta el crédito de descanso como permanente y el anticipo con su pendiente', () => {
    const compensation = buildCompensationBalanceViews([
      { accountId: 'c1', balanceType: 'worked_rest_day', balanceMinutes: '1440' }
    ]);
    expect(compensation[0]!.minutesLabel).toBe('1 día');
    expect(compensation[0]!.permanent).toBe(true);
    expect(compensation[0]!.detail).toContain('sin caducidad');

    const advances = buildAdvanceBalanceViews([
      { id: 'a1', status: 'active', issuedOn: '2025-01-01', principalCents: '40000', repaymentCents: '10000', outstandingCents: '20000' }
    ]);
    expect(advances[0]!.outstandingLabel).toBe('200,00 €');
    expect(advances[0]!.principalLabel).toBe('400,00 €');
  });

  it('solo genera anclas para orígenes conocidos', () => {
    expect(sourceAnchor('agreement-version', 'x')).toBe('#version-x');
    expect(sourceAnchor('desconocido', 'x')).toBeNull();
  });

  it('con bases, cada origen enlaza a la pestaña donde vive', () => {
    // Con la sección en pestañas, el origen de una línea ya no está siempre en
    // la misma página. Ojo con jornadas y gastos: los de la CUENTA ya están
    // resueltos y Conceptos solo pinta pendientes, así que su sitio es la
    // propia línea del Resumen. Los conceptos a mano sí viven enteros en
    // Conceptos, y la versión, donde quien mira lee su contrato.
    const bases = {
      conceptos: '/h/H/employment/conceptos',
      resumen: '/h/H/employment',
      pagos: '/h/H/employment/pagos',
      contrato: '/h/H/employment/acuerdo'
    };
    expect(sourceAnchor('jornadas-extra', 'e1', bases)).toBe('/h/H/employment#extra-e1');
    expect(sourceAnchor('gastos', 'g1', bases)).toBe('/h/H/employment#gasto-g1');
    expect(sourceAnchor('ajustes', 'c1', bases)).toBe('/h/H/employment/conceptos#concepto-c1');
    expect(sourceAnchor('anticipos', 'a1', bases)).toBe('/h/H/employment#anticipo-a1');
    expect(sourceAnchor('agreement-version', 'v1', bases)).toBe('/h/H/employment/acuerdo#version-v1');
    expect(sourceAnchor('desconocido', 'x', bases)).toBeNull();
  });
});

describe('conceptos apuntados a mano en la cuenta del mes', () => {
  const ADJUSTMENTS: ManualAdjustmentRow[] = [
    {
      id: 'c1',
      period: '2026-08',
      requestedPeriod: '2026-08',
      label: 'Gratificación de verano',
      reason: 'Acordada el 2 de agosto',
      amountCents: '15000',
      addsToPay: true,
      deferralNote: '',
      status: 'recorded',
      voidReason: null
    },
    {
      id: 'c2',
      period: '2026-08',
      requestedPeriod: '2026-08',
      label: 'Anticipo devuelto en mano',
      reason: 'Devolvió 200 € en efectivo el 12 de agosto',
      amountCents: '-20000',
      addsToPay: false,
      deferralNote: '',
      status: 'recorded',
      voidReason: null
    },
    {
      id: 'c3',
      period: '2026-08',
      requestedPeriod: '2026-08',
      label: 'Apuntado por error',
      reason: 'El importe era otro',
      amountCents: '9000',
      addsToPay: true,
      deferralNote: '',
      status: 'voided',
      voidReason: 'Se apuntó dos veces'
    }
  ];

  function august(adjustments: ManualAdjustmentRow[]) {
    return buildAccrual({
      period: '2026-08',
      versions: VERSIONS,
      extras: [],
      advances: [],
      expenses: [],
      adjustments
    });
  }

  it('suma el que es dinero para ella, con su motivo como explicación de la línea', () => {
    const accrual = august([ADJUSTMENTS[0]!]);
    expect(accrual!.transferTotalCents).toBe('165000');
    const line = accrual!.lines.find((candidate) => candidate.sourceId === 'c1');
    expect(line!.concept).toBe('Gratificación de verano');
    // Etiqueta y motivo van separados: la interfaz enseña el título arriba y
    // la explicación debajo, sin repetirla ni pegarla con dos puntos.
    expect(line!.detail).toBe('Acordada el 2 de agosto');
    expect(line!.amountLabel).toBe('+150,00 €');
    expect(line!.href).toBe('#concepto-c1');
  });

  it('el que no es dinero para ella no toca el total y consta aparte', () => {
    const accrual = august([ADJUSTMENTS[1]!]);
    // El salario pelado de la v2: descontarlo otra vez sería cobrárselo dos veces.
    expect(accrual!.transferTotalCents).toBe('150000');
    expect(accrual!.lines.some((line) => line.kind === 'adjustment')).toBe(false);
    expect(accrual!.notedAdjustments).toEqual([
      {
        id: 'c2',
        label: 'Anticipo devuelto en mano',
        reason: 'Devolvió 200 € en efectivo el 12 de agosto',
        amountLabel: '−200,00 €'
      }
    ]);
  });

  it('el anulado no cuenta, ni en el total ni como línea', () => {
    const accrual = august(ADJUSTMENTS);
    expect(accrual!.transferTotalCents).toBe('165000');
    expect(accrual!.lines.filter((line) => line.kind === 'adjustment')).toHaveLength(1);
  });

  it('la lista los ordena por mes y dice a dónde fue cada uno y por qué', () => {
    const views = buildManualAdjustmentViews([
      ADJUSTMENTS[2]!,
      {
        id: 'c4',
        period: '2026-09',
        requestedPeriod: '2026-08',
        label: 'Descuento acordado',
        reason: 'Rotura de la vitrocerámica, a medias',
        amountCents: '-5000',
        addsToPay: true,
        deferralNote:
          'Se pidió para agosto de 2026, pero esa cuenta ya estaba cerrada: se imputa a septiembre de 2026.',
        status: 'recorded',
        voidReason: null
      }
    ]);
    expect(views.map((view) => view.id)).toEqual(['c4', 'c3']);
    expect(views[0]!.periodLabel).toBe('Septiembre 2026');
    expect(views[0]!.amountLabel).toBe('−50,00 €');
    expect(views[0]!.transferLabel).toBe('Se suma a la transferencia');
    expect(views[0]!.deferralNote).toContain('ya estaba cerrada');
    // Un anulado se proyecta con su marca y su motivo, aunque a la página ya no
    // llegue ninguno: quién entra en la lista lo decide la consulta del
    // servidor, no esta función, que se limita a dar forma a lo que recibe.
    expect(views[1]!.voided).toBe(true);
    expect(views[1]!.voidReason).toBe('Se apuntó dos veces');
  });
});

describe('trabajo y gastos pendientes de acción', () => {
  it('marca qué acción admite cada jornada extra según su estado', () => {
    const views = buildPendingExtraViews([
      { id: 'e1', kind: 'overtime', typeName: null, workedOn: '2026-08-05', durationMinutes: 90, note: '', origin: 'employee_report', status: 'requested', employeeMembershipId: 'm1' },
      { id: 'e2', kind: 'worked_rest_day', typeName: null, workedOn: '2026-08-09', durationMinutes: 480, note: 'Domingo', origin: 'family_request', status: 'accepted', employeeMembershipId: 'm1' },
      { id: 'e3', kind: 'overtime', typeName: null, workedOn: '2026-08-10', durationMinutes: 45, note: '', origin: 'weekly_report', status: 'performed_pending_resolution', employeeMembershipId: 'm1' }
    ]);
    expect(views.map((view) => [view.acceptable, view.performable, view.resolvable])).toEqual([
      [true, true, false],
      [false, true, false],
      [false, false, true]
    ]);
    expect(views[0]!.durationLabel).toBe('1 h 30 min');
    expect(views[1]!.kindLabel).toBe('Festivo o descanso trabajado');
    expect(views[2]!.statusLabel).toBe('Hecha sin acordarla antes · falta decidir la compensación');
    // Quién apuntó cada jornada, dicho igual para las dos partes.
    expect(views.map((view) => view.originLabel)).toEqual([
      'La apuntó la empleada',
      'La apuntó la familia',
      'Viene del parte semanal'
    ]);
  });

  it('nombra a cada persona empleada del hogar y no inventa nombre cuando la RLS lo oculta', () => {
    const options = buildAgreementOptionViews([
      {
        id: 'ac1',
        status: 'active',
        startsOn: '2025-02-03',
        endsOn: null,
        employeeMembershipId: 'm1',
        employeeName: 'Nombre Inventado Uno'
      },
      {
        id: 'ac2',
        status: 'ended',
        startsOn: '2024-01-07',
        endsOn: '2025-06-30',
        employeeMembershipId: 'm2',
        // Sin perfil visible: quien no administra no lee el nombre de los
        // demás. La etiqueta neutra es preferible a enseñar un identificador.
        employeeName: null
      }
    ]);
    expect(options).toEqual([
      {
        id: 'ac1',
        employeeMembershipId: 'm1',
        employeeLabel: 'Nombre Inventado Uno',
        status: 'active',
        active: true,
        startsOn: '2025-02-03',
        endsOn: null,
        periodLabel: 'Desde el 3 feb 2025'
      },
      {
        id: 'ac2',
        employeeMembershipId: 'm2',
        employeeLabel: 'Empleada del hogar',
        status: 'ended',
        active: false,
        startsOn: '2024-01-07',
        endsOn: '2025-06-30',
        periodLabel: 'Del 7 ene 2024 al 30 jun 2025'
      }
    ]);
  });

  it('presenta los gastos pendientes con importe en céntimos formateado', () => {
    const views = buildPendingExpenseViews([
      { id: 'g1', incurredOn: '2026-08-05', description: 'Farmacia', amountCents: '1850', employeeMembershipId: 'm1' }
    ]);
    expect(views[0]!.amountLabel).toBe('18,50 €');
    expect(views[0]!.incurredOnLabel).toBe('5 ago 2026');
  });
});

describe('la caducidad de los días de vacaciones arrastrados', () => {
  it('ausente son seis meses, que es lo que se les venía aplicando', () => {
    // Todas las versiones anteriores a la 0034 tienen `terms` en `{}`: leerlas
    // como seis meses es lo que hace que la migración no tenga que tocar ni una
    // fila ya firmada.
    expect(readVacationCarryoverExpiry({})).toEqual({ mode: 'months', months: 6 });
    expect(readVacationCarryoverExpiry(null)).toEqual({ mode: 'months', months: 6 });
    expect(vacationCarryoverExpiryLabel(readVacationCarryoverExpiry({}))).toBe('6 meses de margen');
  });

  it('lee las dos formas pactadas y las dice en castellano', () => {
    expect(
      readVacationCarryoverExpiry({ vacationCarryoverExpiry: { mode: 'never' } })
    ).toEqual({ mode: 'never' });
    expect(vacationCarryoverExpiryLabel({ mode: 'never' })).toBe('Nunca expiran');
    expect(
      readVacationCarryoverExpiry({ vacationCarryoverExpiry: { mode: 'months', months: 12 } })
    ).toEqual({ mode: 'months', months: 12 });
    expect(vacationCarryoverExpiryLabel({ mode: 'months', months: 1 })).toBe('1 mes de margen');
  });

  it('lo que no sea una de las dos formas cae en el defecto, no revienta la pantalla', () => {
    // La CHECK de la 0034 impide escribir basura ahí, pero una fila anterior a
    // la restricción tiene que seguir dando una respuesta: la política por
    // omisión, que es la que de hecho se le aplicaba.
    expect(readVacationCarryoverExpiry({ vacationCarryoverExpiry: 'seis meses' })).toEqual({
      mode: 'months',
      months: 6
    });
    expect(
      readVacationCarryoverExpiry({ vacationCarryoverExpiry: { mode: 'months', months: 0 } })
    ).toEqual({ mode: 'months', months: 6 });
  });
});

describe('la última cuenta que dice algo', () => {
  /** Cuenta abierta del mes: sin cerrar, el total vale siempre cero. */
  const abiertaDeSeptiembre: SettlementRow = {
    id: 's-sep',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    dueOn: '2026-09-30',
    status: 'open',
    salaryTotalCents: '0',
    reimbursementTotalCents: '0',
    transferTotalCents: '0',
    paidCents: '0',
    pendingCents: '0',
    receiptConfirmedAt: null,
    receiptNote: null
  };
  /** Agosto cerrada y sin pagar: 1.200 € que la casa debe. */
  const agostoSinPagar: SettlementRow = {
    id: 's-ago',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    dueOn: '2026-08-31',
    status: 'closed',
    salaryTotalCents: '120000',
    reimbursementTotalCents: '0',
    transferTotalCents: '120000',
    paidCents: '0',
    pendingCents: '120000',
    receiptConfirmedAt: null,
    receiptNote: null
  };

  it('abrir la cuenta del mes NO apaga la deuda del mes anterior', () => {
    // El montaje exacto del fallo: agosto cerrada con 1.200 € pendientes, y se
    // empieza septiembre. Antes se elegía la más reciente no anulada —la de
    // septiembre— y sólo DESPUÉS se le aplicaba la guarda de «abierta y sin
    // importe», así que devolvía null y la tarjeta desaparecía. El acto más
    // rutinario del mes escondía una deuda vencida.
    const views = buildSettlementViews([abiertaDeSeptiembre, agostoSinPagar], [], []);
    const elegida = lastMeaningfulSettlement(views);
    expect(elegida?.id).toBe('s-ago');
    expect(elegida?.pendingLabel).toBe('1.200,00 €');
  });

  it('salta las anuladas y calla cuando de verdad no hay nada que contar', () => {
    const anulada: SettlementRow = { ...agostoSinPagar, id: 's-void', status: 'void' };
    const views = buildSettlementViews([abiertaDeSeptiembre, anulada], [], []);
    expect(lastMeaningfulSettlement(views)).toBeNull();
    expect(lastMeaningfulSettlement([])).toBeNull();
  });
});

describe('la portada del hogar', () => {
  it('suma la casa en BigInt y dice null —no cero— para quien no tiene devengo', () => {
    const accrual = buildAccrual({
      period: '2026-08',
      versions: VERSIONS,
      extras: [],
      advances: [],
      expenses: [{ id: 'g1', incurredOn: '2026-08-05', description: 'Farmacia', amountCents: '1850' }]
    });
    const portada = buildPortadaView({
      period: '2026-08',
      seesAmounts: true,
      employees: [
        { agreementId: 'a1', employeeLabel: 'Ana', active: true, accrual, pendingCount: 2 },
        // Su contrato aún no está en vigor este mes: buildAccrual devuelve null
        // y la portada no puede inventarle un 0,00 €.
        { agreementId: 'a2', employeeLabel: 'Bea', active: true, accrual: null, pendingCount: 0 }
      ]
    });

    expect(portada.periodLabel).toBe('Agosto 2026');
    expect(portada.salaryLabel).toBe('1.500,00 €');
    expect(portada.reimbursementLabel).toBe('18,50 €');
    expect(portada.totalLabel).toBe('1.518,50 €');
    expect(portada.withReimbursements).toBe(true);
    expect(portada.seesAmounts).toBe(true);

    expect(portada.employees[0]).toMatchObject({
      employeeLabel: 'Ana',
      monthTotalLabel: '1.518,50 €',
      pendingLabel: '2 asuntos por decidir'
    });
    expect(portada.employees[1]).toMatchObject({
      employeeLabel: 'Bea',
      monthTotalCents: null,
      monthTotalLabel: null,
      pendingLabel: 'Nada pendiente'
    });
  });

  it('seesAmounts es una entrada, no una deducción de que llegara alguna cifra', () => {
    // Quien administra una casa cuyos contratos empiezan el mes que viene no
    // tiene NINGÚN devengo, y aun así ve importes: deducirlo de los datos le
    // echaba la culpa a un permiso que sí tiene.
    const administra = buildPortadaView({
      period: '2026-08',
      seesAmounts: true,
      employees: [
        { agreementId: 'a1', employeeLabel: 'Ana', active: true, accrual: null, pendingCount: 1 }
      ]
    });
    expect(administra.seesAmounts).toBe(true);
    expect(administra.employees[0]!.monthTotalLabel).toBeNull();

    const familia = buildPortadaView({
      period: '2026-08',
      seesAmounts: false,
      employees: [
        { agreementId: 'a1', employeeLabel: 'Ana', active: true, accrual: null, pendingCount: 1 }
      ]
    });
    expect(familia.seesAmounts).toBe(false);
    expect(familia.totalCents).toBe('0');
    expect(familia.employees[0]!.pendingLabel).toBe('1 asunto por decidir');
  });

  it('«pendiente» es la deuda de las cuentas cerradas, y sin deuda no hay cifra', () => {
    const portada = buildPortadaView({
      period: '2026-08',
      seesAmounts: true,
      employees: [
        {
          agreementId: 'a1',
          employeeLabel: 'Ana',
          active: true,
          accrual: null,
          pendingCount: 0,
          // Dos cuentas cerradas sin pagar del todo, una de ellas vencida.
          owed: {
            pendingCents: '145330',
            count: 2,
            earliestDueOn: '2026-07-05',
            overdueCount: 1
          }
        },
        // Sin deuda: null en la etiqueta, para que nadie pinte «0,00 €».
        { agreementId: 'a2', employeeLabel: 'Bea', active: true, accrual: null, pendingCount: 0 }
      ]
    });

    expect(portada.owedTotalCents).toBe('145330');
    expect(portada.owedTotalLabel).toBe('1.453,30 €');
    expect(portada.owedCount).toBe(2);
    expect(portada.anyOverdue).toBe(true);
    expect(portada.employees[0]).toMatchObject({
      owedLabel: '1.453,30 €',
      owedDueLabel: 'Venció el 5 jul 2026',
      overdue: true
    });
    expect(portada.employees[1]).toMatchObject({ owedCents: '0', owedLabel: null, owedDueLabel: null });
  });

  it('sin deuda ninguna, el total no es «0,00 €» sino la ausencia de cifra', () => {
    const portada = buildPortadaView({
      period: '2026-08',
      seesAmounts: true,
      employees: [
        { agreementId: 'a1', employeeLabel: 'Ana', active: true, accrual: null, pendingCount: 0 }
      ]
    });
    expect(portada.owedTotalCents).toBe('0');
    // La pantalla dice «Al día» justamente porque aquí no hay etiqueta.
    expect(portada.owedTotalLabel).toBeNull();
    expect(portada.anyOverdue).toBe(false);
  });

  it('suma la deuda de varias personas en BigInt, por encima de 2^53', () => {
    const portada = buildPortadaView({
      period: '2026-08',
      seesAmounts: true,
      employees: [
        {
          agreementId: 'a1',
          employeeLabel: 'Ana',
          active: true,
          accrual: null,
          pendingCount: 0,
          owed: { pendingCents: '9007199254740993', count: 1, earliestDueOn: '2026-09-05', overdueCount: 0 }
        },
        {
          agreementId: 'a2',
          employeeLabel: 'Bea',
          active: true,
          accrual: null,
          pendingCount: 0,
          owed: { pendingCents: '1', count: 1, earliestDueOn: '2026-09-05', overdueCount: 0 }
        }
      ]
    });
    expect(portada.owedTotalCents).toBe('9007199254740994');
    expect(portada.employees[0]!.owedDueLabel).toBe('Vence el 5 sep 2026');
  });

  it('la que vuelve a la casa no es la que acaba de llegar', () => {
    const portada = buildPortadaView({
      period: '2026-08',
      seesAmounts: true,
      employees: [],
      candidates: [
        { membershipId: 'm1', name: 'Ana', previousEndedOn: '2026-06-30', returning: true },
        { membershipId: 'm2', name: 'Bea', previousEndedOn: null, returning: false }
      ]
    });
    expect(portada.candidates[0]!.detailLabel).toBe(
      'Volvió a la casa · su contrato anterior terminó el 30 jun 2026'
    );
    expect(portada.candidates[1]!.detailLabel).toBe(
      'Acaba de llegar · todavía no se ha pactado ningún contrato'
    );
  });
});

describe('el destino de cada pestaña', () => {
  it('escribe la persona elegida siempre igual, y la escapa', () => {
    expect(employmentTabHref('H', 'resumen')).toBe('/h/H/employment');
    expect(employmentTabHref('H', 'conceptos', 'a 1')).toBe(
      '/h/H/employment/conceptos?empleada=a%201'
    );
    expect(employmentTabHref('H', 'pagos', 'a1', 'cuenta-s1')).toBe(
      '/h/H/employment/pagos?empleada=a1#cuenta-s1'
    );
    // Sin persona no hay pregunta: el hogar de una sola empleada no arrastra
    // una cadena vacía detrás de cada enlace.
    expect(employmentTabHref('H', 'vacaciones', null)).toBe('/h/H/employment/vacaciones');
    expect(employmentTabHref('H', 'acuerdo', 'a1')).toBe('/h/H/employment/acuerdo?empleada=a1');
  });

  it('el origen de un concepto ya aplicado lleva a su mes de Pagos', () => {
    // Entre cerrar la cuenta del mes en curso y que cambie el mes, el concepto
    // sigue en el devengo pero ya no está en Conceptos. Enlazarlo allí sería
    // mandar al lector a una página que no lo tiene.
    const bases = {
      conceptos: '/h/H/employment/conceptos',
      resumen: '/h/H/employment',
      pagos: '/h/H/employment/pagos?empleada=a1',
      contrato: '/h/H/employment/acuerdo'
    };
    const accrual = buildAccrual({
      period: '2026-08',
      versions: VERSIONS,
      extras: [],
      advances: [],
      expenses: [],
      adjustments: [
        {
          id: 'c-ap',
          period: '2026-08',
          requestedPeriod: '2026-08',
          label: 'Adelanto entregado',
          reason: 'Entregado a cuenta',
          amountCents: '-15000',
          addsToPay: true,
          deferralNote: '',
          status: 'recorded',
          voidReason: null,
          settledSettlementId: 's1'
        },
        {
          id: 'c-pe',
          period: '2026-08',
          requestedPeriod: '2026-08',
          label: 'Gratificación de verano',
          reason: 'Acordada al volver',
          amountCents: '5000',
          addsToPay: true,
          deferralNote: '',
          status: 'recorded',
          voidReason: null
        }
      ],
      hrefBases: bases
    });
    // Los dos siguen contando en el total: la nómina cerrada del propio mes ya
    // pagó el adelanto, y descontarlo del devengo lo haría decir de más.
    expect(accrual!.lines.filter((line) => line.kind === 'adjustment')).toHaveLength(2);
    expect(accrual!.lines.find((line) => line.sourceId === 'c-ap')!.href).toBe(
      '/h/H/employment/pagos?empleada=a1#cuenta-s1'
    );
    expect(accrual!.lines.find((line) => line.sourceId === 'c-pe')!.href).toBe(
      '/h/H/employment/conceptos#concepto-c-pe'
    );
  });
});
