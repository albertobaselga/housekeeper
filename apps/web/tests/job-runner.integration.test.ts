import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_RUNNER_TOKEN_HEADER,
  drainJobQueue,
  loadJobRunnerConfig,
  runJobDrainRequest,
  tokenMatches,
  type JobRunnerConfig
} from '../src/lib/server/job-runner.server';
import { FIXTURE_HOUSEHOLD } from './helpers';

// La demostración de que esto sirve para algo: un trabajo encolado por la
// aplicación se EJECUTA cuando el planificador llama al endpoint, y su efecto
// aparece en la base. Antes de esta oleada nadie vaciaba la cola y el parte
// semanal se quedaba en `submitted` para siempre.

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const WORKER_LOGIN = 'it_casa_clara_jobrun_worker_login';
// Base propia: las demás suites recrean el esquema en paralelo y esta cuenta
// filas de la cola, que no admite vecinos.
const JOBS_DB = 'casaclara_jobrun_it';

const AGREEMENT = '12000000-0000-4000-8000-000000000001';
const EMPLOYEE_MEMBERSHIP = '11000000-0000-4000-8000-000000000003';
const TOKEN = 'secreto-de-prueba-32-bytes-largo-0';

/** Cuatro partes semanales enviados hace cuatro días: la auto-confirmación procede. */
const REPORTS = [
  { id: '5a000000-0000-4000-8000-000000000001', week: '2025-04-07' },
  { id: '5a000000-0000-4000-8000-000000000002', week: '2025-04-14' },
  { id: '5a000000-0000-4000-8000-000000000003', week: '2025-04-21' },
  { id: '5a000000-0000-4000-8000-000000000004', week: '2025-04-28' }
];

const SEED = `
BEGIN;
SET LOCAL row_security = off;
INSERT INTO app.weekly_time_reports (
  id, household_id, agreement_id, employee_membership_id, week_starts_on,
  status, submitted_at, submitted_by_membership_id
) VALUES
${REPORTS.map(
  (report) => `  ('${report.id}', '${FIXTURE_HOUSEHOLD}', '${AGREEMENT}', '${EMPLOYEE_MEMBERSHIP}',
   '${report.week}', 'submitted', now() - interval '4 days', '${EMPLOYEE_MEMBERSHIP}')`
).join(',\n')};
COMMIT;
`;

function jobsUrlFor(base: string): string {
  const url = new URL(base);
  url.pathname = `/${JOBS_DB}`;
  return url.toString();
}

function drainRequest(token: string | null = TOKEN): Request {
  return new Request('https://casa.ejemplo.test/api/v1/jobs/run', {
    method: 'POST',
    headers: token === null ? {} : { [JOB_RUNNER_TOKEN_HEADER]: token }
  });
}

