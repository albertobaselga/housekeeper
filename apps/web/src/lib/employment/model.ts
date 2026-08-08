import {
  calculateSettlement,
  vacationYearBalance,
  type AgreementVersion as DomainAgreementVersion,
  type MonetaryInput,
  type SettledExtraWork,
  type SettlementLine
} from '@casa-clara/domain';

/**
 * Modelo de lectura del expediente laboral. Todas las funciones son puras y
 * todo importe viaja como cadena de céntimos: los bigint de Postgres llegan
 * como string desde pg y aquí solo se convierten a BigInt para operar, nunca
 * a Number (perdería precisión y redondearía dinero).
 */

const INTEGER_PATTERN = /^-?\d+$/;

export function parseCents(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (!INTEGER_PATTERN.test(value)) throw new TypeError(`Importe inválido: ${value}`);
  return BigInt(value);
}

/** Formatea céntimos como euros es-ES ("145.330" → "1.453,30 €"). */
export function formatCents(value: string | bigint, options: { signed?: boolean } = {}): string {
  const cents = parseCents(value);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const units = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const magnitude = `${units},${(abs % 100n).toString().padStart(2, '0')} €`;
  if (negative) return `−${magnitude}`;
  return options.signed && cents > 0n ? `+${magnitude}` : magnitude;
}

/**
 * Céntimos → valor editable de un campo de importe es-ES, sin símbolo
 * ("152175" → "1.521,75"). Es la inversa de `parseEuroInput` para poder
 * prellenar formularios con importes que la app ya conoce.
 */
export function centsToEuroInput(value: string | bigint): string {
  return formatCents(value).replace(/\s*€$/, '');
}

/** Formatea minutos como duración legible ("1440" → "1 día", 150 → "2 h 30 min"). */
export function formatMinutes(value: string | number | bigint): string {
  const total = typeof value === 'number' ? BigInt(value) : parseCents(value);
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const days = abs / 1440n;
  const hours = (abs % 1440n) / 60n;
  const minutes = abs % 60n;
  const parts: string[] = [];
  if (days > 0n) parts.push(`${days} ${days === 1n ? 'día' : 'días'}`);
  if (hours > 0n) parts.push(`${hours} h`);
  if (minutes > 0n) parts.push(`${minutes} min`);
  if (parts.length === 0) parts.push('0 min');
  return `${negative ? '−' : ''}${parts.join(' ')}`;
}

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
] as const;

/** "2026-08" → "Agosto 2026". */
export function periodLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return period;
  return `${month[0]!.toLocaleUpperCase('es')}${month.slice(1)} ${match[1]}`;
}

