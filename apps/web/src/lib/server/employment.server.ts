import type { Pool } from 'pg';

import { createLogger, withAuthorizedTransaction } from '@casa-clara/server';

import {
  buildAccrual,
  buildAdvanceBalanceViews,
  buildAgreementOptionViews,
  buildPortadaView,
  buildAgreementTermsView,
  buildAgreementVersionViews,
  buildExtraWorkTypeView,
  buildCompensationBalanceViews,
  buildManualAdjustmentViews,
  buildPendingExpenseViews,
  buildPendingExtraViews,
  buildSettlementViews,
  buildVacationView,
  annualVacationDaysInForce,
  currentLocalDate,
  currentPeriod,
  currentVacationYear,
  type AdvanceRow,
  type AgreementRow,
  type AgreementVersionRow,
  type ApprovedExpenseRow,
  type CompensationBalanceRow,
  type EmploymentOverview,
  type EmploymentPortadaView,
  type ExtraWorkTypeRow,
  type ManualAdjustmentRow,
  type PaymentRow,
  type RecurringSupplementRow,
  type PendingExpenseRow,
  type PendingExtraWorkRow,
  type ResolvedExtraWorkRow,
  type ScheduleDayRow,
  type ScheduleRow,
  type SettlementLineRow,
  type SettlementRow,
  type SourceHrefBases,
  type VacationPeriodRow
} from '$lib/employment/model';
import { can } from '$lib/auth/capabilities';
import { membershipIn } from '$lib/auth/membership';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:employment');

/**
 * Las bases de los orígenes para quien mira: la jornada y el gasto viven en
 * Conceptos, el anticipo en los saldos del Resumen y las versiones donde cada
 * cual lee su contrato (el acuerdo si lo pacta, sus condiciones si no). La
 * empleada elegida viaja en cada base para que el salto no cambie de persona.
 */
export function employmentHrefBases(
  user: Parameters<typeof membershipIn>[0],
  householdId: string,
  empleada: string | null = null
): SourceHrefBases {
  const base = `/h/${householdId}/employment`;
  const query = empleada ? `?empleada=${encodeURIComponent(empleada)}` : '';
  // Algún llamante (y las pruebas de averías) trae un usuario con solo el id:
  // sin membresías nadie administra, y la base inocua es la de condiciones.
  const role = user && Array.isArray(user.memberships) ? membershipIn(user, householdId)?.role : undefined;
  const contrato = can(role, 'agreement.write') ? `${base}/acuerdo` : `${base}/condiciones`;
  return {
    conceptos: `${base}/conceptos${query}`,
    resumen: `${base}${query}`,
    contrato: `${contrato}${query}`
  };
}

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
 *
 * `selectedAgreementId` elige de quién es el expediente cuando el hogar emplea
 * a más de una persona. No es una reja de seguridad y no pretende serlo: la
 * lista de acuerdos llega ya filtrada por la RLS, así que a la empleada solo le
 * consta el suyo y pedir el de otra no la lleva a ninguna parte —cae en su
 * propio expediente—. Quien decide sigue siendo Postgres.
 */
