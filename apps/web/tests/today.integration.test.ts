import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTodayOverview } from '../src/lib/server/today.server';
import { addDays, mondayOf } from '../src/lib/food/dates';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_casa_clara_today_login';
// Base de datos propia (como wiki, auth y food): las otras suites recrean el
// esquema entero en paralelo y ninguna puede compartir instancia.
const TODAY_DB = 'casaclara_today_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
// Acuerdo laboral de las fixtures sintéticas de @casa-clara/db.
const AGREEMENT = '12000000-0000-4000-8000-000000000001';
// La segunda persona empleada del mismo hogar, con su propio acuerdo: lo que
// tenga pendiente también necesita decisión y también tiene que salir en Hoy.
const EMPLOYEE_TWO_MEMBERSHIP = '11000000-0000-4000-8000-000000000006';
const AGREEMENT_TWO = '12000000-0000-4000-8000-000000000002';

const EXTRA_REQUESTED = '51000000-0000-4000-8000-000000000001';
const EXTRA_SEGUNDA = '51000000-0000-4000-8000-000000000003';
const EXTRA_ACCEPTED = '51000000-0000-4000-8000-000000000002';
const EXPENSE_PENDING = '52000000-0000-4000-8000-000000000001';
const MENU_GROUP = '53000000-0000-4000-8000-000000000001';
const DINER = '53100000-0000-4000-8000-000000000001';
const SLOT_HOY = '53200000-0000-4000-8000-000000000001';
const SLOT_FUERA_VENTANA = '53200000-0000-4000-8000-000000000002';
const ROUTINE_EMPLOYEE = '54000000-0000-4000-8000-000000000001';
const ROUTINE_FAMILY = '54000000-0000-4000-8000-000000000002';
const ROUTINE_ALL = '54000000-0000-4000-8000-000000000003';
// Diaria: la que llenaría «Esta semana» de repeticiones si no se resumiera.
const ROUTINE_DIARIA = '54000000-0000-4000-8000-000000000004';
// De un día fijo dentro de la semana: la que sí merece su grupo con nombre.
const ROUTINE_UN_DIA = '54000000-0000-4000-8000-000000000005';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const MEMBER_USER = { id: 'fixture:roble:family' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };
const VIEWER_USER = { id: 'fixture:roble:viewer' };

// La misma referencia de «hoy» que usa el loader (fecha civil de Madrid).
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
// Pasado mañana, dentro de la ventana de «Esta semana» (hoy+1 … hoy+6) y con
// nombre de día distinto del de hoy y del de mañana.
const EN_DOS_DIAS = addDays(TODAY, 2);
const EN_DOS_DIAS_ISODOW = ((new Date(`${EN_DOS_DIAS}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const DIA_EN_DOS_DIAS = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  timeZone: 'UTC'
}).format(new Date(`${EN_DOS_DIAS}T00:00:00Z`));

function todayUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${TODAY_DB}`;
  return url.toString();
}

// Siembra determinista relativa a HOY: una jornada solicitada y otra aceptada
// de la empleada, un gasto pendiente, un hueco de menú de hoy sin confirmar
// (más otro fuera de la ventana ±3d que NO debe contarse) y tres rutinas que
// vencen hoy, una por audiencia.
const TODAY_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.extra_work_events (
  id, household_id, agreement_id, employee_membership_id, kind, worked_on,
  duration_minutes, note, origin, status, requested_by_membership_id, requested_at,
  approved_by_membership_id, approved_at
) VALUES
  ('${EXTRA_REQUESTED}', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT}', '${EMPLOYEE_MEMBERSHIP}',
   'overtime', '${addDays(TODAY, -2)}', 90, 'Plancha del sábado IT', 'employee_report',
   'requested', '${EMPLOYEE_MEMBERSHIP}', now() - interval '2 days', NULL, NULL),
  ('${EXTRA_ACCEPTED}', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT}', '${EMPLOYEE_MEMBERSHIP}',
   'overtime', '${addDays(TODAY, 1)}', 120, 'Canguro aceptado IT', 'employee_report',
   'accepted', '${EMPLOYEE_MEMBERSHIP}', now() - interval '3 days',
   '${ADMIN_MEMBERSHIP}', now() - interval '1 day'),
  ('${EXTRA_SEGUNDA}', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT_TWO}', '${EMPLOYEE_TWO_MEMBERSHIP}',
   'worked_rest_day', '${addDays(TODAY, -3)}', 600, 'Turno de la compañera IT', 'family_request',
   'requested', '${ADMIN_MEMBERSHIP}', now() - interval '3 days', NULL, NULL);