/** Periodo YYYY-MM del instante dado en la zona horaria del hogar. */
export function currentPeriod(now = new Date(), timeZone = 'Europe/Madrid'): string {
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone, year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}`;
}

/** "2026-08-07" → "7 ago 2026" sin depender del huso del proceso. */
export function dateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = MONTHS[Number(match[2]) - 1] ?? '';
  return `${Number(match[3])} ${month.slice(0, 3)} ${match[1]}`;
}

function previousDay(iso: string): string {
  const time = Date.parse(`${iso}T00:00:00Z`) - 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

// --- Filas tal y como salen de Postgres (bigint = string) -------------------

export interface AgreementVersionRow {
  id: string;
  versionNumber: number;
  effectiveFrom: string;
  monthlySalaryCents: string;
  overtimeHourlyRateCents: string;
  workedRestDayRateCents: string;
  workedRestDayCreditMinutes: number;
  contractedWeeklyMinutes: number;
  /** Días naturales de vacaciones al año pactados en esta versión. */
  annualVacationDays: number;
  reason: string;
}

export interface VacationPeriodRow {
  id: string;
  startsOn: string;
  endsOn: string;
  calendarDays: number;
  note: string;
  status: 'recorded' | 'voided';
  voidReason: string | null;
}

export interface ResolvedExtraWorkRow {
  id: string;
  kind: 'overtime' | 'worked_rest_day';
  workedOn: string;
  durationMinutes: number;
  note: string;
  resolution: 'money' | 'time_off';
  frozenUnitRateCents: string;
  frozenAmountCents: string;
  balanceMinutes: number | null;
}

export interface AdvanceRow {
  id: string;
  status: string;
  issuedOn: string;
  principalCents: string;
  repaymentCents: string;
  outstandingCents: string;
}

export interface ApprovedExpenseRow {
  id: string;
  incurredOn: string;
  description: string;
  amountCents: string;
}

export type PendingExtraWorkStatus =
  | 'requested'
  | 'accepted'
  | 'performed'
  | 'performed_pending_resolution';

export interface PendingExtraWorkRow {
  id: string;
  kind: 'overtime' | 'worked_rest_day';
  workedOn: string;
  durationMinutes: number;
  note: string;
  status: PendingExtraWorkStatus;
  employeeMembershipId: string;
}

export interface PendingExpenseRow {
  id: string;
  incurredOn: string;
  description: string;
  amountCents: string;
  employeeMembershipId: string;
  /** true si el gasto llegó con justificante enlazado (receipt_document_id). */
  hasReceipt?: boolean;
}

export type WeeklyReportStatus = 'draft' | 'submitted' | 'confirmed' | 'disputed';

export interface WeeklyReportRow {
  id: string;
  weekStartsOn: string;
  weekEndsOn: string;
  status: WeeklyReportStatus;
  autoConfirmed: boolean;
  disputeReason: string | null;
}

export interface CompensationBalanceRow {
  accountId: string;
  balanceType: string;
  balanceMinutes: string;
}

export interface SettlementRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  status: string;
  salaryTotalCents: string;
  reimbursementTotalCents: string;
  transferTotalCents: string;
  paidCents: string;
  pendingCents: string;
  receiptConfirmedAt: string | null;
  receiptNote: string | null;
}

export interface SettlementLineRow {
  settlementId: string;
  lineNumber: number;
  section: 'salary' | 'reimbursement';
  kind: string;
  occurredOn: string;
  concept: string;
  amountCents: string;
  agreementVersionId: string | null;
  extraWorkEventId: string | null;
  advanceId: string | null;
  expenseId: string | null;
}

export interface PaymentRow {
  id: string;
  settlementId: string;
  amountCents: string;
  method: string;
  valueOn: string;
  reference: string;
}

// --- Vistas para la página ---------------------------------------------------

export type AgreementVersionState = 'vigente' | 'futura' | 'historica';

export interface AgreementVersionView {
  id: string;
  versionNumber: number;
  effectiveFrom: string;
  effectiveFromLabel: string;
  effectiveTo: string | null;
  monthlySalaryCents: string;
  salaryLabel: string;
  overtimeRateLabel: string;
  workedRestDayRateLabel: string;
  weeklyHoursLabel: string;
  /** «30 días naturales al año». */
  vacationDaysLabel: string;
  annualVacationDays: number;
  /** «+2 días» si esta versión cambió el derecho; null si no lo tocó. */
  vacationDiffLabel: string | null;
  reason: string;
  state: AgreementVersionState;
  /** Diferencia salarial frente a la versión anterior, en céntimos con signo. */
  salaryDiffCents: string | null;
  salaryDiffLabel: string | null;
}

export interface AccrualLineView {
  id: string;
  anchorId: string | null;
  kind: SettlementLine['kind'];
  concept: string;
  detail: string;
  amountCents: string;
  amountLabel: string;
  sourceType: string;
  sourceId: string;
  href: string | null;
}

export interface AccrualView {
  period: string;
  periodLabel: string;
  agreementVersionId: string;
  lines: AccrualLineView[];
  salaryCents: string;
  salaryLabel: string;
  reimbursementCents: string;
  reimbursementLabel: string;
  transferTotalCents: string;
  transferTotalLabel: string;
  permanentCreditMinutes: number;
}

export interface SettlementLineView {
  lineNumber: number;
  section: 'salary' | 'reimbursement';
  kind: string;
  occurredOn: string;
  occurredOnLabel: string;
  concept: string;
  amountCents: string;
  amountLabel: string;
  href: string | null;
  /**
   * Gasto reembolsado que SÍ tiene justificante guardado. La cuenta del mes ya
   * está cerrada y no se toca: el enlace es de solo lectura y lo ve quien ya
   * puede ver la cuenta. Null cuando la línea no viene de un gasto o el gasto
   * se aprobó sin foto.
   */
  receiptExpenseId: string | null;
}

export interface SettlementPaymentView {
  id: string;
  amountCents: string;
  amountLabel: string;
  methodLabel: string;
  valueOn: string;
  valueOnLabel: string;
  reference: string;
}

export interface SettlementView {
  id: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  dueOn: string;
  dueOnLabel: string;
  status: string;
  statusLabel: string;
  salaryTotalCents: string;
  salaryTotalLabel: string;
  reimbursementTotalCents: string;
  reimbursementTotalLabel: string;
  transferTotalCents: string;
  transferTotalLabel: string;
  paidCents: string;
  paidLabel: string;
  pendingCents: string;
  pendingLabel: string;
  fullyPaid: boolean;
  receiptConfirmed: boolean;
  receiptConfirmedAt: string | null;
  receiptNote: string | null;
  paymentStateLabel: string;
  lines: SettlementLineView[];
  payments: SettlementPaymentView[];
}

export interface CompensationBalanceView {
  accountId: string;
  balanceType: string;
  typeLabel: string;
  balanceMinutes: string;
  minutesLabel: string;
  /** El crédito de descanso es permanente: nunca caduca por fecha. */
  permanent: true;
  detail: string;
}

export interface VacationPeriodView {
  id: string;
  startsOn: string;
  endsOn: string;
  /** «Del 1 al 15 de agosto de 2026», o «El 3 de agosto de 2026» si es un día. */
  rangeLabel: string;
  calendarDays: number;
  /** «15 días». */
  daysLabel: string;
  note: string;
  voided: boolean;
  voidReason: string | null;
}

export interface VacationView {
  year: number;
  /** Derecho de este año, ya prorrateado si el acuerdo no lo cubre entero. */
  entitledDays: number;
  /** Derecho anual completo pactado, para poder explicar el prorrateo. */
  annualVacationDays: number;
  takenDays: number;
  /** Negativo si se pasó; la interfaz lo enseña, no lo esconde. */
  remainingDays: number;
  prorated: boolean;
  /** «15 de 30 días disfrutados · quedan 15». */
  summaryLabel: string;
  /** Explicación del prorrateo, o null si el acuerdo cubre el año entero. */
  prorationNote: string | null;
  /** Periodos del año, del más reciente al más antiguo, anulados incluidos. */
  periods: VacationPeriodView[];
}

export interface AdvanceBalanceView {
  advanceId: string;
  status: string;
  issuedOn: string;
  issuedOnLabel: string;
  principalCents: string;
  principalLabel: string;
  outstandingCents: string;
  outstandingLabel: string;
  repaymentCents: string;
  repaymentLabel: string;
  detail: string;
}

export interface PendingExtraWorkView {
  id: string;
  kind: PendingExtraWorkRow['kind'];
  kindLabel: string;
  workedOn: string;
  workedOnLabel: string;
  durationMinutes: number;
  durationLabel: string;
  note: string;
  status: PendingExtraWorkStatus;
  statusLabel: string;
  employeeMembershipId: string;
  /** requested → la familia puede aceptarla. */
  acceptable: boolean;
  /** requested/accepted → la empleada puede marcarla como realizada. */
  performable: boolean;
  /** performed/performed_pending_resolution → la familia puede resolverla. */
  resolvable: boolean;
}

export interface PendingExpenseView {
  id: string;
  incurredOn: string;
  incurredOnLabel: string;
  description: string;
  amountCents: string;
  amountLabel: string;
  employeeMembershipId: string;
  hasReceipt: boolean;
}

export interface WeeklyReportView {
  id: string;
  weekStartsOn: string;
  weekEndsOn: string;
  weekLabel: string;
  status: WeeklyReportStatus;
  autoConfirmed: boolean;
  statusLabel: string;
  disputeReason: string | null;
}

export interface EmploymentOverview {
  householdId: string;
  hasEmploymentData: boolean;
  agreement: {
    id: string;
    status: string;
    startsOn: string;
    endsOn: string | null;
    employeeMembershipId: string;
  } | null;
  versions: AgreementVersionView[];
  accrual: AccrualView | null;
  settlements: SettlementView[];
  pendingExtras: PendingExtraWorkView[];
  pendingExpenses: PendingExpenseView[];
  /** Partes semanales recientes (máx. 6 semanas), del más nuevo al más viejo. */
  recentReports: WeeklyReportView[];
  /** Vacaciones del año natural en curso; null si no hay acuerdo visible. */
  vacations: VacationView | null;
  balances: {
    compensation: CompensationBalanceView[];
    advances: AdvanceBalanceView[];
  };
}

// --- Mapeos puros ------------------------------------------------------------

const EXTRA_WORK_LABELS: Record<ResolvedExtraWorkRow['kind'], string> = {
  overtime: 'Horas extraordinarias',
  worked_rest_day: 'Festivo o descanso trabajado'
};

const BALANCE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Vacaciones',
  extra_time: 'Horas por compensar',
  worked_rest_day: 'Descanso compensatorio'
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  bizum: 'Bizum',
  mixed: 'Mixto',
  other: 'Otro'
};

const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  open: 'Abierta',
  closed: 'Cerrada',
  void: 'Anulada'
};

/**
 * Ancla navegable hacia la entidad de origen dentro de la propia página del
 * expediente. Hueco conocido: aún no existen rutas de detalle por entidad, así
 * que el origen enlaza a la sección donde la entidad está pintada.
 */
export function sourceAnchor(sourceType: string, sourceId: string): string | null {
  switch (sourceType) {
    case 'agreement-version':
      return `#version-${sourceId}`;
    case 'jornadas-extra':
      return `#extra-${sourceId}`;
    case 'anticipos':
      return `#anticipo-${sourceId}`;
    case 'gastos':
      return `#gasto-${sourceId}`;
    default:
      return null;
  }
}

