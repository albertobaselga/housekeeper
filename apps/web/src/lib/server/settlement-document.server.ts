import type { Pool } from 'pg';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { createLogger, withAuthorizedTransaction } from '@housekeeper/server';

import {
  buildSupplementView,
  PAYMENT_METHOD_LABELS,
  SETTLEMENT_STATUS_LABELS,
  type AgreementVersionRow,
  type PaymentRow,
  type RecurringSupplementRow,
  type SettlementLineRow,
  type SettlementRow
} from '$lib/employment/model';
import { euroLabel, monthTitle, pdfSafe } from './employment-export.server';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:settlement-document');

/**
 * El documento de pago de UNA cuenta, generado al momento con los mismos datos
 * que la pestaña Pagos: todas las líneas (las que suman y las que restan), lo
 * que consta sin transferirse, los pagos registrados y el estado del cobro.
 *
 * Quién puede pedirlo lo decide la RLS, no esta capa: la lectura corre bajo la
 * sesión de quien lo pide y, sin fila de liquidación, se devuelve null —404,
 * sin distinguir «no existe» de «no te toca», como los justificantes—. El
 * recibo que archiva el worker al cerrar sigue siendo el documento canónico de
 * archivo; este es la vista imprimible, disponible también para cuentas
 * abiertas.
 */
export interface SettlementDocument {
  pdf: Uint8Array;
  filename: string;
}