export async function loadEmploymentOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date(),
  selectedAgreementId: string | null = null,
  // Con la sección en pestañas, el origen de cada línea vive en otra ruta: las
  // bases las pone la página, que sabe quién mira. Sin ellas (pruebas, y
  // llamadas que no pintan líneas) los orígenes quedan como fragmento.
  hrefBases: SourceHrefBases | undefined = undefined
): Promise<EmploymentOverview | null> {
  if (!pool) return null;
  const period = currentPeriod(now);
  const { first, last } = monthBounds(period);

  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      // Todos los acuerdos visibles, no el primero: un hogar puede tener varios
      // vivos a la vez y quien administra tiene que poder elegir. El nombre sale
      // del perfil de la persona empleada; si la RLS no deja verlo (la propia
      // empleada solo lee su perfil) el LEFT JOIN devuelve null y la vista pone
      // una etiqueta neutra en su lugar.
      const agreementResult = await client.query<AgreementRow>(
        `select agreement.id,
                agreement.status::text as "status",
                agreement.starts_on::text as "startsOn",
                agreement.ends_on::text as "endsOn",
                agreement.employee_membership_id as "employeeMembershipId",
                profile.display_name as "employeeName"
           from app.employment_agreements as agreement
           left join app.household_memberships as membership
             on membership.household_id = agreement.household_id
            and membership.id = agreement.employee_membership_id
           left join app.user_profiles as profile
             on profile.user_id = membership.user_id
          where agreement.household_id = $1
          order by (agreement.status = 'active') desc, agreement.starts_on desc`,
        [householdId]
      );
      const agreements = agreementResult.rows;
      const agreement =
        agreements.find((row) => row.id === selectedAgreementId) ?? agreements[0] ?? null;
      if (!agreement) {
        return {
          householdId,
          hasEmploymentData: false,
          agreement: null,
          agreements: [],
          versions: [],
          terms: null,
          registrableTypes: [],
          accrual: null,
          settlements: [],
          pendingExtras: [],
          pendingExpenses: [],
          vacations: null,
          manualAdjustments: [],
          balances: { compensation: [], advances: [] }
        } satisfies EmploymentOverview;
      }

      // Sin las columnas reliquia de tarifa: viajarían al navegador dentro del
      // JSON de la página y con ellas la tarifa horaria de quien no tiene horas
      // permitidas. Las tarifas se leen del catálogo, donde la RLS decide fila
      // a fila qué sale de Postgres.
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
          order by version_number`,
        [householdId, agreement.id]
      );

      // Catálogo de TODAS las versiones visibles: el historial enseña cómo
      // cambiaron las condiciones, no solo cómo están hoy. Para la empleada la
      // RLS ya descartó lo desactivado y lo que no tiene tarifa.
      const extraWorkTypes = await client.query<ExtraWorkTypeRow>(
        `select id,
                agreement_version_id as "agreementVersionId",
                code,
                name,
                unit::text as "unit",
                rate_cents::text as "rateCents",
                reference_minutes as "referenceMinutes",
                active
           from app.extra_work_types
          where household_id = $1 and agreement_id = $2
          order by sort_order, code`,
        [householdId, agreement.id]
      );

      const supplements = await client.query<RecurringSupplementRow>(
        `select id,
                agreement_version_id as "agreementVersionId",
                code,
                name,
                amount_cents::text as "amountCents",
                periodicity::text as "periodicity",
                adds_to_pay as "addsToPay",
                starts_on::text as "startsOn",
                ends_on::text as "endsOn",
                active
           from app.recurring_supplements
          where household_id = $1 and agreement_id = $2
          order by sort_order, code`,
        [householdId, agreement.id]
      );

      /*
       * Horario de todas las versiones visibles (0025). No se filtra por
       * versión aquí: el historial tiene que poder enseñar cómo cambió el
       * horario, igual que enseña cómo cambió el salario.
       *
       * Las horas salen ya como «HH:MM» de `to_char`. Dejar que pg entregue el
       * `time` completo obligaría a cada lector —vista, guion, prueba— a
       * recortar los segundos por su cuenta, y basta con que uno se olvide para
       * que en pantalla aparezca «08:00:00».
       */
      const schedules = await client.query<ScheduleRow>(
        `select schedule.id,
                schedule.agreement_version_id as "agreementVersionId",
                to_char(schedule.starts_at, 'HH24:MI') as "startsAt",
                to_char(schedule.ends_at, 'HH24:MI') as "endsAt",
                schedule.long_break_minutes as "longBreakMinutes",
                schedule.note
           from app.agreement_schedules as schedule
          where schedule.household_id = $1 and schedule.agreement_id = $2`,
        [householdId, agreement.id]
      );

      const scheduleDays = await client.query<ScheduleDayRow>(
        `select day.id,
                day.schedule_id as "scheduleId",
                day.weekday,
                day.works,
                to_char(day.starts_at, 'HH24:MI') as "startsAt",
                to_char(day.ends_at, 'HH24:MI') as "endsAt",
                day.long_break_minutes as "longBreakMinutes",
                day.note
           from app.agreement_schedule_days as day
          where day.household_id = $1 and day.agreement_id = $2
          order by day.weekday`,
        [householdId, agreement.id]
      );

      // Vacaciones del año natural en curso. Se piden los periodos que TOCAN el
      // año, no los que empiezan en él: uno del 24 de diciembre al 5 de enero
      // gasta días de los dos, y el motor de dominio reparte cuáles son de cada
      // uno. Los anulados vienen también: se listan tachados, sin contar.
      const vacationYear = currentVacationYear(now);
      const vacationPeriods = await client.query<VacationPeriodRow>(
        `select id,
                starts_on::text as "startsOn",
                ends_on::text as "endsOn",
                calendar_days as "calendarDays",
                note,
                status::text as "status",
                void_reason as "voidReason"
           from app.vacation_periods
          where household_id = $1 and agreement_id = $2
            and starts_on <= $4 and ends_on >= $3
          order by starts_on desc`,
        [householdId, agreement.id, `${vacationYear}-01-01`, `${vacationYear}-12-31`]
      );

      // Conceptos apuntados a mano (0022). Se piden por `period_month` —el mes
      // que decidió quien los apuntó— y no por la fecha en que se escribieron:
      // un concepto de marzo apuntado en abril pertenece a la cuenta de marzo.
      // La ventana llega hasta un año atrás y no corta por delante, porque un
      // concepto puede estar imputado a un mes que aún no ha llegado (elegido a
      // propósito o aplazado por un cierre). Los anulados vienen también: se
      // listan tachados y el devengo los descarta.
      const manualAdjustments = await client.query<ManualAdjustmentRow>(
        `select id,
                to_char(period_month, 'YYYY-MM') as "period",
                to_char(requested_period_month, 'YYYY-MM') as "requestedPeriod",
                label,
                reason,
                amount_cents::text as "amountCents",
                adds_to_pay as "addsToPay",
                deferral_note as "deferralNote",
                status::text as "status",
                void_reason as "voidReason",
                (select to_char(nomina.period_start, 'YYYY-MM')
                   from app.settlement_lines as linea
                   join app.settlements as nomina
                     on nomina.household_id = linea.household_id
                    and nomina.id = linea.settlement_id
                  where linea.household_id = manual_adjustments.household_id
                    and linea.manual_adjustment_id = manual_adjustments.id
                    and nomina.status = 'closed'
                  limit 1) as "settledPeriod"
           from app.manual_adjustments
          where household_id = $1 and agreement_id = $2
            and period_month >= (date_trunc('month', $3::date) - interval '11 months')::date
          order by period_month desc, recorded_at desc`,
        [householdId, agreement.id, first]
      );

      const extras = await client.query<ResolvedExtraWorkRow>(
        `select id,
                kind::text as "kind",
                (select catalogued.name from app.extra_work_types as catalogued
                  where catalogued.household_id = extra_work_events.household_id
                    and catalogued.id = extra_work_events.extra_work_type_id) as "typeName",
                worked_on::text as "workedOn",
                duration_minutes as "durationMinutes",
                note,
                origin::text as "origin",
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
                (select catalogued.name from app.extra_work_types as catalogued
                  where catalogued.household_id = extra_work_events.household_id
                    and catalogued.id = extra_work_events.extra_work_type_id) as "typeName",
                worked_on::text as "workedOn",
                duration_minutes as "durationMinutes",
                note,
                -- Quién apuntó el hecho viaja con él: una jornada que puso la
                -- familia tiene que verse como tal en el expediente de ella.
                origin::text as "origin",
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
                employee_membership_id as "employeeMembershipId",
                (receipt_document_id is not null) as "hasReceipt"
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

      // Aquí se leían los partes semanales recientes. El parte se retiró con la
      // migración 0029 y la pantalla ya no lo enseña; las filas antiguas siguen
      // en la base como histórico y se leen en un único sitio, el ZIP del
      // expediente de la empleada (employment-export.server.ts).

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
      let receiptExpenseIds: string[] = [];
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

        // Justificantes de los gastos ya reembolsados: la cuenta cerrada
        // enseña el enlace a la foto sin poder tocar nada (RLS decide quién
        // ve estas filas; a quien no ve la cuenta no le llega ninguna).
        const expenseIds = lineRows
          .map((line) => line.expenseId)
          .filter((id): id is string => id !== null);
        if (expenseIds.length > 0) {
          const receipts = await client.query<{ id: string }>(
            `select id
               from app.expenses
              where household_id = $1 and id = any($2::uuid[])
                and receipt_document_id is not null`,
            [householdId, expenseIds]
          );
          receiptExpenseIds = receipts.rows.map((row) => row.id);
        }

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

      // Versión vigente HOY: la de mayor effective_from que no sea futura. Es la
      // que decide qué puede registrar hoy y qué condiciones enseñarle.
      const today = currentLocalDate(now);
      const versionInForce =
        [...versions.rows]
          .filter((row) => row.effectiveFrom <= today)
          .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom))
          .at(-1) ?? null;
      const terms = versionInForce
        ? buildAgreementTermsView({
            version: versionInForce,
            types: extraWorkTypes.rows,
            supplements: supplements.rows,
            schedules: schedules.rows,
            scheduleDays: scheduleDays.rows
          })
        : null;

      return {
        householdId,
        hasEmploymentData: true,
        agreement,
        agreements: buildAgreementOptionViews(agreements),
        versions: buildAgreementVersionViews(
          versions.rows,
          first,
          extraWorkTypes.rows,
          supplements.rows
        ),
        terms,
        // Se filtra por `available` además de por versión: quien administra ve
        // el catálogo entero, pero tampoco él puede registrar trabajo de un
        // concepto desactivado o sin tarifa (el disparador de 0021 lo rechaza).
        registrableTypes: versionInForce
          ? extraWorkTypes.rows
              .filter((row) => row.agreementVersionId === versionInForce.id)
              .map(buildExtraWorkTypeView)
              .filter((view) => view.available)
          : [],
        accrual: buildAccrual({
          period,
          versions: versions.rows,
          extras: extras.rows,
          advances: advances.rows,
          expenses: expenses.rows,
          supplements: supplements.rows.filter(
            (row) => row.agreementVersionId === (versionInForce?.id ?? '')
          ),
          adjustments: manualAdjustments.rows.filter((row) => row.period === period),
          hrefBases
        }),
        settlements: buildSettlementViews(
          settlements.rows,
          lineRows,
          paymentRows,
          new Set(receiptExpenseIds),
          hrefBases
        ),
        pendingExtras: buildPendingExtraViews(pendingExtras.rows),
        pendingExpenses: buildPendingExpenseViews(pendingExpenses.rows),
        // Sin versiones visibles no hay derecho que enseñar: RLS ya decidió que
        // esta persona no ve los términos, y un saldo sobre cero días mentiría.
        vacations:
          versions.rows.length === 0
            ? null
            : buildVacationView({
                year: vacationYear,
                annualVacationDays: annualVacationDaysInForce(
                  versions.rows,
                  currentLocalDate(now)
                ),
                agreementStartsOn: agreement.startsOn,
                agreementEndsOn: agreement.endsOn,
                periods: vacationPeriods.rows
              }),
        manualAdjustments: buildManualAdjustmentViews(manualAdjustments.rows),
        balances: {
          compensation: buildCompensationBalanceViews(compensation.rows),
          advances: buildAdvanceBalanceViews(advances.rows)
        }
      } satisfies EmploymentOverview;
    });
  } catch (cause) {
    return unreadable(log, 'employment overview', cause);
  }
}

