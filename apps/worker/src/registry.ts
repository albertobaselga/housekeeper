/**
 * El registro de manejadores de la cola, en un solo sitio.
 *
 * Existen dos ejecutores de la misma cola y no puede haber dos catálogos de
 * trabajos:
 *
 *   · el demonio de `apps/worker` (host autogestionado, sondeo de 1 s), y
 *   · el drenaje por HTTP de `apps/web` (Vercel + pg_cron, un presupuesto de
 *     segundos por pasada; ver docs/runbooks/planificador-cola.md).
 *
 * Lo único que los distingue son los efectos externos —a qué SMTP se manda el
 * correo, contra qué almacén se sube el PDF y a dónde escribe el log—, así que
 * eso entra por parámetro y todo lo demás se construye igual. Añadir un tipo de
 * trabajo aquí lo enciende en los dos ejecutores a la vez; añadirlo en uno solo
 * es el fallo que este módulo hace imposible.
 *
 * El logger llega inyectado y no importado a propósito. `@casa-clara/server`
 * expone la versión con redacción por dos caminos incompatibles —`/logging`
 * apunta a `dist` (lo que necesita el demonio compilado con tsc) y la raíz
 * apunta a `src` (lo que necesita el empaquetador de la web)—, y un import fijo
 * aquí obligaría a construir el paquete antes de poder ejecutar las pruebas de
 * la web. La interfaz `JobLogger` es el subconjunto que este módulo usa.
 */
import type { Pool } from "pg";

import { RENDER_RECEIPT_JOB, createRenderReceiptHandler, type DocumentUploader } from "./handlers.js";
import {
  ICS_SYNC_ALL_JOB,
  ICS_SYNC_JOB,
  ROUTINE_DUE_JOB,
  createIcsQueries,
  createIcsSyncAllHandler,
  createIcsSyncHandler,
  createRoutineDueHandler,
  fetchIcsSource,
} from "./ics.js";
import type { OutgoingEmail } from "./mail.js";
import {
  PRUNE_DISCOVERY_JOB,
  createMaintenanceQueries,
  createPruneDiscoveryHandler,
} from "./maintenance.js";
import type { JobHandler } from "./queue.js";
import {
  AUTOCONFIRM_JOB,
  SETTLEMENT_DUE_JOB,
  createAutoconfirmHandler,
  createReminderQueries,
  createSettlementDueHandler,
} from "./reminders.js";

/** Lo que este módulo necesita del logger con redacción de `@casa-clara/server`. */
export interface JobLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface JobRuntimeDeps {
  /** Pool con el rol `casa_clara_worker`: es el único que puede tocar la cola. */
  pool: Pool;
  sendEmail: (input: OutgoingEmail) => Promise<void>;
  uploadDocument: DocumentUploader;
  log: JobLogger;
  /** `errorCode` de `@casa-clara/server`: código estable y sin datos personales. */
  errorCode: (cause: unknown) => string;
}

/**
 * Observabilidad de jobs sin PII (control 8): cada handler queda envuelto en
 * el logger compartido con redacción — solo identificadores técnicos, duración
 * y código de error. El fallo se relanza para que la cola aplique reintentos.
 */
export function withJobLogging(
  deps: Pick<JobRuntimeDeps, "log" | "errorCode">,
  jobType: string,
  handler: JobHandler,
): JobHandler {
  return async (job) => {
    const startedAt = Date.now();
    try {
      await handler(job);
      deps.log.info("job completed", {
        jobId: job.id,
        jobType,
        householdId: job.householdId,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      deps.log.error("job failed", {
        jobId: job.id,
        jobType,
        householdId: job.householdId,
        ms: Date.now() - startedAt,
        code: deps.errorCode(error),
      });
      throw error;
    }
  };
}

/**
 * Los siete tipos de trabajo, ya envueltos en el logger con redacción.
 *
 * El objeto se crea con prototipo nulo a propósito: `job_type` viene de una
 * fila de la base y un valor como `constructor` no puede resolver a nada.
 */
export function createJobHandlers(deps: JobRuntimeDeps): Record<string, JobHandler> {
  const reminderQueries = createReminderQueries(deps.pool);
  const maintenanceQueries = createMaintenanceQueries(deps.pool);
  // Fontanería ICS entrante (Ola E): descarga con guard SSRF y expansión de
  // recurrencias en ics.ts; persistencia y registro SOLO vía funciones definer
  // (0009/0015), sin lectura ni escritura directa sobre app.ics_*.
  const icsQueries = createIcsQueries(deps.pool);

  const handlers: Record<string, JobHandler> = Object.create(null) as Record<string, JobHandler>;
  handlers[RENDER_RECEIPT_JOB] = createRenderReceiptHandler(deps.uploadDocument);
  handlers[SETTLEMENT_DUE_JOB] = createSettlementDueHandler({
    readState: reminderQueries.readSettlementReminderState,
    enqueue: reminderQueries.enqueueJob,
    sendEmail: deps.sendEmail,
  });
  handlers[AUTOCONFIRM_JOB] = createAutoconfirmHandler({
    autoconfirm: reminderQueries.autoconfirmWeeklyReport,
  });
  handlers[ROUTINE_DUE_JOB] = createRoutineDueHandler({ sendEmail: deps.sendEmail });
  handlers[PRUNE_DISCOVERY_JOB] = createPruneDiscoveryHandler({
    prune: maintenanceQueries.pruneDiscoveryData,
    enqueue: maintenanceQueries.enqueueJob,
  });
  handlers[ICS_SYNC_JOB] = createIcsSyncHandler({
    fetchSource: (url) => fetchIcsSource(url),
    persistEvents: icsQueries.replaceSourceEvents,
    recordSync: icsQueries.recordSync,
  });
  handlers[ICS_SYNC_ALL_JOB] = createIcsSyncAllHandler({
    listSources: icsQueries.listSourcesForSync,
    enqueue: maintenanceQueries.enqueueJob,
  });

  for (const [type, handler] of Object.entries(handlers)) {
    handlers[type] = withJobLogging(deps, type, handler);
  }
  return handlers;
}
