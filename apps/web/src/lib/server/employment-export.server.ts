import { createHash } from 'node:crypto';

import type { Pool } from 'pg';
import { strToU8, zipSync } from 'fflate';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { AuthorizationError, createLogger, withAuthorizedTransaction } from '@casa-clara/server';

import {
  buildExtraWorkTypeView,
  buildScheduleView,
  buildSupplementView,
  type AdvanceRow,
  type AgreementVersionRow,
  type CompensationBalanceRow,
  type ExtraWorkTypeRow,
  type PaymentRow,
  type RecurringSupplementRow,
  type ScheduleDayRow,
  type ScheduleRow,
  type SettlementLineRow,
  type SettlementRow,
  type WeeklyReportRow
} from '$lib/employment/model';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:employment-export');

export const EMPLOYMENT_EXPORT_VERSION = 1;

// --- Formateo CSV (RFC 4180) -------------------------------------------------

/**
 * Campo CSV según RFC 4180: se entrecomilla solo cuando contiene coma, comillas
 * o saltos de línea; las comillas internas se duplican. null/undefined → campo
 * vacío.
 */
export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'boolean' ? (value ? 'si' : 'no') : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Documento CSV completo: cabecera + filas, separador coma y finales CRLF. */
export function buildCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[]
): string {
  const lines = [header, ...rows].map((row) => row.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Céntimos como decimal con punto ("145330" → "1453.30", "-10000" → "-100.00"). */
export function centsToDecimal(value: string): string {
  if (!/^-?(0|[1-9]\d*)$/.test(value)) throw new TypeError(`Importe en céntimos inválido: ${value}`);
  const cents = BigInt(value);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** Céntimos como etiqueta legible ASCII-segura para el PDF ("145330" → "1.453,30 EUR"). */
function euroLabel(value: string): string {
  const cents = BigInt(value);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const euros = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${euros},${String(abs % 100n).padStart(2, '0')} EUR`;
}

// --- Traducciones de estados -------------------------------------------------

const SETTLEMENT_STATUS: Record<string, string> = {
  open: 'abierta',
  closed: 'cerrada',
  void: 'anulada'
};

const REPORT_STATUS: Record<string, string> = {
  draft: 'borrador',
  submitted: 'enviada',
  confirmed: 'confirmada',
  disputed: 'en_disputa'
};

const EXTRA_STATUS: Record<string, string> = {
  requested: 'solicitada',
  accepted: 'aceptada',
  performed: 'realizada',
  performed_pending_resolution: 'realizada_sin_aceptacion',
  resolved: 'resuelta',
  rejected: 'rechazada'
};

const EXTRA_KIND: Record<string, string> = {
  overtime: 'horas_extra',
  worked_rest_day: 'descanso_trabajado'
};

const RESOLUTION: Record<string, string> = {
  money: 'dinero',
  time_off: 'descanso'
};

const EXPENSE_STATUS: Record<string, string> = {
  pending: 'pendiente',
  approved: 'aprobado',
  rejected: 'rechazado'
};

const PAYMENT_METHOD: Record<string, string> = {
  bank_transfer: 'transferencia',
  cash: 'efectivo'
};

const PAYMENT_STATUS: Record<string, string> = {
  recorded: 'registrado',
  voided: 'anulado'
};

const BALANCE_TYPE: Record<string, string> = {
  worked_rest_day: 'descanso_trabajado'
};

const label = (table: Record<string, string>, value: string): string => table[value] ?? value;

// --- Filas específicas de la exportación -------------------------------------

interface AgreementExportRow {
  id: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
}

interface ExtraWorkExportRow {
  id: string;
  kind: string;
  workedOn: string;
  durationMinutes: number;
  note: string;
  status: string;
  resolution: string | null;
  frozenUnitRateCents: string | null;
  frozenAmountCents: string | null;
  balanceMinutes: number | null;
}

interface ExpenseExportRow {
  id: string;
  incurredOn: string;
  description: string;
  status: string;
  amountCents: string;
  settlementId: string | null;
}

interface PaymentExportRow extends PaymentRow {
  status: string;
}

// --- CSVs --------------------------------------------------------------------

function settlementsCsv(
  settlements: readonly SettlementRow[],
  lines: readonly SettlementLineRow[]
): string {
  const header = [
    'liquidacion_id',
    'periodo_inicio',
    'periodo_fin',
    'vencimiento',
    'estado',
    'cobro_confirmado_en',
    'nota_cobro',
    'tipo',
    'numero_linea',
    'seccion',
    'clase',
    'fecha',
    'concepto',
    'importe_eur',
    'importe_centimos',
    'version_acuerdo_id',
    'jornada_extra_id',
    'anticipo_id',
    'gasto_id'
  ];
  const rows: (string | number | null)[][] = [];
  for (const settlement of settlements) {
    const base = [
      settlement.id,
      settlement.periodStart,
      settlement.periodEnd,
      settlement.dueOn,
      label(SETTLEMENT_STATUS, settlement.status),
      settlement.receiptConfirmedAt,
      settlement.receiptNote
    ];
    for (const line of lines.filter((row) => row.settlementId === settlement.id)) {
      rows.push([
        ...base,
        'linea',
        line.lineNumber,
        line.section === 'salary' ? 'salario' : 'reembolso',
        line.kind,
        line.occurredOn,
        line.concept,
        centsToDecimal(line.amountCents),
        line.amountCents,
        line.agreementVersionId,
        line.extraWorkEventId,
        line.advanceId,
        line.expenseId
      ]);
    }
    const total = (tipo: string, concepto: string, cents: string): (string | number | null)[] => [
      ...base,
      tipo,
      null,
      null,
      null,
      null,
      concepto,
      centsToDecimal(cents),
      cents,
      null,
      null,
      null,
      null
    ];
    rows.push(total('total_salario', 'Total salarial del periodo', settlement.salaryTotalCents));
    rows.push(total('total_reembolsos', 'Total de reembolsos', settlement.reimbursementTotalCents));
    rows.push(total('total_transferencia', 'Total a transferir', settlement.transferTotalCents));
    rows.push(total('total_pagado', 'Total pagado', settlement.paidCents));
    rows.push(total('total_pendiente', 'Pendiente de pago', settlement.pendingCents));
  }
  return buildCsv(header, rows);
}

function paymentsCsv(payments: readonly PaymentExportRow[], settlements: readonly SettlementRow[]): string {
  const byId = new Map(settlements.map((settlement) => [settlement.id, settlement]));
  return buildCsv(
    ['pago_id', 'liquidacion_id', 'periodo_inicio', 'periodo_fin', 'fecha_valor', 'metodo', 'referencia', 'estado', 'importe_eur', 'importe_centimos'],
    payments.map((payment) => {
      const settlement = byId.get(payment.settlementId);
      return [
        payment.id,
        payment.settlementId,
        settlement?.periodStart ?? null,
        settlement?.periodEnd ?? null,
        payment.valueOn,
        label(PAYMENT_METHOD, payment.method),
        payment.reference,
        label(PAYMENT_STATUS, payment.status),
        centsToDecimal(payment.amountCents),
        payment.amountCents
      ];
    })
  );
}

function extrasCsv(extras: readonly ExtraWorkExportRow[]): string {
  return buildCsv(
    [
      'jornada_id',
      'tipo',
      'fecha',
      'duracion_minutos',
      'estado',
      'resolucion',
      'tarifa_congelada_eur',
      'tarifa_congelada_centimos',
      'importe_congelado_eur',
      'importe_congelado_centimos',
      'minutos_compensados',
      'nota'
    ],
    extras.map((extra) => [
      extra.id,
      label(EXTRA_KIND, extra.kind),
      extra.workedOn,
      extra.durationMinutes,
      label(EXTRA_STATUS, extra.status),
      extra.resolution === null ? null : label(RESOLUTION, extra.resolution),
      extra.frozenUnitRateCents === null ? null : centsToDecimal(extra.frozenUnitRateCents),
      extra.frozenUnitRateCents,
      extra.frozenAmountCents === null ? null : centsToDecimal(extra.frozenAmountCents),
      extra.frozenAmountCents,
      extra.balanceMinutes,
      extra.note
    ])
  );
}

function reportsCsv(reports: readonly WeeklyReportRow[]): string {
  return buildCsv(
    ['parte_id', 'semana_inicio', 'semana_fin', 'estado', 'auto_confirmado', 'motivo_disputa'],
    reports.map((report) => [
      report.id,
      report.weekStartsOn,
      report.weekEndsOn,
      label(REPORT_STATUS, report.status),
      report.autoConfirmed,
      report.disputeReason
    ])
  );
}

function expensesCsv(expenses: readonly ExpenseExportRow[]): string {
  return buildCsv(
    ['gasto_id', 'fecha', 'descripcion', 'estado', 'importe_eur', 'importe_centimos', 'liquidacion_id'],
    expenses.map((expense) => [
      expense.id,
      expense.incurredOn,
      expense.description,
      label(EXPENSE_STATUS, expense.status),
      centsToDecimal(expense.amountCents),
      expense.amountCents,
      expense.settlementId
    ])
  );
}

function balancesCsv(
  compensation: readonly CompensationBalanceRow[],
  advances: readonly AdvanceRow[]
): string {
  const rows: (string | number | null)[][] = [];
  for (const balance of compensation) {
    rows.push([
      'compensacion_permanente',
      balance.accountId,
      label(BALANCE_TYPE, balance.balanceType),
      null,
      String(balance.balanceMinutes),
      null,
      null,
      null,
      null
    ]);
  }
  for (const advance of advances) {
    rows.push([
      'anticipo',
      advance.id,
      `Anticipo del ${advance.issuedOn} (cuota ${centsToDecimal(advance.repaymentCents)})`,
      advance.issuedOn,
      null,
      centsToDecimal(advance.principalCents),
      advance.principalCents,
      centsToDecimal(advance.outstandingCents),
      advance.outstandingCents
    ]);
  }
  return buildCsv(
    ['tipo', 'referencia_id', 'detalle', 'fecha', 'minutos', 'principal_eur', 'principal_centimos', 'pendiente_eur', 'pendiente_centimos'],
    rows
  );
}

// --- PDF de resumen ----------------------------------------------------------

interface SummaryInput {
  householdName: string;
  employeeName: string;
  generatedAt: Date;
  currentVersion: AgreementVersionRow | null;
  /**
   * Conceptos vigentes tal como la RLS se los devolvió a QUIEN exporta. La
   * empleada se descarga su propio expediente: si aquí se imprimieran las
   * columnas reliquia de 0002, su PDF llevaría una tarifa horaria que en su
   * acuerdo está desactivada. Se imprime el catálogo o no se imprime nada.
   */
  currentTypes: readonly ExtraWorkTypeRow[];
  currentSupplements: readonly RecurringSupplementRow[];
  /** Horario de la versión vigente, o null si el contrato no declara ninguno. */
  currentSchedule: ScheduleRow | null;
  currentScheduleDays: readonly ScheduleDayRow[];
  agreement: AgreementExportRow | null;
  settlements: readonly SettlementRow[];
  compensation: readonly CompensationBalanceRow[];
  advances: readonly AdvanceRow[];
}

/**
 * Resumen determinista con pdf-lib (patrón exacto de renderReceiptPdf en el
 * worker): metadatos fijados, fechas de creación/modificación = generatedAt y
 * sin object streams; el mismo instante produce siempre los mismos bytes.
 */
async function renderSummaryPdf(input: SummaryInput): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle('Mi expediente laboral');
  document.setAuthor(input.householdName);
  document.setCreator('Gestión del personal doméstico (web)');
  document.setProducer('Gestión del personal doméstico (web)');
  document.setCreationDate(input.generatedAt);
  document.setModificationDate(input.generatedAt);

  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const page = document.addPage([595.28, 841.89]);
  const { height } = page.getSize();
  let y = height - 54;

  // Membrete: la casa que emite el documento, no el nombre del proyecto.
  page.drawText(input.householdName.toLocaleUpperCase('es'), {
    x: 48,
    y,
    size: 11,
    font: bold,
    color: rgb(0.08, 0.32, 0.27)
  });
  y -= 30;
  page.drawText('Mi expediente laboral', { x: 48, y, size: 19, font: bold });
  y -= 22;
  page.drawText(input.employeeName, { x: 48, y, size: 10, font: regular });
  y -= 28;
  page.drawText('Documento doméstico no oficial', {
    x: 48,
    y,
    size: 10,
    font: bold,
    color: rgb(0.64, 0.28, 0.06)
  });
  y -= 34;

  const heading = (text: string): void => {
    page.drawText(text, { x: 48, y, size: 12, font: bold });
    y -= 20;
  };
  const row = (concept: string, value: string): void => {
    page.drawText(concept.slice(0, 64), { x: 48, y, size: 10, font: regular });
    page.drawText(value.slice(0, 32), { x: 400, y, size: 10, font: bold });
    y -= 16;
  };

  heading('Contrato vigente');
  if (input.agreement && input.currentVersion) {
    row('Inicio del contrato', input.agreement.startsOn);
    row('Salario mensual', euroLabel(input.currentVersion.monthlySalaryCents));
    row('Jornada semanal contratada', `${input.currentVersion.contractedWeeklyMinutes} min`);
    row('Vacaciones al año', `${input.currentVersion.annualVacationDays} días naturales`);
    // El horario, si el contrato lo declara. Si no, no se imprime una línea con
    // un guion: la ausencia de horario pactado se dice callando, igual que en
    // pantalla.
    if (input.currentSchedule) {
      const schedule = buildScheduleView({
        schedule: input.currentSchedule,
        days: input.currentScheduleDays,
        contractedWeeklyMinutes: input.currentVersion.contractedWeeklyMinutes
      });
      // `row` recorta el valor a 32 caracteres, y la frase del horario es más
      // larga: va como texto corrido, en su propia línea.
      page.drawText('Horario', { x: 48, y, size: 10, font: regular });
      y -= 14;
      page.drawText(schedule.sentence.slice(0, 96), { x: 60, y, size: 9, font: bold });
      y -= 16;
      if (schedule.mismatchLabel) {
        page.drawText(schedule.mismatchLabel.slice(0, 110), {
          x: 60,
          y,
          size: 8,
          font: regular,
          color: rgb(0.64, 0.28, 0.06)
        });
        y -= 16;
      }
    }
    for (const type of input.currentTypes) {
      const view = buildExtraWorkTypeView(type);
      if (!view.available || view.rateLabel === null) continue;
      row(view.name, view.rateLabel);
    }
    for (const supplement of input.currentSupplements) {
      const view = buildSupplementView(supplement);
      if (!view.active || view.amountLabel === null) continue;
      row(
        view.addsToPay ? view.name : `${view.name} (lo paga la casa)`,
        view.amountLabel
      );
    }
  } else {
    page.drawText('Sin contrato vigente visible.', { x: 48, y, size: 10, font: regular });
    y -= 16;
  }
  y -= 14;

  heading('Liquidaciones');
  if (input.settlements.length === 0) {
    page.drawText('Sin liquidaciones registradas.', { x: 48, y, size: 10, font: regular });
    y -= 16;
  }
  for (const settlement of input.settlements.slice(0, 18)) {
    const state = label(SETTLEMENT_STATUS, settlement.status);
    const confirmed = settlement.receiptConfirmedAt ? 'cobro confirmado' : 'cobro sin confirmar';
    row(`${settlement.periodStart} a ${settlement.periodEnd} · ${state} · ${confirmed}`, euroLabel(settlement.transferTotalCents));
  }
  y -= 14;

  heading('Saldos actuales');
  for (const balance of input.compensation) {
    row(`Compensación permanente (${label(BALANCE_TYPE, balance.balanceType)})`, `${balance.balanceMinutes} min`);
  }
  for (const advance of input.advances) {
    row(`Anticipo del ${advance.issuedOn} · pendiente`, euroLabel(advance.outstandingCents));
  }
  if (input.compensation.length === 0 && input.advances.length === 0) {
    page.drawText('Sin saldos pendientes.', { x: 48, y, size: 10, font: regular });
    y -= 16;
  }

  page.drawText(`Generado: ${input.generatedAt.toISOString()}`, { x: 48, y: 43, size: 8, font: regular });

  return document.save({ addDefaultPage: false, objectsPerTick: Number.POSITIVE_INFINITY, useObjectStreams: false });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// --- Exportación -------------------------------------------------------------

/**
 * Expediente laboral de la propia empleada (AC-13) como ZIP determinista.
 *
 * SOLO employee_live_in y solo sobre SU membresía: cualquier otro rol recibe
 * null y toda lectura corre bajo la sesión RLS de la empleada, restringida
 * además a los acuerdos cuyo employee_membership_id es su propia membresía. El
 * paquete contiene seis CSV (RFC 4180, cabeceras en español, importes en euros
 * con punto decimal y columna aparte en céntimos), un resumen en PDF rotulado
 * «Documento doméstico no oficial» y un manifest con el sha-256 de cada fichero
 * más un hash global (patrón del traspaso operativo).
 *
 * Determinismo: entradas ordenadas por nombre, mtime fijo 1980-01-01 y
 * `generatedAt` inyectable; dos builds con el mismo instante producen bytes
 * idénticos, PDF incluido.
 */
export async function buildEmploymentExport(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  generatedAt: Date = new Date()
): Promise<Uint8Array | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      if (membership.role !== 'employee_live_in') {
        throw new AuthorizationError('El expediente solo puede exportarlo la propia empleada');
      }

      const household = await client.query<{ name: string }>(
        'select display_name as "name" from app.households where id = $1',
        [householdId]
      );
      const profile = await client.query<{ name: string }>(
        'select display_name as "name" from app.user_profiles where user_id = $1',
        [user.id]
      );

      // Solo los acuerdos de SU propia membresía: el filtro replica lo que RLS
      // ya garantiza y deja la intención escrita en la consulta.
      const agreements = await client.query<AgreementExportRow>(
        `select id,
                status::text as "status",
                starts_on::text as "startsOn",
                ends_on::text as "endsOn"
           from app.employment_agreements
          where household_id = $1 and employee_membership_id = $2
          order by starts_on`,
        [householdId, membership.id]
      );
      const agreementIds = agreements.rows.map((row) => row.id);

      const empty = { rows: [] };
      const versions = agreementIds.length
        ? await client.query<AgreementVersionRow>(
            `select id,
                    version_number as "versionNumber",
                    effective_from::text as "effectiveFrom",
                    monthly_salary_cents as "monthlySalaryCents",
                    contracted_weekly_minutes as "contractedWeeklyMinutes",
                    annual_vacation_days as "annualVacationDays",
                    reason
               from app.agreement_versions
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by effective_from, version_number`,
            [householdId, agreementIds]
          )
        : empty;

      const extraWorkTypes = agreementIds.length
        ? await client.query<ExtraWorkTypeRow>(
            `select id,
                    agreement_version_id as "agreementVersionId",
                    code, name, unit::text as "unit",
                    rate_cents::text as "rateCents",
                    reference_minutes as "referenceMinutes",
                    active
               from app.extra_work_types
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by sort_order, code`,
            [householdId, agreementIds]
          )
        : empty;

      const supplements = agreementIds.length
        ? await client.query<RecurringSupplementRow>(
            `select id,
                    agreement_version_id as "agreementVersionId",
                    code, name,
                    amount_cents::text as "amountCents",
                    periodicity::text as "periodicity",
                    adds_to_pay as "addsToPay",
                    starts_on::text as "startsOn",
                    ends_on::text as "endsOn",
                    active
               from app.recurring_supplements
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by sort_order, code`,
            [householdId, agreementIds]
          )
        : empty;

      // Horario pactado (0025). Va en el expediente por lo mismo que el salario:
      // es una condición del contrato, y una copia de su expediente que no diga
      // a qué hora entra y sale no es una copia completa.
      const schedules = agreementIds.length
        ? await client.query<ScheduleRow>(
            `select id,
                    agreement_version_id as "agreementVersionId",
                    to_char(starts_at, 'HH24:MI') as "startsAt",
                    to_char(ends_at, 'HH24:MI') as "endsAt",
                    long_break_minutes as "longBreakMinutes",
                    note
               from app.agreement_schedules
              where household_id = $1 and agreement_id = any($2::uuid[])`,
            [householdId, agreementIds]
          )
        : empty;

      const scheduleDays = agreementIds.length
        ? await client.query<ScheduleDayRow>(
            `select id,
                    schedule_id as "scheduleId",
                    weekday, works,
                    to_char(starts_at, 'HH24:MI') as "startsAt",
                    to_char(ends_at, 'HH24:MI') as "endsAt",
                    long_break_minutes as "longBreakMinutes",
                    note
               from app.agreement_schedule_days
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by weekday`,
            [householdId, agreementIds]
          )
        : empty;

      const reports = agreementIds.length
        ? await client.query<WeeklyReportRow>(
            `select id,
                    week_starts_on::text as "weekStartsOn",
                    week_ends_on::text as "weekEndsOn",
                    status::text as "status",
                    auto_confirmed as "autoConfirmed",
                    dispute_reason as "disputeReason"
               from app.weekly_time_reports
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by week_starts_on, id`,
            [householdId, agreementIds]
          )
        : empty;

      const extras = agreementIds.length
        ? await client.query<ExtraWorkExportRow>(
            `select id,
                    kind::text as "kind",
                    worked_on::text as "workedOn",
                    duration_minutes as "durationMinutes",
                    note,
                    status::text as "status",
                    resolution::text as "resolution",
                    frozen_unit_rate_cents as "frozenUnitRateCents",
                    frozen_amount_cents as "frozenAmountCents",
                    balance_minutes as "balanceMinutes"
               from app.extra_work_events
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by worked_on, requested_at, id`,
            [householdId, agreementIds]
          )
        : empty;

      const expenses = agreementIds.length
        ? await client.query<ExpenseExportRow>(
            `select expense.id,
                    expense.incurred_on::text as "incurredOn",
                    expense.description,
                    expense.status::text as "status",
                    expense.amount_cents as "amountCents",
                    line.settlement_id as "settlementId"
               from app.expenses as expense
               left join app.settlement_lines as line
                 on line.household_id = expense.household_id
                and line.expense_id = expense.id
              where expense.household_id = $1 and expense.agreement_id = any($2::uuid[])
              order by expense.incurred_on, expense.submitted_at, expense.id`,
            [householdId, agreementIds]
          )
        : empty;

      const settlements = agreementIds.length
        ? await client.query<SettlementRow>(
            `select settlement.id,
                    settlement.period_start::text as "periodStart",
                    settlement.period_end::text as "periodEnd",
                    settlement.due_on::text as "dueOn",
                    settlement.status::text as "status",
                    settlement.salary_total_cents as "salaryTotalCents",
                    settlement.reimbursement_total_cents as "reimbursementTotalCents",
                    settlement.transfer_total_cents as "transferTotalCents",
                    totals.paid_cents as "paidCents",
                    totals.pending_cents as "pendingCents",
                    confirmation.confirmed_at::text as "receiptConfirmedAt",
                    confirmation.note as "receiptNote"
               from app.settlements as settlement
               join app.settlement_payment_totals as totals
                 on totals.household_id = settlement.household_id
                and totals.settlement_id = settlement.id
               left join app.settlement_receipt_confirmations as confirmation
                 on confirmation.household_id = settlement.household_id
                and confirmation.settlement_id = settlement.id
              where settlement.household_id = $1 and settlement.agreement_id = any($2::uuid[])
              order by settlement.period_start, settlement.id`,
            [householdId, agreementIds]
          )
        : empty;

      const settlementIds = settlements.rows.map((row) => row.id);
      const lines = settlementIds.length
        ? await client.query<SettlementLineRow>(
            `select line.settlement_id as "settlementId",
                    line.line_number as "lineNumber",
                    line.section::text as "section",
                    line.kind::text as "kind",
                    line.occurred_on::text as "occurredOn",
                    line.concept,
                    line.amount_cents as "amountCents",
                    line.agreement_version_id as "agreementVersionId",
                    line.extra_work_event_id as "extraWorkEventId",
                    ledger.advance_id as "advanceId",
                    line.expense_id as "expenseId"
               from app.settlement_lines as line
               left join app.advance_ledger_entries as ledger
                 on ledger.household_id = line.household_id
                and ledger.id = line.advance_ledger_entry_id
              where line.household_id = $1 and line.settlement_id = any($2::uuid[])
              order by line.settlement_id, line.line_number`,
            [householdId, settlementIds]
          )
        : empty;

      const payments = settlementIds.length
        ? await client.query<PaymentExportRow>(
            `select id,
                    settlement_id as "settlementId",
                    amount_cents as "amountCents",
                    method::text as "method",
                    status::text as "status",
                    value_on::text as "valueOn",
                    reference
               from app.payments
              where household_id = $1 and settlement_id = any($2::uuid[])
              order by value_on, recorded_at, id`,
            [householdId, settlementIds]
          )
        : empty;

      const compensation = agreementIds.length
        ? await client.query<CompensationBalanceRow>(
            `select account_id as "accountId",
                    balance_type::text as "balanceType",
                    balance_minutes as "balanceMinutes"
               from app.compensation_balances
              where household_id = $1 and agreement_id = any($2::uuid[])
              order by balance_type, account_id`,
            [householdId, agreementIds]
          )
        : empty;

      const advances = agreementIds.length
        ? await client.query<AdvanceRow>(
            `select advance.id,
                    advance.status::text as "status",
                    advance.issued_on::text as "issuedOn",
                    advance.principal_cents as "principalCents",
                    advance.repayment_cents as "repaymentCents",
                    balance.outstanding_cents as "outstandingCents"
               from app.advances as advance
               join app.advance_balances as balance
                 on balance.household_id = advance.household_id
                and balance.advance_id = advance.id
              where advance.household_id = $1 and advance.agreement_id = any($2::uuid[])
              order by advance.issued_on, advance.id`,
            [householdId, agreementIds]
          )
        : empty;

      // Contrato y versión vigentes en el instante de generación (para el PDF).
      const activeAgreement =
        agreements.rows.find((row) => row.status === 'active') ?? agreements.rows.at(-1) ?? null;
      const today = generatedAt.toISOString().slice(0, 10);
      const currentVersion =
        versions.rows.filter((version) => version.effectiveFrom <= today).at(-1) ??
        versions.rows[0] ??
        null;

      const files = new Map<string, Uint8Array>();
      files.set('liquidaciones.csv', strToU8(settlementsCsv(settlements.rows, lines.rows)));
      files.set('pagos.csv', strToU8(paymentsCsv(payments.rows, settlements.rows)));
      files.set('jornadas-extra.csv', strToU8(extrasCsv(extras.rows)));
      files.set('partes-semanales.csv', strToU8(reportsCsv(reports.rows)));
      files.set('gastos.csv', strToU8(expensesCsv(expenses.rows)));
      files.set('saldos.csv', strToU8(balancesCsv(compensation.rows, advances.rows)));
      files.set(
        'resumen.pdf',
        await renderSummaryPdf({
          householdName: household.rows[0]?.name ?? 'Hogar',
          employeeName: profile.rows[0]?.name ?? 'Empleada',
          generatedAt,
          currentVersion,
          currentTypes: currentVersion
            ? extraWorkTypes.rows.filter(
                (row) => row.agreementVersionId === currentVersion.id
              )
            : [],
          currentSupplements: currentVersion
            ? supplements.rows.filter((row) => row.agreementVersionId === currentVersion.id)
            : [],
          currentSchedule: currentVersion
            ? (schedules.rows.find((row) => row.agreementVersionId === currentVersion.id) ?? null)
            : null,
          currentScheduleDays: scheduleDays.rows,
          agreement: activeAgreement,
          settlements: settlements.rows,
          compensation: compensation.rows,
          advances: advances.rows
        })
      );

      const sortedPaths = [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'));
      const fileHashes = sortedPaths.map((path) => ({ path, sha256: sha256(files.get(path)!) }));
      const filesHash = sha256(strToU8(fileHashes.map((file) => `${file.path}\n${file.sha256}\n`).join('')));

      const manifest = {
        version: EMPLOYMENT_EXPORT_VERSION,
        household: { name: household.rows[0]?.name ?? 'Hogar' },
        employee: { name: profile.rows[0]?.name ?? 'Empleada' },
        generatedAt: generatedAt.toISOString(),
        files: fileHashes,
        filesHash
      };
      files.set('manifest.json', strToU8(`${JSON.stringify(manifest, null, 2)}\n`));

      const entries: Record<string, Uint8Array> = {};
      for (const path of [...files.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
        entries[path] = files.get(path)!;
      }
      return zipSync(entries, { level: 6, mtime: new Date('1980-01-01T00:00:00.000Z') });
    });
  } catch (cause) {
    // Sin esta separación, una avería contestaba «solo la propia empleada
    // puede descargar su expediente» a la propia empleada.
    return unreadable(log, 'employment export', cause);
  }
}
