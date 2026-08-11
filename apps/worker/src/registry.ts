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
 * Lo único que los distingue son los efectos externos —contra qué almacén se
 * sube el PDF y a dónde escribe el log—, así que eso entra por parámetro y todo
 * lo demás se construye igual. Añadir un tipo de trabajo aquí lo enciende en los
 * dos ejecutores a la vez; añadirlo en uno solo es el fallo que este módulo hace
 * imposible.
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
  createIcsQueries,
  createIcsSyncAllHandler,
  createIcsSyncHandler,
  fetchIcsSource,
} from "./ics.js";
import {
  PRUNE_DISCOVERY_JOB,
  createMaintenanceQueries,
  createPruneDiscoveryHandler,
} from "./maintenance.js";
import {
  PUSH_NOTICE_JOB,
  createPushNoticeHandler,
  createPushQueries,
  createWebPushSender,
  loadVapidConfig,
  type VapidConfig,
} from "./push.js";
import type { JobHandler } from "./queue.js";

/** Lo que este módulo necesita del logger con redacción de `@casa-clara/server`. */
export interface JobLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface JobRuntimeDeps {
  /** Pool con el rol `casa_clara_worker`: es el único que puede tocar la cola. */
  pool: Pool;
  uploadDocument: DocumentUploader;
  log: JobLogger;
  /** `errorCode` de `@casa-clara/server`: código estable y sin datos personales. */
  errorCode: (cause: unknown) => string;
  /**
   * Entorno del que salen las claves VAPID. Se pasa —y no se lee de
   * `process.env` aquí dentro— porque en Vercel las variables llegan por
   * `$env/dynamic/private` y porque así las pruebas no dependen del entorno de
   * quien las ejecute. Sin claves, el canal de avisos sencillamente no existe:
   * ver `createJobHandlers`.
   */
  environment?: Partial<Record<string, string>>;
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
 * Los tipos de trabajo, ya envueltos en el logger con redacción.
 *
 * Eran siete, luego cuatro. La migración 0029 retiró tres de golpe y por la
 * misma razón: `notification.settlement_due` y `notification.routine_due` solo
 * sabían mandar correo, y `time_report.autoconfirm` confirmaba solo un parte
 * semanal que ya no existe. Lo que quedara encolado de los tres pasó a `dead` en
 * esa migración.
 *
 * El quinto, `notification.push`, es el canal que sustituye a aquellos dos —y
 * **solo a uno de ellos**: la cuenta del mes por pagar vuelve, hacia quien
 * administra; el recordatorio de rutinas no vuelve, y las razones están escritas
 * en `docs/notificaciones.md` §6 y en la cabecera de `push.ts`—. Se registra
 * **únicamente si hay claves VAPID**: sin ellas no hay canal, y un manejador que
 * no puede mandar nada dejaría cada aviso muriéndose en la cola con cinco
 * reintentos. Sin manejador, el trabajo pasa a `dead` en el primer intento con
 * «tipo de trabajo no soportado» escrito en `last_error`, que es lo que de
 * verdad ocurre.
 *
 * El objeto se crea con prototipo nulo a propósito: `job_type` viene de una
 * fila de la base y un valor como `constructor` no puede resolver a nada.
 */
export function createJobHandlers(deps: JobRuntimeDeps): Record<string, JobHandler> {
  const maintenanceQueries = createMaintenanceQueries(deps.pool);
  // Fontanería ICS entrante (Ola E): descarga con guard SSRF y expansión de
  // recurrencias en ics.ts; persistencia y registro SOLO vía funciones definer
  // (0009/0015), sin lectura ni escritura directa sobre app.ics_*.
  const icsQueries = createIcsQueries(deps.pool);
  const vapid: VapidConfig | null = loadVapidConfig(deps.environment ?? {});
  const pushQueries = createPushQueries(deps.pool);

  const handlers: Record<string, JobHandler> = Object.create(null) as Record<string, JobHandler>;
  handlers[RENDER_RECEIPT_JOB] = createRenderReceiptHandler({
    upload: deps.uploadDocument,
    // El aviso se encola SOLO si el canal existe. Si no hay claves, el recibo se
    // genera igual y nadie se entera por el móvil: exactamente lo que pasaba
    // hasta hoy, y nada vive solo detrás del push.
    announceReceipt: vapid ? pushQueries.announceReceipt : undefined,
  });
  if (vapid) {
    handlers[PUSH_NOTICE_JOB] = createPushNoticeHandler({
      resolveTargets: pushQueries.resolveTargets,
      recordDelivery: pushQueries.recordDelivery,
      rescheduleSettlementDue: pushQueries.rescheduleSettlementDue,
      send: createWebPushSender(vapid),
    });
  }
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
