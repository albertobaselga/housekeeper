import {
  calculateSettlement,
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
  reason: string;
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
  payments: readonly PaymentRow[]
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
        href: settlementLineHref(line)
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

const PENDING_EXTRA_STATUS_LABELS: Record<PendingExtraWorkStatus, string> = {
  requested: 'Solicitada',
  accepted: 'Aceptada · sin realizar',
  performed: 'Realizada · pendiente de resolver',
  performed_pending_resolution: 'Realizada sin aceptación previa'
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
    employeeMembershipId: row.employeeMembershipId
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
      return 'Disputado';
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
