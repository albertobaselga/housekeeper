import type { Pool } from "pg";

import { PermanentJobError, type JobHandler } from "./queue.js";

export const PRUNE_DISCOVERY_JOB = "maintenance.prune_discovery";

/** Cadencia de la poda: mientras el worker viva, se re-encola cada semana. */
export const PRUNE_INTERVAL_DAYS = 7;

// Espejo de los DEFAULT de app_private.prune_discovery_data (migración 0012).
// El mínimo duro de 30 días lo impone la propia función con ERRCODE 22023.
export const DEFAULT_READS_KEEP_DAYS = 45;
export const DEFAULT_GAPS_KEEP_DAYS = 180;

const DAY_MS = 86_400_000;

export interface PruneResult {
  prunedReads: number;
  prunedGaps: number;
}

export interface PruneEnqueueInput {
  householdId: string;
  type: string;
  payload: unknown;
  runAt: Date;
}

export interface PruneDiscoveryDeps {
  prune: (readsKeepDays: number, gapsKeepDays: number) => Promise<PruneResult>;
  enqueue: (input: PruneEnqueueInput) => Promise<void>;
  now?: () => Date;
}

interface PrunePayload {
  readsKeepDays: number;
  gapsKeepDays: number;
}

function optionalKeepDays(payload: unknown, field: string, fallback: number): number {
  const value = (payload as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PermanentJobError(`${field} debe ser un número entero de días`);
  }
  return value;
}

export function parsePrunePayload(payload: unknown): PrunePayload {
  return {
    readsKeepDays: optionalKeepDays(payload, "readsKeepDays", DEFAULT_READS_KEEP_DAYS),
    gapsKeepDays: optionalKeepDays(payload, "gapsKeepDays", DEFAULT_GAPS_KEEP_DAYS),
  };
}

/**
 * Job `maintenance.prune_discovery` {readsKeepDays?, gapsKeepDays?}: retención
 * de los datos de descubrimiento (P2-4 de la revisión). La función
 * `app_private.prune_discovery_data` de la 0012 es GLOBAL — poda
 * `app.wiki_page_reads` y `app.search_gap_events` de todos los hogares en una
 * sola llamada — así que el `household_id` del job es solo el requisito NOT
 * NULL de la cola, no un ámbito. Al completar se re-encola a +7 días con el
 * mismo payload (patrón de los recordatorios). Una retención bajo el mínimo de
 * 30 días la rechaza la base con 22023 y aquí se convierte en fallo permanente:
 * reintentar no la haría legal.
 */
export function createPruneDiscoveryHandler(deps: PruneDiscoveryDeps): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job) => {
    const payload = parsePrunePayload(job.payload);
    try {
      await deps.prune(payload.readsKeepDays, payload.gapsKeepDays);
    } catch (error) {
      if ((error as { code?: string }).code === "22023") {
        throw new PermanentJobError(
          `Retención inválida (mínimo 30 días): reads=${payload.readsKeepDays}, gaps=${payload.gapsKeepDays}`,
        );
      }
      throw error;
    }
    await deps.enqueue({
      householdId: job.householdId,
      type: PRUNE_DISCOVERY_JOB,
      payload: { readsKeepDays: payload.readsKeepDays, gapsKeepDays: payload.gapsKeepDays },
      runAt: new Date(now().getTime() + PRUNE_INTERVAL_DAYS * DAY_MS),
    });
  };
}

/**
 * Dependencias reales sobre el pool del worker: EXECUTE de la función de la
 * 0012 e INSERT directo en `app_private.job_queue` (el worker no puede usar
 * `app.enqueue_job`, que exige contexto de aplicación).
 */
export function createMaintenanceQueries(pool: Pool): {
  pruneDiscoveryData: PruneDiscoveryDeps["prune"];
  enqueueJob: PruneDiscoveryDeps["enqueue"];
} {
  return {
    pruneDiscoveryData: async (readsKeepDays, gapsKeepDays) => {
      const result = await pool.query<{ pruned_reads: string; pruned_gaps: string }>(
        "select pruned_reads::text, pruned_gaps::text from app_private.prune_discovery_data($1, $2)",
        [readsKeepDays, gapsKeepDays],
      );
      const row = result.rows[0];
      return {
        prunedReads: Number(row?.pruned_reads ?? "0"),
        prunedGaps: Number(row?.pruned_gaps ?? "0"),
      };
    },
    enqueueJob: async ({ householdId, type, payload, runAt }) => {
      await pool.query(
        `insert into app_private.job_queue (household_id, job_type, payload, run_at)
         values ($1, $2, $3::jsonb, $4)`,
        [householdId, type, JSON.stringify(payload), runAt],
      );
    },
  };
}

/**
 * Auto-encolado al arrancar el worker: si no hay ningún `maintenance.prune_discovery`
 * pendiente (queued o running), inserta uno inmediato con los valores por defecto.
 *
 * `job_queue.household_id` es NOT NULL y el worker no puede leer
 * `app.households` (sin grant, deliberadamente), así que el hogar se toma
 * prestado de cualquier fila ya existente de la cola — la función de poda es
 * global y ese id es solo relleno estructural. Con la cola completamente vacía
 * (posible solo en un despliegue recién sembrado sin actividad) el worker no
 * puede fabricar un id válido y se abstiene: ese único caso lo arranca el
 * operador con el SQL documentado en docs/runbooks/staging-synthetic.md, y en
 * cuanto exista cualquier job el siguiente arranque lo encola solo.
 *
 * Devuelve qué pasó para poder observarlo (y probarlo) sin efectos ocultos.
 */
export async function ensurePruneDiscoveryScheduled(
  pool: Pool,
): Promise<"already-scheduled" | "scheduled" | "empty-queue"> {
  const pending = await pool.query(
    `select 1 from app_private.job_queue
      where job_type = $1 and status in ('queued', 'running')
      limit 1`,
    [PRUNE_DISCOVERY_JOB],
  );
  if ((pending.rowCount ?? 0) > 0) return "already-scheduled";

  const anchor = await pool.query<{ household_id: string }>(
    "select household_id from app_private.job_queue limit 1",
  );
  const householdId = anchor.rows[0]?.household_id;
  if (!householdId) return "empty-queue";

  await pool.query(
    `insert into app_private.job_queue (household_id, job_type, payload, run_at)
     values ($1, $2, $3::jsonb, now())`,
    [
      householdId,
      PRUNE_DISCOVERY_JOB,
      JSON.stringify({
        readsKeepDays: DEFAULT_READS_KEEP_DAYS,
        gapsKeepDays: DEFAULT_GAPS_KEEP_DAYS,
      }),
    ],
  );
  return "scheduled";
}
