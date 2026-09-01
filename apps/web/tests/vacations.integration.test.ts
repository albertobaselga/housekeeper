import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTodayOverview } from '../src/lib/server/today.server';
import { loadVacationOverview, markVacationsSeen } from '../src/lib/server/vacations.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = 'it_housekeeper_vacations_login';
// Base propia: las demás suites recrean el esquema entero en paralelo.
const VACATIONS_DB = 'housekeeper_vacaciones_it';

const ADMIN_MEMBERSHIP = '11000000-0000-4000-8000-000000000001';
const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
const EMPLOYEE_TWO_MEMBERSHIP = '11000000-0000-4000-8000-000000000006';
const AGREEMENT = '12000000-0000-4000-8000-000000000001';
const AGREEMENT_TWO = '12000000-0000-4000-8000-000000000002';

const ADMIN_USER = { id: 'fixture:roble:admin' };
const EMPLOYEE_USER = { id: 'fixture:roble:employee' };
const HELPER_USER = { id: 'fixture:roble:helper' };

// Reloj fijo de la suite: agosto de 2026, con el contrato de la empleada vivo
// desde febrero de 2025. Así hay dos años que enseñar y uno de ellos prorrateado.
const NOW = new Date('2026-08-11T09:00:00Z');

const VACATION_SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.vacation_periods
  (id, household_id, agreement_id, employee_membership_id, starts_on, ends_on, note,
   recorded_by_membership_id, recorded_at) VALUES
  -- 2025: ya disfrutadas, y vistas hace mucho (ver la marca del final).
  ('af100000-0000-4000-8000-000000000001', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT}',
   '${EMPLOYEE_MEMBERSHIP}', '2025-08-04', '2025-08-17', 'Quincena de agosto de 2025',
   '${ADMIN_MEMBERSHIP}', '2025-07-01T09:00:00Z'),
  -- 2026: apuntadas ANTEAYER, todavía sin ver.
  ('af100000-0000-4000-8000-000000000002', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT}',
   '${EMPLOYEE_MEMBERSHIP}', '2026-09-01', '2026-09-15', 'Quincena de septiembre',
   '${ADMIN_MEMBERSHIP}', now() - interval '2 days'),
  -- 2026: apuntada y anulada, las dos cosas antes de que ella mirara nunca.
  ('af100000-0000-4000-8000-000000000003', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT}',
   '${EMPLOYEE_MEMBERSHIP}', '2026-03-02', '2026-03-06', 'Apuntado por error',
   '${ADMIN_MEMBERSHIP}', '2026-02-01T09:00:00Z'),
  -- La compañera del mismo hogar: quien administra tiene que verla también.
  ('af100000-0000-4000-8000-000000000004', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT_TWO}',
   '${EMPLOYEE_TWO_MEMBERSHIP}', '2026-06-01', '2026-06-07', 'Semana de junio',
   '${ADMIN_MEMBERSHIP}', '2026-05-01T09:00:00Z');

UPDATE app.vacation_periods
   SET status = 'voided',
       voided_by_membership_id = '${ADMIN_MEMBERSHIP}',
       voided_at = '2026-02-02T10:00:00Z',
       void_reason = 'Las fechas eran otras'
 WHERE id = 'af100000-0000-4000-8000-000000000003';

-- Ella ya miró en julio de 2025: lo de aquel verano no vuelve a ser novedad, y
-- el periodo que se apuntó y se anuló en febrero de 2026 —entre dos miradas
-- suyas— no llegó a existir para ella.
INSERT INTO app.vacation_notice_marks (household_id, membership_id, seen_through)
VALUES ('${FIXTURE_HOUSEHOLD}', '${EMPLOYEE_MEMBERSHIP}', '2025-07-02T09:00:00Z');

