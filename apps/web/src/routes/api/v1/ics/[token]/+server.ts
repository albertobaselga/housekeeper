import { createHash } from 'node:crypto';

import { error } from '@sveltejs/kit';
import ical from 'ical-generator';
import { advanceDueDate } from '@casa-clara/server';

import { getDatabasePool } from '$lib/server/db.server';
import type { RequestHandler } from './$types';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const PROJECTED_OCCURRENCES = 8;

interface FeedRow {
  feed_id: string;
  household_id: string;
  feed_audience: string;
  routine_id: string | null;
  title: string | null;
  details: string | null;
  next_due_on: string | null;
  frequency: string | null;
  interval_count: number | null;
}

/**
 * Feed ICS público por token (sin sesión). La única puerta a los datos es la
 * función SECURITY DEFINER `app_private.ics_feed_events` (migración 0009):
 * conocer el token equivale a la autorización, el servidor solo guarda su
 * sha-256 y la revocación corta el acceso al instante. La emisión usa
 * ical-generator para producir un .ics interoperable (plegado, CRLF, escapado).
 */
export const GET: RequestHandler = async ({ params }) => {
  if (!TOKEN_PATTERN.test(params.token)) error(404, 'Ese calendario ya no existe');
  const pool = getDatabasePool();
  if (!pool) error(404, 'Ese calendario ya no existe');

  const tokenHash = createHash('sha256').update(params.token).digest('hex');
  const result = await pool.query<FeedRow>(
    'select * from app_private.ics_feed_events($1)',
    [tokenHash]
  );
  if (result.rows.length === 0) error(404, 'Ese calendario ya no existe');

  const calendar = ical({
    name: 'Casa Clara · rutinas',
    prodId: { company: 'Casa Clara', product: 'routines', language: 'ES' }
  });

  for (const row of result.rows) {
    if (!row.routine_id || !row.next_due_on || !row.frequency || !row.interval_count) continue;
    let dueOn = row.next_due_on;
    for (let occurrence = 0; occurrence < PROJECTED_OCCURRENCES; occurrence += 1) {
      calendar.createEvent({
        id: `${row.routine_id}-${dueOn}@casaclara`,
        start: new Date(`${dueOn}T00:00:00.000Z`),
        allDay: true,
        summary: row.title ?? 'Rutina',
        description: row.details || undefined
      });
      dueOn = advanceDueDate(
        dueOn,
        row.frequency as 'daily' | 'weekly' | 'monthly' | 'quarterly',
        row.interval_count
      );
    }
  }

  return new Response(calendar.toString(), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
};
