import { createHash } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GET } from '../src/routes/api/v1/ics/[token]/+server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.DATABASE_URL;

/**
 * El feed ICS, emitido de verdad y por su ruta.
 *
 * Por qué existe esta prueba: hasta la 0033 NO había ninguna que llamara a la
 * ruta, y por eso nadie se enteró de que llevaba desde la 0023 devolviendo un
 * calendario VACÍO. La función `app_private.ics_feed_events` había dejado de
 * publicar `frequency` en su tipo de retorno y el emisor descartaba en
 * silencio todas las filas por la comprobación `if (!row.frequency) continue`.
 * Ni una suite se puso roja: todas comprobaban el GRANT y el 404, ninguna que
 * un token bueno trajera algún evento.
 *
 * De ahí la forma de lo que se afirma aquí: no «responde 200», sino que el
 * calendario TRAE ocurrencias, y que son las de la regla.
 */
const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const FEED_TOKEN = 'token-de-prueba-del-feed-ics-0033';
const FEED_ID = '4a000000-0000-4000-8000-000000000001';
const ROUTINE_CON_CADENCIA = '4a100000-0000-4000-8000-000000000001';
const ROUTINE_SIN_CADENCIA = '4a100000-0000-4000-8000-000000000002';

/** La ruta solo usa `params`; el resto del evento no se toca. */
function request(token: string): Promise<Response> {
  return (GET as unknown as (event: { params: { token: string } }) => Promise<Response>)({
    params: { token }
  });
}

describe.runIf(Boolean(adminUrl))('feed ICS emitido desde Postgres', () => {
  let adminPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    await adminPool.query('begin');
    await adminPool.query('set local row_security = off');
    // Una rutina con cadencia rica —«los lunes y los jueves», que el
    // vocabulario viejo no sabía decir— y otra sin cadencia confirmada.
    await adminPool.query(
      `insert into app.routines
         (id, household_id, title, details, audience, next_due_hint,
          pattern, anchor_on, repeat_every, weekdays, overdue_policy, created_by_membership_id)
       values ($1, $3, 'Cocina a fondo (ICS)', 'Campana y horno', 'all', '2027-06-07',
               'days_of_week', '2027-06-07', 1, array[1,4]::smallint[], 'skip', $4),
              ($2, $3, 'Garaje algún día (ICS)', '', 'all', null,
               null, null, null, null, 'carry', $4)
       on conflict (id) do nothing`,
      [ROUTINE_CON_CADENCIA, ROUTINE_SIN_CADENCIA, FIXTURE_HOUSEHOLD, ADMIN_MEMBERSHIP]
    );
    await adminPool.query(
      `insert into app.ics_feeds (id, household_id, audience, token_hash, created_by_membership_id)
       values ($1, $2, 'all', $3, $4)
       on conflict (id) do update set revoked_at = null`,
      [
        FEED_ID,
        FIXTURE_HOUSEHOLD,
        createHash('sha256').update(FEED_TOKEN).digest('hex'),
        ADMIN_MEMBERSHIP
      ]
    );
    await adminPool.query('commit');
  });

  afterAll(async () => {
    await adminPool?.query('begin');
    await adminPool?.query('set local row_security = off');
    await adminPool?.query('delete from app.ics_feeds where id = $1', [FEED_ID]);
    await adminPool?.query('delete from app.routines where id = any($1::uuid[])', [
      [ROUTINE_CON_CADENCIA, ROUTINE_SIN_CADENCIA]
    ]);
    await adminPool?.query('commit');
    await adminPool?.end();
  });

  it('un token válido trae ocurrencias REALES, no un calendario vacío', async () => {
    const response = await request(FEED_TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');

    const body = await response.text();
    expect(body).toContain('BEGIN:VCALENDAR');

    // Lo que la regresión protege: que haya eventos. Con el emisor anterior
    // esto era exactamente cero y nadie lo veía.
    const events = body.split('BEGIN:VEVENT').length - 1;
    expect(events).toBeGreaterThan(0);
    expect(body).toContain('Cocina a fondo (ICS)');
  });

  it('las ocurrencias son las de la regla: lunes y jueves, no una por semana', async () => {
    const body = await request(FEED_TOKEN).then((response) => response.text());
    const fechas = [...body.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((match) => match[1]);
    expect(fechas.length).toBeGreaterThan(0);

    // «Los lunes y los jueves» son DOS ocurrencias por semana. El emisor viejo
    // solo sabía avanzar un intervalo fijo desde una fecha, así que esta
    // cadencia era literalmente inexpresable para él.
    const diasDeLaSemana = new Set(
      fechas.map((fecha) => {
        const iso = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;
        const dia = new Date(`${iso}T00:00:00Z`).getUTCDay();
        return dia === 0 ? 7 : dia;
      })
    );
    expect([...diasDeLaSemana].sort()).toEqual([1, 4]);
  });

  it('una rutina sin cadencia confirmada no publica nada (§2.3)', async () => {
    const body = await request(FEED_TOKEN).then((response) => response.text());
    expect(body).not.toContain('Garaje algún día (ICS)');
  });

  it('un token revocado deja de servir, y uno desconocido no existe', async () => {
    await adminPool.query('begin');
    await adminPool.query('set local row_security = off');
    await adminPool.query('update app.ics_feeds set revoked_at = now() where id = $1', [FEED_ID]);
    await adminPool.query('commit');

    await expect(request(FEED_TOKEN)).rejects.toMatchObject({ status: 404 });
    await expect(request('token-que-no-existe-en-esta-casa')).rejects.toMatchObject({
      status: 404
    });

    await adminPool.query('begin');
    await adminPool.query('set local row_security = off');
    await adminPool.query('update app.ics_feeds set revoked_at = null where id = $1', [FEED_ID]);
    await adminPool.query('commit');
  });
});
