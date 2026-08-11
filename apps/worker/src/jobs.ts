/**
 * Superficie pública del worker para quien lo ejecute desde fuera.
 *
 * El único consumidor hoy es `apps/web`, que drena la misma cola desde una
 * función de Vercel disparada por `pg_cron` (ver
 * `apps/web/src/lib/server/job-runner.server.ts` y
 * `docs/runbooks/planificador-cola.md`). Se exporta el mínimo: cómo se reclama
 * un trabajo, cómo se construye el catálogo de manejadores, cómo se re-arman
 * las cadenas periódicas y el único efecto externo que necesitan (el almacén de
 * objetos; el envío de correo se retiró con la migración 0029).
 *
 * Deliberadamente NO se exporta `integrations.ts`: importarlo arrastraría
 * `sharp` y `tesseract.js` al paquete serverless. Quien necesite OCR o
 * miniaturas está en el demonio, no aquí.
 */
export {
  runOneJob,
  reclaimStaleJobs,
  countReadyJobs,
  PermanentJobError,
  DEFAULT_JOB_LEASE_MS,
  type ClaimedJob,
  type JobHandler,
} from "./queue.js";
export {
  createJobHandlers,
  withJobLogging,
  type JobLogger,
  type JobRuntimeDeps,
} from "./registry.js";
export { ensureIcsSyncScheduled, ICS_SYNC_INTERVAL_HOURS } from "./ics.js";
export { ensurePruneDiscoveryScheduled, PRUNE_INTERVAL_DAYS } from "./maintenance.js";
export { objectStore, putPrivateObject, type ObjectStoreConfig } from "./object-store.js";