export function buildAgreementVersionViews(
  rows: readonly AgreementVersionRow[],
  onDate: string
): AgreementVersionView[] {
  const ordered = [...rows].sort((a, b) => a.versionNumber - b.versionNumber);
  return ordered.map((row, index) => {
    const next = ordered[index + 1];
    const effectiveTo = next ? previousDay(next.effectiveFrom) : null;
    let state: AgreementVersionState = 'vigente';
    if (row.effectiveFrom > onDate) state = 'futura';
    else if (effectiveTo !== null && effectiveTo < onDate) state = 'historica';
    const previous = index > 0 ? ordered[index - 1] : undefined;
    const diff = previous
      ? parseCents(row.monthlySalaryCents) - parseCents(previous.monthlySalaryCents)
      : null;
    return {
      id: row.id,
      versionNumber: row.versionNumber,
      effectiveFrom: row.effectiveFrom,
      effectiveFromLabel: dateLabel(row.effectiveFrom),
      effectiveTo,
      monthlySalaryCents: row.monthlySalaryCents,
      salaryLabel: formatCents(row.monthlySalaryCents),
      overtimeRateLabel: `${formatCents(row.overtimeHourlyRateCents)}/h`,
      workedRestDayRateLabel: `${formatCents(row.workedRestDayRateCents)}/día`,
      weeklyHoursLabel: formatMinutes(row.contractedWeeklyMinutes) + '/semana',
      vacationDaysLabel: `${row.annualVacationDays} ${
        row.annualVacationDays === 1 ? 'día natural' : 'días naturales'
      } al año`,
      annualVacationDays: row.annualVacationDays,
      vacationDiffLabel:
        previous === undefined || previous.annualVacationDays === row.annualVacationDays
          ? null
          : formatDayDiff(row.annualVacationDays - previous.annualVacationDays),
      reason: row.reason,
      state,
      salaryDiffCents: diff === null ? null : diff.toString(),
      salaryDiffLabel: diff === null || diff === 0n ? null : formatCents(diff, { signed: true })
    };
  });
}