INSERT INTO app.extra_work_transitions (
  id, household_id, extra_work_event_id, sequence_number, from_status, to_status,
  actor_membership_id, occurred_at, reason
) VALUES
  ('51100000-0000-4000-8000-000000000001', '${FIXTURE_HOUSEHOLD}', '${EXTRA_REQUESTED}', 1, NULL, 'requested',
   '${EMPLOYEE_MEMBERSHIP}', now() - interval '2 days', 'Solicitada IT'),
  ('51100000-0000-4000-8000-000000000002', '${FIXTURE_HOUSEHOLD}', '${EXTRA_ACCEPTED}', 1, NULL, 'requested',
   '${EMPLOYEE_MEMBERSHIP}', now() - interval '3 days', 'Solicitada IT'),
  ('51100000-0000-4000-8000-000000000003', '${FIXTURE_HOUSEHOLD}', '${EXTRA_ACCEPTED}', 2, 'requested', 'accepted',
   '${ADMIN_MEMBERSHIP}', now() - interval '1 day', 'Aceptada IT'),
  ('51100000-0000-4000-8000-000000000004', '${FIXTURE_HOUSEHOLD}', '${EXTRA_SEGUNDA}', 1, NULL, 'requested',
   '${ADMIN_MEMBERSHIP}', now() - interval '3 days', 'Apuntada por la familia IT');

INSERT INTO app.expenses (
  id, household_id, agreement_id, employee_membership_id, incurred_on,
  description, amount_cents, status, submitted_by_membership_id, submitted_at
) VALUES (
  '${EXPENSE_PENDING}', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT}', '${EMPLOYEE_MEMBERSHIP}',
  '${addDays(TODAY, -1)}', 'Farmacia IT pendiente', 2175, 'pending',
  '${EMPLOYEE_MEMBERSHIP}', now() - interval '1 day'
);

INSERT INTO app.diners (id, household_id, name, notes)
VALUES ('${DINER}', '${FIXTURE_HOUSEHOLD}', 'Leo (IT)', '');

INSERT INTO app.menu_groups (id, household_id, name, position)
VALUES ('${MENU_GROUP}', '${FIXTURE_HOUSEHOLD}', 'Casa IT', 20);

INSERT INTO app.menu_group_diners (household_id, group_id, diner_id)
VALUES ('${FIXTURE_HOUSEHOLD}', '${MENU_GROUP}', '${DINER}');