interface NotedConcept {
  concept: string;
  amountCents: string;
  note: string;
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const LEFT = 48;
const RIGHT = 547;
const CONTENT_FLOOR = 76;

interface DocumentInput {
  householdName: string;
  employeeName: string;
  generatedAt: Date;
  settlement: SettlementRow;
  lines: readonly SettlementLineRow[];
  payments: readonly PaymentRow[];
  noted: readonly NotedConcept[];
}

/** Misma receta determinista que el resumen del expediente (A4, Helvetica). */
async function renderSettlementPdf(input: DocumentInput): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.setTitle(`Documento de pago · ${monthTitle(input.settlement.periodStart)}`);
  document.setAuthor(input.householdName);
  document.setCreator('Gestión del personal doméstico (web)');
  document.setProducer('Gestión del personal doméstico (web)');
  document.setCreationDate(input.generatedAt);
  document.setModificationDate(input.generatedAt);

  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);

  let page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - 54;

  const ensure = (space: number): void => {
    if (y - space >= CONTENT_FLOOR) return;
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - 54;
  };

  const write = (
    text: string,
    options: { x?: number; size?: number; strong?: boolean; color?: ReturnType<typeof rgb> } = {}
  ): void => {
    page.drawText(pdfSafe(text), {
      x: options.x ?? LEFT,
      y,
      size: options.size ?? 10,
      font: options.strong ? bold : regular,
      ...(options.color ? { color: options.color } : {})
    });
  };

  const money = (
    concept: string,
    amount: string,
    options: { x?: number; size?: number; strong?: boolean; color?: ReturnType<typeof rgb> } = {}
  ): void => {
    const size = options.size ?? 10;
    const font = options.strong ? bold : regular;
    const safeAmount = pdfSafe(amount);
    write(concept, options);
    page.drawText(safeAmount, {
      x: RIGHT - font.widthOfTextAtSize(safeAmount, size),
      y,
      size,
      font,
      ...(options.color ? { color: options.color } : {})
    });
  };

  const { settlement } = input;
  // El mismo diccionario que la pantalla, en minúscula porque va dentro de frase.
  const state = (SETTLEMENT_STATUS_LABELS[settlement.status] ?? settlement.status).toLocaleLowerCase('es');
  const collected = settlement.receiptConfirmedAt ? 'cobro confirmado' : 'cobro sin confirmar';

  // Membrete: la casa que emite el documento, no el nombre del proyecto.
  write(input.householdName.toLocaleUpperCase('es'), {
    size: 11,
    strong: true,
    color: rgb(0.08, 0.32, 0.27)
  });
  y -= 30;
  write(`Documento de pago · ${monthTitle(settlement.periodStart)}`, { size: 19, strong: true });
  y -= 22;
  write(input.employeeName);
  y -= 16;
  write(
    `del ${settlement.periodStart} al ${settlement.periodEnd} · vence el ${settlement.dueOn} · cuenta ${state} · ${collected}`,
    { size: 8, color: rgb(0.35, 0.35, 0.35) }
  );
  y -= 20;
  write('Documento doméstico no oficial', {
    strong: true,
    color: rgb(0.64, 0.28, 0.06)
  });
  y -= 30;

  if (input.lines.length === 0) {
    ensure(18);
    write(
      settlement.status === 'open'
        ? 'Mes sin cerrar: los conceptos se fijan al cerrarlo.'
        : 'Sin conceptos registrados en este mes.',
      { x: 56, size: 9 }
    );
    y -= 18;
  } else {
    ensure(20);
    write('Conceptos del mes', { size: 12, strong: true });
    y -= 18;
    for (const line of input.lines) {
      ensure(15);
      money(`${line.concept} · ${line.occurredOn}`, euroLabel(line.amountCents), { x: 56, size: 9 });
      y -= 15;
    }

    ensure(66);
    page.drawLine({ start: { x: 56, y: y + 6 }, end: { x: RIGHT, y: y + 6 }, thickness: 0.5 });
    y -= 6;
    money('Salario del mes', euroLabel(settlement.salaryTotalCents), { x: 56, size: 9 });
    y -= 14;
    money('Reembolso de gastos', euroLabel(settlement.reimbursementTotalCents), { x: 56, size: 9 });
    y -= 16;
    money('Total a transferir', euroLabel(settlement.transferTotalCents), {
      x: 56,
      size: 11,
      strong: true
    });
    y -= 14;
    write(
      `Pagado ${euroLabel(settlement.paidCents)} · pendiente ${euroLabel(settlement.pendingCents)}`,
      { x: 56, size: 8, color: rgb(0.35, 0.35, 0.35) }
    );
    y -= 16;

    // Que cuadre no es una aspiración: se comprueba. Si las líneas y el total
    // congelado dejaran de coincidir, el documento lo DICE.
    const printed = input.lines.reduce((total, line) => total + BigInt(line.amountCents), 0n);
    if (printed !== BigInt(settlement.transferTotalCents)) {
      ensure(16);
      write(
        `Aviso: las líneas de arriba suman ${euroLabel(printed.toString())} y el total congelado es ${euroLabel(settlement.transferTotalCents)}. Consúltalo con quien administra la casa.`,
        { x: 56, size: 8, color: rgb(0.64, 0.28, 0.06) }
      );
      y -= 16;
    }
  }

  // Aparte de las líneas, como en el motor: para que sea imposible sumarlo por
  // descuido. Pero TIENE que salir: un concepto que existe y no aparece
  // convierte el documento en una discusión.
  if (input.noted.length > 0) {
    ensure(18);
    write('Consta en este mes y NO entra en la transferencia:', { x: 56, size: 9, strong: true });
    y -= 14;
    for (const concept of input.noted) {
      ensure(26);
      money(concept.concept, euroLabel(concept.amountCents), { x: 64, size: 9 });
      y -= 11;
      write(concept.note, { x: 64, size: 8, color: rgb(0.35, 0.35, 0.35) });
      y -= 15;
    }
  }

  y -= 6;
  ensure(20);
  write('Pagos registrados', { size: 12, strong: true });
  y -= 18;
  if (input.payments.length === 0) {
    ensure(15);
    write('Todavía no consta ningún pago de esta cuenta.', { x: 56, size: 9 });
    y -= 15;
  } else {
    for (const payment of input.payments) {
      ensure(15);
      money(
        `${PAYMENT_METHOD_LABELS[payment.method] ?? payment.method} · ${payment.valueOn}${payment.reference ? ` · ${payment.reference}` : ''}`,
        euroLabel(payment.amountCents),
        { x: 56, size: 9 }
      );
      y -= 15;
    }
  }

  y -= 8;
  ensure(15);
  // Sin recortar el instante a fecha: `confirmed_at` es un timestamptz que
  // Postgres serializa en la zona de la sesión, y quedarse con los diez
  // primeros caracteres puede decir «el día anterior» para una confirmación
  // de madrugada. El hecho (confirmado o no) es lo que este documento afirma.
  write(
    settlement.receiptConfirmedAt
      ? `Cobro confirmado por la empleada${settlement.receiptNote ? ` · ${settlement.receiptNote}` : '.'}`
      : 'La empleada aún no ha confirmado el cobro.',
    { x: 56, size: 9 }
  );

  // Pie en cada página, después de saber cuántas hay. El instante va entero y
  // con su Z, como en el expediente: una fecha pelada mentiría una hora al día
  // de cada lado de la medianoche de Madrid.
  const pages = document.getPages();
  for (const [index, sheet] of pages.entries()) {
    sheet.drawText(
      pdfSafe(
        `Documento doméstico no oficial · generado ${input.generatedAt.toISOString()} · página ${index + 1} de ${pages.length}`
      ),
      { x: LEFT, y: 52, size: 8, font: regular, color: rgb(0.35, 0.35, 0.35) }
    );
  }

  return document.save({ useObjectStreams: false });
}

/**
 * Carga la cuenta bajo la sesión RLS de quien pide y devuelve el PDF, o null
 * si la RLS no le enseña esa liquidación (o no existe: no se distingue).
 */