export function toDomainVersions(rows: readonly AgreementVersionRow[]): DomainAgreementVersion[] {
  const ordered = [...rows].sort((a, b) => a.versionNumber - b.versionNumber);
  return ordered.map((row, index) => {
    const next = ordered[index + 1];
    return {
      id: row.id,
      validFrom: row.effectiveFrom,
      validTo: next ? previousDay(next.effectiveFrom) : null,
      monthlySalaryCents: parseCents(row.monthlySalaryCents)
    };
  });
}

function accrualDetail(line: SettlementLine): string {
  switch (line.kind) {
    case 'base_salary':
      return 'Salario mensual de la versión vigente';
    case 'extra_work':
      return line.unitCents === null
        ? `${line.quantity} · compensada en descanso permanente`
        : `${line.quantity} × ${formatCents(line.unitCents)}`;
    case 'advance_deduction':
      return 'Cuota mensual del anticipo';
    case 'expense_reimbursement':
      return 'Justificante aprobado';
    default:
      return line.quantity === '1' ? '' : line.quantity;
  }
}

export interface AccrualFacts {
  period: string;
  versions: readonly AgreementVersionRow[];
  extras: readonly ResolvedExtraWorkRow[];
  advances: readonly AdvanceRow[];
  expenses: readonly ApprovedExpenseRow[];
}

