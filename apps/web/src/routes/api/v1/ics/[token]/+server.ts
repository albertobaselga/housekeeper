import { createHash } from 'node:crypto';

import { error } from '@sveltejs/kit';
import ical from 'ical-generator';
import { occurrencesBetween } from '@casa-clara/domain';

import { getDatabasePool } from '$lib/server/db.server';
import {
  routineScheduleFrom,
  type RoutineScheduleRow
} from '$lib/server/routine-rules.server';
import type { RequestHandler } from './$types';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
/** Ventana publicada: un año por delante, que es lo que mira un calendario. */
const HORIZON_DAYS = 365;
/** Tope por rutina, para que una diaria no llene el feed ella sola. */
const MAX_EVENTS_PER_ROUTINE = 60;

interface FeedRow extends RoutineScheduleRow {
  feed_id: string;
  household_id: string;
  feed_audience: string;
  routine_id: string | null;
  title: string | null;
  details: string | null;
}

/** `YYYY-MM-DD` desplazado n días, sin tocar la zona del proceso. */
function addDaysISO(isoDate: string, days: number): string {
  const shifted = new Date(`${isoDate}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Feed ICS público por token (sin sesión). La única puerta a los datos es la
 * función SECURITY DEFINER `app_private.ics_feed_events`: conocer el token
 * equivale a la autorización, el servidor solo guarda su sha-256 y la
 * revocación corta el acceso al instante. La emisión usa ical-generator para
 * producir un .ics interoperable (plegado, CRLF, escapado).
 *
 * Las ocurrencias las genera el motor puro de `@casa-clara/domain` desde las
 * columnas de patrón, que son la verdad de la cadencia. Antes se proyectaban
 * avanzando `next_due_on` con la frecuencia heredada; eso dejó de funcionar en
 * cuanto la 0023 sacó `frequency` del tipo de retorno de la función —el feed
 * llevaba desde entonces devolviendo un calendario VACÍO, callando— y la 0033
 * ha borrado la columna. `next_due_hint` no se usa para generar: es una caché
 * que solo promete ser cota inferior, y un calendario que arrancara en ella
 * podría repetir lo ya hecho o empezar tarde.
 *
 * Sigue emitiendo ocurrencias explícitas y no RRULE: la emisión fiel con RRULE
 * es trabajo aparte (§5.4, T8), y hasta que llegue vale más un calendario que
 * dice la verdad con muchas líneas que uno vacío.
 */
export const GET: RequestHandler = async ({ params }) => {
  if (!TOKEN_PATTERN.test(params.token)) error(404, 'Ese calendario ya no existe');
  const pool = getDatabasePool();
  if (!pool) error(404, 'Ese calendario ya no existe');

  const tokenHash = createHash('sha256').update(params.token).digest('hex');
  const result = await pool.query<FeedRow>(
    `select feed_id, household_id, feed_audience, routine_id, title, details,
            pattern as "pattern", anchor_on::text as "anchorOn",
            repeat_every as "repeatEvery", weekdays::int[] as "weekdays",
            month_day::int as "monthDay", months::int[] as "months",
            ends_on::text as "endsOn"
       from app_private.ics_feed_events($1)`,
    [tokenHash]
  );
  if (result.rows.length === 0) error(404, 'Ese calendario ya no existe');

  const calendar = ical({
    // El feed es público por token: se nombra por lo que trae, no por la casa
    // que hay detrás (quien tenga la URL no tiene por qué saberlo).
    name: 'Rutinas del hogar',
    prodId: { company: 'Casa Clara', product: 'routines', language: 'ES' }
  });

  // El día del hogar, no el del proceso: una ocurrencia es un día de calendario.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
  const horizon = addDaysISO(today, HORIZON_DAYS);

  for (const row of result.rows) {
    if (!row.routine_id) continue;
    // Una rutina sin cadencia confirmada no publica nada. La función ya las
    // filtra, pero el lector no se fía: `null` aquí significa lo mismo.
    const schedule = routineScheduleFrom(row);
    if (schedule === null) continue;
    for (const dueOn of occurrencesBetween(schedule, today, horizon, {
      limit: MAX_EVENTS_PER_ROUTINE
    })) {
      calendar.createEvent({
        id: `${row.routine_id}-${dueOn}@casaclara`,
        start: new Date(`${dueOn}T00:00:00.000Z`),
        allDay: true,
        summary: row.title ?? 'Rutina',
        description: row.details || undefined
      });
    }
  }

  return new Response(calendar.toString(), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
};
