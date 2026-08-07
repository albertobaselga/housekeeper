import type { Pool } from 'pg';

import type { Role } from '@casa-clara/contracts';
import { AuthorizationError, createLogger, errorCode, computeMenuSlotHash, withAuthorizedTransaction } from '@casa-clara/server';

import { dateLabel, formatCents, formatMinutes, parseCents, periodLabel } from '$lib/employment/model';
import { addDays, mondayOf } from '$lib/food/dates';
import type { MealSlot } from '$lib/food/commands';
import { getDatabasePool } from './db.server';

const log = createLogger('web:today');

/**
 * «Hoy» real (UX-P1-1): proyección ligera leída de Postgres bajo RLS con la
 * fecha real de Madrid, el menú del día, las rutinas que vencen hoy o antes y
 * un bloque «Necesita tu decisión» por rol con enlace directo (1 click) a la
 * pantalla —y ancla, si existe— donde se resuelve cada cosa. Todo corre dentro
 * de UNA withAuthorizedTransaction (patrón employment.server.ts): es la base
 * de datos quien decide qué filas ve cada rol. Devuelve null solo sin pool
 * (demo sin DATABASE_URL) o sin membresía autorizada; la página cae entonces a
 * la fixture de demostración.
 */

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
const MADRID_HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  hour: 'numeric',
  hourCycle: 'h23'
});
const HEADER_LABEL = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'Europe/Madrid'
});

export const MEAL_LABELS: Readonly<Record<MealSlot, string>> = {
  desayuno: 'Desayuno',
  almuerzo: 'Almuerzo',
  comida: 'Comida',
  merienda: 'Merienda',
  cena: 'Cena'
};

export interface TodayDecisionItem {
  /** Clave estable para keyed each y asserts (p. ej. `extra-<uuid>`). */
  key: string;
  title: string;
  detail: string;
  /** Destino que resuelve el asunto en 1 click (ancla incluida si existe). */
  href: string;
  /** Verbo del enlace («Revisar», «Confirmar»…). */
  cta: string;
}

export interface TodayMenuSlotView {
  id: string;
  meal: MealSlot;
  mealLabel: string;
  groupName: string;
  /** Título de la receta o el texto libre del hueco. */
  dish: string;
  isRecipe: boolean;
  notes: string;
  /** Confirmación vigente (hash al día); null = hueco sin contenido que confirmar. */
  confirmed: boolean;
}

export interface TodayRoutineView {
  id: string;
  title: string;
  details: string;
  nextDueOn: string;
  dueLabel: string;
  /** Vencía antes de hoy. */
  overdue: boolean;
  completedCurrent: boolean;
  /** Recurrencia: permite pintar la próxima fecha de forma optimista al marcar. */
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  intervalCount: number;
}

export interface TodayOverview {
  householdId: string;
  role: Role;
  todayISO: string;
  /** «Viernes, 7 de agosto», calculado con la fecha real (Europe/Madrid). */
  dateLabel: string;
  greeting: string;
  decisions: TodayDecisionItem[];
  menu: TodayMenuSlotView[];
  routines: TodayRoutineView[];
}

// ─── Filas crudas que alimentan el mapeo puro (unit-testeable) ───────────────

export type TodayExtraStatus = 'requested' | 'accepted' | 'performed' | 'performed_pending_resolution';

export interface TodayExtraRow {
  id: string;
  workedOn: string;
  durationMinutes: number;
  note: string;
  status: TodayExtraStatus;
  employeeMembershipId: string;
}

export interface TodayExpenseRow {
  id: string;
  incurredOn: string;
  description: string;
  amountCents: string;
}

export interface TodaySettlementRow {
  id: string;
  periodStart: string;
  dueOn: string;
  status: string;
  paidCents: string;
  pendingCents: string;
  receiptConfirmed: boolean;
}

export interface UnconfirmedSlotRow {
  id: string;
  onDate: string;
  meal: MealSlot;
}

export interface TodayDecisionFacts {
  householdId: string;
  role: Role;
  membershipId: string;
  todayISO: string;
  extras: TodayExtraRow[];
  pendingExpenses: TodayExpenseRow[];
  settlements: TodaySettlementRow[];
  /** Huecos de hoy±3 días sin confirmación vigente. */
  unconfirmedSlots: UnconfirmedSlotRow[];
  /** Rutinas del rol que vencen hoy o antes. */
  dueRoutines: TodayRoutineView[];
}

function extraDetail(extra: TodayExtraRow): string {
  const base = `${dateLabel(extra.workedOn)} · ${formatMinutes(extra.durationMinutes)}`;
  return extra.note ? `${base} · ${extra.note}` : base;
}

