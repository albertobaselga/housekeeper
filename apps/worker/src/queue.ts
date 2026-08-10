import type { Pool, PoolClient } from "pg";

export interface ClaimedJob {
  id: string;
  householdId: string;
  type: string;
  payload: unknown;
  attempts: number;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Error que no merece reintentos: el job pasa directamente a `dead`. */
export class PermanentJobError extends Error {
  override readonly name = "PermanentJobError";
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNextJob(pool: Pool): Promise<ClaimedJob | null> {
  return transaction(pool, async (client) => {
    const result = await client.query<{
      id: string;
      household_id: string;
      job_type: string;
      payload: unknown;
      attempts: number;
    }>(`select id, household_id, job_type, payload, attempts
        from app_private.job_queue
        where status = 'queued' and run_at <= now()
        order by run_at, created_at
        for update skip locked
        limit 1`);
    const row = result.rows[0];
    if (!row) return null;
    await client.query(
      `update app_private.job_queue
       set status = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
       where id = $1`,
      [row.id],
    );
    return {
      id: row.id,
      householdId: row.household_id,
      type: row.job_type,
      payload: row.payload,
      attempts: row.attempts + 1,
    };
  });
}

export async function completeJob(pool: Pool, id: string): Promise<void> {
  await pool.query(
    `update app_private.job_queue
     set status = 'completed', completed_at = now(), locked_at = null, updated_at = now()
     where id = $1`,
    [id],
  );
}

export async function failJob(
  pool: Pool,
  job: ClaimedJob,
  error: unknown,
  maxAttempts: number,
): Promise<void> {
  const permanent = job.attempts >= maxAttempts;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "Error desconocido";
  const delaySeconds = Math.min(3_600, 2 ** job.attempts * 15);
  await pool.query(
    `update app_private.job_queue
     set status = $2,
         last_error = $3,
         run_at = case when $2 = 'queued' then now() + make_interval(secs => $4) else run_at end,
         locked_at = null,
         updated_at = now()
     where id = $1`,
    [job.id, permanent ? "dead" : "queued", message.slice(0, 500), delaySeconds],
  );
}

/**
 * Duración máxima que se le concede a un trabajo reclamado antes de darlo por
 * abandonado. Cinco minutos es dos órdenes de magnitud más que el más lento de
 * los siete tipos (`ics.sync_source`, con un tope de 10 s de descarga), así que
 * una fila que lleve más tiempo en `running` no está trabajando: su ejecutor ya
 * no existe.
 */
export const DEFAULT_JOB_LEASE_MS = 300_000;

/**
 * Devuelve a la cola los trabajos cuyo ejecutor desapareció a mitad.
 *
 * `claimNextJob` solo mira filas `queued`, así que un trabajo que quedó en
 * `running` porque el proceso murió —o, en el drenaje serverless, porque la
 * plataforma cortó la función al agotarse su tiempo— se queda ahí para siempre
 * y bloquea ese aviso, ese PDF o esa sincronización sin que nadie se entere.
 * No es un fallo del trabajo: el handler nunca llegó a lanzar, así que los
 * reintentos de `failJob` tampoco entran.
 *
 * `attempts` ya se incrementó al reclamarlo, de modo que el presupuesto de
 * reintentos se respeta sin tocarlo: quien ya lo agotó pasa a `dead` con la
 * causa escrita, y el resto vuelve a `queued` para el siguiente turno. Devuelve
 * cuántas filas se movieron a cada estado.
 */
export async function reclaimStaleJobs(
  pool: Pool,
  maxAttempts: number,
  leaseMs: number = DEFAULT_JOB_LEASE_MS,
): Promise<{ requeued: number; dead: number }> {
  const result = await pool.query<{ status: string }>(
    `update app_private.job_queue
        set status = (case when attempts >= $2 then 'dead' else 'queued' end)::app_private.job_status,
            last_error = $3,
            locked_at = null,
            updated_at = now()
      where status = 'running'
        and locked_at is not null
        and locked_at < now() - make_interval(secs => $1)
      returning status::text as status`,
    [Math.max(1, Math.round(leaseMs / 1_000)), maxAttempts, "AbandonedJobError: el ejecutor no terminó el trabajo"],
  );
  let requeued = 0;
  let dead = 0;
  for (const row of result.rows) {
    if (row.status === "dead") dead += 1;
    else requeued += 1;
  }
  return { requeued, dead };
}

/** Trabajos listos para ejecutarse ahora mismo (`queued` y con `run_at` vencido). */
export async function countReadyJobs(pool: Pool): Promise<number> {
  const result = await pool.query<{ ready: string }>(
    `select count(*)::text as ready
       from app_private.job_queue
      where status = 'queued' and run_at <= now()`,
  );
  return Number(result.rows[0]?.ready ?? "0");
}

export async function runOneJob(
  pool: Pool,
  handlers: Readonly<Record<string, JobHandler>>,
  maxAttempts: number,
): Promise<boolean> {
  const job = await claimNextJob(pool);
  if (!job) return false;
  const handler = handlers[job.type];
  if (!handler) {
    await failJob(pool, job, new Error(`Tipo de trabajo no soportado: ${job.type}`), 1);
    return true;
  }
  try {
    await handler(job);
    await completeJob(pool, job.id);
  } catch (error) {
    await failJob(pool, job, error, error instanceof PermanentJobError ? 1 : maxAttempts);
  }
  return true;
}
