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

    const overview = await loadCalendar(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    expect(overview!.canManage).toBe(true);
    expect(overview!.sources.map((source) => source.label)).toEqual(['Cole de los niños']);
    expect(overview!.days.map((day) => day.dateISO)).toEqual([TODAY_ISO, TOMORROW_ISO]);
    expect(overview!.days[0]?.isToday).toBe(true);
    // El día completo primero; después la hora. Todo con su fuente en claro.
    expect(overview!.days[0]?.events.map((event) => event.title)).toEqual(['Excursión del cole', 'Natación']);
    const swim = overview!.days[0]!.events[1]!;
    expect(swim.timeLabel).toMatch(/^\d{2}:\d{2}$/);
    expect(swim.endLabel).toMatch(/^\d{2}:\d{2}$/);
    expect(swim.sourceLabel).toBe('Cole de los niños');
    expect(overview!.days[0]?.events[0]?.timeLabel).toBe('Todo el día');
  });

  it('empleada y visor ven la agenda sin la gestión de fuentes; el apoyo no ve nada', async () => {
    for (const user of [EMPLOYEE_USER, VIEWER_USER]) {
      const overview = await loadCalendar(user, FIXTURE_HOUSEHOLD, appPool);
      expect(overview).not.toBeNull();
      expect(overview!.canManage).toBe(false);
      // La RLS de ics_sources es solo de administración: la lista llega vacía.
      expect(overview!.sources).toEqual([]);
      expect(overview!.days.map((day) => day.dateISO)).toEqual([TODAY_ISO, TOMORROW_ISO]);
    }

    // helper no tiene calendar.read: cero eventos por RLS.
    const helper = await loadCalendar(HELPER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(helper).not.toBeNull();
    expect(helper!.days).toEqual([]);
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
    const overview = await loadCalendar(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview!.days).toEqual([]);
    expect(overview!.sources[0]?.enabled).toBe(false);
  });
});