/**
 * Bloque «Necesita tu decisión» por rol. Puro y determinista: recibe filas ya
 * filtradas por RLS y devuelve items ordenados con su href de resolución.
 *
 * - family_admin: jornadas extra requested/performed_pending_resolution,
 *   gastos pendientes, huecos de menú (hoy±3d) sin confirmar y liquidaciones
 *   cerradas con importe pendiente de pago.
 * - family_member: gastos y huecos, sin jornadas ni liquidaciones.
 * - employee_live_in: sus jornadas aceptadas por marcar realizadas, el cobro
 *   confirmable (cerrada, pagada del todo y sin confirmación) y su rutina de hoy.
 * - helper/viewer: nada que decidir (solo menú y rutinas visibles).
 */
export function buildTodayDecisions(facts: TodayDecisionFacts): TodayDecisionItem[] {
  const base = `/h/${facts.householdId}`;
  const items: TodayDecisionItem[] = [];
  const isAdmin = facts.role === 'family_admin';
  const isMember = facts.role === 'family_member';
  const isEmployee = facts.role === 'employee_live_in';

  if (isAdmin) {
    for (const extra of facts.extras) {
      if (extra.status === 'requested') {
        items.push({
          key: `extra-${extra.id}`,
          title: 'Jornada extra solicitada',
          detail: extraDetail(extra),
          href: `${base}/employment#extra-${extra.id}`,
          cta: 'Revisar'
        });
      } else if (extra.status === 'performed_pending_resolution') {
        items.push({
          key: `extra-${extra.id}`,
          title: 'Jornada extra por resolver',
          detail: extraDetail(extra),
          href: `${base}/employment#extra-${extra.id}`,
          cta: 'Resolver'
        });
      }
    }
  }

  if (isAdmin || isMember) {
    for (const expense of facts.pendingExpenses) {
      items.push({
        key: `gasto-${expense.id}`,
        title: 'Gasto pendiente de aprobar',
        detail: `${expense.description} · ${formatCents(expense.amountCents)} · ${dateLabel(expense.incurredOn)}`,
        href: `${base}/employment#gasto-${expense.id}`,
        cta: 'Revisar'
      });
    }
    if (facts.unconfirmedSlots.length > 0) {
      const sorted = [...facts.unconfirmedSlots].sort((a, b) => a.onDate.localeCompare(b.onDate));
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      items.push({
        key: 'menu-unconfirmed',
        title:
          sorted.length === 1
            ? `Hueco del menú sin confirmar (${MEAL_LABELS[first.meal].toLocaleLowerCase('es')} del ${dateLabel(first.onDate)})`
            : `${sorted.length} huecos del menú sin confirmar`,
        detail:
          sorted.length === 1
            ? 'La cocina espera la confirmación.'
            : `Entre el ${dateLabel(first.onDate)} y el ${dateLabel(last.onDate)}.`,
        href: `${base}/menu?week=${mondayOf(first.onDate)}`,
        cta: 'Confirmar'
      });
    }
  }

  if (isAdmin) {
    for (const settlement of facts.settlements) {
      if (settlement.status === 'closed' && parseCents(settlement.pendingCents) > 0n) {
        items.push({
          key: `liquidacion-${settlement.id}`,
          title: `Liquidación de ${periodLabel(settlement.periodStart.slice(0, 7)).toLocaleLowerCase('es')} pendiente de pago`,
          detail: `Pendiente ${formatCents(settlement.pendingCents)} · vence el ${dateLabel(settlement.dueOn)}`,
          href: `${base}/employment`,
          cta: 'Registrar pago'
        });
      }
    }
  }

  if (isEmployee) {
    for (const extra of facts.extras) {
      if (extra.status === 'accepted' && extra.employeeMembershipId === facts.membershipId) {
        items.push({
          key: `extra-${extra.id}`,
          title: 'Jornada aceptada: márcala cuando la realices',
          detail: extraDetail(extra),
          href: `${base}/employment#extra-${extra.id}`,
          cta: 'Marcar realizada'
        });
      }
    }
    for (const settlement of facts.settlements) {
      if (
        settlement.status === 'closed' &&
        parseCents(settlement.pendingCents) === 0n &&
        parseCents(settlement.paidCents) > 0n &&
        !settlement.receiptConfirmed
      ) {
        items.push({
          key: `cobro-${settlement.id}`,
          title: `Cobro de ${periodLabel(settlement.periodStart.slice(0, 7)).toLocaleLowerCase('es')} por confirmar`,
          detail: `${formatCents(settlement.paidCents)} pagados · confirma que lo has recibido`,
          href: `${base}/employment`,
          cta: 'Confirmar cobro'
        });
      }
    }
    for (const routine of facts.dueRoutines) {
      if (!routine.completedCurrent) {
        items.push({
          key: `rutina-${routine.id}`,
          title: `Rutina de hoy: ${routine.title}`,
          detail: routine.overdue ? `Vencía el ${dateLabel(routine.nextDueOn)}` : 'Vence hoy',
          // La acción vive en esta misma página: ancla a la sección de rutinas.
          href: '#rutinas-de-hoy',
          cta: 'Marcar hecha'
        });
      }
    }
  }

  return items;
}

