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
/**
 * Y hasta dónde llega esta prueba: la propia 0027.
 *
 * No sigue hasta la cabeza a propósito. La 0029 retiró los avisos por correo y
 * el parte semanal, y de paso mandó a `dead` lo que quedara encolado de esos
 * tres tipos —que son justo los que esta prueba siembra—. Aplicarla aquí
 * mezclaría dos migraciones en una sola aserción y dejaría este fichero
 * hablando de algo que no es lo suyo. Lo que hace la 0029 con esas filas se
 * comprueba abajo, en su propio bloque.
 */
const STOP_AT_TIMEZONE = '0027_job_run_at_local_morning.sql';

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

    await expect(
      applyMigrations(client, { until: STOP_AT_TIMEZONE })
    ).resolves.toBeGreaterThan(0);

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

  it('0029 mata lo encolado de los tipos retirados y no toca lo ya terminal', async () => {
    // Sobre la cola que dejó la prueba anterior, con uno de los cuatro avisos
    // completado a mano: es la comprobación de las DOS migraciones que tocan
    // filas encoladas de tipos que ya no existen.
    //
    // Ninguna de las dos puede tocar un trabajo terminal. Si el UPDATE de 0027
    // —o el de 0029— no filtrase por `status = 'queued'`, el trigger
    // `job_queue_state_machine` (0004) abortaría la migración entera con 55000
    // y el despliegue se caería a mitad.
    //
    // Y ninguna de las dos puede BORRAR: `app_private.enforce_job_transition`
    // lo prohíbe porque la cola es rastro de auditoría. Así que la retirada
    // deja los avisos en el único estado terminal que admite un trabajo que
    // nadie va a ejecutar, `dead`, con su motivo escrito. Sin eso, la primera
    // pasada del vaciador los reclamaría, fallaría por tipo desconocido y los
    // gastaría a reintentos hasta morir igual, ensuciando el log por el camino.
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

    await expect(applyMigrations(client)).resolves.toBeGreaterThan(0);

    const { rows } = await client.query(
      `select id, status::text as status, last_error,
              to_char(run_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as run_at
         from app_private.job_queue where household_id = $1 order by id`,
      [HOUSEHOLD]
    );
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const job of JOBS.slice(0, 3)) {
      expect(byId.get(job.id).status, job.type).toBe('dead');
      expect(byId.get(job.id).last_error, job.type).toContain('retirado en la migración 0029');
    }
    // El que ya estaba completado sigue intacto, hora incluida.
    expect(byId.get(JOBS[3].id)).toMatchObject({
      status: 'completed',
      last_error: null,
      run_at: completedAt
    });
  }, 120_000);
});