/**
 * La portada de Contrato: primero la persona, luego su expediente. Responde
 * «¿cuánto nos cuesta la casa este mes y cómo va cada una?» con el devengo del
 * mes de CADA acuerdo visible y lo que espera decisión, sin cargar historial
 * de liquidaciones ni vacaciones de nadie. Las consultas van agrupadas por
 * hogar (`= any(ids)`) y se reparten por acuerdo aquí: el número de consultas
 * no crece con el número de empleadas.
 *
 * Quién ve qué lo decide la RLS, como en el resto del expediente: la familia
 * no administradora recibe las personas pero ninguna versión salarial, así
 * que sus devengos salen null y la portada dice «importes reservados».
 */
export async function loadEmploymentPortada(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<EmploymentPortadaView | null> {
  if (!pool) return null;
  const period = currentPeriod(now);
  const { first, last } = monthBounds(period);

  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client) => {
      const agreementResult = await client.query<AgreementRow>(
        `select agreement.id,
                agreement.status::text as "status",
                agreement.starts_on::text as "startsOn",
                agreement.ends_on::text as "endsOn",
                agreement.employee_membership_id as "employeeMembershipId",
                profile.display_name as "employeeName"
           from app.employment_agreements as agreement
           left join app.household_memberships as membership
             on membership.household_id = agreement.household_id
            and membership.id = agreement.employee_membership_id
           left join app.user_profiles as profile
             on profile.user_id = membership.user_id
          where agreement.household_id = $1
          order by (agreement.status = 'active') desc, agreement.starts_on desc`,
        [householdId]
      );
      const agreements = agreementResult.rows;
      if (agreements.length === 0) return null;
      const ids = agreements.map((row) => row.id);

      const versions = await client.query<AgreementVersionRow & { agreementId: string }>(
        `select agreement_id as "agreementId",
                id,
                version_number as "versionNumber",
                effective_from::text as "effectiveFrom",
                monthly_salary_cents as "monthlySalaryCents",
                contracted_weekly_minutes as "contractedWeeklyMinutes",
                annual_vacation_days as "annualVacationDays",
                reason
           from app.agreement_versions
          where household_id = $1 and agreement_id = any($2::uuid[])
          order by agreement_id, version_number`,
        [householdId, ids]
      );

      const supplements = await client.query<RecurringSupplementRow & { agreementId: string }>(
        `select agreement_id as "agreementId",
                id,
                agreement_version_id as "agreementVersionId",
                code,
                name,
                amount_cents::text as "amountCents",
                periodicity::text as "periodicity",
                adds_to_pay as "addsToPay",
                starts_on::text as "startsOn",
                ends_on::text as "endsOn",
                active
           from app.recurring_supplements
          where household_id = $1 and agreement_id = any($2::uuid[])
          order by agreement_id, sort_order, code`,
        [householdId, ids]
      );

      const extras = await client.query<ResolvedExtraWorkRow & { agreementId: string }>(
        `select agreement_id as "agreementId",
                id,
                kind::text as "kind",
                (select catalogued.name from app.extra_work_types as catalogued
                  where catalogued.household_id = extra_work_events.household_id
                    and catalogued.id = extra_work_events.extra_work_type_id) as "typeName",
                worked_on::text as "workedOn",
                duration_minutes as "durationMinutes",
                note,
                origin::text as "origin",
                resolution::text as "resolution",
                frozen_unit_rate_cents as "frozenUnitRateCents",
                frozen_amount_cents as "frozenAmountCents",
                balance_minutes as "balanceMinutes"
           from app.extra_work_events
          where household_id = $1 and agreement_id = any($2::uuid[])
            and status = 'resolved'
            and worked_on between $3 and $4
          order by agreement_id, worked_on, requested_at`,
        [householdId, ids, first, last]
      );

      const expenses = await client.query<ApprovedExpenseRow & { agreementId: string }>(
        `select expense.agreement_id as "agreementId",
                expense.id,
                expense.incurred_on::text as "incurredOn",
                expense.description,
                expense.amount_cents as "amountCents"
           from app.expenses as expense
          where expense.household_id = $1 and expense.agreement_id = any($2::uuid[])
            and expense.status = 'approved'
            and not exists (
              select 1 from app.settlement_lines as line
               where line.household_id = expense.household_id
                 and line.expense_id = expense.id
            )
          order by expense.agreement_id, expense.incurred_on`,
        [householdId, ids]
      );

      const advances = await client.query<AdvanceRow & { agreementId: string }>(
        `select advance.agreement_id as "agreementId",
                advance.id,
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
          order by advance.agreement_id, advance.issued_on`,
        [householdId, ids]
      );

      const adjustments = await client.query<ManualAdjustmentRow & { agreementId: string }>(
        `select agreement_id as "agreementId",
                id,
                to_char(period_month, 'YYYY-MM') as "period",
                to_char(requested_period_month, 'YYYY-MM') as "requestedPeriod",
                label,
                reason,
                amount_cents::text as "amountCents",
                adds_to_pay as "addsToPay",
                deferral_note as "deferralNote",
                status::text as "status",
                void_reason as "voidReason",
                (select to_char(nomina.period_start, 'YYYY-MM')
                   from app.settlement_lines as linea
                   join app.settlements as nomina
                     on nomina.household_id = linea.household_id
                    and nomina.id = linea.settlement_id
                  where linea.household_id = manual_adjustments.household_id
                    and linea.manual_adjustment_id = manual_adjustments.id
                    and nomina.status = 'closed'
                  limit 1) as "settledPeriod"
           from app.manual_adjustments
          where household_id = $1 and agreement_id = any($2::uuid[])
            and period_month = date_trunc('month', $3::date)::date
          order by agreement_id, recorded_at`,
        [householdId, ids, first]
      );

      // Lo que espera decisión, contado en la base: jornadas vivas y gastos
      // pendientes. La portada solo necesita el número.
      const pendingCounts = await client.query<{ agreementId: string; pending: string }>(
        `select agreement_id as "agreementId", count(*)::text as "pending"
           from (
             select agreement_id from app.extra_work_events
              where household_id = $1 and agreement_id = any($2::uuid[])
                and status in ('requested', 'accepted', 'performed', 'performed_pending_resolution')
             union all
             select agreement_id from app.expenses
              where household_id = $1 and agreement_id = any($2::uuid[])
                and status = 'pending'
           ) as pendiente
          group by agreement_id`,
        [householdId, ids]
      );
      const pendingByAgreement = new Map(
        pendingCounts.rows.map((row) => [row.agreementId, Number(row.pending)])
      );

      const byAgreement = <T extends { agreementId: string }>(rows: readonly T[]) => {
        const grouped = new Map<string, T[]>();
        for (const row of rows) {
          const bucket = grouped.get(row.agreementId);
          if (bucket) bucket.push(row);
          else grouped.set(row.agreementId, [row]);
        }
        return grouped;
      };
      const versionsBy = byAgreement(versions.rows);
      const supplementsBy = byAgreement(supplements.rows);
      const extrasBy = byAgreement(extras.rows);
      const expensesBy = byAgreement(expenses.rows);
      const advancesBy = byAgreement(advances.rows);
      const adjustmentsBy = byAgreement(adjustments.rows);

      const options = buildAgreementOptionViews(agreements);
      return buildPortadaView({
        period,
        employees: agreements.map((agreement) => {
          const own = versionsBy.get(agreement.id) ?? [];
          // La misma elección que congela el motor al cerrar: la versión en
          // vigor el PRIMER día del periodo manda sobre los complementos.
          const inForce =
            [...own].filter((row) => row.effectiveFrom <= first).at(-1) ?? null;
          return {
            agreementId: agreement.id,
            employeeLabel:
              options.find((option) => option.id === agreement.id)?.employeeLabel ?? 'La empleada',
            active: agreement.status === 'active',
            accrual: buildAccrual({
              period,
              versions: own,
              extras: extrasBy.get(agreement.id) ?? [],
              advances: advancesBy.get(agreement.id) ?? [],
              expenses: expensesBy.get(agreement.id) ?? [],
              supplements: (supplementsBy.get(agreement.id) ?? []).filter(
                (row) => row.agreementVersionId === (inForce?.id ?? '')
              ),
              adjustments: adjustmentsBy.get(agreement.id) ?? []
            }),
            pendingCount: pendingByAgreement.get(agreement.id) ?? 0
          };
        })
      });
    });
  } catch (cause) {
    return unreadable(log, 'employment portada', cause);
  }
}
