import { createHash } from 'node:crypto';

import { error } from '@sveltejs/kit';
import ical from 'ical-generator';
import { nextOccurrenceOnOrAfter, occurrencesBetween } from '@casa-clara/domain';

import { getDatabasePool } from '$lib/server/db.server';
import { routineRrule } from '$lib/server/ics-rrule.server';
import {
  routineScheduleFrom,
  type RoutineScheduleRow
} from '$lib/server/routine-rules.server';
import type { RequestHandler } from './$types';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
/**
 * Ventana de las ocurrencias SUELTAS: un año por delante, que es lo que mira un
 * calendario. Las cadencias que se dicen con RRULE no tienen ventana —la serie
 * es infinita y la expande el cliente—, de modo que esto solo gobierna el
 * repuesto de `month_day >= 29`.
 */
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
 * DESDE T8 LA CADENCIA SE PUBLICA COMO REGLA (§5.4). Un VEVENT con su `RRULE`
 * en vez de cientos sueltos: el suscriptor ve «esto se repite cada semana» y su
 * calendario no se queda seco al pasar el horizonte. La traducción vive en
 * `ics-rrule.server.ts` y es de todo o nada: cuando la RRULE no reproduciría
 * exactamente lo que genera el motor —`month_day >= 29`, donde la RFC salta los
 * meses cortos y nosotros recortamos— se vuelve a las ocurrencias explícitas,
 * que son feas pero ciertas.
 *
 * Dos decisiones del VEVENT repetido que conviene tener a la vista:
 *
 * · `DTSTART` es la PRIMERA ocurrencia de la regla contada desde el ancla, no
 *   la primera a partir de hoy. La RFC deja indefinido el conjunto generado por
 *   un `DTSTART` que no case con la regla, así que tiene que ser una ocurrencia
 *   de verdad; y tomando la del ancla el VEVENT sale idéntico en cada refresco,
 *   mientras que uno que empezara «hoy» cambiaría de `DTSTART` cada día sin
 *   subir `SEQUENCE`, que es justo la forma de que un cliente suscrito se quede
 *   con datos viejos. El precio, asumido, es que el pasado de la rutina también
 *   queda publicado; para una serie repetida no cuesta nada y §E2 ya dice que
 *   el pasado se ve.
 *
 * · Una rutina cuya cadencia ya terminó (`ends_on` pasado) no publica nada, ni
 *   siquiera su serie muerta.
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
    // Una cadencia agotada no publica ni su historia: sin ocurrencias por
    // delante no hay nada a lo que suscribirse.
    if (nextOccurrenceOnOrAfter(schedule, today) === null) continue;

    const summary = row.title ?? 'Rutina';
    const description = row.details || undefined;

    const rrule = routineRrule(schedule);
    const seriesStart = rrule === null ? null : nextOccurrenceOnOrAfter(schedule, schedule.anchorOn);
    if (rrule !== null && seriesStart !== null) {
      calendar.createEvent({
        id: `${row.routine_id}@casaclara`,
        start: new Date(`${seriesStart}T00:00:00.000Z`),
        allDay: true,
        summary,
        description,
        // La RRULE va como texto y no como objeto de opciones a propósito:
        // ical-generator escribe `UNTIL` en forma de DATE-TIME UTC, y la RFC
        // 5545 §3.3.10 exige que sea del mismo tipo que `DTSTART`, que aquí es
        // una DATE. Escribirla entera es la única manera de que `ends_on` se
        // publique sin ambigüedad de zona horaria.
        repeating: rrule
      });
      continue;
    }

    for (const dueOn of occurrencesBetween(schedule, today, horizon, {
      limit: MAX_EVENTS_PER_ROUTINE
    })) {
      calendar.createEvent({
        id: `${row.routine_id}-${dueOn}@casaclara`,
        start: new Date(`${dueOn}T00:00:00.000Z`),
        allDay: true,
        summary,
        description
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