export async function buildSettlementDocument(
  user: { id: string },
  householdId: string,
  settlementId: string,
  pool: Pool | null = getDatabasePool(),
  generatedAt: Date = new Date()
): Promise<SettlementDocument | null> {
  if (!pool) return null;
  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const settlements = await client.query<SettlementRow & { agreementId: string }>(
        `select settlement.id,
                settlement.agreement_id as "agreementId",
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
          where settlement.household_id = $1 and settlement.id = $2`,
        [householdId, settlementId]
      );
      const settlement = settlements.rows[0];
      if (!settlement) return null;

      const household = await client.query<{ name: string }>(
        'select display_name as "name" from app.households where id = $1',
        [householdId]
      );

      // El nombre sale del perfil de la persona empleada; si la RLS no deja
      // verlo, la etiqueta neutra de siempre en su lugar.
      const profile = await client.query<{ name: string | null }>(
        `select profile.display_name as "name"
           from app.employment_agreements as agreement
           left join app.household_memberships as membership
             on membership.household_id = agreement.household_id
            and membership.id = agreement.employee_membership_id
           left join app.user_profiles as profile
             on profile.user_id = membership.user_id
          where agreement.household_id = $1 and agreement.id = $2`,
        [householdId, settlement.agreementId]
      );

      const lines = await client.query<SettlementLineRow>(
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
          where line.household_id = $1 and line.settlement_id = $2
          order by line.line_number`,
        [householdId, settlementId]
      );

      const payments = await client.query<PaymentRow>(
        `select id,
                settlement_id as "settlementId",
                amount_cents as "amountCents",
                method::text as "method",
                value_on::text as "valueOn",
                reference
           from app.payments
          where household_id = $1 and settlement_id = $2
            and status = 'recorded'
          order by value_on, recorded_at, id`,
        [householdId, settlementId]
      );

      // Lo que consta sin transferirse, reconstruido desde los hechos como en
      // el expediente: la liquidación nunca lo materializó como fila porque el
      // motor lo aparta antes (packages/domain/src/settlement.ts).
      const versions = await client.query<AgreementVersionRow>(
        `select id,
                version_number as "versionNumber",
                effective_from::text as "effectiveFrom",
                monthly_salary_cents as "monthlySalaryCents",
                contracted_weekly_minutes as "contractedWeeklyMinutes",
                annual_vacation_days as "annualVacationDays",
                reason
           from app.agreement_versions
          where household_id = $1 and agreement_id = $2
          order by effective_from, version_number`,
        [householdId, settlement.agreementId]
      );
      const supplements = await client.query<RecurringSupplementRow>(
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
          where household_id = $1 and agreement_id = $2
          order by sort_order, code`,
        [householdId, settlement.agreementId]
      );
      const adjustments = await client.query<{
        label: string;
        reason: string;
        amountCents: string;
      }>(
        `select label, reason, amount_cents::text as "amountCents"
           from app.manual_adjustments
          where household_id = $1 and agreement_id = $2
            and status = 'recorded' and adds_to_pay = false
            and period_month = date_trunc('month', $3::date)::date
          order by recorded_at, id`,
        [householdId, settlement.agreementId, settlement.periodStart]
      );

      const noted: NotedConcept[] = [];
      const version =
        versions.rows.filter((row) => row.effectiveFrom <= settlement.periodStart).at(-1) ?? null;
      if (version) {
        for (const row of supplements.rows) {
          if (row.agreementVersionId !== version.id) continue;
          const view = buildSupplementView(row);
          if (view.addsToPay || !view.active || view.amountCents === null) continue;
          if (view.startsOn !== null && view.startsOn > settlement.periodEnd) continue;
          if (view.endsOn !== null && view.endsOn < settlement.periodStart) continue;
          noted.push({
            concept: view.name,
            amountCents: view.amountCents,
            note: 'lo paga la casa aparte; no entra en la transferencia'
          });
        }
      }
      for (const adjustment of adjustments.rows) {
        noted.push({
          concept: `${adjustment.label} · ${adjustment.reason}`,
          amountCents: adjustment.amountCents,
          note: 'consta en el expediente; no entra en la transferencia'
        });
      }

      const pdf = await renderSettlementPdf({
        householdName: household.rows[0]?.name ?? 'La casa',
        employeeName: profile.rows[0]?.name ?? 'La empleada',
        generatedAt,
        settlement,
        lines: lines.rows,
        payments: payments.rows,
        noted
      });

      return {
        pdf,
        filename: `pago-${settlement.periodStart.slice(0, 7)}.pdf`
      };
    });
  } catch (cause) {
    return unreadable(log, 'settlement document', cause);
  }
}
