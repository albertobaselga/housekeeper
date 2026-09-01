import type { Pool } from 'pg';

import type { Role } from '@housekeeper/contracts';
import type { RoutineOverduePolicy, RoutineSchedule } from '@housekeeper/domain';
import { cadenceClause } from '@housekeeper/domain';
import { createLogger, withAuthorizedTransaction } from '@housekeeper/server';

import {
  monthGridRange,
  resolveAnchor,
  resolveScope,
  type CalendarCompletionView,
  type CalendarEventView,
  type CalendarRoutineView,
  type CalendarScope
} from '$lib/calendar/view';
import { unreadable } from './data-source.server';
import { getDatabasePool } from './db.server';

const log = createLogger('web:calendar');

/**
 * Calendario UNIFICADO: rutinas y eventos en la misma página, en tres alcances
 * (enmienda E1 de `docs/rutinas-y-calendario.md`) y con el pasado consultable
 * por hechos y autoría (E2).
 *
 * Cuatro decisiones que gobiernan este módulo:
 *
 * · LA SEPARACIÓN POR AUDIENCIA LA HACE LA RLS, NO ESTE CÓDIGO (E3). El SELECT
 *   de `app.routines` no lleva un solo `and audience = …`: la política
 *   `routines_read` de la 0008 ya dice que la familia lo ve todo, la empleada
 *   `employee` y `all`, y el apoyo solo `all`. Filtrar aquí ADEMÁS de allí sería
 *   duplicar la regla en el sitio donde se puede olvidar; filtrar SOLO aquí
 *   dejaría las filas ajenas viajando en el JSON de la página aunque no se
 *   pintaran. Por eso la prueba negativa mira el HTML *y* el payload.
 *
 * · SE MANDAN REGLAS, NO OCURRENCIAS. Un hogar tiene 10-40 rutinas; sus reglas
 *   son unos pocos kilobytes y con ellas el navegador pinta CUALQUIER semana,
 *   mes o año sin volver al servidor —y por tanto sin red—. Mandar las
 *   ocurrencias ya expandidas costaría una fila por rutina y día (un año son
 *   ~12.000) y dejaría muerta la navegación sin conexión. La expansión la hace
 *   el motor puro de `@housekeeper/domain`, el mismo que usan Hoy y el ICS.
 *
 * · LOS EVENTOS Y LA AUTORÍA NO SE PUEDEN CALCULAR: se descargan. Por eso hay
 *   una VENTANA DE DETALLE explícita —la rejilla de seis semanas del mes del
 *   ancla— y la página dice cuándo se sale de ella, en vez de pintar un día
 *   pasado «sin marcar» cuando lo que ocurre es que no se ha descargado. La
 *   distinción no es cosmética: dar por no hecha una tarea de la que no se
 *   tienen datos es el falso negativo que la enmienda E2 prohíbe.
 *
 * · NI UN AGREGADO QUE PUNTÚE A NADIE (E2 / AC-26 revisado). Aquí no se calcula
 *   ningún porcentaje, racha, media, comparativa ni nota, y lo vigila
 *   `tests/calendar-no-metrics.test.ts`, que lee este fichero y la página.
 */

export {
  CALENDAR_SCOPES,
  MONTH_GRID_DAYS,
  monthGridRange,
  resolveAnchor,
  resolveScope
} from '$lib/calendar/view';
export type {
  CalendarCompletionView,
  CalendarEventView,
  CalendarRoutineView,
  CalendarScope
} from '$lib/calendar/view';

// ─────────────────────────────────────────────────────────────────────────────
// Etiquetas (Intl vive en el servidor: no cuesta un byte de bundle)
// ─────────────────────────────────────────────────────────────────────────────

const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
const TIME_LABEL = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const DAY_LABEL = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC'
});
const MONTH_LABEL = new Intl.DateTimeFormat('es-ES', {
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Madrid'
});
const SYNC_LABEL = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Madrid'
});

function capitalize(value: string): string {
  return value.charAt(0).toLocaleUpperCase('es') + value.slice(1);
}

