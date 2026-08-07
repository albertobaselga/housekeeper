import type { Pool } from 'pg';

import { AuthorizationError, withAuthorizedTransaction } from '@casa-clara/server';

import {
  buildAccrual,
  buildAdvanceBalanceViews,
  buildAgreementVersionViews,
  buildCompensationBalanceViews,
  buildPendingExpenseViews,
  buildPendingExtraViews,
  buildSettlementViews,
  buildWeeklyReportViews,
  currentPeriod,
  type AdvanceRow,
  type AgreementVersionRow,
  type ApprovedExpenseRow,
  type CompensationBalanceRow,
  type EmploymentOverview,
  type PaymentRow,
  type PendingExpenseRow,
  type PendingExtraWorkRow,
  type ResolvedExtraWorkRow,
  type SettlementLineRow,
  type SettlementRow,
  type WeeklyReportRow
} from '$lib/employment/model';
import { getDatabasePool } from './db.server';

function monthBounds(period: string): { first: string; last: string } {
  const [year, month] = period.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * Expediente laboral leído de Postgres bajo RLS. Toda consulta corre dentro de
 * `withAuthorizedTransaction` con el userId de la sesión: es la base de datos,
 * no este código, quien decide qué filas ve cada rol (un helper/viewer recibe
 * cero filas y la página degrada a un estado vacío). Devuelve null solo cuando
 * no hay pool (demo sin DATABASE_URL) o la membresía no autoriza el hogar; en
 * ese caso la página cae a la fixture actual.
 *
 * Los importes se mantienen como cadenas de céntimos de extremo a extremo: pg
 * entrega los bigint como string y aquí nunca pasan por Number.
 */
export async function loadEmploymentOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<EmploymentOverview | null> {
  if (!pool) return null;
  const period = currentPeriod(now);
  const { first, last } = monthBounds(period);

  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const agreementResult = await client.query<{
        id: string;
        status: string;
        startsOn: string;
        endsOn: string | null;
        employeeMembershipId: string;
      }>(
        `select id,
                status::text as "status",
                starts_on::text as "startsOn",
                ends_on::text as "endsOn",
                employee_membership_id as "employeeMembershipId"
           from app.employment_agreements
          where household_id = $1
          order by (status = 'active') desc, starts_on desc
          limit 1`,
        [householdId]
      );
      const agreement = agreementResult.rows[0] ?? null;
      if (!agreement) {
        return {
          householdId,
          hasEmploymentData: false,
          agreement: null,
          versions: [],
          accrual: null,
          settlements: [],
          pendingExtras: [],
          pendingExpenses: [],
          recentReports: [],
          balances: { compensation: [], advances: [] }
        } satisfies EmploymentOverview;
      }

      const versions = await client.query<AgreementVersionRow>(
        `select id,
                version_number as "versionNumber",
                effective_from::text as "effectiveFrom",
                monthly_salary_cents as "monthlySalaryCents",
                overtime_hourly_rate_cents as "overtimeHourlyRateCents",
                worked_rest_day_rate_cents as "workedRestDayRateCents",
                worked_rest_day_credit_minutes as "workedRestDayCreditMinutes",
                contracted_weekly_minutes as "contractedWeeklyMinutes",
                reason
           from app.agreement_versions
          where household_id = $1 and agreement_id = $2
          order by version_number`,
        [householdId, agreement.id]
      );

      const extras = await client.query<ResolvedExtraWorkRow>(
        `select id,
                kind::text as "kind",
                worked_on::text as "workedOn",
                duration_minutes as "durationMinutes",
                note,
                resolution::text as "resolution",
                frozen_unit_rate_cents as "frozenUnitRateCents",
                frozen_amount_cents as "frozenAmountCents",
                balance_minutes as "balanceMinutes"
           from app.extra_work_events
          where household_id = $1 and agreement_id = $2
            and status = 'resolved'
            and worked_on between $3 and $4
          order by worked_on, requested_at`,
        [householdId, agreement.id, first, last]
      );

      // Jornadas extra vivas (sin resolver ni rechazar): sobre ellas actúan la
      // empleada (marcar realizada) y la familia (aceptar/resolver). Sin filtro
      // de mes: una jornada pendiente exige acción aunque sea antigua.
      const pendingExtras = await client.query<PendingExtraWorkRow>(
        `select id,
                kind::text as "kind",
                worked_on::text as "workedOn",
                duration_minutes as "durationMinutes",
                note,
                status::text as "status",
                employee_membership_id as "employeeMembershipId"
           from app.extra_work_events
          where household_id = $1 and agreement_id = $2
            and status in ('requested', 'accepted', 'performed', 'performed_pending_resolution')
          order by worked_on, requested_at`,
        [householdId, agreement.id]
      );

      // Gastos pendientes de resolución: la familia los aprueba o rechaza.
      const pendingExpenses = await client.query<PendingExpenseRow>(
        `select id,
                incurred_on::text as "incurredOn",
                description,
                amount_cents as "amountCents",
                employee_membership_id as "employeeMembershipId"
           from app.expenses
          where household_id = $1 and agreement_id = $2 and status = 'pending'
          order by incurred_on, submitted_at`,
        [householdId, agreement.id]
      );

      // Gastos aprobados aún no incorporados a una liquidación: son los que el
      // devengo del mes en curso reembolsará.
      const expenses = await client.query<ApprovedExpenseRow>(
        `select expense.id,
                expense.incurred_on::text as "incurredOn",
                expense.description,
                expense.amount_cents as "amountCents"
           from app.expenses as expense
          where expense.household_id = $1 and expense.agreement_id = $2
            and expense.status = 'approved'
            and not exists (
              select 1 from app.settlement_lines as line
               where line.household_id = expense.household_id
                 and line.expense_id = expense.id
            )
          order by expense.incurred_on`,
        [householdId, agreement.id]
      );

      const advances = await client.query<AdvanceRow>(
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
          where advance.household_id = $1 and advance.agreement_id = $2
          order by advance.issued_on`,
        [householdId, agreement.id]
      );

      // Partes semanales recientes (últimas 6 semanas enviadas): permiten
      // mostrar su estado y evitar reenviar una semana ya reportada.
      const weeklyReports = await client.query<WeeklyReportRow>(
        `select id,
                week_starts_on::text as "weekStartsOn",
                week_ends_on::text as "weekEndsOn",
                status::text as "status",
                auto_confirmed as "autoConfirmed",
                dispute_reason as "disputeReason"
           from app.weekly_time_reports
          where household_id = $1 and agreement_id = $2
          order by week_starts_on desc
          limit 6`,
        [householdId, agreement.id]
      );

      const compensation = await client.query<CompensationBalanceRow>(
        `select account_id as "accountId",
                balance_type::text as "balanceType",
                balance_minutes as "balanceMinutes"
           from app.compensation_balances
          where household_id = $1 and agreement_id = $2
          order by balance_type`,
        [householdId, agreement.id]
      );

      const settlements = await client.query<SettlementRow>(
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
          where settlement.household_id = $1 and settlement.agreement_id = $2
          order by settlement.period_start desc`,
        [householdId, agreement.id]
      );

      const settlementIds = settlements.rows.map((row) => row.id);
      let lineRows: SettlementLineRow[] = [];
      let paymentRows: PaymentRow[] = [];
      if (settlementIds.length > 0) {
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
            where line.household_id = $1 and line.settlement_id = any($2::uuid[])
            order by line.settlement_id, line.line_number`,
          [householdId, settlementIds]
        );
        lineRows = lines.rows;
        const payments = await client.query<PaymentRow>(
          `select id,
                  settlement_id as "settlementId",
                  amount_cents as "amountCents",
                  method::text as "method",
                  value_on::text as "valueOn",
                  reference
             from app.payments
            where household_id = $1 and settlement_id = any($2::uuid[])
              and status = 'recorded'
            order by value_on, recorded_at`,
          [householdId, settlementIds]
        );
        paymentRows = payments.rows;
      }

      return {
        householdId,
        hasEmploymentData: true,
        agreement,
        versions: buildAgreementVersionViews(versions.rows, first),
        accrual: buildAccrual({
          period,
          versions: versions.rows,
          extras: extras.rows,
          advances: advances.rows,
          expenses: expenses.rows
        }),
        settlements: buildSettlementViews(settlements.rows, lineRows, paymentRows),
        pendingExtras: buildPendingExtraViews(pendingExtras.rows),
        pendingExpenses: buildPendingExpenseViews(pendingExpenses.rows),
        recentReports: buildWeeklyReportViews(weeklyReports.rows),
        balances: {
          compensation: buildCompensationBalanceViews(compensation.rows),
          advances: buildAdvanceBalanceViews(advances.rows)
        }
      } satisfies EmploymentOverview;
    });
  } catch (cause) {
    // Sin membresía viva no hay expediente que enseñar; cualquier otra avería
    // degrada a la fixture para no tumbar la página de demo.
    if (!(cause instanceof AuthorizationError)) {
      console.error('employment overview unavailable', cause);
    }
    return null;
  }
}