/**
 * Proyección del devengo del periodo en curso con los hechos reales del mes.
 * Devuelve null cuando ninguna versión del acuerdo está vigente en el periodo
 * (por ejemplo, un acuerdo que empieza el mes que viene).
 */
export function buildAccrual(facts: AccrualFacts): AccrualView | null {
  if (facts.versions.length === 0) return null;

  const extraWork: SettledExtraWork[] = facts.extras.map((row) => ({
    id: row.id,
    workedOn: row.workedOn,
    label: row.note.trim()
      ? `${EXTRA_WORK_LABELS[row.kind]} · ${row.note.trim()}`
      : EXTRA_WORK_LABELS[row.kind],
    resolution: row.resolution,
    quantityLabel: formatMinutes(row.durationMinutes),
    frozenUnitRateCents: parseCents(row.frozenUnitRateCents),
    frozenAmountCents: parseCents(row.frozenAmountCents),
    permanentCreditMinutes: row.resolution === 'time_off' ? (row.balanceMinutes ?? 0) : 0
  }));

  const advanceDeductions: MonetaryInput[] = facts.advances
    .filter((row) => row.status === 'active' && parseCents(row.outstandingCents) > 0n)
    .map((row) => {
      const outstanding = parseCents(row.outstandingCents);
      const installment = parseCents(row.repaymentCents);
      return {
        id: row.id,
        label: 'Anticipo · cuota mensual',
        amountCents: installment < outstanding ? installment : outstanding
      };
    });

  const expenses: MonetaryInput[] = facts.expenses.map((row) => ({
    id: row.id,
    label: `${row.description} (${dateLabel(row.incurredOn)})`,
    amountCents: parseCents(row.amountCents)
  }));

  let projection;
  try {
    projection = calculateSettlement({
      period: facts.period,
      agreementVersions: toDomainVersions(facts.versions),
      extraWork,
      extraPay: [],
      advanceDeductions,
      unpaidAbsences: [],
      adjustments: [],
      expenses
    });
  } catch (cause) {
    if (cause instanceof RangeError) return null;
    throw cause;
  }

  const lines: AccrualLineView[] = projection.lines.map((line) => {
    const anchorId =
      line.sourceType === 'jornadas-extra'
        ? `extra-${line.sourceId}`
        : line.sourceType === 'gastos'
          ? `gasto-${line.sourceId}`
          : null;
    return {
      id: line.id,
      anchorId,
      kind: line.kind,
      concept: line.label,
      detail: accrualDetail(line),
      amountCents: line.amountCents.toString(),
      amountLabel: formatCents(line.amountCents, { signed: line.kind !== 'base_salary' }),
      sourceType: line.sourceType,
      sourceId: line.sourceId,
      href: sourceAnchor(line.sourceType, line.sourceId)
    };
  });

  return {
    period: projection.period,
    periodLabel: periodLabel(projection.period),
    agreementVersionId: projection.agreementVersionId,
    lines,
    salaryCents: projection.salaryCents.toString(),
    salaryLabel: formatCents(projection.salaryCents),
    reimbursementCents: projection.reimbursementCents.toString(),
    reimbursementLabel: formatCents(projection.reimbursementCents),
    transferTotalCents: projection.transferTotalCents.toString(),
    transferTotalLabel: formatCents(projection.transferTotalCents),
    permanentCreditMinutes: projection.permanentCreditMinutes
  };
}

