import { createServer } from "node:http";

import { Pool } from "pg";

import { createLogger, errorCode } from "@casa-clara/server/logging";

import { loadWorkerConfig } from "./config.js";
import { RENDER_RECEIPT_JOB, createRenderReceiptHandler } from "./handlers.js";
import {
  ICS_SYNC_ALL_JOB,
  ICS_SYNC_JOB,
  ROUTINE_DUE_JOB,
  createIcsQueries,
  createIcsSyncAllHandler,
  createIcsSyncHandler,
  createRoutineDueHandler,
  ensureIcsSyncScheduled,
  fetchIcsSource,
} from "./ics.js";
import { objectStore, putPrivateObject, sendEmail } from "./integrations.js";
import {
  PRUNE_DISCOVERY_JOB,
  createMaintenanceQueries,
  createPruneDiscoveryHandler,
  ensurePruneDiscoveryScheduled,
} from "./maintenance.js";
import { runOneJob, type JobHandler } from "./queue.js";
import {
  AUTOCONFIRM_JOB,
  SETTLEMENT_DUE_JOB,
  createAutoconfirmHandler,
  createReminderQueries,
  createSettlementDueHandler,
} from "./reminders.js";

const config = loadWorkerConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
const storageClient = objectStore(config.storage);
const log = createLogger("worker");
let stopping = false;
let lastSuccessfulPollAt: string | null = null;
let processedJobs = 0;
let pollFailures = 0;

/**
 * Observabilidad de jobs sin PII (control 8): cada handler queda envuelto en
 * el logger compartido con redacción — solo identificadores técnicos, duración
 * y código de error. El fallo se relanza para que la cola aplique reintentos.
 */
function withJobLogging(jobType: string, handler: JobHandler): JobHandler {
  return async (job) => {
    const startedAt = Date.now();
    try {
      await handler(job);
      log.info("job completed", {
        jobId: job.id,
        jobType,
        householdId: job.householdId,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      log.error("job failed", {
        jobId: job.id,
        jobType,
        householdId: job.householdId,
        ms: Date.now() - startedAt,
        code: errorCode(error),
      });
      throw error;
    }
  };
}

const handlers: Record<string, JobHandler> = Object.create(null) as Record<string, JobHandler>;
handlers[RENDER_RECEIPT_JOB] = createRenderReceiptHandler((key, body, contentType) =>
  putPrivateObject(storageClient, config.storage.bucket, key, body, contentType),
);
const reminderQueries = createReminderQueries(pool);
handlers[SETTLEMENT_DUE_JOB] = createSettlementDueHandler({
  readState: reminderQueries.readSettlementReminderState,
  enqueue: reminderQueries.enqueueJob,
  sendEmail: (input) => sendEmail(config.smtp, input),
});
handlers[AUTOCONFIRM_JOB] = createAutoconfirmHandler({
  autoconfirm: reminderQueries.autoconfirmWeeklyReport,
});
handlers[ROUTINE_DUE_JOB] = createRoutineDueHandler({
  sendEmail: (input) => sendEmail(config.smtp, input),
});
const maintenanceQueries = createMaintenanceQueries(pool);
handlers[PRUNE_DISCOVERY_JOB] = createPruneDiscoveryHandler({
  prune: maintenanceQueries.pruneDiscoveryData,
  enqueue: maintenanceQueries.enqueueJob,
});
// Fontanería ICS entrante (Ola E): descarga con guard SSRF y expansión de
// recurrencias en ics.ts; persistencia y registro SOLO vía funciones definer
// (0009/0015), sin lectura ni escritura directa sobre app.ics_*.
const icsQueries = createIcsQueries(pool);
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
  handlers[type] = withJobLogging(type, handler);
}

const healthServer = createServer(async (request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
    response.end([
      "# HELP casa_clara_worker_processed_jobs_total Jobs claimed by this worker.",
      "# TYPE casa_clara_worker_processed_jobs_total counter",
      `casa_clara_worker_processed_jobs_total ${processedJobs}`,
      "# HELP casa_clara_worker_poll_failures_total Queue polling failures.",
      "# TYPE casa_clara_worker_poll_failures_total counter",
      `casa_clara_worker_poll_failures_total ${pollFailures}`,
      "",
    ].join("\n"));
    return;
  }
  if (request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  try {
    await pool.query("select 1");
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", lastSuccessfulPollAt }));
  } catch {
    response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "degraded" }));
  }
});

healthServer.listen(config.healthPort, "0.0.0.0");

async function loop(): Promise<void> {
  // Retención de descubrimiento: si no hay ninguna poda pendiente, se encola
  // una al arrancar (re-encolado semanal al completar). Un fallo aquí no debe
  // tumbar el worker: el siguiente arranque —o el operador— la encolará.
  try {
    await ensurePruneDiscoveryScheduled(pool);
  } catch {
    pollFailures += 1;
  }
  // Ciclo periódico de calendarios enlazados: mismo contrato que la poda
  // (si ya hay un ics.sync_all pendiente no se duplica; fallo no fatal).
  try {
    await ensureIcsSyncScheduled(pool);
  } catch {
    pollFailures += 1;
  }
  while (!stopping) {
    try {
      const worked = await runOneJob(pool, handlers, config.maxJobAttempts);
      lastSuccessfulPollAt = new Date().toISOString();
      if (worked) processedJobs += 1;
      else await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    } catch (error) {
      pollFailures += 1;
      log.error("queue poll failed", { code: errorCode(error) });
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, config.pollIntervalMs * 5)));
    }
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  healthServer.close();
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

void loop().catch(async (error: unknown) => {
  log.error("worker crashed", { code: errorCode(error) });
  await shutdown();
  process.exitCode = 1;
});