describe.runIf(Boolean(adminUrl))('drenaje de la cola desde la web', () => {
  let adminPool: pg.Pool;
  let workerPool: pg.Pool;
  let config: JobRunnerConfig;

  async function enqueue(type: string, payload: unknown, runAt = 'now()'): Promise<void> {
    await adminPool.query(
      `insert into app_private.job_queue (household_id, job_type, payload, run_at)
       values ($1, $2, $3::jsonb, ${runAt})`,
      [FIXTURE_HOUSEHOLD, type, JSON.stringify(payload)]
    );
  }

  async function reportStatuses(): Promise<Array<{ status: string; auto: boolean }>> {
    const result = await adminPool.query<{ status: string; auto: boolean }>(
      `select status::text as status, auto_confirmed as auto
         from app.weekly_time_reports
        where id = any($1::uuid[])
        order by week_starts_on`,
      [REPORTS.map((report) => report.id)]
    );
    return result.rows;
  }

  async function jobStates(type: string): Promise<Array<{ status: string; attempts: number }>> {
    const result = await adminPool.query<{ status: string; attempts: number }>(
      `select status::text as status, attempts
         from app_private.job_queue
        where job_type = $1
        order by created_at, id`,
      [type]
    );
    return result.rows;
  }

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${JOBS_DB} with (force)`);
      await cluster.query(`create database ${JOBS_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: jobsUrlFor(adminUrl as string) });
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
      await admin.query(`drop role if exists ${WORKER_LOGIN}`);
      await admin.query(
        `create role ${WORKER_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_worker`
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: jobsUrlFor(adminUrl as string), max: 2 });

    // El drenaje se conecta con el rol del WORKER, no con el de la aplicación:
    // `app_private.job_queue` no tiene ni un GRANT para casa_clara_app.
    const workerUrl = new URL(jobsUrlFor(adminUrl as string));
    workerUrl.username = WORKER_LOGIN;
    workerUrl.password = 'integration-only';
    workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 4 });

    // Los valores de S3 son de relleno: los trabajos de esta suite son los de
    // SQL puro y su cliente se construye dentro del efecto, así que nada sale
    // de la máquina. El endpoint sí construye el catálogo REAL de manejadores
    // con ellos, que es lo que interesa comprobar.
    config = {
      databaseUrl: workerUrl.toString(),
      token: TOKEN,
      budgetMs: 8_000,
      maxAttempts: 5,
      leaseMs: undefined,
      storage: {
        endpoint: 'https://s3.invalid',
        region: 'eu-west-1',
        bucket: 'casaclara-test',
        accessKeyId: 'test',
        secretAccessKey: 'test'
      }
    };
  }, 180_000);

  afterAll(async () => {
    await workerPool?.end();
    try {
      await adminPool?.query(`drop role if exists ${WORKER_LOGIN}`);
    } catch {
      // El rol puede seguir referenciado por otra sesión; no es fallo del suite.
    }
    await adminPool?.end();
  });

  it('sin el secreto correcto no ejecuta nada y responde 401', async () => {
    await enqueue('time_report.autoconfirm', { reportId: REPORTS[0]!.id });

    // Sin cabecera, vacío, otro secreto y dos casi-aciertos: el que le sobra un
    // carácter y el que le falta. (Un token con espacios al final no se prueba
    // aquí: HTTP recorta el valor de la cabecera antes de que llegue.)
    for (const token of [null, '', 'otro-secreto', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const response = await runJobDrainRequest(drainRequest(token), { config, pool: workerPool });
      expect(response.status, String(token)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }

    // La cola sigue intacta: ni un trabajo reclamado.
    expect(await jobStates('time_report.autoconfirm')).toEqual([{ status: 'queued', attempts: 0 }]);
    expect((await reportStatuses())[0]).toEqual({ status: 'submitted', auto: false });
  });

  it('sin configuración completa responde 503 y deja la cola quieta', async () => {
    const response = await runJobDrainRequest(drainRequest(), { config: null, pool: workerPool });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'job_runner_unavailable' });
    expect(await jobStates('time_report.autoconfirm')).toEqual([{ status: 'queued', attempts: 0 }]);
  });

  it('con el secreto correcto ejecuta el trabajo encolado y el parte queda confirmado', async () => {
    const response = await runJobDrainRequest(drainRequest(), { config, pool: workerPool });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ran: number;
      remaining: number;
      stoppedBy: string;
      reclaimed: { requeued: number; dead: number };
    };

    // El efecto real: el parte que llevaba cuatro días enviado ya está
    // confirmado, y sin actor humano.
    expect((await reportStatuses())[0]).toEqual({ status: 'confirmed', auto: true });
    expect(await jobStates('time_report.autoconfirm')).toEqual([
      { status: 'completed', attempts: 1 }
    ]);

    // Y de paso el drenaje re-armó las dos cadenas periódicas, que en el demonio
    // se sembraban al arrancar y aquí no tienen arranque al que agarrarse.
    expect(await jobStates('maintenance.prune_discovery')).toEqual([
      { status: 'completed', attempts: 1 },
      { status: 'queued', attempts: 0 }
    ]);
    expect(await jobStates('ics.sync_all')).toEqual([
      { status: 'completed', attempts: 1 },
      { status: 'queued', attempts: 0 }
    ]);

    // Se agotó la cola (los re-encolados quedan a +7 días y +6 horas) y no
    // quedaba nada listo.
    expect(body.stoppedBy).toBe('empty');
    expect(body.ran).toBe(3);
    expect(body.remaining).toBe(0);
    expect(body.reclaimed).toEqual({ requeued: 0, dead: 0 });
  });

  it('el presupuesto corta ENTRE trabajos: ninguno se queda a medias', async () => {
    // Tres trabajos idénticos (la auto-confirmación es idempotente) para tener
    // cola de sobra sin gastar los partes que usa la prueba siguiente.
    for (let index = 0; index < 3; index += 1) {
      await enqueue('time_report.autoconfirm', { reportId: REPORTS[1]!.id });
    }

    // Reloj falso: el primer trabajo entra dentro del presupuesto y el segundo
    // ya no. Lo que importa es que el corte no deje ninguna fila en `running`.
    let tick = 0;
    const outcome = await drainJobQueue(workerPool, {
      handlers: {
        'time_report.autoconfirm': async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
      maxAttempts: 5,
      budgetMs: 1_000,
      now: () => {
        tick += 1;
        // 0 al empezar, 0 antes del primer trabajo, 5000 antes del segundo.
        return tick <= 2 ? 0 : 5_000;
      }
    });

    expect(outcome.stoppedBy).toBe('budget');
    expect(outcome.ran).toBe(1);
    expect(outcome.remaining).toBe(2);

    const running = await adminPool.query("select 1 from app_private.job_queue where status = 'running'");
    expect(running.rowCount).toBe(0);
  });

  it('dos pasadas simultáneas se reparten la cola sin ejecutar nada dos veces', async () => {
    for (const report of REPORTS.slice(2)) {
      await enqueue('time_report.autoconfirm', { reportId: report.id });
    }

    const [first, second] = await Promise.all([
      runJobDrainRequest(drainRequest(), { config, pool: workerPool }),
      runJobDrainRequest(drainRequest(), { config, pool: workerPool })
    ]);
    expect([first!.status, second!.status]).toEqual([200, 200]);

    // Los cuatro partes confirmados y, sobre todo, CADA trabajo con un solo
    // intento: nadie reclamó el mismo dos veces (`for update skip locked`).
    expect(await reportStatuses()).toEqual(REPORTS.map(() => ({ status: 'confirmed', auto: true })));
    // 1 del primer drenaje + 3 del presupuesto + 2 de aquí.
    const states = await jobStates('time_report.autoconfirm');
    expect(states).toHaveLength(6);
    expect(states.every((job) => job.status === 'completed' && job.attempts === 1)).toBe(true);
  });

  it('un trabajo abandonado en `running` vuelve a la cola pasado su arriendo', async () => {
    await enqueue('time_report.autoconfirm', { reportId: REPORTS[0]!.id });
    // Se simula el corte de la plataforma a mitad: reclamado y nunca cerrado.
    await adminPool.query(
      `update app_private.job_queue
          set status = 'running', attempts = 1, locked_at = now() - interval '30 minutes'
        where job_type = 'time_report.autoconfirm' and status = 'queued'`
    );

    const response = await runJobDrainRequest(drainRequest(), { config, pool: workerPool });
    const body = (await response.json()) as { reclaimed: { requeued: number; dead: number } };
    expect(body.reclaimed).toEqual({ requeued: 1, dead: 0 });

    // Rescatado y ejecutado en la misma pasada; el intento anterior se conserva.
    const states = await jobStates('time_report.autoconfirm');
    expect(states.at(-1)).toEqual({ status: 'completed', attempts: 2 });
  });

  it('un abandonado que ya agotó sus intentos pasa a `dead` en vez de girar para siempre', async () => {
    await enqueue('time_report.autoconfirm', { reportId: REPORTS[1]!.id });
    await adminPool.query(
      `update app_private.job_queue
          set status = 'running', attempts = 5, locked_at = now() - interval '30 minutes'
        where job_type = 'time_report.autoconfirm' and status = 'queued'`
    );

    const response = await runJobDrainRequest(drainRequest(), { config, pool: workerPool });
    const body = (await response.json()) as { reclaimed: { requeued: number; dead: number } };
    expect(body.reclaimed).toEqual({ requeued: 0, dead: 1 });

    const dead = await adminPool.query<{ last_error: string }>(
      `select last_error from app_private.job_queue where status = 'dead'`
    );
    expect(dead.rows).toEqual([{ last_error: 'AbandonedJobError: el ejecutor no terminó el trabajo' }]);
  });
});

