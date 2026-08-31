import {
  calculateSettlement,
  describeSchedule,
  resolveWeek,
  scheduleCoherence,
  spokenDuration,
  spokenTime,
  vacationYearBalance,
  weekdayName,
  type AgreementSchedule,
  type AgreementVersion as DomainAgreementVersion,
  type MonetaryInput,
  type ScheduleDay as DomainScheduleDay,
  type SettledExtraWork,
  type SettlementLine,
  type Weekday
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

/**
 * Sin `overtime_hourly_rate_cents` ni `worked_rest_day_rate_cents` a propósito.
 * Esas columnas siguen en la base por compatibilidad (ver el pie de la
 * migración 0021), pero NO se leen aquí: si viajaran en este objeto llegarían
 * al JSON de la página, y con ellas la tarifa horaria de una empleada a la que
 * no se le permiten horas. Las tarifas salen del catálogo, que la RLS filtra
 * fila a fila según quién pregunta.
 */
export interface AgreementVersionRow {
  id: string;
  versionNumber: number;
  effectiveFrom: string;
  monthlySalaryCents: string;
  contractedWeeklyMinutes: number;
  /** Días naturales de vacaciones al año pactados en esta versión. */
  annualVacationDays: number;
  reason: string;
}

export type ExtraWorkUnit = 'per_hour' | 'per_shift' | 'fixed_amount';

export interface ExtraWorkTypeRow {
  id: string;
  agreementVersionId: string;
  code: string;
  name: string;
  unit: ExtraWorkUnit;
  rateCents: string | null;
  referenceMinutes: number | null;
  active: boolean;
}

export interface RecurringSupplementRow {
  id: string;
  agreementVersionId: string;
  code: string;
  name: string;
  amountCents: string | null;
  periodicity: 'monthly';
  addsToPay: boolean;
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
}

/**
 * Horario pactado en una versión (migración 0025). Las horas llegan ya como
 * «HH:MM»: la consulta las formatea con `to_char` en vez de dejar que pg
 * entregue el `time` completo y que cada lector recorte los segundos por su
 * cuenta.
 */
export interface ScheduleRow {
  id: string;
  agreementVersionId: string;
  startsAt: string;
  endsAt: string;
  longBreakMinutes: number;
  note: string;
}

export interface ScheduleDayRow {
  id: string;
  scheduleId: string;
  weekday: number;
  works: boolean;
  startsAt: string | null;
  endsAt: string | null;
  longBreakMinutes: number | null;
  note: string;
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

/**
 * Concepto apuntado a mano (migración 0022) tal y como sale de Postgres.
 *
 * `period` es el mes al que se imputa DE VERDAD y `requestedPeriod` el que se
 * pidió: distintos solo cuando aquel ya estaba cerrado. La `deferralNote` viene
 * congelada de la fila, no se recalcula aquí: la frase que se guardó el día del
 * apunte es la que debe leerse siempre.
 */
export interface ManualAdjustmentRow {
  id: string;
  /** `YYYY-MM`. */
  period: string;
  /** `YYYY-MM`. */
  requestedPeriod: string;
  label: string;
  reason: string;
  /** Con signo: positivo suma, negativo resta. */
  amountCents: string;
  addsToPay: boolean;
  deferralNote: string;
  status: 'recorded' | 'voided';
  voidReason: string | null;
}

/**
 * Quién apuntó la jornada. Viaja con el hecho hasta la pantalla porque no es lo
 * mismo que una jornada la anote la empleada a que se la apunte la familia: el
 * expediente tiene que decir de dónde salió cada línea.
 */
export type ExtraWorkOrigin =
  | 'employee_report'
  | 'family_request'
  | 'weekly_report'
  | 'system_import';

export interface ResolvedExtraWorkRow {
  id: string;
  kind: 'overtime' | 'worked_rest_day';
  /** Nombre del concepto catalogado; null en el histórico anterior a 0021. */
  typeName: string | null;
  workedOn: string;
  durationMinutes: number;
  note: string;
  origin: ExtraWorkOrigin;
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
  /** Nombre del concepto catalogado; null en el histórico anterior a 0021. */
  typeName: string | null;
  workedOn: string;
  durationMinutes: number;
  note: string;
  origin: ExtraWorkOrigin;
  status: PendingExtraWorkStatus;
  employeeMembershipId: string;
}

/**
 * Acuerdo del hogar tal y como sale de Postgres. `employeeName` es null cuando
 * la RLS no deja leer el perfil de esa persona (solo quien administra los ve
 * todos); la vista pone entonces una etiqueta neutra, nunca un hueco.
 */
export interface AgreementRow {
  id: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
  employeeMembershipId: string;
  employeeName: string | null;
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

export interface ExtraWorkTypeView {
  id: string;
  code: string;
  name: string;
  unit: ExtraWorkUnit;
  /** «por hora», «por jornada», «importe fijo». */
  unitLabel: string;
  rateCents: string | null;
  /** null cuando el concepto aún no tiene tarifa: no hay precio que enseñar. */
  rateLabel: string | null;
  referenceMinutes: number | null;
  /** «jornada de 10 h», null si el concepto no pacta duración. */
  referenceLabel: string | null;
  active: boolean;
  /** Activo y con tarifa: es lo que la empleada puede ver y registrar. */
  available: boolean;
}

export interface SupplementView {
  id: string;
  code: string;
  name: string;
  amountCents: string | null;
  amountLabel: string | null;
  /** true: suma a la transferencia. false: lo paga la casa aparte. */
  addsToPay: boolean;
  active: boolean;
  startsOn: string | null;
  endsOn: string | null;
  /** «desde el 1 sep 2026», «hasta el 31 dic 2026», null si rige toda la versión. */
  validityLabel: string | null;
}

/** Un día de la semana ya resuelto contra la jornada tipo. */
export interface ScheduleDayView {
  weekday: number;
  /** «Lunes», «Sábado». */
  weekdayLabel: string;
  works: boolean;
  startsAt: string | null;
  endsAt: string | null;
  longBreakMinutes: number;
  /** «hora y media»; null los días de libranza o sin descanso pactado. */
  breakLabel: string | null;
  effectiveMinutes: number;
  /** «8:00 a 16:30» o «Libra». */
  hoursLabel: string;
  /**
   * La línea entera de ese día: horas, descanso y nota, ya cosidas. Se arma
   * aquí y no en la plantilla porque los separadores entre trozos opcionales
   * son justo lo que Svelte se come al recortar el espacio en blanco de un
   * bloque `{#if}`.
   */
  detailLabel: string;
  /** Minutos efectivos en palabras: «7 h», «5 h», «—» si libra. */
  effectiveLabel: string;
  /** true si este día NO es la jornada tipo. */
  differs: boolean;
  note: string;
}

/**
 * El horario de una versión, listo para pintar.
 *
 * Que este objeto sea `null` en `AgreementTermsView` es el «si aplica» del
 * encargo llegando hasta la plantilla: sin horario pactado no hay fila en
 * Postgres, no hay vista, y la página no enseña ni sección vacía ni guiones.
 */
export interface ScheduleView {
  id: string;
  /**
   * El horario en una frase de castellano llano. Es lo único que la empleada
   * necesita leer; la tabla día a día es para quien administra.
   */
  sentence: string;
  startsAt: string;
  endsAt: string;
  /** «De 8:00 a 16:30». */
  spanLabel: string;
  longBreakMinutes: number;
  /** «hora y media», null si no se pactó descanso. */
  breakLabel: string | null;
  note: string;
  /** Los siete días resueltos, de lunes a domingo. */
  days: ScheduleDayView[];
  /** «Domingo», «Sábado y domingo»; vacío si no se declara ninguna libranza. */
  restDayLabels: string[];
  weeklyMinutes: number;
  /** «40 h a la semana». */
  weeklyLabel: string;
  contractedWeeklyMinutes: number;
  contractedLabel: string;
  matchesContract: boolean;
  /**
   * null cuando cuadra. Cuando no, la frase que lo dice sin rodeos: callarlo
   * sería dejar que dos condiciones del mismo contrato se contradigan en
   * silencio.
   */
  mismatchLabel: string | null;
}

/**
 * Las condiciones de contrato en lenguaje llano: lo que la empleada tiene que
 * poder leer sin preguntar. Se construye SIEMPRE desde las filas que la RLS
 * devolvió, nunca filtrando en la plantilla.
 */
export interface AgreementTermsView {
  versionId: string;
  versionNumber: number;
  effectiveFromLabel: string;
  salaryLabel: string;
  weeklyHoursLabel: string;
  vacationDaysLabel: string;
  /** Trabajo extra que puede hacer, con su tarifa. Vacío = no puede hacer ninguno. */
  extraWorkTypes: ExtraWorkTypeView[];
  /** Complementos que le suman al mes. */
  paidSupplements: SupplementView[];
  /** Complementos que la casa paga por su cuenta; constan, no se transfieren. */
  householdPaidSupplements: SupplementView[];
  /** null = este contrato no declara horario; no hay sección que enseñar. */
  schedule: ScheduleView | null;
}

export interface AgreementVersionView {
  id: string;
  versionNumber: number;
  effectiveFrom: string;
  effectiveFromLabel: string;
  effectiveTo: string | null;
  monthlySalaryCents: string;
  salaryLabel: string;
  /**
   * Conceptos catalogados en esta versión. Vienen de las filas que la RLS dejó
   * salir, así que para la empleada solo contienen lo que le aplica: si en esta
   * versión no se le permiten horas, la lista no trae ninguna tarifa horaria.
   */
  concepts: ExtraWorkTypeView[];
  supplements: SupplementView[];
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
  /**
   * De dónde salió la jornada extra que produjo esta línea; null en el resto de
   * líneas (salario, anticipos, gastos), que no tienen a quién atribuir.
   */
  originLabel: string | null;
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
  /**
   * Lo que la casa abona por ella fuera de la transferencia. Va aparte de
   * `lines` a propósito: ningún total lo incluye y la plantilla no puede
   * sumarlo por descuido.
   */
  householdPaidSupplements: { id: string; label: string; amountLabel: string }[];
  /**
   * Conceptos apuntados a mano que NO mueven la transferencia. Mismo trato y
   * mismo motivo que `householdPaidSupplements`: fuera de `lines` para que
   * ningún total pueda sumarlos por descuido, pero a la vista, porque forman
   * parte de lo que se decidió sobre este mes.
   */
  notedAdjustments: { id: string; label: string; reason: string; amountLabel: string }[];
}

/**
 * Un concepto apuntado a mano, listo para pintar en su lista. Lleva ya
 * resueltas las dos frases que la interfaz no debería componer por su cuenta:
 * a qué mes va y por qué no fue al que se pidió.
 */
export interface ManualAdjustmentView {
  id: string;
  period: string;
  /** «Abril 2026». */
  periodLabel: string;
  label: string;
  reason: string;
  amountCents: string;
  /** Con signo siempre: «+150,00 €» / «−50,00 €». */
  amountLabel: string;
  addsToPay: boolean;
  /** «Se suma a la transferencia» / «Consta, no se transfiere». */
  transferLabel: string;
  /** Frase congelada del aplazamiento, o cadena vacía si cayó en su mes. */
  deferralNote: string;
  voided: boolean;
  voidReason: string | null;
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
  origin: ExtraWorkOrigin;
  /** «La apuntó la familia», «La apuntó la empleada»… Nunca vacío. */
  originLabel: string;
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

/**
 * Una persona empleada entre las que el hogar puede tener a la vez. Es lo que
 * se pinta en el selector de quien administra: nombre, si el acuerdo sigue vivo
 * y desde cuándo. No lleva ni un importe: elegir a quién se mira no es todavía
 * mirar sus cuentas.
 */
export interface AgreementOptionView {
  id: string;
  employeeMembershipId: string;
  /** Nombre del perfil, o «Empleada del hogar» si la RLS no dejó leerlo. */
  employeeLabel: string;
  status: string;
  active: boolean;
  startsOn: string;
  endsOn: string | null;
  /** «Desde el 3 feb 2025» o «Del 3 feb 2025 al 1 jul 2026». */
  periodLabel: string;
}

export interface EmploymentOverview {
  householdId: string;
  hasEmploymentData: boolean;
  agreement: AgreementRow | null;
  /**
   * Todos los acuerdos que quien mira puede ver, para poder elegir de quién es
   * el expediente. A la empleada la RLS solo le devuelve el suyo, así que su
   * lista tiene exactamente un elemento y no hay nada que elegir.
   */
  agreements: AgreementOptionView[];
  versions: AgreementVersionView[];
  /**
   * Condiciones de la versión vigente hoy, en lenguaje llano. null si no hay
   * ninguna vigente o si RLS no dejó ver ninguna versión.
   */
  terms: AgreementTermsView | null;
  /**
   * Conceptos con los que se puede registrar trabajo extra HOY. Para la
   * empleada son exactamente los que le aplican, porque la RLS no le devolvió
   * los demás; vacío = no se le permite registrar ninguno.
   */
  registrableTypes: ExtraWorkTypeView[];
  accrual: AccrualView | null;
  settlements: SettlementView[];
  pendingExtras: PendingExtraWorkView[];
  pendingExpenses: PendingExpenseView[];
  /** Vacaciones del año natural en curso; null si no hay acuerdo visible. */
  vacations: VacationView | null;
  /**
   * Conceptos apuntados a mano, del mes más reciente al más antiguo, con los
   * anulados incluidos: la lista es el rastro, no el resultado. La RLS de 0022
   * la enseña a quien administra y a la propia empleada; a nadie más le llega
   * ninguna fila.
   */
  manualAdjustments: ManualAdjustmentView[];
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

/**
 * Origen del hecho en lenguaje de casa. Se dice en tercera persona («la
 * empleada», «la familia») porque la misma frase la leen las dos partes: quien
 * administra tiene que ver quién apuntó cada jornada y ella tiene que ver
 * cuáles le apuntaron sin haberlas pedido.
 */
const EXTRA_WORK_ORIGIN_LABELS: Record<ExtraWorkOrigin, string> = {
  employee_report: 'La apuntó la empleada',
  family_request: 'La apuntó la familia',
  weekly_report: 'Viene del parte semanal',
  system_import: 'Viene de una importación'
};

export function extraWorkOriginLabel(origin: ExtraWorkOrigin | null | undefined): string {
  return (origin && EXTRA_WORK_ORIGIN_LABELS[origin]) || 'Origen sin registrar';
}

const BALANCE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Vacaciones',
  extra_time: 'Horas por compensar',
  worked_rest_day: 'Descanso compensatorio'
};

// Exportados a propósito: el documento de pago en PDF imprime los MISMOS
// nombres que la pantalla, y una tercera copia de esta tabla ya divergió una
// vez (la del exportador solo conocía dos métodos).
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bank_transfer: 'Transferencia',
  cash: 'Efectivo',
  bizum: 'Bizum',
  mixed: 'Mixto',
  other: 'Otro'
};

export const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  open: 'Abierta',
  closed: 'Cerrada',
  void: 'Anulada'
};

/**
 * Dónde vive cada origen ahora que la sección va en pestañas. Las rellena el
 * servidor, que sabe el hogar y quién mira: `contrato` es el acuerdo para
 * quien administra y las condiciones para la empleada, porque cada cual lee
 * las versiones en su propia pestaña.
 */
export interface SourceHrefBases {
  /** Ruta de la pestaña Conceptos (jornadas, gastos y conceptos a mano). */
  conceptos: string;
  /** Ruta del Resumen: los anticipos viven en sus saldos. */
  resumen: string;
  /** Donde quien mira lee las versiones del contrato. */
  contrato: string;
}

/**
 * Ancla navegable hacia la entidad de origen. Sin `bases` es un fragmento en
 * la misma página (lo que era cuando todo vivía en una); con `bases`, la ruta
 * de la pestaña donde la entidad está pintada, con el ancla detrás. Hueco
 * conocido: aún no existen rutas de detalle por entidad.
 */
export function sourceAnchor(
  sourceType: string,
  sourceId: string,
  bases?: SourceHrefBases
): string | null {
  switch (sourceType) {
    case 'agreement-version':
      return `${bases?.contrato ?? ''}#version-${sourceId}`;
    // Una jornada o un gasto de la CUENTA ya está resuelto, y Conceptos solo
    // pinta pendientes: su sitio es la propia línea del Resumen, que lleva el
    // ancla. Los pendientes llegan a Conceptos por los avisos de Hoy, no por
    // aquí.
    case 'jornadas-extra':
      return `${bases?.resumen ?? ''}#extra-${sourceId}`;
    case 'anticipos':
      return `${bases?.resumen ?? ''}#anticipo-${sourceId}`;
    case 'gastos':
      return `${bases?.resumen ?? ''}#gasto-${sourceId}`;
    // Los conceptos a mano sí viven enteros en Conceptos: la tarjeta lista
    // también los ya apuntados, con su ancla `concepto-…`.
    case 'ajustes':
      return `${bases?.conceptos ?? ''}#concepto-${sourceId}`;
    default:
      return null;
  }
}

const UNIT_LABELS: Record<ExtraWorkUnit, string> = {
  per_hour: 'por hora trabajada',
  per_shift: 'por jornada',
  fixed_amount: 'un importe fijo cada vez'
};

/**
 * Etiqueta de tarifa según la unidad, para que nadie tenga que interpretar un
 * número suelto: «14,00 €/h» no es lo mismo que «50,00 € por jornada».
 * Devuelve null si no hay tarifa: un concepto sin precio no enseña ninguno.
 */
export function buildExtraWorkTypeView(row: ExtraWorkTypeRow): ExtraWorkTypeView {
  const rateLabel =
    row.rateCents === null
      ? null
      : row.unit === 'per_hour'
        ? `${formatCents(row.rateCents)}/h`
        : row.unit === 'per_shift'
          ? `${formatCents(row.rateCents)} por jornada`
          : `${formatCents(row.rateCents)} cada vez`;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    unit: row.unit,
    unitLabel: UNIT_LABELS[row.unit],
    rateCents: row.rateCents,
    rateLabel,
    referenceMinutes: row.referenceMinutes,
    // Solo la jornada anuncia su duración pactada. En un importe fijo la
    // duración no decide el importe, y enseñarla invitaría a creer que sí.
    referenceLabel:
      row.unit === 'per_shift' && row.referenceMinutes !== null
        ? `jornada de ${formatMinutes(row.referenceMinutes)}`
        : null,
    active: row.active,
    available: row.active && row.rateCents !== null
  };
}

export function buildSupplementView(row: RecurringSupplementRow): SupplementView {
  const from = row.startsOn === null ? null : `desde el ${dateLabel(row.startsOn)}`;
  const to = row.endsOn === null ? null : `hasta el ${dateLabel(row.endsOn)}`;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    amountCents: row.amountCents,
    amountLabel: row.amountCents === null ? null : `${formatCents(row.amountCents)} al mes`,
    addsToPay: row.addsToPay,
    active: row.active,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    validityLabel: from && to ? `${from} ${to}` : (from ?? to)
  };
}

