// La migración 0027 no solo cambia cómo se encolará a partir de ahora: tiene
// que arreglar los avisos QUE YA ESTÁN en la cola con la hora mala.
//
// El error original: `$1::date::timestamptz` resuelve la medianoche en la zona
// de la SESIÓN. Con el servidor de producción en UTC, el aviso «del día 15»
// quedaba a las 00:00Z, que en Madrid son las 02:00 de la madrugada. Las filas
// ya encoladas con ese criterio no se arreglan solas: siguen ahí, apuntando de
// madrugada, hasta que alguien las mueva.
//
// Esta prueba migra hasta el punto anterior, siembra la cola con las cuatro
// combinaciones que importan, y sigue hasta la cabeza para comprobar que 0027
// mueve exactamente las que debe y ni una más.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations } from './migrate.mjs';

const adminUrl = process.env.TEST_DATABASE_URL;

/** Última migración anterior a la que corrige la hora de los avisos. */
const STOP_AT = '0021_agreement_terms_catalogue.sql';

const HOUSEHOLD = '7b000000-0000-4000-8000-000000000001';

/** Día futuro cualquiera en horario de verano peninsular (UTC+2). */
const SUMMER_DAY = '2026-08-15';
/** Y otro en horario de invierno (UTC+1): el arreglo no puede fijar el offset. */
const WINTER_DAY = '2026-01-15';

const JOBS = [
  // Los dos que nacen de una fecha civil y cayeron en el error: se mueven.
  {
    id: '7b000000-0000-4000-8000-000000000011',
    type: 'notification.routine_due',
    runAt: `${SUMMER_DAY}T00:00:00Z`,
    expectedMadrid: `${SUMMER_DAY} 08:00`
  },
  {
    id: '7b000000-0000-4000-8000-000000000012',
    type: 'notification.settlement_due',
    runAt: `${WINTER_DAY}T00:00:00Z`,
    expectedMadrid: `${WINTER_DAY} 08:00`
  },
  // Control 1: mismo tipo, pero encolado a una hora que NO es la medianoche
  // UTC. No lo puso este error (por ejemplo, una escalada re-encolada por el
  // worker a +3 días desde el momento del aviso anterior) y no se toca.
  {
    id: '7b000000-0000-4000-8000-000000000013',
    type: 'notification.settlement_due',
    runAt: `${SUMMER_DAY}T13:37:00Z`,
    expectedMadrid: `${SUMMER_DAY} 15:37`
  },
  // Control 2: medianoche UTC clavada, pero de un tipo que no se programa por
  // fecha (es «envío + 3 días»). Fuera del filtro.
  {
    id: '7b000000-0000-4000-8000-000000000014',
    type: 'time_report.autoconfirm',
    runAt: `${SUMMER_DAY}T00:00:00Z`,
    expectedMadrid: `${SUMMER_DAY} 02:00`
  }
];

describe.runIf(Boolean(adminUrl))('0027 reprograma los avisos ya encolados de madrugada', () => {
  /** @type {pg.Client} */
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    await client.query('drop schema if exists app cascade');
    await client.query('drop schema if exists app_private cascade');
    await client.query('drop table if exists public.schema_migrations');
    await applyMigrations(client, { until: STOP_AT });
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  it('mueve a las 08:00 de Madrid solo los avisos encolados a medianoche UTC', async () => {
    await client.query('begin');
    await client.query('set local row_security = off');
    await client.query(
      `insert into app.households (id, slug, display_name)
       values ($1, 'hogar-horario', 'Hogar con avisos de madrugada')`,
      [HOUSEHOLD]
    );
    for (const job of JOBS) {
      await client.query(
        `insert into app_private.job_queue (id, household_id, job_type, payload, run_at)
         values ($1, $2, $3, '{}'::jsonb, $4::timestamptz)`,
        [job.id, HOUSEHOLD, job.type, job.runAt]
      );
    }
    await client.query('commit');

    // Antes de 0027, los cuatro están donde se sembraron; los dos de medianoche
    // UTC en verano/invierno son las 02:00 y la 01:00 de Madrid.
    const before = await client.query(
      `select id, to_char(run_at at time zone 'Europe/Madrid', 'HH24:MI') as hora
         from app_private.job_queue where household_id = $1 order by id`,
      [HOUSEHOLD]
    );
    expect(before.rows.map((row) => row.hora)).toEqual(['02:00', '01:00', '15:37', '02:00']);

    await expect(applyMigrations(client)).resolves.toBeGreaterThan(0);

    const after = await client.query(
      `select id,
              to_char(run_at at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as pared,
              status::text as status
         from app_private.job_queue where household_id = $1 order by id`,
      [HOUSEHOLD]
    );
    expect(after.rows).toEqual(
      JOBS.map((job) => ({ id: job.id, pared: job.expectedMadrid, status: 'queued' }))
    );
  }, 120_000);

  it('un aviso ya completado no se toca: los jobs terminales son inmutables', async () => {
    // Si el UPDATE de 0027 no filtrase por `status = 'queued'`, el trigger
    // `job_queue_state_machine` (0004) abortaría la migración entera con 55000.
    // La prueba lo fija: se completa uno a mano y se re-aplica la migración —que
    // ya no hace nada— para dejar constancia de que la fila sigue intacta.
    const completedAt = `${SUMMER_DAY}T00:00:00Z`;
    await client.query(
      `update app_private.job_queue
          set status = 'running', locked_at = now(), attempts = 1
        where id = $1`,
      [JOBS[3].id]
    );
    await client.query(
      `update app_private.job_queue
          set status = 'completed', completed_at = now(), locked_at = null
        where id = $1`,
      [JOBS[3].id]
    );

    await expect(applyMigrations(client)).resolves.toBe(0);

    const { rows } = await client.query(
      `select to_char(run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as run_at
         from app_private.job_queue where id = $1`,
      [JOBS[3].id]
    );
    expect(rows).toEqual([{ run_at: completedAt }]);
  }, 120_000);
});