describe('secreto compartido y configuración del drenaje', () => {
  it('la comparación del secreto no acepta prefijos, sufijos ni la cadena vacía', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    for (const candidate of ['', TOKEN.slice(0, -1), `${TOKEN}x`, ` ${TOKEN}`, 'x'.repeat(200)]) {
      expect(tokenMatches(candidate, TOKEN), candidate).toBe(false);
    }
    expect(tokenMatches(null, TOKEN)).toBe(false);
    // Sin secreto configurado no pasa nadie, ni siquiera presentando la vacía.
    expect(tokenMatches('', '')).toBe(false);
  });

  it('exige TODO lo que necesitan los cuatro trabajos, no solo la base', () => {
    const complete = {
      WORKER_DATABASE_URL: 'postgresql://casa_clara_worker_login@db.invalid:6543/postgres',
      JOB_RUNNER_TOKEN: TOKEN,
      S3_ENDPOINT: 'https://s3.invalid',
      S3_PRIVATE_BUCKET: 'casaclara',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret'
    };
    expect(loadJobRunnerConfig(complete)).toMatchObject({
      token: TOKEN,
      budgetMs: 8_000,
      maxAttempts: 5,
      storage: { region: 'eu-west-1' }
    });

    for (const missing of Object.keys(complete)) {
      const partial = { ...complete, [missing]: '  ' };
      expect(loadJobRunnerConfig(partial), missing).toBeNull();
    }
  });

  it('SIN remitente SMTP el drenaje arranca igual: era la exigencia que paraba la cola', () => {
    // El defecto que corrige la 0029. Con `SMTP_HOST`/`SMTP_FROM` en la lista de
    // imprescindibles, producción —que nunca los tuvo, porque no hay correo—
    // recibía un 503 en cada pasada del cron y la cola no avanzaba: ni recibos,
    // ni sincronización de calendarios, ni poda. Ahora ni se miran.
    const withoutMail = {
      WORKER_DATABASE_URL: 'postgresql://casa_clara_worker_login@db.invalid:6543/postgres',
      JOB_RUNNER_TOKEN: TOKEN,
      S3_ENDPOINT: 'https://s3.invalid',
      S3_PRIVATE_BUCKET: 'casaclara',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret'
    };
    expect(loadJobRunnerConfig(withoutMail)).not.toBeNull();
    // Y declararlos tampoco cambia nada: son variables sin lector.
    expect(
      loadJobRunnerConfig({ ...withoutMail, SMTP_HOST: 'smtp.invalid', SMTP_FROM: 'x@invalid' })
    ).toEqual(loadJobRunnerConfig(withoutMail));
  });

  it('el presupuesto y los intentos se pueden ajustar, y un valor absurdo cae al defecto', () => {
    const base = {
      WORKER_DATABASE_URL: 'postgresql://casa_clara_worker_login@db.invalid:6543/postgres',
      JOB_RUNNER_TOKEN: TOKEN,
      S3_ENDPOINT: 'https://s3.invalid',
      S3_PRIVATE_BUCKET: 'casaclara',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret'
    };
    expect(
      loadJobRunnerConfig({ ...base, JOB_RUNNER_BUDGET_MS: '25000', WORKER_MAX_JOB_ATTEMPTS: '3' })
    ).toMatchObject({ budgetMs: 25_000, maxAttempts: 3 });
    expect(
      loadJobRunnerConfig({ ...base, JOB_RUNNER_BUDGET_MS: '-1', WORKER_MAX_JOB_ATTEMPTS: 'muchos' })
    ).toMatchObject({ budgetMs: 8_000, maxAttempts: 5 });
  });
});
