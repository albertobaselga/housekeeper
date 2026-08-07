import type { Pool, PoolClient } from "pg";

export interface ClaimedJob {
  id: string;
  householdId: string;
  type: string;
  payload: unknown;
  attempts: number;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

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
    await failJob(pool, job, error, maxAttempts);
  }
  return true;
}