/** «Buenos días» / «Buenas tardes» / «Buenas noches» según la hora de Madrid. */
export function greetingFor(hour: number): string {
  if (hour >= 6 && hour < 14) return 'Buenos días';
  if (hour >= 14 && hour < 21) return 'Buenas tardes';
  return 'Buenas noches';
}

/** «viernes, 7 de agosto» → «Viernes, 7 de agosto». */
export function headerDateLabel(todayISO: string): string {
  const raw = HEADER_LABEL.format(new Date(`${todayISO}T12:00:00Z`));
  return raw.charAt(0).toLocaleUpperCase('es') + raw.slice(1);
}

export async function loadTodayOverview(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<TodayOverview | null> {
  if (!pool) return null;
  const todayISO = MADRID_DATE.format(now);
  const windowStart = addDays(todayISO, -3);
  const windowEnd = addDays(todayISO, 3);

  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
      // Rutinas del rol (RLS filtra por audiencia) que vencen hoy o antes.
      const routineResult = await client.query<{
        id: string;
        title: string;
        details: string;
        nextDueOn: string;
        completedCurrent: boolean;
        frequency: TodayRoutineView['frequency'];
        intervalCount: number;
      }>(
        `select routine.id,
                routine.title,
                routine.details,
                routine.next_due_on::text as "nextDueOn",
                routine.frequency::text as "frequency",
                routine.interval_count as "intervalCount",
                exists (
                  select 1 from app.routine_completions as completion
                   where completion.household_id = routine.household_id
                     and completion.routine_id = routine.id
                     and completion.due_on = routine.next_due_on
                ) as "completedCurrent"
           from app.routines as routine
          where routine.household_id = $1
            and routine.archived_at is null
            and routine.next_due_on <= $2
          order by routine.next_due_on, routine.title`,
        [householdId, todayISO]
      );
      const routines: TodayRoutineView[] = routineResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        details: row.details,
        nextDueOn: row.nextDueOn,
        dueLabel: row.nextDueOn === todayISO ? 'Hoy' : `Vencía el ${dateLabel(row.nextDueOn)}`,
        overdue: row.nextDueOn < todayISO,
        completedCurrent: row.completedCurrent,
        frequency: row.frequency,
        intervalCount: row.intervalCount
      }));

      // Huecos de menú de hoy±3 días con su receta, grupo y confirmación. El
      // hash canónico se calcula en esta misma transacción (computeMenuSlotHash,
      // la función contra la que compara menu_slot.confirm): una confirmación
      // con hash antiguo cuenta como «sin confirmar».
      const slotResult = await client.query<{
        id: string;
        onDate: string;
        meal: MealSlot;
        groupName: string;
        freeText: string;
        notes: string;
        recipeTitle: string | null;
        confirmedHash: string | null;
      }>(
        `select slot.id,
                slot.on_date::text as "onDate",
                slot.meal::text as "meal",
                menu_group.name as "groupName",
                slot.free_text as "freeText",
                slot.notes,
                coalesce(revision.title, page.current_slug) as "recipeTitle",
                confirmation.content_hash as "confirmedHash"
           from app.menu_slots as slot
           join app.menu_groups as menu_group
             on menu_group.household_id = slot.household_id and menu_group.id = slot.group_id
           left join app.wiki_pages as page
             on page.household_id = slot.household_id and page.id = slot.recipe_page_id
           left join app.wiki_revisions as revision
             on revision.household_id = page.household_id and revision.id = page.current_revision_id
           left join app.menu_confirmations as confirmation
             on confirmation.household_id = slot.household_id and confirmation.slot_id = slot.id
          where slot.household_id = $1 and slot.on_date between $2 and $3
          order by slot.on_date, menu_group.name, slot.meal`,
        [householdId, windowStart, windowEnd]
      );

      const unconfirmedSlots: UnconfirmedSlotRow[] = [];
      const menu: TodayMenuSlotView[] = [];
      for (const slot of slotResult.rows) {
        const contentHash = await computeMenuSlotHash(client, householdId, slot.id);
        const hasContent = Boolean(slot.recipeTitle || slot.freeText);
        const confirmed = Boolean(contentHash && slot.confirmedHash === contentHash);
        if (hasContent && !confirmed) {
          unconfirmedSlots.push({ id: slot.id, onDate: slot.onDate, meal: slot.meal });
        }
        if (slot.onDate === todayISO) {
          menu.push({
            id: slot.id,
            meal: slot.meal,
            mealLabel: MEAL_LABELS[slot.meal] ?? slot.meal,
            groupName: slot.groupName,
            dish: slot.recipeTitle ?? slot.freeText,
            isRecipe: slot.recipeTitle !== null,
            notes: slot.notes,
            confirmed
          });
        }
      }

      // Hechos laborales: el acuerdo más relevante y sus pendientes. Para roles
      // sin acceso laboral (helper/viewer) RLS devuelve cero filas y el bloque
      // queda sin items de empleo.
      const agreementResult = await client.query<{ id: string }>(
        `select id from app.employment_agreements
          where household_id = $1
          order by (status = 'active') desc, starts_on desc
          limit 1`,
        [householdId]
      );
      const agreementId = agreementResult.rows[0]?.id ?? null;

      let extras: TodayExtraRow[] = [];
      let pendingExpenses: TodayExpenseRow[] = [];
      let settlements: TodaySettlementRow[] = [];
      if (agreementId) {
        const extrasResult = await client.query<TodayExtraRow>(
          `select id,
                  worked_on::text as "workedOn",
                  duration_minutes as "durationMinutes",
                  note,
                  status::text as "status",
                  employee_membership_id as "employeeMembershipId"
             from app.extra_work_events
            where household_id = $1 and agreement_id = $2
              and status in ('requested', 'accepted', 'performed', 'performed_pending_resolution')
            order by worked_on, requested_at`,
          [householdId, agreementId]
        );
        extras = extrasResult.rows;

        const expensesResult = await client.query<TodayExpenseRow>(
          `select id,
                  incurred_on::text as "incurredOn",
                  description,
                  amount_cents as "amountCents"
             from app.expenses
            where household_id = $1 and agreement_id = $2 and status = 'pending'
            order by incurred_on, submitted_at`,
          [householdId, agreementId]
        );
        pendingExpenses = expensesResult.rows;

        const settlementsResult = await client.query<{
          id: string;
          periodStart: string;
          dueOn: string;
          status: string;
          paidCents: string;
          pendingCents: string;
          receiptConfirmedAt: string | null;
        }>(
          `select settlement.id,
                  settlement.period_start::text as "periodStart",
                  settlement.due_on::text as "dueOn",
                  settlement.status::text as "status",
                  totals.paid_cents as "paidCents",
                  totals.pending_cents as "pendingCents",
                  confirmation.confirmed_at::text as "receiptConfirmedAt"
             from app.settlements as settlement
             join app.settlement_payment_totals as totals
               on totals.household_id = settlement.household_id
              and totals.settlement_id = settlement.id
             left join app.settlement_receipt_confirmations as confirmation
               on confirmation.household_id = settlement.household_id
              and confirmation.settlement_id = settlement.id
            where settlement.household_id = $1 and settlement.agreement_id = $2
              and settlement.status = 'closed'
            order by settlement.period_start desc`,
          [householdId, agreementId]
        );
        settlements = settlementsResult.rows.map((row) => ({
          id: row.id,
          periodStart: row.periodStart,
          dueOn: row.dueOn,
          status: row.status,
          paidCents: row.paidCents,
          pendingCents: row.pendingCents,
          receiptConfirmed: row.receiptConfirmedAt !== null
        }));
      }

      const decisions = buildTodayDecisions({
        householdId,
        role: membership.role,
        membershipId: membership.id,
        todayISO,
        extras,
        pendingExpenses,
        settlements,
        unconfirmedSlots,
        dueRoutines: routines
      });

      const hour = Number(MADRID_HOUR.format(now));
      return {
        householdId,
        role: membership.role,
        todayISO,
        dateLabel: headerDateLabel(todayISO),
        greeting: greetingFor(hour),
        decisions,
        menu,
        routines
      } satisfies TodayOverview;
    });
  } catch (cause) {
    // Sin membresía viva no hay hogar que enseñar; cualquier otra avería
    // degrada a la fixture para no tumbar la pantalla de aterrizaje.
    if (!(cause instanceof AuthorizationError)) {
      log.error('today overview unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}
