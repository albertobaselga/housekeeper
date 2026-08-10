import { describe, expect, it } from 'vitest';

import { parseEuroInput } from '../src/lib/employment/commands';
import {
  buildAccrual,
  centsToEuroInput,
  buildAdvanceBalanceViews,
  buildAgreementOptionViews,
  buildAgreementVersionViews,
  buildCompensationBalanceViews,
  buildPendingExpenseViews,
  buildPendingExtraViews,
  buildSettlementViews,
  buildVacationView,
  annualVacationDaysInForce,
  currentLocalDate,
  currentPeriod,
  currentVacationYear,
  formatCents,
  formatMinutes,
  parseCents,
  periodLabel,
  sourceAnchor,
  vacationRangeLabel,
  type AgreementVersionRow,
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

describe('vacaciones del año en curso', () => {
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
      year: 2026,
      annualVacationDays: 30,
      agreementStartsOn: '2020-01-01',
      agreementEndsOn: null,
      periods: PERIODS
    });
    expect(view.takenDays).toBe(15);
    expect(view.remainingDays).toBe(15);
    expect(view.summaryLabel).toBe('15 de 30 días disfrutados · quedan 15');
    expect(view.prorationNote).toBeNull();
    // Lo anulado se LISTA (para entender por qué el saldo es el que es) pero
    // no suma.
    expect(view.periods.map((period) => period.voided)).toEqual([false, true]);
    expect(view.periods[1]!.voidReason).toBe('Las fechas eran otras');
  });

  it('ordena del más reciente al más antiguo y nombra bien un solo día', () => {
    const view = buildVacationView({
      year: 2026,
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
      year: 2026,
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

  it('explica el prorrateo del primer año en vez de enseñar 30 a secas', () => {
    const view = buildVacationView({
      year: 2026,
      annualVacationDays: 30,
      agreementStartsOn: '2026-02-03',
      agreementEndsOn: null,
      periods: []
    });
    expect(view.prorated).toBe(true);
    expect(view.entitledDays).toBe(28);
    expect(view.summaryLabel).toBe('0 de 28 días disfrutados · quedan 28');
    expect(view.prorationNote).toBe(
      'El acuerdo cubre 332 días de 2026, así que de los 30 días del año le tocan 28 en 2026.'
    );
  });

  it('un periodo a caballo del fin de año solo gasta sus días de este año', () => {
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
    expect(
      buildVacationView({
        year: 2026,
        annualVacationDays: 30,
        agreementStartsOn: '2020-01-01',
        agreementEndsOn: null,
        periods
      }).takenDays
    ).toBe(8);
    expect(
      buildVacationView({
        year: 2027,
        annualVacationDays: 30,
        agreementStartsOn: '2020-01-01',
        agreementEndsOn: null,
        periods
      }).takenDays
    ).toBe(5);
  });

  it('el año natural se lee en la zona del hogar, no en la del proceso', () => {
    // 31 de diciembre a las 23:30 UTC ya es 1 de enero en Madrid.
    expect(currentVacationYear(new Date('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(currentLocalDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
    expect(currentVacationYear(new Date('2026-06-15T10:00:00Z'))).toBe(2026);
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
