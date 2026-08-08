import type { Pool } from 'pg';

import type { Role } from '@casa-clara/contracts';
import { AuthorizationError, createLogger, errorCode, withAuthorizedTransaction } from '@casa-clara/server';

import { addDays } from '$lib/food/dates';
import { getDatabasePool } from './db.server';

const log = createLogger('web:calendar');

/**
 * Calendario real (Ola E): agenda de los próximos días leída de Postgres bajo
 * RLS desde app.ics_source_events (ocurrencias que el worker persiste de los
 * calendarios enlazados). La política de lectura calca calendar.read (familia,
 * empleada y visor; el apoyo no llega a esta página). Las fuentes solo las ve
 * la administración (policy ics_sources_admin): para el resto la lista llega
 * vacía y la UI no especula sobre lo que no puede saber.
 */

/** Días de agenda por delante de hoy (hoy incluido). */
export const CALENDAR_AGENDA_DAYS = 30;

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

export interface CalendarEventView {
  id: string;
  /** «16:45», o «Todo el día» para eventos de día completo. */
  timeLabel: string;
  /** «17:30» si el evento acaba el mismo día; null en el resto de casos. */
  endLabel: string | null;
  allDay: boolean;
  title: string;
  location: string | null;
  /** Nombre del calendario enlazado del que viene el evento. */
  sourceLabel: string;
}

export interface CalendarDayView {
  dateISO: string;
  label: string;
  isToday: boolean;
  events: CalendarEventView[];
}

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
  monthLabel: string;
  /** Días con eventos dentro de la ventana, en orden cronológico. */
  days: CalendarDayView[];
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

/** Filas ya filtradas por RLS → agenda agrupada por día local. Pura y testeable. */
export function groupCalendarDays(rows: EventRow[], todayISO: string): CalendarDayView[] {
  const days: CalendarDayView[] = [];
  for (const row of rows) {
    let day = days[days.length - 1];
    if (!day || day.dateISO !== row.onDate) {
      day = { dateISO: row.onDate, label: calendarDayLabel(row.onDate), isToday: row.onDate === todayISO, events: [] };
      days.push(day);
    }
    day.events.push({
      id: row.id,
      timeLabel: row.allDay ? 'Todo el día' : TIME_LABEL.format(row.startsAt),
      endLabel:
        !row.allDay && row.endsAt !== null && row.endDate === row.onDate ? TIME_LABEL.format(row.endsAt) : null,
      allDay: row.allDay,
      title: row.summary,
      location: row.location,
      sourceLabel: row.sourceLabel
    });
  }
  return days;
}

/**
 * Carga bajo UNA withAuthorizedTransaction (patrón today.server.ts). Devuelve
 * null solo sin pool (demo sin DATABASE_URL) o sin membresía autorizada; la
 * página cae entonces a la fixture de demostración.
 */
export async function loadCalendar(
  user: { id: string },
  householdId: string,
  pool: Pool | null = getDatabasePool(),
  now: Date = new Date()
): Promise<CalendarOverview | null> {
  if (!pool) return null;
  const todayISO = MADRID_DATE.format(now);
  const windowEnd = addDays(todayISO, CALENDAR_AGENDA_DAYS - 1);

  try {
    return await withAuthorizedTransaction(pool, { userId: user.id }, householdId, async (client, membership) => {
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
        [householdId, todayISO, windowEnd]
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
        monthLabel: capitalize(MONTH_LABEL.format(now)),
        days: groupCalendarDays(events.rows, todayISO),
        sources: sources.rows.map((row) => ({
          id: row.id,
          label: row.label,
          url: row.url,
          enabled: row.enabled,
          lastSyncLabel: row.lastFetchedAt ? SYNC_LABEL.format(row.lastFetchedAt) : null,
          lastError: row.lastError
        }))
      } satisfies CalendarOverview;
    });
  } catch (cause) {
    if (!(cause instanceof AuthorizationError)) {
      log.error('calendar unavailable', { code: errorCode(cause) });
    }
    return null;
  }
}
