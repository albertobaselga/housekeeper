import type { PoolClient } from "pg";

import type { UUID } from "@casa-clara/contracts";
import { settlementCommandPayloadSchema } from "@casa-clara/contracts/schemas";
import {
  calculateSettlement,
  type SettledExtraWork,
  type MonetaryInput,
} from "@casa-clara/domain";

import { canonicalSha256 } from "../canonical-json.js";
import type { ActiveMembership } from "../database.js";
import { CommandRejectedError, type CommandHandler } from "../sync.js";
import { loadAgreementVersions, requireAgreement } from "./shared.js";

interface OpenPayload {
  agreementId: UUID;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
}

interface ClosePayload {
  settlementId: UUID;
}

interface ConfirmReceiptPayload {
  settlementId: UUID;
  note?: string | undefined;
}

function monthBounds(period: string): { first: string; last: string } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(lastDay).padStart(2, "0")}` };
}

async function openSettlement(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: OpenPayload,
): Promise<{ resourceId: UUID }> {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora abre liquidaciones");
  }
  if (payload.periodEnd < payload.periodStart || payload.dueOn < payload.periodEnd) {
    throw new CommandRejectedError("invalid_payload", "El periodo o el vencimiento no son coherentes");
  }
  const agreement = await requireAgreement(client, householdId, payload.agreementId);

  const inserted = await client.query<{ id: string }>(
    `insert into app.settlements
       (household_id, agreement_id, employee_membership_id, period_start, period_end,
        due_on, status, created_by_membership_id)
     values ($1, $2, $3, $4, $5, $6, 'open', $7)
     returning id`,
    [
      householdId,
      payload.agreementId,
      agreement.employeeMembershipId,
      payload.periodStart,
      payload.periodEnd,
      payload.dueOn,
      membership.id,
    ],
  );
  const settlementId = inserted.rows[0]?.id;
  if (!settlementId) throw new Error("La inserción de la liquidación no devolvió identificador");
  return { resourceId: settlementId };
}

interface SettlementLineRow {
  lineNumber: number;
  section: "salary" | "reimbursement";
  kind:
    | "base_salary"
    | "extra_work"
    | "time_off_compensation"
    | "advance_deduction"
    | "expense_reimbursement";
  occurredOn: string;
  concept: string;
  amountCents: bigint;
  agreementVersionId: UUID | null;
  extraWorkEventId: UUID | null;
  advanceLedgerEntryId: UUID | null;
  expenseId: UUID | null;
  provenance: Record<string, unknown>;
}

async function closeSettlement(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: ClosePayload,
): Promise<{ resourceId: UUID }> {
  if (membership.role !== "family_admin") {
    throw new CommandRejectedError("not_allowed", "Solo la familia administradora cierra liquidaciones");
  }

  const loaded = await client.query<{
    id: string;
    agreement_id: string;
    employee_membership_id: string;
    period_start: string;
    period_end: string;
    status: string;
  }>(
    `select id, agreement_id, employee_membership_id,
            period_start::text as period_start, period_end::text as period_end, status
       from app.settlements
      where household_id = $1 and id = $2
      for update`,
    [householdId, payload.settlementId],
  );
  const settlement = loaded.rows[0];
  if (!settlement) {
    throw new CommandRejectedError("settlement_not_found", "La liquidación no existe en este hogar");
  }
  if (settlement.status !== "open") {
    throw new CommandRejectedError("settlement_not_open", "Solo una liquidación abierta puede cerrarse");
  }

  // El motor puro liquida meses naturales (YYYY-MM); un periodo que no coincida
  // exactamente con el mes no puede congelarse con `calculateSettlement`.
  const period = settlement.period_start.slice(0, 7);
  const bounds = monthBounds(period);
  if (settlement.period_start !== bounds.first || settlement.period_end !== bounds.last) {
    throw new CommandRejectedError("unsupported_period", "El cierre requiere un periodo de mes natural");
  }

  const versions = await loadAgreementVersions(client, householdId, settlement.agreement_id);

  // Hechos REALES del periodo, leídos bajo RLS dentro de la misma transacción.
  const extraRows = await client.query<{
    id: string;
    kind: "overtime" | "worked_rest_day";
    worked_on: string;
    duration_minutes: number;
    resolution: "money" | "time_off";
    frozen_unit_rate_cents: string;
    frozen_amount_cents: string;
    balance_minutes: number;
  }>(
    `select id, kind, worked_on::text as worked_on, duration_minutes, resolution,
            frozen_unit_rate_cents::text as frozen_unit_rate_cents,
            frozen_amount_cents::text as frozen_amount_cents, balance_minutes
       from app.extra_work_events
      where household_id = $1 and agreement_id = $2 and status = 'resolved'
        and worked_on between $3 and $4
      order by worked_on, id`,
    [householdId, settlement.agreement_id, settlement.period_start, settlement.period_end],
  );
  const extraWork: SettledExtraWork[] = extraRows.rows.map((row) => ({
    id: row.id,
    workedOn: row.worked_on,
    label:
      row.kind === "overtime"
        ? `Horas extra del ${row.worked_on}`
        : `Festivo trabajado el ${row.worked_on}`,
    resolution: row.resolution,
    quantityLabel: `${row.duration_minutes} min`,
    frozenUnitRateCents: BigInt(row.frozen_unit_rate_cents),
    frozenAmountCents: BigInt(row.frozen_amount_cents),
    permanentCreditMinutes: row.balance_minutes,
  }));
  const extraById = new Map(extraRows.rows.map((row) => [row.id, row]));

  const advanceRows = await client.query<{ id: string; delta_cents: string; effective_on: string }>(
    `select entry.id, entry.delta_cents::text as delta_cents, entry.effective_on::text as effective_on
       from app.advance_ledger_entries as entry
       join app.advances as advance
         on advance.household_id = entry.household_id and advance.id = entry.advance_id
      where entry.household_id = $1 and advance.agreement_id = $2 and entry.kind = 'repayment'
        and entry.effective_on between $3 and $4
      order by entry.effective_on, entry.id`,
    [householdId, settlement.agreement_id, settlement.period_start, settlement.period_end],
  );
  const advanceDeductions: MonetaryInput[] = advanceRows.rows.map((row) => ({
    id: row.id,
    label: `Cuota de anticipo del ${row.effective_on}`,
    amountCents: BigInt(row.delta_cents),
  }));
  const advanceById = new Map(advanceRows.rows.map((row) => [row.id, row]));

  const expenseRows = await client.query<{ id: string; incurred_on: string; description: string; amount_cents: string }>(
    `select id, incurred_on::text as incurred_on, description, amount_cents::text as amount_cents
       from app.expenses
      where household_id = $1 and agreement_id = $2 and status = 'approved'
        and incurred_on between $3 and $4
      order by incurred_on, id`,
    [householdId, settlement.agreement_id, settlement.period_start, settlement.period_end],
  );
  const expenses: MonetaryInput[] = expenseRows.rows.map((row) => ({
    id: row.id,
    label: row.description,
    amountCents: BigInt(row.amount_cents),
  }));
  const expenseById = new Map(expenseRows.rows.map((row) => [row.id, row]));

  const projection = calculateSettlement({
    period,
    agreementVersions: versions,
    extraWork,
    extraPay: [],
    advanceDeductions,
    unpaidAbsences: [],
    adjustments: [],
    expenses,
  });

  const dbLines: SettlementLineRow[] = projection.lines.map((line, index) => {
    const base: Omit<SettlementLineRow, "kind" | "section" | "occurredOn"> = {
      lineNumber: index + 1,
      concept: line.label,
      amountCents: line.amountCents,
      agreementVersionId: null,
      extraWorkEventId: null,
      advanceLedgerEntryId: null,
      expenseId: null,
      provenance: {
        engineLineId: line.id,
        sourceType: line.sourceType,
        sourceHref: line.sourceHref,
        quantity: line.quantity,
        unitCents: line.unitCents === null ? null : line.unitCents.toString(),
      },
    };
    switch (line.kind) {
      case "base_salary":
        return {
          ...base,
          kind: "base_salary",
          section: "salary",
          occurredOn: settlement.period_start,
          agreementVersionId: line.sourceId,
        };
      case "extra_work": {
        const fact = extraById.get(line.sourceId);
        if (!fact) throw new Error(`Jornada extra sin hecho de origen: ${line.sourceId}`);
        return {
          ...base,
          kind: fact.resolution === "time_off" ? "time_off_compensation" : "extra_work",
          section: "salary",
          occurredOn: fact.worked_on,
          extraWorkEventId: fact.id,
        };
      }
      case "advance_deduction": {
        const fact = advanceById.get(line.sourceId);
        if (!fact) throw new Error(`Deducción sin asiento de anticipo de origen: ${line.sourceId}`);
        return {
          ...base,
          kind: "advance_deduction",
          section: "salary",
          occurredOn: fact.effective_on,
          advanceLedgerEntryId: fact.id,
        };
      }
      case "expense_reimbursement": {
        const fact = expenseById.get(line.sourceId);
        if (!fact) throw new Error(`Reembolso sin gasto de origen: ${line.sourceId}`);
        return {
          ...base,
          kind: "expense_reimbursement",
          section: "reimbursement",
          occurredOn: fact.incurred_on,
          expenseId: fact.id,
        };
      }
      default:
        throw new Error(`El cierre no admite líneas de motor de tipo ${line.kind}`);
    }
  });

  for (const line of dbLines) {
    await client.query(
      `insert into app.settlement_lines
         (household_id, settlement_id, agreement_id, employee_membership_id, line_number,
          section, kind, occurred_on, concept, amount_cents,
          agreement_version_id, extra_work_event_id, advance_ledger_entry_id, expense_id, provenance)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
      [
        householdId,
        settlement.id,
        settlement.agreement_id,
        settlement.employee_membership_id,
        line.lineNumber,
        line.section,
        line.kind,
        line.occurredOn,
        line.concept,
        line.amountCents.toString(),
        line.agreementVersionId,
        line.extraWorkEventId,
        line.advanceLedgerEntryId,
        line.expenseId,
        JSON.stringify(line.provenance),
      ],
    );
  }

  // Snapshot canónico de las líneas: el hash congelado es reproducible desde
  // las propias filas y sus referencias de procedencia.
  const snapshot = {
    settlementId: settlement.id,
    agreementId: settlement.agreement_id,
    period,
    lines: dbLines.map((line) => ({
      lineNumber: line.lineNumber,
      section: line.section,
      kind: line.kind,
      occurredOn: line.occurredOn,
      concept: line.concept,
      amountCents: line.amountCents.toString(),
      agreementVersionId: line.agreementVersionId,
      extraWorkEventId: line.extraWorkEventId,
      advanceLedgerEntryId: line.advanceLedgerEntryId,
      expenseId: line.expenseId,
    })),
    salaryTotalCents: projection.salaryCents.toString(),
    reimbursementTotalCents: projection.reimbursementCents.toString(),
    transferTotalCents: projection.transferTotalCents.toString(),
  };
  const snapshotHash = canonicalSha256(snapshot);

  const closed = await client.query<{ transfer_total_cents: string }>(
    `update app.settlements
        set status = 'closed', closed_by_membership_id = $3, closed_at = now(), snapshot_hash = $4
      where household_id = $1 and id = $2
      returning transfer_total_cents::text as transfer_total_cents`,
    [householdId, settlement.id, membership.id, snapshotHash],
  );
  const frozenTotal = closed.rows[0]?.transfer_total_cents;
  if (frozenTotal === undefined || BigInt(frozenTotal) !== projection.transferTotalCents) {
    // Divergencia entre el total recalculado por el trigger y el motor puro:
    // se aborta la transacción entera antes que congelar un total incorrecto.
    throw new Error(
      `El total congelado (${frozenTotal}) no coincide con el motor (${projection.transferTotalCents})`,
    );
  }

  const names = await client.query<{ household_name: string; employee_name: string }>(
    `select household.display_name as household_name, profile.display_name as employee_name
       from app.households as household
       join app.household_memberships as membership
         on membership.household_id = household.id
       join app.user_profiles as profile
         on profile.user_id = membership.user_id
      where household.id = $1 and membership.id = $2`,
    [householdId, settlement.employee_membership_id],
  );
  const parties = names.rows[0];
  if (!parties) throw new Error("No se pudieron resolver los nombres para el recibo");

  const receipt = {
    receipt: {
      householdName: parties.household_name,
      employeeName: parties.employee_name,
      period,
      generatedAt: new Date().toISOString(),
      lines: dbLines.map((line) => ({
        concept: line.concept,
        detail:
          line.provenance.unitCents === null
            ? String(line.provenance.quantity)
            : `${String(line.provenance.quantity)} × ${String(line.provenance.unitCents)} cts`,
        amountCents: line.amountCents.toString(),
      })),
      salaryTotalCents: projection.salaryCents.toString(),
      reimbursementTotalCents: projection.reimbursementCents.toString(),
      transferTotalCents: projection.transferTotalCents.toString(),
      reference: `liq-${period}-${settlement.id.slice(0, 8)}`,
    },
  };
  await client.query("select app.enqueue_job('document.render_receipt', $1::jsonb)", [
    JSON.stringify(receipt),
  ]);

  return { resourceId: settlement.id };
}