/** «40 h a la semana», «37 h 30 min a la semana». */
export function weeklyHoursLabel(minutes: number): string {
  const hours = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h${rest > 0 ? ` ${rest} min` : ''} a la semana`;
}

/** «7 h», «7 h 30 min», «30 min». Sin la coletilla semanal, para una celda. */
export function hoursLabel(minutes: number): string {
  const hours = Math.trunc(Math.abs(minutes) / 60);
  const rest = Math.abs(minutes) % 60;
  if (hours === 0) return `${rest} min`;
  return `${hours} h${rest > 0 ? ` ${rest} min` : ''}`;
}

/**
 * La frase que denuncia que el horario y la jornada contratada no dicen lo
 * mismo, o null si cuadran.
 *
 * Vive aquí y no en la plantilla porque la escriben DOS sitios: el servidor,
 * al pintar una versión guardada, y el editor de administración, mientras se
 * teclea. Si cada uno la redactara por su cuenta, la misma incoherencia se
 * contaría con dos números distintos según dónde se mirara — que es exactamente
 * lo que pasó la primera vez que se escribió dos veces.
 */
export function scheduleMismatchLabel(
  weeklyMinutes: number,
  contractedWeeklyMinutes: number
): string | null {
  const difference = weeklyMinutes - contractedWeeklyMinutes;
  if (difference === 0) return null;
  return (
    `El horario suma ${hoursLabel(weeklyMinutes)} a la semana y la jornada contratada ` +
    `dice ${hoursLabel(contractedWeeklyMinutes)}: ` +
    `${difference > 0 ? 'sobran' : 'faltan'} ${hoursLabel(difference)}.`
  );
}

/**
 * El horario de una versión, resuelto y redactado.
 *
 * La frase y los minutos salen del motor puro (`@casa-clara/domain`), no de
 * aquí: son las mismas reglas que aplican el guion de alta y las pruebas, y
 * reescribirlas en la capa de vista sería tener dos horarios distintos según
 * quién los mire.
 *
 * La comparación con la jornada contratada se calcula SIEMPRE, cuadre o no. No
 * hay tolerancia: los dos lados son minutos enteros, así que cualquier
 * diferencia es real y merece decirse.
 */
export function buildScheduleView(input: {
  schedule: ScheduleRow;
  days: readonly ScheduleDayRow[];
  contractedWeeklyMinutes: number;
}): ScheduleView {
  const mine = input.days
    .filter((row) => row.scheduleId === input.schedule.id)
    .map(
      (row): DomainScheduleDay => ({
        weekday: row.weekday as Weekday,
        works: row.works,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        longBreakMinutes: row.longBreakMinutes,
        note: row.note
      })
    );
  const pure: AgreementSchedule = {
    startsAt: input.schedule.startsAt,
    endsAt: input.schedule.endsAt,
    longBreakMinutes: input.schedule.longBreakMinutes,
    note: input.schedule.note,
    days: mine
  };

  const week = resolveWeek(pure);
  const coherence = scheduleCoherence(pure, input.contractedWeeklyMinutes);
  /** «lunes» → «Lunes»: el motor puro los dice en minúscula, en mitad de frase. */
  const dayLabel = (weekday: Weekday): string => {
    const name = weekdayName(weekday);
    return `${name[0]!.toLocaleUpperCase('es')}${name.slice(1)}`;
  };

  return {
    id: input.schedule.id,
    sentence: describeSchedule(pure),
    startsAt: input.schedule.startsAt,
    endsAt: input.schedule.endsAt,
    spanLabel: `De ${spokenTime(input.schedule.startsAt)} a ${spokenTime(input.schedule.endsAt)}`,
    longBreakMinutes: input.schedule.longBreakMinutes,
    breakLabel:
      input.schedule.longBreakMinutes > 0 ? spokenDuration(input.schedule.longBreakMinutes) : null,
    note: input.schedule.note,
    days: week.map((day) => ({
      weekday: day.weekday,
      weekdayLabel: dayLabel(day.weekday),
      works: day.works,
      startsAt: day.startsAt,
      endsAt: day.endsAt,
      longBreakMinutes: day.longBreakMinutes,
      breakLabel:
        day.works && day.longBreakMinutes > 0 ? spokenDuration(day.longBreakMinutes) : null,
      effectiveMinutes: day.effectiveMinutes,
      hoursLabel: day.works
        ? `${spokenTime(day.startsAt!)} a ${spokenTime(day.endsAt!)}`
        : 'Libra',
      detailLabel: [
        day.works ? `${spokenTime(day.startsAt!)} a ${spokenTime(day.endsAt!)}` : 'Libra',
        day.works && day.longBreakMinutes > 0
          ? `${spokenDuration(day.longBreakMinutes)} de descanso`
          : null,
        day.note === '' ? null : day.note
      ]
        .filter((piece): piece is string => piece !== null)
        .join(' · '),
      effectiveLabel: day.works ? hoursLabel(day.effectiveMinutes) : '—',
      differs: day.differs,
      note: day.note
    })),
    restDayLabels: week
      .filter((day) => !day.works)
      .map((day) => dayLabel(day.weekday)),
    weeklyMinutes: coherence.weeklyMinutes,
    weeklyLabel: weeklyHoursLabel(coherence.weeklyMinutes),
    contractedWeeklyMinutes: coherence.contractedWeeklyMinutes,
    contractedLabel: weeklyHoursLabel(coherence.contractedWeeklyMinutes),
    matchesContract: coherence.matches,
    mismatchLabel: scheduleMismatchLabel(
      coherence.weeklyMinutes,
      coherence.contractedWeeklyMinutes
    )
  };
}

/**
 * Condiciones de la versión indicada. Lo que llega aquí ya pasó por la RLS: si
 * la persona que preguntó es la empleada, `types` no contiene los conceptos
 * desactivados ni los que no tienen tarifa, y por tanto tampoco los contiene el
 * objeto que se serializa hacia el navegador.
 */
export function buildAgreementTermsView(input: {
  version: AgreementVersionRow;
  types: readonly ExtraWorkTypeRow[];
  supplements: readonly RecurringSupplementRow[];
  schedules?: readonly ScheduleRow[];
  scheduleDays?: readonly ScheduleDayRow[];
}): AgreementTermsView {
  const mine = input.types
    .filter((row) => row.agreementVersionId === input.version.id)
    .map(buildExtraWorkTypeView)
    .filter((view) => view.available);
  const supplements = input.supplements
    .filter((row) => row.agreementVersionId === input.version.id && row.active)
    .map(buildSupplementView)
    .filter((view) => view.amountLabel !== null);
  return {
    versionId: input.version.id,
    versionNumber: input.version.versionNumber,
    effectiveFromLabel: dateLabel(input.version.effectiveFrom),
    salaryLabel: formatCents(input.version.monthlySalaryCents),
    // Una jornada semanal se cuenta en horas, no en días: «1 día 16 h» es
    // aritméticamente cierto y no significa nada para quien la trabaja.
    weeklyHoursLabel: weeklyHoursLabel(input.version.contractedWeeklyMinutes),
    vacationDaysLabel: `${input.version.annualVacationDays} ${
      input.version.annualVacationDays === 1 ? 'día natural' : 'días naturales'
    } al año`,
    extraWorkTypes: mine,
    paidSupplements: supplements.filter((view) => view.addsToPay),
    householdPaidSupplements: supplements.filter((view) => !view.addsToPay),
    // Sin fila de horario en esta versión no hay vista, y sin vista la página
    // no enseña sección. El «si aplica» viaja como null desde Postgres hasta la
    // plantilla sin que nadie tenga que acordarse de comprobarlo dos veces.
    schedule: (() => {
      const row = (input.schedules ?? []).find(
        (candidate) => candidate.agreementVersionId === input.version.id
      );
      return row
        ? buildScheduleView({
            schedule: row,
            days: input.scheduleDays ?? [],
            contractedWeeklyMinutes: input.version.contractedWeeklyMinutes
          })
        : null;
    })()
  };
}

/**
 * Las personas que el hogar emplea, en el orden en que llegan de Postgres
 * (activo primero). El nombre puede faltar por RLS —quien no administra no lee
 * el perfil de los demás—; en ese caso se dice «Empleada del hogar» en vez de
 * dejar un hueco o, peor, inventar un identificador en pantalla.
 */
export function buildAgreementOptionViews(
  rows: readonly AgreementRow[]
): AgreementOptionView[] {
  return rows.map((row) => ({
    id: row.id,
    employeeMembershipId: row.employeeMembershipId,
    employeeLabel: row.employeeName?.trim() || 'Empleada del hogar',
    status: row.status,
    active: row.status === 'active',
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    periodLabel:
      row.endsOn === null
        ? `Desde el ${dateLabel(row.startsOn)}`
        : `Del ${dateLabel(row.startsOn)} al ${dateLabel(row.endsOn)}`
  }));
}

export function buildAgreementVersionViews(
  rows: readonly AgreementVersionRow[],
  onDate: string,
  types: readonly ExtraWorkTypeRow[] = [],
  supplements: readonly RecurringSupplementRow[] = []
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
      concepts: types
        .filter((type) => type.agreementVersionId === row.id)
        .map(buildExtraWorkTypeView),
      supplements: supplements
        .filter((supplement) => supplement.agreementVersionId === row.id)
        .map(buildSupplementView),
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
  // El motivo de un concepto apuntado a mano viaja en `note`, aparte de la
  // etiqueta, precisamente para poder enseñarlo como explicación de la línea en
  // vez de pegarlo al título con dos puntos.
  if (line.note) return line.note;
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
  /** Complementos de la versión vigente el primer día del periodo. */
  supplements?: readonly RecurringSupplementRow[];
  /**
   * Conceptos apuntados a mano IMPUTADOS a este mes y sin anular. Se filtran
   * por el mes que decidió quien los apuntó, no por ninguna fecha de hecho:
   * eso es exactamente lo que significa «que se contabilicen el mes que toque».
   */
  adjustments?: readonly ManualAdjustmentRow[];
  /** Sin bases, los orígenes enlazan como fragmento en la misma página. */
  hrefBases?: SourceHrefBases;
}

/**
 * Proyección del devengo del periodo en curso con los hechos reales del mes.
 * Devuelve null cuando ninguna versión del acuerdo está vigente en el periodo
 * (por ejemplo, un acuerdo que empieza el mes que viene).
 */
export function buildAccrual(facts: AccrualFacts): AccrualView | null {
  if (facts.versions.length === 0) return null;

  const extraWork: SettledExtraWork[] = facts.extras.map((row) => {
    const concept = row.typeName ?? EXTRA_WORK_LABELS[row.kind];
    return {
    id: row.id,
    workedOn: row.workedOn,
    label: row.note.trim() ? `${concept} · ${row.note.trim()}` : concept,
    resolution: row.resolution,
    quantityLabel: formatMinutes(row.durationMinutes),
    frozenUnitRateCents: parseCents(row.frozenUnitRateCents),
    frozenAmountCents: parseCents(row.frozenAmountCents),
    permanentCreditMinutes: row.resolution === 'time_off' ? (row.balanceMinutes ?? 0) : 0
    };
  });

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
      adjustments: (facts.adjustments ?? [])
        .filter((row) => row.status === 'recorded')
        .map((row) => ({
          id: row.id,
          label: row.label,
          reason: row.reason,
          amountCents: parseCents(row.amountCents),
          addsToPay: row.addsToPay
        })),
      expenses,
      supplements: (facts.supplements ?? []).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        amountCents: row.amountCents === null ? null : parseCents(row.amountCents),
        periodicity: row.periodicity,
        addsToPay: row.addsToPay,
        startsOn: row.startsOn,
        endsOn: row.endsOn,
        active: row.active
      }))
    });
  } catch (cause) {
    if (cause instanceof RangeError) return null;
    throw cause;
  }

  // El origen se recupera del hecho, no de la línea: el motor de dominio
  // calcula dinero y no tiene por qué saber quién apuntó la jornada.
  const originByExtraId = new Map(facts.extras.map((row) => [row.id, row.origin]));

  const lines: AccrualLineView[] = projection.lines.map((line) => {
    const anchorId =
      line.sourceType === 'jornadas-extra'
        ? `extra-${line.sourceId}`
        : line.sourceType === 'gastos'
          ? `gasto-${line.sourceId}`
          : line.sourceType === 'ajustes'
            ? `linea-concepto-${line.sourceId}`
            : null;
    const origin =
      line.sourceType === 'jornadas-extra' ? originByExtraId.get(line.sourceId) : undefined;
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
      href: sourceAnchor(line.sourceType, line.sourceId, facts.hrefBases),
      originLabel: origin === undefined ? null : extraWorkOriginLabel(origin)
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
    permanentCreditMinutes: projection.permanentCreditMinutes,
    householdPaidSupplements: projection.householdPaidSupplements.map((item) => ({
      id: item.id,
      label: item.label,
      amountLabel: formatCents(item.amountCents)
    })),
    notedAdjustments: projection.notedAdjustments.map((item) => ({
      id: item.id,
      label: item.label,
      reason: item.reason,
      amountLabel: formatCents(item.amountCents, { signed: true })
    }))
  };
}

const TRANSFER_LABELS = {
  adds: 'Se suma a la transferencia',
  noted: 'Consta, no se transfiere'
} as const;

/**
 * Lista de conceptos apuntados a mano, del mes más reciente al más antiguo.
 * Los anulados vienen dentro, no fuera: la corrección es parte del rastro y
 * esconderla convertiría la lista en un resumen, que es justo lo contrario de
 * lo que un expediente append-only promete.
 */
export function buildManualAdjustmentViews(
  rows: readonly ManualAdjustmentRow[]
): ManualAdjustmentView[] {
  return [...rows]
    .sort((left, right) => right.period.localeCompare(left.period))
    .map((row) => ({
      id: row.id,
      period: row.period,
      periodLabel: periodLabel(row.period),
      label: row.label,
      reason: row.reason,
      amountCents: row.amountCents,
      amountLabel: formatCents(row.amountCents, { signed: true }),
      addsToPay: row.addsToPay,
      transferLabel: row.addsToPay ? TRANSFER_LABELS.adds : TRANSFER_LABELS.noted,
      deferralNote: row.deferralNote,
      voided: row.status === 'voided',
      voidReason: row.voidReason
    }));
}

export function settlementLineHref(
  row: SettlementLineRow,
  bases?: SourceHrefBases
): string | null {
  if (row.agreementVersionId) return sourceAnchor('agreement-version', row.agreementVersionId, bases);
  if (row.advanceId) return sourceAnchor('anticipos', row.advanceId, bases);
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
  expensesWithReceipt: ReadonlySet<string> = new Set(),
  hrefBases?: SourceHrefBases
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
        href: settlementLineHref(line, hrefBases),
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
    // El nombre del catálogo manda: una noche de guardia no es «Festivo o
    // descanso trabajado» por mucho que su clasificación gruesa lo sea.
    kindLabel: row.typeName ?? EXTRA_WORK_LABELS[row.kind],
    workedOn: row.workedOn,
    workedOnLabel: dateLabel(row.workedOn),
    durationMinutes: row.durationMinutes,
    durationLabel: formatMinutes(row.durationMinutes),
    note: row.note,
    origin: row.origin,
    originLabel: extraWorkOriginLabel(row.origin),
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

/**
 * Rango de un periodo, sin repetir lo que ya se ha dicho: «Del 2 al 8 nov
 * 2026» dentro del mismo mes, «Del 20 nov al 5 dic 2026» dentro del mismo año,
 * y con los dos años completos solo cuando el periodo cruza el fin de año. Un
 * día suelto se dice «El 3 ago 2026».
 */
export function vacationRangeLabel(startsOn: string, endsOn: string): string {
  if (startsOn === endsOn) return `El ${dateLabel(startsOn)}`;
  const sameYear = startsOn.slice(0, 4) === endsOn.slice(0, 4);
  const sameMonth = sameYear && startsOn.slice(5, 7) === endsOn.slice(5, 7);
  if (sameMonth) return `Del ${Number(startsOn.slice(8, 10))} al ${dateLabel(endsOn)}`;
  if (sameYear) {
    // dateLabel devuelve «20 nov 2026»; aquí sobra el año del primer extremo.
    const from = dateLabel(startsOn).replace(/ \d{4}$/, '');
    return `Del ${from} al ${dateLabel(endsOn)}`;
  }
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