/** «viernes, 7 de agosto» (capitalizado) a partir de una fecha ISO local. */
export function calendarDayLabel(dateISO: string): string {
  return capitalize(DAY_LABEL.format(new Date(`${dateISO}T12:00:00Z`)));
}

const AUDIENCE_LABEL: Readonly<Record<string, string>> = Object.freeze({
  family: 'Familia',
  employee: 'Empleada',
  all: 'Toda la casa'
});

// ─────────────────────────────────────────────────────────────────────────────
// Vistas
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarSourceView {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  /** «7 ago, 09:15» de la última lectura correcta; null si nunca se leyó. */
  lastSyncLabel: string | null;
  /** Último error de lectura, ya en crudo (la UI lo traduce a lenguaje llano). */
  lastError: string | null;
}

export interface CalendarOverview {
  householdId: string;
  role: Role;
  /** Solo la administración enlaza o quita calendarios (RLS ics_sources_admin). */
  canManage: boolean;
  todayISO: string;
  /** Alcance y día de referencia con los que se sirvió esta carga. */
  scope: CalendarScope;
  anchorISO: string;
  monthLabel: string;
  /** Ventana con detalle descargado: eventos y autoría solo son fiables aquí. */
  windowFromISO: string;
  windowToISO: string;
  /**
   * Cuándo se leyó esto («7 ago, 09:15»). Sin conexión la página se sirve de la
   * caché del service worker y hay que poder decir de cuándo es lo que se ve,
   * en vez de un «sin conexión» a secas que no dice si son datos de hoy o de la
   * semana pasada.
   */
  loadedAtLabel: string;
  /** Reglas visibles para quien mira, ya filtradas por la RLS de la 0008. */
  routines: CalendarRoutineView[];
  /** Finalizaciones dentro de la ventana, con su autoría. */
  completions: CalendarCompletionView[];
  /** Eventos dentro de la ventana, en orden cronológico. */
  events: CalendarEventView[];
  /** Año para el que se conocen los días con eventos (alcance «año»). */
  eventDaysYear: number;
  /** Días de ese año con al menos un evento. Densidad, no detalle. */
  eventDaysISO: string[];
  /** Fuentes del hogar; vacío para quien no es administración. */
  sources: CalendarSourceView[];
}

interface EventRow {
  id: string;
  onDate: string;
  startsAt: Date;
  endsAt: Date | null;
  endDate: string | null;
  allDay: boolean;
  summary: string;
  location: string | null;
  sourceLabel: string;
}

/** Filas ya filtradas por RLS → eventos con sus etiquetas. Pura y testeable. */
export function mapCalendarEvents(rows: EventRow[]): CalendarEventView[] {
  return rows.map((row) => ({
    id: row.id,
    dateISO: row.onDate,
    timeLabel: row.allDay ? 'Todo el día' : TIME_LABEL.format(row.startsAt),
    endLabel:
      !row.allDay && row.endsAt !== null && row.endDate === row.onDate
        ? TIME_LABEL.format(row.endsAt)
        : null,
    allDay: row.allDay,
    title: row.summary,
    location: row.location,
    sourceLabel: row.sourceLabel
  }));
}

export interface RoutineRow {
  id: string;
  title: string;
  details: string;
  audience: 'family' | 'employee' | 'all';
  pattern: string | null;
  anchorOn: string | null;
  repeatEvery: number | null;
  weekdays: number[] | null;
  monthDay: number | null;
  months: number[] | null;
  endsOn: string | null;
  overduePolicy: RoutineOverduePolicy;
}

/**
 * Fila de patrón → regla del generador. A diferencia del camino de escritura
 * (`rhythm.ts`, que rechaza el comando), aquí una fila incoherente devuelve
 * `null` y la rutina se lee como «sin día todavía»: una pantalla de lectura no
 * puede caerse por un dato viejo, y el estado «sin cadencia confirmada» (§2.3)
 * ya existe y dice la verdad sobre lo que se sabe.
 */