INSERT INTO app.menu_slots (id, household_id, group_id, on_date, meal, free_text, notes, updated_by_membership_id) VALUES
  ('${SLOT_HOY}', '${FIXTURE_HOUSEHOLD}', '${MENU_GROUP}', '${TODAY}', 'comida', 'Guiso de verduras IT', 'Apartar sin sal', '${ADMIN_MEMBERSHIP}'),
  ('${SLOT_FUERA_VENTANA}', '${FIXTURE_HOUSEHOLD}', '${MENU_GROUP}', '${addDays(TODAY, 5)}', 'cena', 'Sopa IT', '', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.routines (id, household_id, title, details, audience, next_due_hint, created_by_membership_id,
  pattern, anchor_on, repeat_every, weekdays, overdue_policy) VALUES
  ('${ROUTINE_EMPLOYEE}', '${FIXTURE_HOUSEHOLD}', 'Filtro del agua (IT)', 'Aclarar la jarra', 'employee', '${TODAY}', '${ADMIN_MEMBERSHIP}', 'every_n_days', '${TODAY}', 7, NULL, 'carry'),
  ('${ROUTINE_FAMILY}', '${FIXTURE_HOUSEHOLD}', 'Botiquín (IT)', '', 'family', '${addDays(TODAY, -1)}', '${ADMIN_MEMBERSHIP}', 'every_n_days', '${addDays(TODAY, -1)}', 30, NULL, 'carry'),
  ('${ROUTINE_ALL}', '${FIXTURE_HOUSEHOLD}', 'Regar plantas (IT)', '', 'all', '${TODAY}', '${ADMIN_MEMBERSHIP}', 'every_n_days', '${TODAY}', 7, NULL, 'carry'),
  ('${ROUTINE_DIARIA}', '${FIXTURE_HOUSEHOLD}', 'Ventilación (IT)', '', 'employee', '${TODAY}', '${ADMIN_MEMBERSHIP}', 'every_n_days', '${TODAY}', 1, NULL, 'skip'),
  ('${ROUTINE_UN_DIA}', '${FIXTURE_HOUSEHOLD}', 'Colada de sábanas (IT)', '', 'employee', '${EN_DOS_DIAS}', '${ADMIN_MEMBERSHIP}', 'days_of_week', '${EN_DOS_DIAS}', 1, ARRAY[${EN_DOS_DIAS_ISODOW}]::smallint[], 'skip');

COMMIT;
`;

describe.runIf(Boolean(adminUrl))('Hoy desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    // Igual que las suites de wiki/food (migraciones + fixtures + login sin
    // BYPASSRLS), sobre una base propia y con la siembra del día encima.
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${TODAY_DB} with (force)`);
      await cluster.query(`create database ${TODAY_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: todayUrlFor(adminUrl as string) });
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
      await admin.query(TODAY_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(todayUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('admin: fecha real y bloque con jornada, gasto y hueco de hoy, cada uno con su ancla', async () => {
    const overview = await loadTodayOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    expect(overview!.role).toBe('family_admin');
    expect(overview!.todayISO).toBe(TODAY);
    expect(overview!.dateLabel.charAt(0)).toBe(overview!.dateLabel.charAt(0).toLocaleUpperCase('es'));

    const keys = overview!.decisions.map((item) => item.key);
    expect(keys).toContain(`extra-${EXTRA_REQUESTED}`);
    expect(keys).toContain(`gasto-${EXPENSE_PENDING}`);
    expect(keys).toContain('menu-unconfirmed');
    expect(overview!.decisions.length).toBeGreaterThanOrEqual(3);
    // La jornada aceptada espera a la empleada, no al admin.
    expect(keys).not.toContain(`extra-${EXTRA_ACCEPTED}`);

    const jornada = overview!.decisions.find((item) => item.key === `extra-${EXTRA_REQUESTED}`)!;
    // El enlace dice de quién es el expediente al que lleva: el hogar puede
    // emplear a varias personas y el ancla solo existe en el de la suya.
    expect(jornada.href).toBe(
      `/h/${FIXTURE_HOUSEHOLD}/employment/conceptos?empleada=${AGREEMENT}#extra-${EXTRA_REQUESTED}`
    );
    expect(jornada.detail).toContain('Plancha del sábado IT');

    const gasto = overview!.decisions.find((item) => item.key === `gasto-${EXPENSE_PENDING}`)!;
    expect(gasto.href).toBe(
      `/h/${FIXTURE_HOUSEHOLD}/employment/conceptos?empleada=${AGREEMENT}#gasto-${EXPENSE_PENDING}`
    );
    expect(gasto.detail).toContain('21,75');

    // El hueco fuera de la ventana ±3d no cuenta: el item es singular y de hoy.
    const menuItem = overview!.decisions.find((item) => item.key === 'menu-unconfirmed')!;
    expect(menuItem.title).toContain('Comida del menú sin confirmar');
    expect(menuItem.href).toBe(`/h/${FIXTURE_HOUSEHOLD}/menu?week=${mondayOf(TODAY)}`);

    // Menú de hoy con el hueco sin confirmar y rutinas: la familia las ve todas.
    expect(overview!.menu).toHaveLength(1);
    expect(overview!.menu[0]!.dish).toBe('Guiso de verduras IT');
    expect(overview!.menu[0]!.confirmed).toBe(false);
    // La familia las ve todas. Lo atrasado va en su bloque y lo de hoy en el
    // suyo: son cosas distintas y la pantalla no las mezcla.
    expect(overview!.routines.overdue.map((row) => row.title)).toEqual(['Botiquín (IT)']);
    expect(overview!.routines.overdue[0]!.note).toBe('Tocaba ayer');
    expect(overview!.routines.overdue[0]!.dueOn).toBe(addDays(TODAY, -1));
    expect(overview!.routines.today.map((row) => row.title).sort()).toEqual([
      'Filtro del agua (IT)',
      'Regar plantas (IT)',
      'Ventilación (IT)'
    ]);
    // El chip es CUENTA, no nota: ni porcentaje ni racha (AC-26 revisado).
    expect(overview!.routines.countChip).toBe('4 por hacer');
    expect(JSON.stringify(overview!.routines)).not.toMatch(/%|racha/);
    // El chip optimista viaja resuelto desde el servidor: el navegador ya no
    // importa la aritmética de recurrencia para predecirlo.
    expect(overview!.routines.today[0]!.doneChip).toMatch(/^Hecha ✓ · próxima el /);
  });

  it('«Esta semana» agrupa por día con el día nombrado y resume lo que se repite', async () => {
    const overview = await loadTodayOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    // La diaria no se repite seis veces: se dice una, con su cadencia.
    expect(overview!.routines.weekRepeats).toEqual([
      expect.objectContaining({ title: 'Ventilación (IT)', cadence: 'todos los días' })
    ]);
    expect(overview!.routines.week.flatMap((group) => group.items.map((item) => item.title))).not.toContain(
      'Ventilación (IT)'
    );

    // Y la de un día fijo sí tiene su grupo, con el día NOMBRADO y no una fecha.
    const group = overview!.routines.week.find((candidate) => candidate.key === EN_DOS_DIAS);
    expect(group).toBeDefined();
    expect(group!.label).toBe(`El ${DIA_EN_DOS_DIAS}`);
    expect(group!.items.map((item) => item.title)).toEqual(['Colada de sábanas (IT)']);
    // Nada de la semana es accionable: no hay ocurrencia que marcar en estas
    // filas, solo título y detalle.
    expect(Object.keys(group!.items[0]!).sort()).toEqual(['details', 'key', 'title']);
  });

  it('lo pendiente de la SEGUNDA empleada también necesita decisión, y el enlace dice de quién es', async () => {
    const overview = await loadTodayOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool);
    const segunda = overview!.decisions.find((item) => item.key === `extra-${EXTRA_SEGUNDA}`);
    // Antes se leía un solo acuerdo y esta jornada no existía para Hoy: una
    // decisión que no se enseña es una decisión que no se toma.
    expect(segunda).toBeDefined();
    expect(segunda!.detail).toContain('Turno de la compañera IT');
    expect(segunda!.href).toBe(
      `/h/${FIXTURE_HOUSEHOLD}/employment/conceptos?empleada=${AGREEMENT_TWO}#extra-${EXTRA_SEGUNDA}`
    );

    // Y sigue sin cruzarse: la primera empleada no ve lo de su compañera.
    const hers = await loadTodayOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(hers!.decisions.map((item) => item.key)).not.toContain(`extra-${EXTRA_SEGUNDA}`);
  });

  it('family_member: huecos del menú y nada más; ni gastos, ni jornadas, ni liquidaciones', async () => {
    const overview = await loadTodayOverview(MEMBER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    const keys = overview!.decisions.map((item) => item.key);
    expect(keys).toContain('menu-unconfirmed');
    expect(keys.some((key) => key.startsWith('extra-'))).toBe(false);
    expect(keys.some((key) => key.startsWith('liquidacion-'))).toBe(false);
    // Los gastos SALIERON de esta lista con la migración 0036. Antes estaban, y
    // el detalle traía el importe formateado: la portada era el segundo sitio
    // por el que la familia no administradora leía lo que la empleada se había
    // adelantado. Lo corta la RLS —`expenses_read` ya no incluye a
    // `family_member`— y el bloque de arriba lo repite en TypeScript.
    expect(keys).not.toContain(`gasto-${EXPENSE_PENDING}`);
  });

  it('empleada: su jornada aceptada y sus rutinas de hoy; nada de gastos ni huecos', async () => {
    const overview = await loadTodayOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    expect(overview!.role).toBe('employee_live_in');

    const keys = overview!.decisions.map((item) => item.key);
    expect(keys).toContain(`extra-${EXTRA_ACCEPTED}`);
    expect(keys).not.toContain(`extra-${EXTRA_REQUESTED}`);
    expect(keys).not.toContain(`gasto-${EXPENSE_PENDING}`);
    expect(keys).not.toContain('menu-unconfirmed');
    // Sus rutinas de hoy NO piden decisión: son el trabajo, y están en su
    // tarjeta. Sin atraso suyo, este bloque no dice nada de rutinas.
    expect(keys.some((key) => key.startsWith('rutina'))).toBe(false);

    // RLS por audiencia: la rutina de familia no existe para ella.
    expect(overview!.routines.overdue).toEqual([]);
    expect(overview!.routines.today.map((row) => row.title).sort()).toEqual([
      'Filtro del agua (IT)',
      'Regar plantas (IT)',
      'Ventilación (IT)'
    ]);
    // El menú del día sí es suyo (lo cocina ella).
    expect(overview!.menu).toHaveLength(1);
  });

  it('helper: solo menú y rutinas de audiencia general; sin nada que decidir (RLS manda)', async () => {
    const overview = await loadTodayOverview(HELPER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    expect(overview!.decisions).toEqual([]);
    expect(overview!.menu).toHaveLength(1);
    expect(overview!.routines.today.map((row) => row.title)).toEqual(['Regar plantas (IT)']);
  });

  it('viewer: cero filas en todo — la base de datos, no la vista, decide', async () => {
    const overview = await loadTodayOverview(VIEWER_USER, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).not.toBeNull();
    expect(overview!.decisions).toEqual([]);
    expect(overview!.menu).toEqual([]);
    expect(overview!.routines.anyToday).toBe(false);
    expect(overview!.routines.overdue).toEqual([]);
    expect(overview!.routines.today).toEqual([]);
    expect(overview!.routines.week).toEqual([]);
  });

  it('un usuario sin membresía cae a null (la página degrada a la fixture)', async () => {
    const overview = await loadTodayOverview({ id: 'fixture:ajeno' }, FIXTURE_HOUSEHOLD, appPool);
    expect(overview).toBeNull();
  });
});
