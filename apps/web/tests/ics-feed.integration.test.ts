import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { occurrencesBetween, type RoutineRule } from '@housekeeper/domain';

import { GET } from '../src/routes/api/v1/ics/[token]/+server';
import { FIXTURE_HOUSEHOLD } from './helpers';
import { expandRrule } from './rrule-expand';

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
 * calendario TRAE la cadencia, y que es la de la regla. Con T8 eso quiere decir
 * una `RRULE` cuando se puede decir con fidelidad y ocurrencias sueltas cuando
 * no (`month_day >= 29`), y la comparación se hace expandiendo el texto que la
 * ruta ha emitido —no el que esta prueba esperaba— contra el motor puro.
 *
 * La suite se montaba sobre `DATABASE_URL` a secas y sobre el esquema que
 * hubiera en ella. En CI solo se exporta `TEST_DATABASE_URL` (ci.yml:160), así
 * que la regresión que la 0033 estrenó para que esto no volviera a pasar
 * llevaba desde entonces SALTÁNDOSE ENTERA. Ahora se provisiona su propia base,
 * como hacen hoy/snapshot/wiki, y se le dice a la ruta dónde está.
 */
const ICS_DB = 'housekeeper_ics_it';
const APP_LOGIN = 'it_housekeeper_ics_login';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// La ruta pide su pool a `$env/dynamic/private`, así que la base de esta suite
// se declara ahí. `vi.mock` se iza por encima de los imports: el valor tiene
// que calcularse en un `vi.hoisted` o llegaría `undefined`.
const FEED_DATABASE_URL = vi.hoisted(() => {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) return '';
  const url = new URL(base);
  url.pathname = '/housekeeper_ics_it';
  url.username = 'it_housekeeper_ics_login';
  url.password = 'integration-only';
  return url.toString();
});
vi.mock('$env/dynamic/private', () => ({ env: { DATABASE_URL: FEED_DATABASE_URL } }));

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const FEED_TOKEN = 'token-de-prueba-del-feed-ics-0033';
const FEED_ID = '4a000000-0000-4000-8000-000000000001';
const ROUTINE_SEMANAL = '4a100000-0000-4000-8000-000000000001';
const ROUTINE_SIN_CADENCIA = '4a100000-0000-4000-8000-000000000002';
const ROUTINE_DIA_31 = '4a100000-0000-4000-8000-000000000003';
const ROUTINE_TEMPORADAS = '4a100000-0000-4000-8000-000000000004';
const ROUTINE_TERMINADA = '4a100000-0000-4000-8000-000000000005';

/** El mismo «hoy» que usa la ruta: día civil de Madrid. */
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
const HORIZON_DAYS = 365;