export function scheduleFromRoutineRow(row: RoutineRow): RoutineSchedule {
  const anchorOn = row.anchorOn;
  if (row.pattern === null || anchorOn === null) return null;
  const endsOn = row.endsOn;
  // `smallint[]` llega como números con node-pg, pero una siembra vieja o un
  // driver distinto podrían darlos como cadenas: normalizar es barato.
  const numbers = (values: number[] | null): number[] | null =>
    values === null ? null : values.map(Number);
  switch (row.pattern) {
    case 'every_n_days':
      return row.repeatEvery === null
        ? null
        : { pattern: 'every_n_days', anchorOn, repeatEvery: row.repeatEvery, endsOn };
    case 'days_of_week': {
      const weekdays = numbers(row.weekdays);
      return row.repeatEvery === null || weekdays === null || weekdays.length === 0
        ? null
        : { pattern: 'days_of_week', anchorOn, repeatEvery: row.repeatEvery, weekdays, endsOn };
    }
    case 'day_of_month':
      return row.repeatEvery === null || row.monthDay === null
        ? null
        : {
            pattern: 'day_of_month',
            anchorOn,
            repeatEvery: row.repeatEvery,
            monthDay: Number(row.monthDay),
            endsOn
          };
    case 'months_of_year': {
      const months = numbers(row.months);
      return months === null || months.length === 0 || row.monthDay === null
        ? null
        : { pattern: 'months_of_year', anchorOn, months, monthDay: Number(row.monthDay), endsOn };
    }
    default:
      return null;
  }
}

