import type { Pool } from "pg";

import { PUSH_NOTICE_JOB } from "./push.js";
import type { JobHandler } from "./queue.js";

export const CLOSE_DUE_SWEEP_JOB = "notification.close_due_sweep";

/** Cadencia: una vez al mes, el penúltimo día (ver `closeDueTargetDay`). */

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** El penúltimo día (UTC, sin hora) del mes `monthIndex0` (0 = enero) de `year`. */
function secondToLastDayOfMonth(year: number, monthIndex0: number): Date {
  // Día 0 del mes siguiente = último día de este mes; día -1 = el anterior.
  return new Date(Date.UTC(year, monthIndex0 + 1, -1));
}

/**
 * Cuándo programar el barrido de este mes: el penúltimo día del mes de
 * `today`, o el del mes SIGUIENTE si ese día ya pasó (p. ej. el worker arranca
 * por primera vez el último día de un mes de 31, con el 30 ya history). «Ya
 * pasó» es estricto: si hoy es exactamente el penúltimo día, se programa para
 * hoy — `app.job_run_at` decide la hora y, si ya es tarde, sale en el primer
 * drenaje, igual que cualquier otro trabajo de esta cola.
 */
export function closeDueTargetDay(today: Date): string {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  let candidate = secondToLastDayOfMonth(year, month);
  const todayMidnight = Date.UTC(year, month, today.getUTCDate());
  if (candidate.getTime() < todayMidnight) {
    candidate = secondToLastDayOfMonth(year, month + 1);
  }
  return formatIsoDate(candidate);
}

/** El penúltimo día del mes SIGUIENTE al de `today`, para re-armar el barrido. */
export function closeDueTargetDayNextMonth(today: Date): string {
  return formatIsoDate(secondToLastDayOfMonth(today.getUTCFullYear(), today.getUTCMonth() + 1));
}

export interface CloseDueSweepDeps {
  /** `app_private.close_due_households(referenceDay)`: hogares con algo por cerrar. */
  listHouseholds: (referenceDay: string) => Promise<string[]>;
  /**
   * Encola `notification.push {topic:'settlement.close_due'}` para un hogar.
   * Idempotente por construcción: el índice único parcial de la migración 0034
   * (`close_due_push_pending_idx`) impide un segundo aviso pendiente para el
   * mismo hogar mientras el primero siga `queued`/`running`, así que repetir
   * este trabajo entero —p. ej. tras un fallo a mitad de la lista— no duplica
   * ningún aviso: el hogar ya avisado simplemente no vuelve a insertarse.
   */
  enqueuePush: (input: { householdId: string }) => Promise<void>;
  /** Re-arma el barrido para el mes siguiente (SIEMPRE, incluso con cero hogares hoy). */
  enqueueSweep: (input: { householdId: string; targetDay: string }) => Promise<void>;
  /**
   * Fecha civil de HOY en `Europe/Madrid`, vía consulta — nunca `new Date()`
   * del proceso: el proceso puede correr en UTC (o cualquier otra zona) y la
   * base reevalúa el mes natural con `Europe/Madrid`. Mismo patrón que
   * `ensureCloseDueScheduled`.
   */
  today: () => Promise<string>;
}

/**
 * Job `notification.close_due_sweep` (global, patrón `maintenance.prune_discovery`
 * / `ics.sync_all`): por cada hogar con algo por cerrar este mes natural,
 * encola un `notification.push` de tópico `settlement.close_due`; después se
 * re-arma para el mes siguiente. Se re-arma SIEMPRE, también con cero hogares
 * esta vez, para que la cadena periódica no se muera un mes tranquilo.
 */
export function createCloseDueSweepHandler(deps: CloseDueSweepDeps): JobHandler {
  return async (job) => {
    const todayIso = await deps.today();
    const households = await deps.listHouseholds(todayIso);
    for (const householdId of households) {
      await deps.enqueuePush({ householdId });
    }
    await deps.enqueueSweep({
      householdId: job.householdId,
      targetDay: closeDueTargetDayNextMonth(new Date(`${todayIso}T00:00:00.000Z`)),
    });
  };
}

/**
 * Fecha civil de HOY en `Europe/Madrid`, vía consulta: nunca `new Date()` del
 * proceso, que puede correr en cualquier zona y desalinearse justo en los
 * bordes de mes que este trabajo necesita acertar.
 */