export function settlementLineHref(row: SettlementLineRow): string | null {
  if (row.agreementVersionId) return sourceAnchor('agreement-version', row.agreementVersionId);
  if (row.advanceId) return sourceAnchor('anticipos', row.advanceId);
  return null;
}

function paymentStateLabel(row: SettlementRow, fullyPaid: boolean, anyPayment: boolean): string {
  if (row.status === 'void') return 'Anulada';
  if (row.status === 'open') return 'Periodo abierto';
  if (fullyPaid && row.receiptConfirmedAt) return 'Pagada y cobro confirmado';
  if (fullyPaid) return 'Pagada · cobro sin confirmar';
  if (anyPayment) return 'Pago parcial registrado';
  return 'Pendiente de pago';
}

export function buildSettlementViews(
  settlements: readonly SettlementRow[],
  lines: readonly SettlementLineRow[],
  payments: readonly PaymentRow[],
  /** Gastos de estas líneas que tienen justificante guardado (lectura RLS). */
  expensesWithReceipt: ReadonlySet<string> = new Set()
): SettlementView[] {
  return settlements.map((row) => {
    const ownLines = lines
      .filter((line) => line.settlementId === row.id)
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        lineNumber: line.lineNumber,
        section: line.section,
        kind: line.kind,
        occurredOn: line.occurredOn,
        occurredOnLabel: dateLabel(line.occurredOn),
        concept: line.concept,
        amountCents: line.amountCents,
        amountLabel: formatCents(line.amountCents, { signed: line.kind !== 'base_salary' }),
        href: settlementLineHref(line),
        receiptExpenseId:
          line.expenseId && expensesWithReceipt.has(line.expenseId) ? line.expenseId : null
      }));
    const ownPayments = payments
      .filter((payment) => payment.settlementId === row.id)
      .map((payment) => ({
        id: payment.id,
        amountCents: payment.amountCents,
        amountLabel: formatCents(payment.amountCents),
        methodLabel: PAYMENT_METHOD_LABELS[payment.method] ?? payment.method,
        valueOn: payment.valueOn,
        valueOnLabel: dateLabel(payment.valueOn),
        reference: payment.reference
      }));
    const fullyPaid =
      parseCents(row.pendingCents) === 0n && parseCents(row.transferTotalCents) > 0n;
    return {
      id: row.id,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      periodLabel: periodLabel(row.periodStart.slice(0, 7)),
      dueOn: row.dueOn,
      dueOnLabel: dateLabel(row.dueOn),
      status: row.status,
      statusLabel: SETTLEMENT_STATUS_LABELS[row.status] ?? row.status,
      salaryTotalCents: row.salaryTotalCents,
      salaryTotalLabel: formatCents(row.salaryTotalCents),
      reimbursementTotalCents: row.reimbursementTotalCents,
      reimbursementTotalLabel: formatCents(row.reimbursementTotalCents),
      transferTotalCents: row.transferTotalCents,
      transferTotalLabel: formatCents(row.transferTotalCents),
      paidCents: row.paidCents,
      paidLabel: formatCents(row.paidCents),
      pendingCents: row.pendingCents,
      pendingLabel: formatCents(row.pendingCents),
      fullyPaid,
      receiptConfirmed: row.receiptConfirmedAt !== null,
      receiptConfirmedAt: row.receiptConfirmedAt,
      receiptNote: row.receiptNote,
      paymentStateLabel: paymentStateLabel(row, fullyPaid, ownPayments.length > 0),
      lines: ownLines,
      payments: ownPayments
    };
  });
}

// Lenguaje de casa (revisión UX v3, P2-5): «resolver» suena a pleito; los
// estados cuentan qué falta en frases llanas.
const PENDING_EXTRA_STATUS_LABELS: Record<PendingExtraWorkStatus, string> = {
  requested: 'Solicitada',
  accepted: 'Aceptada · sin realizar',
  performed: 'Hecha · falta decidir la compensación',
  performed_pending_resolution: 'Hecha sin acordarla antes · falta decidir la compensación'
};

