import { describe, expect, it } from 'vitest';

import {
  buildAccrual,
  buildAdvanceBalanceViews,
  buildAgreementVersionViews,
  buildCompensationBalanceViews,
  buildSettlementViews,
  currentPeriod,
  formatCents,
  formatMinutes,
  parseCents,
  periodLabel,
  sourceAnchor,
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
    overtimeHourlyRateCents: '1200',
    workedRestDayRateCents: '7000',
    workedRestDayCreditMinutes: 1440,
    contractedWeeklyMinutes: 2400,
    reason: 'Acuerdo inicial'
  },
  {
    id: 'v2',
    versionNumber: 2,
    effectiveFrom: '2025-04-01',
    monthlySalaryCents: '150000',
    overtimeHourlyRateCents: '1400',
    workedRestDayRateCents: '8000',
    workedRestDayCreditMinutes: 1440,
    contractedWeeklyMinutes: 2400,
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
          workedOn: '2026-08-03',
          durationMinutes: 120,
          note: 'Cena tardía',
          resolution: 'money',
          frozenUnitRateCents: '1400',
          frozenAmountCents: '2800',
          balanceMinutes: 0
        },
        {
          id: 'e2',
          kind: 'worked_rest_day',
          workedOn: '2026-08-09',
          durationMinutes: 480,
          note: '',
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