async function civilToday(pool: Pool): Promise<string> {
  const result = await pool.query<{ today: string }>(
    "select ((now() AT TIME ZONE 'Europe/Madrid')::date)::text as today",
  );
  const today = result.rows[0]?.today;
  if (!today) throw new Error("No se pudo obtener la fecha civil de Europe/Madrid");
  return today;
}

/**
 * Dependencias reales sobre el pool del worker: la función definer de la 0034
 * para listar hogares, e INSERT directo en `app_private.job_queue` para los
 * dos tipos de trabajo que encola (mismo patrón que `createMaintenanceQueries`
 * y `createPushQueries`).
 */
export function createCloseDueQueries(pool: Pool): {
  listHouseholds: CloseDueSweepDeps["listHouseholds"];
  enqueuePush: CloseDueSweepDeps["enqueuePush"];
  enqueueSweep: CloseDueSweepDeps["enqueueSweep"];
  today: CloseDueSweepDeps["today"];
} {
  return {
    listHouseholds: async (referenceDay) => {
      // `RETURNS SETOF uuid` expone la columna con el NOMBRE DE LA FUNCIÓN
      // (`close_due_households`), no `household_id`: sin el alias, esto falla
      // con 42703 («no existe la columna household_id»).
      const result = await pool.query<{ household_id: string }>(
        "select close_due_households as household_id from app_private.close_due_households($1::date)",
        [referenceDay],
      );
      return result.rows.map((row) => row.household_id);
    },
    enqueuePush: async ({ householdId }) => {
      try {
        await pool.query(
          `insert into app_private.job_queue (household_id, job_type, payload, run_at)
           values ($1, $2, $3::jsonb, app.push_run_at(statement_timestamp()))`,
          [householdId, PUSH_NOTICE_JOB, JSON.stringify({ topic: "settlement.close_due" })],
        );
      } catch (error) {
        // El índice único parcial de la 0034 es quien de verdad impide el
        // duplicado (ver su comentario): un choque aquí (23505) es el
        // mecanismo funcionando, no un fallo del trabajo.
        if ((error as { code?: string }).code === "23505") return;
        throw error;
      }
    },
    enqueueSweep: async ({ householdId, targetDay }) => {
      await pool.query(
        `insert into app_private.job_queue (household_id, job_type, payload, run_at)
         values ($1, $2, '{}'::jsonb, app.job_run_at($3::date))`,
        [householdId, CLOSE_DUE_SWEEP_JOB, targetDay],
      );
    },
    today: () => civilToday(pool),
  };
}

/**
 * Auto-encolado al arrancar (y en cada pasada del drenaje serverless, mismo
 * contrato que `ensurePruneDiscoveryScheduled`/`ensureIcsSyncScheduled`): si
 * no hay ya un barrido pendiente, programa el próximo para el penúltimo día
 * del mes en curso (o el siguiente, si ese día ya pasó). El hogar-ancla es
 * relleno estructural de la cola, igual que en los otros dos: `household_id`
 * es NOT NULL y el worker no puede leer `app.households` directamente.
 */
export async function ensureCloseDueScheduled(
  pool: Pool,
): Promise<"already-scheduled" | "scheduled" | "empty-queue"> {
  const pending = await pool.query(
    `select 1 from app_private.job_queue
      where job_type = $1 and status in ('queued', 'running')
      limit 1`,
    [CLOSE_DUE_SWEEP_JOB],
  );
  if ((pending.rowCount ?? 0) > 0) return "already-scheduled";

  const anchor = await pool.query<{ household_id: string }>(
    "select household_id from app_private.job_queue limit 1",
  );
  const householdId = anchor.rows[0]?.household_id;
  if (!householdId) return "empty-queue";

  const today = await civilToday(pool);
  const targetDay = closeDueTargetDay(new Date(`${today}T00:00:00.000Z`));

  await pool.query(
    `insert into app_private.job_queue (household_id, job_type, payload, run_at)
     values ($1, $2, '{}'::jsonb, app.job_run_at($3::date))`,
    [householdId, CLOSE_DUE_SWEEP_JOB, targetDay],
  );
  return "scheduled";
}