export function buildPendingExtraViews(
  rows: readonly PendingExtraWorkRow[]
): PendingExtraWorkView[] {
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    kindLabel: EXTRA_WORK_LABELS[row.kind],
    workedOn: row.workedOn,
    workedOnLabel: dateLabel(row.workedOn),
    durationMinutes: row.durationMinutes,
    durationLabel: formatMinutes(row.durationMinutes),
    note: row.note,
    status: row.status,
    statusLabel: PENDING_EXTRA_STATUS_LABELS[row.status] ?? row.status,
    employeeMembershipId: row.employeeMembershipId,
    acceptable: row.status === 'requested',
    performable: row.status === 'requested' || row.status === 'accepted',
    resolvable: row.status === 'performed' || row.status === 'performed_pending_resolution'
  }));
}

export function buildPendingExpenseViews(
  rows: readonly PendingExpenseRow[]
): PendingExpenseView[] {
  return rows.map((row) => ({
    id: row.id,
    incurredOn: row.incurredOn,
    incurredOnLabel: dateLabel(row.incurredOn),
    description: row.description,
    amountCents: row.amountCents,
    amountLabel: formatCents(row.amountCents),
    employeeMembershipId: row.employeeMembershipId,
    hasReceipt: row.hasReceipt === true
  }));
}

/**
 * Estado visible del parte semanal. `draft` no llega nunca desde el servidor
 * (submit_week crea el parte ya enviado), pero el mapeo lo cubre por si acaso.
 */
export function weeklyReportStatusLabel(status: WeeklyReportStatus, autoConfirmed: boolean): string {
  switch (status) {
    case 'submitted':
      return 'Enviado · pendiente de confirmación';
    case 'confirmed':
      return autoConfirmed ? 'Auto-confirmado' : 'Confirmado';
    case 'disputed':
      return 'Con reparos de la familia';
    default:
      return 'Borrador';
  }
}

export function buildWeeklyReportViews(rows: readonly WeeklyReportRow[]): WeeklyReportView[] {
  return [...rows]
    .sort((left, right) => right.weekStartsOn.localeCompare(left.weekStartsOn))
    .map((row) => ({
      id: row.id,
      weekStartsOn: row.weekStartsOn,
      weekEndsOn: row.weekEndsOn,
      weekLabel: `Semana del ${dateLabel(row.weekStartsOn)}`,
      status: row.status,
      autoConfirmed: row.autoConfirmed,
      statusLabel: weeklyReportStatusLabel(row.status, row.autoConfirmed),
      disputeReason: row.disputeReason
    }));
}

export function buildCompensationBalanceViews(
  rows: readonly CompensationBalanceRow[]
): CompensationBalanceView[] {
  return rows.map((row) => ({
    accountId: row.accountId,
    balanceType: row.balanceType,
    typeLabel: BALANCE_TYPE_LABELS[row.balanceType] ?? row.balanceType,
    balanceMinutes: row.balanceMinutes,
    minutesLabel: formatMinutes(row.balanceMinutes),
    permanent: true,
    detail: 'Crédito permanente · sin caducidad'
  }));
}

/** Año natural en curso en la zona horaria del hogar. */
export function currentVacationYear(now = new Date(), timeZone = 'Europe/Madrid'): number {
  const year = new Intl.DateTimeFormat('es-ES', { timeZone, year: 'numeric' })
    .formatToParts(now)
    .find((part) => part.type === 'year')?.value;
  return Number(year ?? now.getUTCFullYear());
}

/** Fecha de hoy `YYYY-MM-DD` en la zona horaria del hogar, no en la del proceso. */
export function currentLocalDate(now = new Date(), timeZone = 'Europe/Madrid'): string {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '01';
  return `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`;
}

/**
 * Derecho anual que rige el año que se está mirando.
 *
 * Si el derecho cambió a mitad de año hay dos respuestas defendibles y ninguna
 * es «la buena»; se elige la ÚLTIMA versión ya en vigor dentro del año, porque
 * es lo que el hogar pactó de más reciente y sigue siendo verdad hoy. El cambio
 * no se esconde: la tarjeta de versiones lo enseña con su fecha y su motivo.
 */
