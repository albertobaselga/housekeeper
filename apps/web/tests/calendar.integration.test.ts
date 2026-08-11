import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processSyncBatch, rhythmCommandHandlers } from '@casa-clara/server';

import { upsertCalendarSource } from '../src/lib/calendar/commands';
import { addDays } from '../src/lib/food/dates';
import { loadCalendar } from '../src/lib/server/calendar.server';
import { loadTodayOverview } from '../src/lib/server/today.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_calendar_login';
// Base propia (patrón de contactos/comida): las suites recrean el esquema
// entero en paralelo y ninguna puede compartir instancia.
const CALENDAR_DB = 'casaclara_cal_it';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };

const TODAY_ISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const TOMORROW_ISO = addDays(TODAY_ISO, 1);

function calendarUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${CALENDAR_DB}`;
  return url.toString();
}

let operationCounter = 0;
function nextOperation(): { operationId: string; occurredAt: string } {
  operationCounter += 1;
  return {
    operationId: `99999999-0000-4000-8000-${String(operationCounter).padStart(12, '0')}`,
    occurredAt: new Date().toISOString()
  };
}

describe.runIf(Boolean(adminUrl))('calendario real desde Postgres bajo RLS', () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let sourceId: string;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${CALENDAR_DB} with (force)`);
      await cluster.query(`create database ${CALENDAR_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: calendarUrlFor(adminUrl as string) });
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
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: calendarUrlFor(adminUrl as string), max: 2 });
    const url = new URL(calendarUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it('la administración enlaza un calendario y el alta encola su sincronización', async () => {
    const result = await processSyncBatch(
      appPool,
      { userId: ADMIN_USER.id },
      [
        upsertCalendarSource(
          {
            householdId: FIXTURE_HOUSEHOLD,
            label: 'Cole de los niños',
            url: 'https://calendario.example.com/cole.ics',
            enabled: true
          },
          nextOperation()
        )
      ],
      rhythmCommandHandlers
    );
    const ack = result.acknowledgements[0]!;
    expect(ack.status).toBe('accepted');
    sourceId = ack.resourceId!;

    const jobs = await adminPool.query<{ payload: { sourceId: string; url: string; clear?: boolean } }>(
      `select payload from app_private.job_queue
        where household_id = $1 and job_type = 'ics.sync_source'
        order by created_at`,
      [FIXTURE_HOUSEHOLD]
    );
    expect(jobs.rows.at(-1)?.payload).toEqual({
      sourceId,
      url: 'https://calendario.example.com/cole.ics'
    });
  });

  it('los eventos que persiste el worker aparecen agrupados por día bajo RLS', async () => {
    // El «worker» de este test: la función definer de la 0015 con eventos de
    // hoy (uno con hora, uno de día completo) y de mañana.
    const events = [
      {
        uid: 'natacion@example.com',
        startsAt: `${TODAY_ISO}T10:00:00Z`,
        endsAt: `${TODAY_ISO}T11:00:00Z`,
        allDay: false,
        summary: 'Natación',
        location: 'Piscina municipal',
        contentHash: '1'.repeat(64)
      },
      {
        uid: 'excursion@example.com',
        startsAt: `${TODAY_ISO}T05:00:00Z`,
        endsAt: null,
        allDay: true,
        summary: 'Excursión del cole',
        location: null,
        contentHash: '2'.repeat(64)
      },
      {
        uid: 'dentista@example.com',
        startsAt: `${TOMORROW_ISO}T15:30:00Z`,
        endsAt: null,
        allDay: false,
        summary: 'Dentista de Leo',
        location: null,
        contentHash: '3'.repeat(64)
      }
    ];
    const written = await adminPool.query<{ written: number }>(
      'select app_private.replace_ics_source_events($1, $2, $3::jsonb) as written',
      [FIXTURE_HOUSEHOLD, sourceId, JSON.stringify(events)]
    );
    expect(written.rows[0]?.written).toBe(3);

    const overview = await loadCalendar(ADMIN_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    expect(overview).not.toBeNull();
    expect(overview!.canManage).toBe(true);
    expect(overview!.sources.map((source) => source.label)).toEqual(['Cole de los niños']);
    const eventDays = [...new Set(overview!.events.map((event) => event.dateISO))];
    expect(eventDays).toEqual([TODAY_ISO, TOMORROW_ISO]);
    // El día completo primero; después la hora. Todo con su fuente en claro.
    expect(
      overview!.events.filter((event) => event.dateISO === TODAY_ISO).map((event) => event.title)
    ).toEqual(['Excursión del cole', 'Natación']);
    const swim = overview!.events.find((event) => event.title === 'Natación')!;
    expect(swim.timeLabel).toMatch(/^\d{2}:\d{2}$/);
    expect(swim.endLabel).toMatch(/^\d{2}:\d{2}$/);
    expect(swim.sourceLabel).toBe('Cole de los niños');
    expect(overview!.events[0]?.timeLabel).toBe('Todo el día');
    // La densidad del año conoce los mismos días, sin traerse su detalle.
    expect(overview!.eventDaysISO).toContain(TODAY_ISO);
  });

  it('empleada y visor ven la agenda sin la gestión de fuentes; el apoyo no ve nada', async () => {
    for (const user of [EMPLOYEE_USER, VIEWER_USER]) {
      const overview = await loadCalendar(user, FIXTURE_HOUSEHOLD, {}, appPool);
      expect(overview).not.toBeNull();
      expect(overview!.canManage).toBe(false);
      // La RLS de ics_sources es solo de administración: la lista llega vacía.
      expect(overview!.sources).toEqual([]);
      expect([...new Set(overview!.events.map((event) => event.dateISO))]).toEqual([
        TODAY_ISO,
        TOMORROW_ISO
      ]);
    }

    // helper no tiene calendar.read: cero eventos por RLS.
    const helper = await loadCalendar(HELPER_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    expect(helper).not.toBeNull();
    expect(helper!.events).toEqual([]);
  });

  it('los eventos de hoy alimentan la agenda de «Hoy» según el rol', async () => {
    const admin = await loadTodayOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(admin).not.toBeNull();
    expect(admin!.agenda.map((event) => event.title)).toEqual(['Excursión del cole', 'Natación']);
    expect(admin!.agenda[0]?.timeLabel).toBe('Todo el día');
    expect(admin!.agenda[1]?.sourceLabel).toBe('Cole de los niños');

    const helper = await loadTodayOverview(HELPER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(helper).not.toBeNull();
    expect(helper!.agenda).toEqual([]);
  });

  it('pausar el calendario encola la limpieza y sus eventos desaparecen', async () => {
    const result = await processSyncBatch(
      appPool,
      { userId: ADMIN_USER.id },
      [
        upsertCalendarSource(
          {
            householdId: FIXTURE_HOUSEHOLD,
            sourceId,
            label: 'Cole de los niños',
            url: 'https://calendario.example.com/cole.ics',
            enabled: false
          },
          nextOperation()
        )
      ],
      rhythmCommandHandlers
    );
    expect(result.acknowledgements[0]?.status).toBe('accepted');

    const jobs = await adminPool.query<{ payload: { clear?: boolean } }>(
      `select payload from app_private.job_queue
        where household_id = $1 and job_type = 'ics.sync_source'
        order by created_at`,
      [FIXTURE_HOUSEHOLD]
    );
    expect(jobs.rows.at(-1)?.payload).toEqual({
      sourceId,
      url: 'https://calendario.example.com/cole.ics',
      clear: true
    });

    // El «worker» ejecuta la limpieza y el calendario queda en vacío honesto,
    // con la fuente aún listada (en pausa) para la administración.
    await adminPool.query('select app_private.replace_ics_source_events($1, $2, $3::jsonb)', [
      FIXTURE_HOUSEHOLD,
      sourceId,
      '[]'
    ]);
    const overview = await loadCalendar(ADMIN_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    expect(overview!.events).toEqual([]);
    expect(overview!.sources[0]?.enabled).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Rutinas en el calendario: quién ve qué (E3) y el pasado con su autoría (E2)
  // ───────────────────────────────────────────────────────────────────────────

  const FAMILY_ROUTINE = 'cc000000-0000-4000-8000-000000000001';
  const SHARED_ROUTINE = 'cc000000-0000-4000-8000-000000000002';
  const EMPLOYEE_ROUTINE = 'cc000000-0000-4000-8000-000000000003';
  const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
  const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
  // Día 1 del mes en curso: SIEMPRE dentro de la rejilla de seis semanas que
  // descarga el calendario, mientras que «ayer» se sale de ella cuando hoy es
  // día 1 de un mes que empieza en lunes.
  const PAST_ISO = `${TODAY_ISO.slice(0, 8)}01`;

  it('las rutinas viajan como REGLAS y la RLS decide cuáles (E3)', async () => {
    await adminPool.query(
      `insert into app.routines (id, household_id, title, details, audience,
                                 next_due_hint, created_by_membership_id,
                                 pattern, anchor_on, repeat_every, weekdays, overdue_policy)
       values ($1, $4, 'Revisión del botiquín', 'Caduca el paracetamol', 'family',
               $5::date, $6, 'days_of_week', $5::date, 1, array[1,4]::smallint[], 'skip'),
              ($2, $4, 'Ventilación de la mañana', '', 'all',
               $5::date, $6, 'every_n_days', $5::date, 1, null, 'skip'),
              ($3, $4, 'Limpieza de baños', 'Sin lejía en el mármol', 'employee',
               $5::date, $6, 'every_n_days', $5::date, 1, null, 'skip')`,
      [
        FAMILY_ROUTINE,
        SHARED_ROUTINE,
        EMPLOYEE_ROUTINE,
        FIXTURE_HOUSEHOLD,
        PAST_ISO,
        ADMIN_MEMBERSHIP
      ]
    );

    const admin = await loadCalendar(ADMIN_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    expect(admin!.routines.map((routine) => routine.title).sort()).toEqual([
      'Limpieza de baños',
      'Revisión del botiquín',
      'Ventilación de la mañana'
    ]);
    // La regla viaja entera: con ella el navegador pinta cualquier semana.
    const weekly = admin!.routines.find((routine) => routine.title === 'Revisión del botiquín')!;
    expect(weekly.rule).toMatchObject({ pattern: 'days_of_week', weekdays: [1, 4] });
    expect(weekly.cadence).toBe('los lunes y los jueves');

    // La empleada NO recibe la rutina de audiencia `family`: lo impide
    // `routines_read` (0008), no un filtro de esta capa.
    const employee = await loadCalendar(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    expect(employee!.routines.map((routine) => routine.title).sort()).toEqual([
      'Limpieza de baños',
      'Ventilación de la mañana'
    ]);
    expect(JSON.stringify(employee)).not.toContain('Revisión del botiquín');
    expect(JSON.stringify(employee)).not.toContain('Caduca el paracetamol');

    // El apoyo solo alcanza las de audiencia `all`.
    const helper = await loadCalendar(HELPER_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    expect(helper!.routines.map((routine) => routine.title)).toEqual(['Ventilación de la mañana']);
  });

  it('el pasado se ve con quién lo marcó, y sin ninguna nota (E2)', async () => {
    await adminPool.query(
      `insert into app.routine_completions (household_id, routine_id, due_on, completed_by_membership_id)
       values ($1, $2, $3::date, $4)`,
      [FIXTURE_HOUSEHOLD, EMPLOYEE_ROUTINE, PAST_ISO, EMPLOYEE_MEMBERSHIP]
    );

    const admin = await loadCalendar(ADMIN_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    const done = admin!.completions.find((row) => row.routineId === EMPLOYEE_ROUTINE);
    expect(done).toMatchObject({ dueOn: PAST_ISO, byName: 'Fixture Empleada Roble' });

    // La empleada ve su propio marcado; el nombre sale de su perfil, que sí
    // puede leer (user_profiles_self_read).
    const employee = await loadCalendar(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, {}, appPool);
    expect(employee!.completions.map((row) => row.routineId)).toEqual([EMPLOYEE_ROUTINE]);

    // Ni una cifra agregada en toda la carga: ni porcentaje, ni cuenta de
    // hechas, ni nada que puntúe a nadie (AC-26 revisado).
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(admin);
    for (const key of keys) {
      expect(key).not.toMatch(/percent|ratio|streak|racha|media|average|score|cumplimiento/i);
    }
  });
});