/** Filas de rutina → vistas con su frase de cadencia. Pura y testeable. */
export function mapCalendarRoutines(rows: RoutineRow[]): CalendarRoutineView[] {
  return rows.map((row) => {
    const rule = scheduleFromRoutineRow(row);
    return {
      id: row.id,
      title: row.title,
      details: row.details,
      audience: row.audience,
      audienceLabel: AUDIENCE_LABEL[row.audience] ?? 'Toda la casa',
      cadence: cadenceClause(rule),
      rule,
      overduePolicy: row.overduePolicy
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Carga
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarRequest {
  scope?: string | null;
  anchor?: string | null;
}

/**
 * Carga bajo UNA withAuthorizedTransaction (patrón today.server.ts). Devuelve
 * null solo sin pool (demo sin DATABASE_URL) o sin membresía autorizada; la
 * página cae entonces a la fixture de demostración.
 */
export async function loadCalendar(
  user: { id: string },
  householdId: string,
  request: CalendarRequest = {},
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<CalendarOverview | null> {
  if (!pool) return null;
  const todayISO = MADRID_DATE.format(now);
  const scope = resolveScope(request.scope);
  const anchorISO = resolveAnchor(request.anchor, todayISO);
  const { fromISO, toISO } = monthGridRange(anchorISO);
  const eventDaysYear = Number(anchorISO.slice(0, 4));

  try {
    return await withAuthorizedTransaction(
      pool,
      { userId: user.id },
      householdId,
      async (client, membership) => {
        // ── Reglas ──────────────────────────────────────────────────────────
        // Sin un solo filtro de audiencia: lo hace `routines_read` (0008). La
        // prueba negativa de E3 vive en `apps/web/e2e/calendar.dbe2e.ts`.
        const routines = await client.query<RoutineRow>(
          `select id,
                  title,
                  details,
                  audience::text as "audience",
                  pattern::text as "pattern",
                  anchor_on::text as "anchorOn",
                  repeat_every as "repeatEvery",
                  weekdays as "weekdays",
                  month_day as "monthDay",
                  months as "months",
                  ends_on::text as "endsOn",
                  overdue_policy::text as "overduePolicy"
             from app.routines
            where household_id = $1
              and archived_at is null
            order by title`,
          [householdId]
        );

        // ── Lo que se hizo, y quién lo marcó (E2) ───────────────────────────
        // La RLS de `routine_completions` se apoya en un EXISTS sobre
        // `app.routines`, que a su vez está bajo `routines_read`: quien no ve la
        // rutina tampoco ve sus finalizaciones. El nombre sale del perfil; si la
        // RLS no deja leerlo, el LEFT JOIN da null y se pone etiqueta neutra.
        const completions = await client.query<{
          routineId: string;
          dueOn: string;
          completedOn: string;
          byName: string | null;
        }>(
          `select completion.routine_id as "routineId",
                  completion.due_on::text as "dueOn",
                  (completion.completed_at at time zone 'Europe/Madrid')::date::text as "completedOn",
                  profile.display_name as "byName"
             from app.routine_completions as completion
             left join app.household_memberships as membership
               on membership.household_id = completion.household_id
              and membership.id = completion.completed_by_membership_id
             left join app.user_profiles as profile on profile.user_id = membership.user_id
            where completion.household_id = $1
              and completion.due_on between $2::date and $3::date
            order by completion.due_on`,
          [householdId, fromISO, toISO]
        );

        // ── Eventos con detalle, dentro de la ventana ───────────────────────
        const events = await client.query<EventRow>(
          `select id,
                  (starts_at at time zone 'Europe/Madrid')::date::text as "onDate",
                  starts_at as "startsAt",
                  ends_at as "endsAt",
                  (ends_at at time zone 'Europe/Madrid')::date::text as "endDate",
                  all_day as "allDay",
                  summary,
                  location,
                  source_label as "sourceLabel"
             from app.ics_source_events
            where household_id = $1
              and (starts_at at time zone 'Europe/Madrid')::date between $2::date and $3::date
            order by starts_at, summary`,
          [householdId, fromISO, toISO]
        );

        // ── Densidad del año: solo los DÍAS con algo, no los eventos ────────
        // El alcance «año» responde «¿cuándo toca lo estacional?», y para eso
        // basta la marca. Traerse un año de eventos con su detalle serían
        // decenas de kilobytes en el payload de un móvil a cambio de nada que
        // se lea a esa escala.
        const eventDays = await client.query<{ dateISO: string }>(
          `select distinct (starts_at at time zone 'Europe/Madrid')::date::text as "dateISO"
             from app.ics_source_events
            where household_id = $1
              and (starts_at at time zone 'Europe/Madrid')::date
                  between make_date($2, 1, 1) and make_date($2, 12, 31)
            order by 1`,
          [householdId, eventDaysYear]
        );

        // Fuentes: la RLS de ics_sources es solo de administración; para el
        // resto de roles este SELECT devuelve cero filas y no se enseña gestión.
        const sources = await client.query<{
          id: string;
          label: string;
          url: string;
          enabled: boolean;
          lastFetchedAt: Date | null;
          lastError: string | null;
        }>(
          `select id, label, url, enabled,
                  last_fetched_at as "lastFetchedAt",
                  last_error as "lastError"
             from app.ics_sources
            where household_id = $1
            order by created_at, label`,
          [householdId]
        );

        return {
          householdId,
          role: membership.role,
          canManage: membership.role === 'family_admin',
          todayISO,
          scope,
          anchorISO,
          monthLabel: capitalize(MONTH_LABEL.format(now)),
          windowFromISO: fromISO,
          windowToISO: toISO,
          loadedAtLabel: SYNC_LABEL.format(now),
          routines: mapCalendarRoutines(routines.rows),
          completions: completions.rows.map((row) => ({
            routineId: row.routineId,
            dueOn: row.dueOn,
            completedOn: row.completedOn,
            byName: row.byName ?? 'Alguien de la casa'
          })),
          events: mapCalendarEvents(events.rows),
          eventDaysYear,
          eventDaysISO: eventDays.rows.map((row) => row.dateISO),
          sources: sources.rows.map((row) => ({
            id: row.id,
            label: row.label,
            url: row.url,
            enabled: row.enabled,
            lastSyncLabel: row.lastFetchedAt ? SYNC_LABEL.format(row.lastFetchedAt) : null,
            lastError: row.lastError
          }))
        } satisfies CalendarOverview;
      }
    );
  } catch (cause) {
    return unreadable(log, 'calendar', cause);
  }
}
