import type { Pool } from 'pg';

import { createLogger, withAuthorizedTransaction } from '@casa-clara/server';
import { contractYear, contractYearOn } from '@casa-clara/domain';

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
  employmentTabHref,
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
import { readEmployeeCandidates } from './agreement-terms.server';
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
  // Algún llamante (y las pruebas de averías) trae un usuario con solo el id:
  // sin membresías nadie administra, y la base inocua es la de condiciones.
  const role = user && Array.isArray(user.memberships) ? membershipIn(user, householdId)?.role : undefined;
  const contrato = can(role, 'agreement.write') ? 'acuerdo' : 'condiciones';
  return {
    conceptos: employmentTabHref(householdId, 'conceptos', empleada),
    resumen: employmentTabHref(householdId, 'resumen', empleada),
    pagos: employmentTabHref(householdId, 'pagos', empleada),
    contrato: employmentTabHref(householdId, contrato, empleada)
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
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      // Mismo corte que la portada: los importes los ven quien administra y la
      // propia empleada, y se decide por el PAPEL, no por si llegó alguna cifra.
      const seesAmounts =
        can(membership.role, 'settlement.close') || can(membership.role, 'payment.confirm.self');
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

      // Vacaciones del año de CONTRATO en curso: los doce meses contados desde
      // el día en que empezó el acuerdo, no del 1 de enero al 31 de diciembre.
      // Se piden los periodos que TOCAN ese año, no los que empiezan en él: uno
      // a caballo del aniversario gasta días de los dos, y el motor de dominio
      // reparte cuáles son de cada uno. Los anulados vienen también: se listan
      // tachados, sin contar. Un contrato que aún no ha empezado enseña su
      // primer año, que es el que va a regir.
      const vacationYear =
        contractYearOn(agreement.startsOn, currentLocalDate(now)) ??
        contractYear(agreement.startsOn, 1);
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
        [householdId, agreement.id, vacationYear.startsOn, vacationYear.endsOn]
      );

      // Conceptos apuntados a mano (0022) que TODAVÍA esperan decisión: es lo
      // único que la página lista. Se piden por `period_month` —el mes que
      // decidió quien los apuntó— y no por la fecha en que se escribieron: un
      // concepto de marzo apuntado en abril pertenece a la cuenta de marzo.
      //
      // SIN VENTANA DE FECHAS, ni por delante ni por detrás. Un concepto puede
      // estar imputado a un mes que aún no ha llegado (elegido a propósito o
      // aplazado por un cierre), y hacia atrás la ventana de tres meses que hubo
      // aquí era un error: se comprobó que un pendiente que nunca se cerró no
      // está en Pagos —nunca tuvo línea—, ni en el devengo —que sólo mira el mes
      // en curso—, ni en Hoy, ni en el contador de la portada. Al cuarto mes
      // salía de la única pantalla donde vivía y no aparecía en ninguna otra.
      // Como el `not exists` de abajo ya retira lo aplicado y el `status` retira
      // lo anulado, lo que queda son pendientes vivos: pocos, y todos importan
      // tengan la edad que tengan.
      //
      // Fuera lo anulado y fuera lo que una nómina CERRADA ya materializó: un
      // adelanto de agosto ya descontado en la nómina de agosto no es un
      // concepto de septiembre, y obligar a descartarlo cada mes es trabajo que
      // esta pantalla no debería pedir. No se pierde nada: la nómina cerrada
      // lista todas sus líneas en Pagos y el documento de pago las repite.
      // `closed` y no cualquier estado: el enum admite 'void' (0003) y el día
      // que se pueda anular una nómina sus conceptos tienen que volver aquí.
      const pendingAdjustments = await client.query<ManualAdjustmentRow>(
        `select id,
                to_char(period_month, 'YYYY-MM') as "period",
                to_char(requested_period_month, 'YYYY-MM') as "requestedPeriod",
                label,
                reason,
                amount_cents::text as "amountCents",
                adds_to_pay as "addsToPay",
                deferral_note as "deferralNote",
                status::text as "status",
                void_reason as "voidReason"
           from app.manual_adjustments
          where household_id = $1 and agreement_id = $2
            and status = 'recorded'
            and not exists (
              select 1
                from app.settlement_lines as linea
                join app.settlements as nomina
                  on nomina.household_id = linea.household_id
                 and nomina.id = linea.settlement_id
               where linea.household_id = manual_adjustments.household_id
                 -- Y del MISMO acuerdo. Sin este acote, una línea de la nómina
                 -- cerrada de otra empleada apuntando a este concepto lo hacía
                 -- desaparecer de esta lista: la base lo acepta, y aquí es lo
                 -- que decide si se paga. Todas las demás consultas de este
                 -- fichero van por household_id + agreement_id; ésta era la
                 -- excepción. Además, un NOT EXISTS sobre tablas con RLS
                 -- responde «lo que el lector puede ver» y no «lo que es
                 -- verdad», así que sin el acote la empleada y la
                 -- administración veían listas distintas del mismo mes.
                 and linea.agreement_id = manual_adjustments.agreement_id
                 and linea.manual_adjustment_id = manual_adjustments.id
                 and nomina.status = 'closed')
          order by period_month desc, recorded_at desc`,
        [householdId, agreement.id]
      );

      // Y aparte, los del MES EN CURSO para el devengo, que necesita otra cosa:
      // trae también lo que una nómina cerrada de este mismo mes ya materializó.
      // La cuenta se puede cerrar el 28 con tres días de mes por delante; si
      // aquí faltara lo ya pagado, el «Total previsto del mes» diría más de lo
      // que la nómina pagó de verdad, que es dinero mintiendo en pantalla.
      // De ahí sale también a dónde enlaza cada línea: lo ya aplicado se lee en
      // Pagos, no en Conceptos, donde ya no está.
      const monthAdjustments = await client.query<ManualAdjustmentRow>(
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
                (select nomina.id
                   from app.settlement_lines as linea
                   join app.settlements as nomina
                     on nomina.household_id = linea.household_id
                    and nomina.id = linea.settlement_id
                  where linea.household_id = manual_adjustments.household_id
                    -- Mismo acote por acuerdo que arriba, y por lo mismo: la
                    -- nómina de otra persona no materializa este concepto.
                    and linea.agreement_id = manual_adjustments.agreement_id
                    and linea.manual_adjustment_id = manual_adjustments.id
                    and nomina.status = 'closed'
                  limit 1) as "settledSettlementId"
           from app.manual_adjustments
          where household_id = $1 and agreement_id = $2
            and period_month = date_trunc('month', $3::date)::date
          order by recorded_at`,
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
          adjustments: monthAdjustments.rows,
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
        pendingExpenses: buildPendingExpenseViews(pendingExpenses.rows, seesAmounts),
        // Sin versiones visibles no hay derecho que enseñar: RLS ya decidió que
        // esta persona no ve los términos, y un saldo sobre cero días mentiría.
        vacations:
          versions.rows.length === 0
            ? null
            : buildVacationView({
                today: currentLocalDate(now),
                annualVacationDays: annualVacationDaysInForce(
                  versions.rows,
                  currentLocalDate(now)
                ),
                agreementStartsOn: agreement.startsOn,
                agreementEndsOn: agreement.endsOn,
                periods: vacationPeriods.rows
              }),
        manualAdjustments: buildManualAdjustmentViews(pendingAdjustments.rows),
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
 * las DOS preguntas de quien administra —«¿qué debo?» y «¿cuánto va costando
 * este mes?»— con la deuda real de cada acuerdo (cuentas CERRADAS con importe
 * sin pagar) y su devengo del mes, sin cargar historial de liquidaciones ni
 * vacaciones de nadie. Las consultas van agrupadas por hogar (`= any(ids)`) y
 * se reparten por acuerdo aquí: el número de consultas no crece con el número
 * de empleadas.
 *
 * Quién ve qué lo decide la RLS, como en el resto del expediente. `seesAmounts`
 * se decide por el PAPEL y no por si llegó alguna cifra: deducirlo de los datos
 * confundía «no puedes verlo» con «su contrato no está en vigor este mes».
 *
 * **Con cero acuerdos devuelve una portada vacía, no null.** La casa donde
 * todavía no trabaja nadie es justo la que necesita el camino al alta, y
 * devolver null la dejaba sin ninguna pantalla desde la que darla.
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
  const today = currentLocalDate(now);

  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      // Mismo corte que el Resumen: los importes los ven quien administra y la
      // propia empleada. Es una entrada explícita del modelo, no una deducción.
      const seesAmounts =
        can(membership.role, 'settlement.close') || can(membership.role, 'payment.confirm.self');
      // Las personas con acceso y sin contrato en vigor sólo le importan a
      // quien puede hacer algo con ellas; nadie más las pide.
      const administra = can(membership.role, 'access.manage');
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
      const ids = agreements.map((row) => row.id);
      const candidates = administra ? await readEmployeeCandidates(client, householdId) : [];
      // La casa donde todavía no trabaja nadie tiene portada igual: es la única
      // pantalla desde la que se puede dar de alta a la primera persona.
      if (agreements.length === 0) {
        return buildPortadaView({ period, seesAmounts, employees: [], candidates });
      }

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

      // Sin la nómina que ya los materializó: la portada no pinta el origen de
      // ninguna línea, así que esa subconsulta correlacionada se calculaba por
      // cada concepto de cada empleada para tirarla a la basura.
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
                void_reason as "voidReason"
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

      /*
       * LO QUE SE DEBE DE VERDAD. Una sola consulta agrupada por acuerdo, con
       * el mismo criterio que ya usa Hoy: cuentas CERRADAS cuyo pendiente sigue
       * por encima de cero. Fuera quedan, y son decisiones del propietario, el
       * devengo del mes en curso (previsión, no deuda), la cuenta abierta sin
       * cerrar y el cobro pagado pendiente de que ella lo confirme, que no es
       * dinero que la casa deba sino un acuse que le toca a ella.
       *
       * El `::text` del `sum` no es cosmético: el dinero no puede pasar por
       * Number ni una sola vez. Los `count(*)` sí son números, que es lo que
       * son. La RLS de `settlements` deja estas filas a quien administra y a la
       * propia empleada, el mismo corte que los importes que ya se enseñan.
       */
      const owed = await client.query<{
        agreementId: string;
        count: string;
        pendingCents: string;
        earliestDueOn: string | null;
        overdueCount: string;
      }>(
        `select settlement.agreement_id as "agreementId",
                count(*)::text as "count",
                sum(totals.pending_cents)::text as "pendingCents",
                min(settlement.due_on)::text as "earliestDueOn",
                count(*) filter (where settlement.due_on < $3::date)::text as "overdueCount"
           from app.settlements as settlement
           join app.settlement_payment_totals as totals
             on totals.household_id = settlement.household_id
            and totals.settlement_id = settlement.id
          where settlement.household_id = $1
            and settlement.agreement_id = any($2::uuid[])
            and settlement.status = 'closed'
            and totals.pending_cents > 0
          group by settlement.agreement_id`,
        [householdId, ids, today]
      );
      const owedByAgreement = new Map(
        owed.rows.map((row) => [
          row.agreementId,
          {
            pendingCents: row.pendingCents,
            count: Number(row.count),
            earliestDueOn: row.earliestDueOn,
            overdueCount: Number(row.overdueCount)
          }
        ])
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
        seesAmounts,
        candidates,
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
            pendingCount: pendingByAgreement.get(agreement.id) ?? 0,
            owed: owedByAgreement.get(agreement.id) ?? null
          };
        })
      });
    });
  } catch (cause) {
    return unreadable(log, 'employment portada', cause);
  }
}
