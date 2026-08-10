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
// aparece en la base. Antes de esta oleada nadie vaciaba la cola y el
// calendario no se refrescaba solo.
//
// El trabajo de ejemplo es `maintenance.prune_discovery`, la poda de los datos
// de descubrimiento. Era `time_report.autoconfirm`, que se retiró con la
// migración 0029 junto con el parte semanal. La poda sirve igual y además
// mejor: es SQL puro (no toca red ni almacén), es idempotente, y su efecto se
// mira sin sembrar nada porque al terminar SE RE-ENCOLA a siete días. Eso es
// justo lo que hay que comprobar de un ejecutor: que el trabajo corrió entero,
// no solo que la fila cambió de estado.

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const WORKER_LOGIN = 'it_casa_clara_jobrun_worker_login';
// Base propia: las demás suites recrean el esquema en paralelo y esta cuenta
// filas de la cola, que no admite vecinos.
const JOBS_DB = 'casaclara_jobrun_it';

const TOKEN = 'secreto-de-prueba-32-bytes-largo-0';
const PRUNE_JOB = 'maintenance.prune_discovery';

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

  /** Encola una poda lista para ejecutarse y devuelve su id, para poder seguirla. */
  async function enqueuePrune(): Promise<string> {
    const inserted = await adminPool.query<{ id: string }>(
      `insert into app_private.job_queue (household_id, job_type, payload, run_at)
       values ($1, $2, '{}'::jsonb, now())
       returning id`,
      [FIXTURE_HOUSEHOLD, PRUNE_JOB]
    );
    return inserted.rows[0]!.id;
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

  async function jobById(id: string): Promise<{ status: string; attempts: number } | undefined> {
    const result = await adminPool.query<{ status: string; attempts: number }>(
      `select status::text as status, attempts from app_private.job_queue where id = $1`,
      [id]
    );
    return result.rows[0];
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

  let firstPrune: string;

  it('sin el secreto correcto no ejecuta nada y responde 401', async () => {
    firstPrune = await enqueuePrune();

    // Sin cabecera, vacío, otro secreto y dos casi-aciertos: el que le sobra un
    // carácter y el que le falta. (Un token con espacios al final no se prueba
    // aquí: HTTP recorta el valor de la cabecera antes de que llegue.)
    for (const token of [null, '', 'otro-secreto', `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const response = await runJobDrainRequest(drainRequest(token), { config, pool: workerPool });
      expect(response.status, String(token)).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }

    // La cola sigue intacta: ni un trabajo reclamado.
    expect(await jobStates(PRUNE_JOB)).toEqual([{ status: 'queued', attempts: 0 }]);
  });

  it('sin configuración completa responde 503 y deja la cola quieta', async () => {
    const response = await runJobDrainRequest(drainRequest(), { config: null, pool: workerPool });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'job_runner_unavailable' });
    expect(await jobStates(PRUNE_JOB)).toEqual([{ status: 'queued', attempts: 0 }]);
  });

  it('con el secreto correcto ejecuta la cola entera con el catálogo real', async () => {
    const response = await runJobDrainRequest(drainRequest(), { config, pool: workerPool });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ran: number;
      remaining: number;
      stoppedBy: string;
      reclaimed: { requeued: number; dead: number };
    };

    // El efecto real, y la prueba de que el manejador corrió ENTERO y no solo
    // se marcó la fila: la poda encolada se completó y dejó la siguiente puesta
    // para dentro de una semana.
    expect(await jobById(firstPrune)).toEqual({ status: 'completed', attempts: 1 });
    expect(await jobStates(PRUNE_JOB)).toEqual([
      { status: 'completed', attempts: 1 },
      { status: 'queued', attempts: 0 }
    ]);

    // Y de paso el drenaje re-armó la cadena periódica de calendarios, que en
    // el demonio se sembraba al arrancar y aquí no tiene arranque al que
    // agarrarse. (La de la poda no hizo falta re-armarla: ya había una puesta.)
    expect(await jobStates('ics.sync_all')).toEqual([
      { status: 'completed', attempts: 1 },
      { status: 'queued', attempts: 0 }
    ]);

    // Se agotó la cola (los re-encolados quedan a +7 días y +6 horas) y no
    // quedaba nada listo.
    expect(body.stoppedBy).toBe('empty');
    expect(body.ran).toBe(2);
    expect(body.remaining).toBe(0);
    expect(body.reclaimed).toEqual({ requeued: 0, dead: 0 });
  });

  it('el presupuesto corta ENTRE trabajos: ninguno se queda a medias', async () => {
    // Tres trabajos y un manejador de mentira: aquí no se comprueba qué hace la
    // poda —eso es lo anterior— sino que el corte por reloj no deja ninguna
    // fila reclamada a medias.
    for (let index = 0; index < 3; index += 1) await enqueuePrune();

    let tick = 0;
    const outcome = await drainJobQueue(workerPool, {
      handlers: {
        [PRUNE_JOB]: async () => {
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
    const [first, second] = await Promise.all([
      runJobDrainRequest(drainRequest(), { config, pool: workerPool }),
      runJobDrainRequest(drainRequest(), { config, pool: workerPool })
    ]);
    expect([first!.status, second!.status]).toEqual([200, 200]);

    // Lo que importa: NINGÚN trabajo con más de un intento. Dos pasadas a la vez
    // se reparten la cola con `for update skip locked` y nadie reclama el mismo
    // dos veces; un segundo intento sería justo la señal de que sí.
    const states = await jobStates(PRUNE_JOB);
    expect(states.filter((job) => job.attempts > 1)).toEqual([]);
    expect(states.filter((job) => job.status === 'running')).toEqual([]);
    expect(states.filter((job) => job.status === 'completed').length).toBeGreaterThanOrEqual(3);
  });

  it('un trabajo abandonado en `running` vuelve a la cola pasado su arriendo', async () => {
    const abandoned = await enqueuePrune();
    // Se simula el corte de la plataforma a mitad: reclamado y nunca cerrado.
    await adminPool.query(
      `update app_private.job_queue
          set status = 'running', attempts = 1, locked_at = now() - interval '30 minutes'
        where id = $1`,
      [abandoned]
    );

    const response = await runJobDrainRequest(drainRequest(), { config, pool: workerPool });
    const body = (await response.json()) as { reclaimed: { requeued: number; dead: number } };
    expect(body.reclaimed).toEqual({ requeued: 1, dead: 0 });

    // Rescatado y ejecutado en la misma pasada; el intento anterior se conserva.
    expect(await jobById(abandoned)).toEqual({ status: 'completed', attempts: 2 });
  });

  it('un abandonado que ya agotó sus intentos pasa a `dead` en vez de girar para siempre', async () => {
    const exhausted = await enqueuePrune();
    await adminPool.query(
      `update app_private.job_queue
          set status = 'running', attempts = 5, locked_at = now() - interval '30 minutes'
        where id = $1`,
      [exhausted]
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