function addDays(isoDate: string, days: number): string {
  const shifted = new Date(`${isoDate}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Anclas en el pasado, para que la serie publicada no dependa del día de hoy. */
const ANCLA_VIEJA = addDays(TODAY, -400);
const FIN_PASADO = addDays(TODAY, -30);

const REGLA_SEMANAL: RoutineRule = {
  pattern: 'days_of_week',
  anchorOn: ANCLA_VIEJA,
  repeatEvery: 1,
  weekdays: [1, 4]
};
const REGLA_DIA_31: RoutineRule = {
  pattern: 'day_of_month',
  anchorOn: ANCLA_VIEJA,
  repeatEvery: 1,
  monthDay: 31
};
const REGLA_TEMPORADAS: RoutineRule = {
  pattern: 'months_of_year',
  anchorOn: ANCLA_VIEJA,
  months: [6, 12],
  monthDay: 1
};

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.routines
  (id, household_id, title, details, audience, next_due_hint,
   pattern, anchor_on, repeat_every, weekdays, month_day, months, ends_on,
   overdue_policy, created_by_membership_id) VALUES
  -- Cadencia rica que el vocabulario viejo no sabía decir, y que sí se expresa
  -- entera con FREQ=WEEKLY;BYDAY=MO,TH.
  ('${ROUTINE_SEMANAL}', '${FIXTURE_HOUSEHOLD}', 'Cocina a fondo (ICS)', 'Campana y horno', 'all', NULL,
   'days_of_week', '${ANCLA_VIEJA}', 1, ARRAY[1,4]::smallint[], NULL, NULL, NULL, 'skip', '${ADMIN_MEMBERSHIP}'),
  -- Sin cadencia confirmada (§2.3): no publica nada.
  ('${ROUTINE_SIN_CADENCIA}', '${FIXTURE_HOUSEHOLD}', 'Garaje algún día (ICS)', '', 'all', NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'carry', '${ADMIN_MEMBERSHIP}'),
  -- El caso que NO se puede decir con RRULE: la RFC salta los meses sin día 31.
  ('${ROUTINE_DIA_31}', '${FIXTURE_HOUSEHOLD}', 'Limpieza a fondo (ICS)', '', 'all', NULL,
   'day_of_month', '${ANCLA_VIEJA}', 1, NULL, 31::smallint, NULL, NULL, 'carry', '${ADMIN_MEMBERSHIP}'),
  -- Estacional: FREQ=YEARLY, que el parser de entrada del worker ni siquiera
  -- acepta y que el modelo sí sabe decir.
  ('${ROUTINE_TEMPORADAS}', '${FIXTURE_HOUSEHOLD}', 'Ropa de temporada (ICS)', '', 'all', NULL,
   'months_of_year', '${ANCLA_VIEJA}', NULL, NULL, 1::smallint, ARRAY[6,12]::smallint[], NULL, 'carry', '${ADMIN_MEMBERSHIP}'),
  -- Cadencia agotada: ni serie muerta ni ocurrencias.
  ('${ROUTINE_TERMINADA}', '${FIXTURE_HOUSEHOLD}', 'Mudanza terminada (ICS)', '', 'all', NULL,
   'every_n_days', '${ANCLA_VIEJA}', 7, NULL, NULL, NULL, '${FIN_PASADO}', 'carry', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.ics_feeds (id, household_id, audience, token_hash, created_by_membership_id)
VALUES ('${FEED_ID}', '${FIXTURE_HOUSEHOLD}', 'all',
        '${createHash('sha256').update(FEED_TOKEN).digest('hex')}', '${ADMIN_MEMBERSHIP}');

COMMIT;
`;

/** La ruta solo usa `params`; el resto del evento no se toca. */
function request(token: string): Promise<Response> {
  return (GET as unknown as (event: { params: { token: string } }) => Promise<Response>)({
    params: { token }
  });
}

/** Deshace el plegado de líneas de la RFC 5545 antes de leer nada. */
function unfold(body: string): string {
  return body.replaceAll(/\r\n[ \t]/g, '');
}

interface Vevento {
  readonly uid: string;
  readonly summary: string;
  readonly dtStart: string;
  readonly rrule: string | null;
}

function eventos(body: string): Vevento[] {
  const bloques = unfold(body).split('BEGIN:VEVENT').slice(1);
  return bloques.map((bloque) => {
    const cuerpo = bloque.slice(0, bloque.indexOf('END:VEVENT'));
    const leer = (pattern: RegExp): string | null => cuerpo.match(pattern)?.[1] ?? null;
    const fecha = leer(/DTSTART;VALUE=DATE:(\d{8})/);
    return {
      uid: leer(/UID:(.*)\r\n/) ?? '',
      summary: leer(/SUMMARY:(.*)\r\n/) ?? '',
      dtStart: fecha === null ? '' : `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`,
      rrule: leer(/RRULE:(.*)\r\n/)
    };
  });
}

describe.runIf(Boolean(adminUrl))('feed ICS emitido desde Postgres', () => {
  let adminPool: pg.Pool;
  let cuerpo: string;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${ICS_DB} with (force)`);
      await cluster.query(`create database ${ICS_DB}`);
    } finally {
      await cluster.end();
    }

    const feedUrl = new URL(adminUrl as string);
    feedUrl.pathname = `/${ICS_DB}`;
    const admin = new pg.Client({ connectionString: feedUrl.toString() });
    await admin.connect();
    try {
      const dbWorkspace = new URL('../../../packages/db/', import.meta.url);
      const migrateHref = new URL('scripts/migrate.mjs', dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      const fixturesDir = fileURLToPath(new URL('fixtures', dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith('.sql')).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), 'utf8'));
      }
      await admin.query(SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: feedUrl.toString(), max: 2 });
    cuerpo = await request(FEED_TOKEN).then((response) => response.text());
  }, 120_000);

  afterAll(async () => {
    await adminPool?.end();
  });

  it('un token válido trae la cadencia REAL, no un calendario vacío', async () => {
    const response = await request(FEED_TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');
    expect(cuerpo).toContain('BEGIN:VCALENDAR');
    // Lo que la regresión protege: que haya eventos. Con el emisor anterior a
    // la 0033 esto era exactamente cero y nadie lo veía.
    expect(eventos(cuerpo).length).toBeGreaterThan(0);
  });

  it('«los lunes y los jueves» sale como UNA serie con su RRULE, no como cien eventos', () => {
    const semanales = eventos(cuerpo).filter((evento) => evento.summary.includes('Cocina a fondo'));
    expect(semanales).toHaveLength(1);
    const [evento] = semanales;
    expect(evento?.uid).toBe(`${ROUTINE_SEMANAL}@housekeeper`);
    expect(evento?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TH;WKST=MO');
  });

  it('la RRULE emitida, expandida, da exactamente las fechas del motor puro', () => {
    for (const [regla, titulo, esperada] of [
      [REGLA_SEMANAL, 'Cocina a fondo', 'FREQ=WEEKLY;BYDAY=MO,TH;WKST=MO'],
      [REGLA_TEMPORADAS, 'Ropa de temporada', 'FREQ=YEARLY;BYMONTH=6,12;BYMONTHDAY=1']
    ] as const) {
      const evento = eventos(cuerpo).find((item) => item.summary.includes(titulo));
      expect(evento, titulo).toBeDefined();
      expect(evento?.rrule).toBe(esperada);
      // Se expande LO QUE HA SALIDO POR EL CABLE, con su DTSTART, y se compara
      // con lo que genera el motor desde esa misma fecha.
      expect(expandRrule(evento?.rrule ?? '', evento?.dtStart ?? '', 40)).toEqual(
        occurrencesBetween(regla, evento?.dtStart ?? '', '2400-12-31', { limit: 40 })
      );
    }
  });

  it('el DTSTART de la serie es la primera ocurrencia desde el ancla, no «hoy»', () => {
    const evento = eventos(cuerpo).find((item) => item.summary.includes('Cocina a fondo'));
    const [primera] = occurrencesBetween(REGLA_SEMANAL, ANCLA_VIEJA, TODAY, { limit: 1 });
    expect(evento?.dtStart).toBe(primera);
    // Y por tanto está en el pasado: el VEVENT no se reescribe cada día.
    expect(evento?.dtStart.localeCompare(TODAY)).toBeLessThan(0);
  });

  it('el día 31 no emite RRULE: sale una ocurrencia por VEVENT, ya recortada', () => {
    const treintaYUno = eventos(cuerpo).filter((item) =>
      item.summary.includes('Limpieza a fondo')
    );
    // La RFC saltaría febrero, abril, junio, septiembre y noviembre; el motor
    // recorta. Emitir la RRULE aquí sería mentir, así que no se emite.
    expect(treintaYUno.every((item) => item.rrule === null)).toBe(true);
    expect(treintaYUno.length).toBeGreaterThan(1);

    const delMotor = occurrencesBetween(REGLA_DIA_31, TODAY, addDays(TODAY, HORIZON_DAYS), {
      limit: 60
    });
    expect(treintaYUno.map((item) => item.dtStart)).toEqual(delMotor);
    // Y el recorte se ve: hay meses publicados que no acaban en 31.
    expect(delMotor.some((fecha) => !fecha.endsWith('-31'))).toBe(true);
  });

  it('una rutina sin cadencia confirmada no publica nada (§2.3)', () => {
    expect(cuerpo).not.toContain('Garaje algún día (ICS)');
  });

  it('una cadencia agotada tampoco: ni serie muerta ni ocurrencias', () => {
    expect(cuerpo).not.toContain('Mudanza terminada (ICS)');
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