COMMIT;
`;

function vacationsUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${VACATIONS_DB}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))('vacaciones completas desde Postgres bajo RLS', () => {
  let appPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${VACATIONS_DB} with (force)`);
      await cluster.query(`create database ${VACATIONS_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: vacationsUrlFor(adminUrl as string) });
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
      await admin.query(VACATION_SEED);
      await admin.query(`drop role if exists ${APP_LOGIN}`);
      await admin.query(
        `create role ${APP_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_app`
      );
    } finally {
      await admin.end();
    }

    const url = new URL(vacationsUrlFor(adminUrl as string));
    url.username = APP_LOGIN;
    url.password = 'integration-only';
    appPool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  }, 180_000);

  afterAll(async () => {
    await appPool?.end();
  });

  it('la empleada ve sus años, lo anulado como anulado, y solo lo suyo', async () => {
    const overview = await loadVacationOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(overview).not.toBeNull();
    // La RLS no le enseña el contrato de su compañera: aquí no hay filtro de
    // código que quitar por descuido.
    expect(overview!.people).toHaveLength(1);
    const mine = overview!.people[0]!;
    expect(mine.own).toBe(true);
    expect(mine.years.map((year) => year.year)).toEqual([2026, 2025]);

    const twentySix = mine.years[0]!;
    expect(twentySix.takenDays).toBe(15);
    expect(twentySix.headline).toContain('te tocan');
    const voided = twentySix.periods.find((period) => period.state === 'voided');
    expect(voided?.detail).toContain('Anuladas: Las fechas eran otras');
    expect(voided?.daysLabel).toBe('—');

    // 2025 va prorrateado: el contrato empezó el 3 de febrero.
    const twentyFive = mine.years[1]!;
    expect(twentyFive.prorationNote).toContain('El contrato cubre 332 días de 2025');
    expect(twentyFive.entitledDays).toBe(28);
    expect(twentyFive.takenDays).toBe(14);
  });

  it('quien administra ve a las dos empleadas del hogar, no solo a la primera', async () => {
    const overview = await loadVacationOverview(ADMIN_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(overview!.people).toHaveLength(2);
    expect(overview!.people.every((person) => !person.own)).toBe(true);
    expect(overview!.people.map((person) => person.agreementId).sort()).toEqual(
      [AGREEMENT, AGREEMENT_TWO].sort()
    );
    // Historial es historial: lo de la compañera también sale con sus años.
    const companion = overview!.people.find((person) => person.agreementId === AGREEMENT_TWO)!;
    expect(companion.years.some((year) => year.takenDays === 7)).toBe(true);
    // Quien administra no es empleada de nadie: no tiene novedades propias.
    expect(overview!.news).toBeNull();
  });

  it('la familia no administradora ve los días apuntados, pero no el derecho pactado', async () => {
    const overview = await loadVacationOverview(
      { id: 'fixture:roble:family' },
      FIXTURE_HOUSEHOLD,
      appPool,
      NOW
    );
    const mine = overview!.people.find((person) => person.agreementId === AGREEMENT)!;
    expect(mine.years[0]?.takenDays).toBe(15);
    // La RLS no le devuelve ninguna versión del contrato: ni derecho, ni saldo,
    // ni un cero de relleno que parecería un dato.
    expect(mine.years[0]?.entitledDays).toBeNull();
    expect(mine.entitlementNote).not.toBeNull();
  });

  it('al apoyo del hogar no le consta ningún contrato, así que tampoco vacaciones', async () => {
    const overview = await loadVacationOverview(HELPER_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(overview!.people).toEqual([]);
    expect(overview!.news).toBeNull();
  });

  it('lo apuntado sin que lo haya visto sale en Hoy, y deja de salir cuando lo mira', async () => {
    const before = await loadVacationOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(before!.news?.count).toBe(1);
    expect(before!.news?.headline).toContain('Te han apuntado vacaciones');

    const todayBefore = await loadTodayOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    const notice = todayBefore!.decisions.find((item) => item.key === 'vacaciones-nuevas');
    expect(notice?.href).toBe(`/h/${FIXTURE_HOUSEHOLD}/employment/vacaciones`);
    expect(todayBefore!.decisionsTitle).not.toBe('Necesita tu decisión');

    // Mirar la sección es lo que la da por vista: ni botón ni descarte a mano.
    const stored = await markVacationsSeen(
      EMPLOYEE_USER,
      FIXTURE_HOUSEHOLD,
      before!.news!.seenThrough,
      appPool
    );
    expect(stored).not.toBeNull();

    const after = await loadVacationOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(after!.news).toBeNull();
    // Y lo apuntado sigue estando: la marca apaga el aviso, no borra el hecho.
    expect(after!.people[0]!.years[0]!.takenDays).toBe(15);

    const todayAfter = await loadTodayOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(todayAfter!.decisions.some((item) => item.key === 'vacaciones-nuevas')).toBe(false);
  });

  it('lo que se anula después de que ella lo viera vuelve a ser novedad', async () => {
    const admin = new pg.Client({ connectionString: vacationsUrlFor(adminUrl as string) });
    await admin.connect();
    try {
      await admin.query(`
        BEGIN;
        SET LOCAL row_security = off;
        UPDATE app.vacation_periods
           SET status = 'voided',
               voided_by_membership_id = '${ADMIN_MEMBERSHIP}',
               voided_at = now(),
               void_reason = 'Al final no se cogieron'
         WHERE id = 'af100000-0000-4000-8000-000000000002';
        COMMIT;
      `);
    } finally {
      await admin.end();
    }

    const overview = await loadVacationOverview(EMPLOYEE_USER, FIXTURE_HOUSEHOLD, appPool, NOW);
    expect(overview!.news?.count).toBe(1);
    expect(overview!.news?.headline).toContain('Se han anulado');
  });

  it('la administración no puede ver la marca de la empleada', async () => {
    const client = await appPool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [ADMIN_USER.id]);
      await client.query('select app.set_household_context($1, $2)', [
        FIXTURE_HOUSEHOLD,
        ADMIN_MEMBERSHIP
      ]);
      const marks = await client.query('select count(*)::int as total from app.vacation_notice_marks');
      expect(marks.rows[0]?.total).toBe(0);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});