async function confirmReceipt(
  client: PoolClient,
  membership: ActiveMembership,
  householdId: UUID,
  payload: ConfirmReceiptPayload,
): Promise<{ resourceId: UUID }> {
  if (membership.role !== "employee_live_in") {
    throw new CommandRejectedError("not_allowed", "Solo la empleada confirma el cobro de su liquidación");
  }

  const loaded = await client.query<{ id: string; employee_membership_id: string; status: string }>(
    `select id, employee_membership_id, status
       from app.settlements
      where household_id = $1 and id = $2`,
    [householdId, payload.settlementId],
  );
  const settlement = loaded.rows[0];
  if (!settlement || settlement.employee_membership_id !== membership.id) {
    throw new CommandRejectedError("settlement_not_found", "La liquidación no existe o no es de la empleada");
  }
  if (settlement.status !== "closed") {
    throw new CommandRejectedError("settlement_not_closed", "Solo se confirma una liquidación cerrada");
  }

  const confirmed = await client.query(
    `select 1
       from app.settlement_receipt_confirmations
      where household_id = $1 and settlement_id = $2`,
    [householdId, settlement.id],
  );
  if ((confirmed.rowCount ?? 0) > 0) {
    throw new CommandRejectedError("receipt_already_confirmed", "El cobro ya fue confirmado");
  }

  const totals = await client.query<{ pending_cents: string }>(
    `select pending_cents::text as pending_cents
       from app.settlement_payment_totals
      where household_id = $1 and settlement_id = $2`,
    [householdId, settlement.id],
  );
  const pending = totals.rows[0]?.pending_cents ?? "0";
  if (BigInt(pending) > 0n) {
    throw new CommandRejectedError(
      "settlement_not_fully_paid",
      `Quedan ${pending} céntimos pendientes de pago`,
    );
  }

  const inserted = await client.query<{ id: string }>(
    `insert into app.settlement_receipt_confirmations
       (household_id, settlement_id, employee_membership_id, note)
     values ($1, $2, $3, $4)
     returning id`,
    [householdId, settlement.id, membership.id, payload.note ?? ""],
  );
  const confirmationId = inserted.rows[0]?.id;
  if (!confirmationId) throw new Error("La confirmación de cobro no devolvió identificador");
  return { resourceId: confirmationId };
}

/**
 * `settlement`: apertura (admin), cierre con materialización de líneas desde
 * los hechos del periodo + hash del snapshot canónico + encolado del recibo
 * (admin), y confirmación de cobro (solo la empleada, con el total cubierto).
 */
export const settlementCommandHandler: CommandHandler = async (client, membership, envelope) => {
  const parsed = settlementCommandPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    throw new CommandRejectedError("invalid_payload", parsed.error.issues[0]?.message);
  }
  const payload = parsed.data;
  switch (payload.action) {
    case "open":
      return openSettlement(client, membership, envelope.householdId, payload);
    case "close":
      return closeSettlement(client, membership, envelope.householdId, payload);
    case "confirm_receipt":
      return confirmReceipt(client, membership, envelope.householdId, payload);
  }
};