export function annualVacationDaysInForce(
  rows: readonly AgreementVersionRow[],
  onDate: string
): number {
  const ordered = [...rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const inForce = ordered.filter((row) => row.effectiveFrom <= onDate).at(-1);
  return (inForce ?? ordered[0])?.annualVacationDays ?? 0;
}

function dayCountLabel(days: number): string {
  return `${days} ${Math.abs(days) === 1 ? 'día' : 'días'}`;
}

function formatDayDiff(days: number): string {
  return `${days > 0 ? '+' : '−'}${dayCountLabel(Math.abs(days))}`;
}

/** «15 días» / «1 día», con el plural correcto. */
export function vacationDaysLabel(days: number): string {
  return dayCountLabel(days);
}

/** «Del 1 al 15 de agosto de 2026»; un solo día se dice «El 3 de agosto de 2026». */
export function vacationRangeLabel(startsOn: string, endsOn: string): string {
  if (startsOn === endsOn) return `El ${dateLabel(startsOn)}`;
  return `Del ${dateLabel(startsOn)} al ${dateLabel(endsOn)}`;
}

/**
 * Bloque de vacaciones del año natural en curso.
 *
 * El saldo lo calcula el motor puro del dominio (`vacationYearBalance`), que es
 * quien sabe prorratear el primer año y repartir un periodo que cruza el 31 de
 * diciembre. Aquí solo se ponen las palabras.
 *
 * Los periodos ANULADOS se listan pero no cuentan: verlos tachados es lo que
 * convierte «me faltan días» en «ah, aquello se anuló el martes».
 */
export function buildVacationView(input: {
  year: number;
  annualVacationDays: number;
  agreementStartsOn: string;
  agreementEndsOn: string | null;
  periods: readonly VacationPeriodRow[];
}): VacationView {
  const balance = vacationYearBalance({
    year: input.year,
    annualVacationDays: input.annualVacationDays,
    agreementStartsOn: input.agreementStartsOn,
    agreementEndsOn: input.agreementEndsOn,
    periods: input.periods
      .filter((row) => row.status === 'recorded')
      .map((row) => ({ startsOn: row.startsOn, endsOn: row.endsOn }))
  });

  // «quedan 15» a secas: la unidad ya la ha dicho «de 30 días disfrutados» y
  // repetirla tres veces en un renglón lo vuelve ilegible. El exceso sí lleva
  // unidad, porque «5 de más» a secas no se entiende de qué son.
  const remaining =
    balance.remainingDays < 0
      ? `${dayCountLabel(-balance.remainingDays)} de más`
      : `quedan ${balance.remainingDays}`;

  return {
    year: balance.year,
    entitledDays: balance.entitledDays,
    annualVacationDays: balance.annualVacationDays,
    takenDays: balance.takenDays,
    remainingDays: balance.remainingDays,
    prorated: balance.prorated,
    summaryLabel: `${balance.takenDays} de ${balance.entitledDays} días disfrutados · ${remaining}`,
    prorationNote: balance.prorated
      ? `El acuerdo cubre ${dayCountLabel(balance.coveredDays)} de ${input.year}, así que de los ` +
        `${balance.annualVacationDays} días del año le tocan ${balance.entitledDays} en ${input.year}.`
      : null,
    periods: [...input.periods]
      .sort((left, right) => right.startsOn.localeCompare(left.startsOn))
      .map((row) => ({
        id: row.id,
        startsOn: row.startsOn,
        endsOn: row.endsOn,
        rangeLabel: vacationRangeLabel(row.startsOn, row.endsOn),
        calendarDays: row.calendarDays,
        daysLabel: dayCountLabel(row.calendarDays),
        note: row.note,
        voided: row.status === 'voided',
        voidReason: row.voidReason
      }))
  };
}

export function buildAdvanceBalanceViews(rows: readonly AdvanceRow[]): AdvanceBalanceView[] {
  return rows.map((row) => ({
    advanceId: row.id,
    status: row.status,
    issuedOn: row.issuedOn,
    issuedOnLabel: dateLabel(row.issuedOn),
    principalCents: row.principalCents,
    principalLabel: formatCents(row.principalCents),
    outstandingCents: row.outstandingCents,
    outstandingLabel: formatCents(row.outstandingCents),
    repaymentCents: row.repaymentCents,
    repaymentLabel: formatCents(row.repaymentCents),
    detail: `Cuota mensual de ${formatCents(row.repaymentCents)} · concedido el ${dateLabel(row.issuedOn)}`
  }));
}
