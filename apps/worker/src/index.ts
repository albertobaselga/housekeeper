import { createServer } from "node:http";

import { Pool } from "pg";

import { createLogger, errorCode } from "@housekeeper/server/logging";

import { ensureCloseDueScheduled } from "./close-due.js";
import { loadWorkerConfig } from "./config.js";
import { ensureIcsSyncScheduled } from "./ics.js";
import { objectStore, putPrivateObject } from "./integrations.js";
import { ensurePruneDiscoveryScheduled } from "./maintenance.js";
import { loadVapidConfig } from "./push.js";
import { reclaimStaleJobs, runOneJob } from "./queue.js";
import { createJobHandlers } from "./registry.js";

const config = loadWorkerConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
const storageClient = objectStore(config.storage);
const log = createLogger("worker");
let stopping = false;
let lastSuccessfulPollAt: string | null = null;
let processedJobs = 0;
let pollFailures = 0;

// El catálogo de trabajos es común con el drenaje por HTTP de apps/web
// (registry.ts); aquí solo se enchufan los efectos externos de este proceso.
const handlers = createJobHandlers({
  pool,
  uploadDocument: (key, body, contentType) =>
    putPrivateObject(storageClient, config.storage.bucket, key, body, contentType),
  documentsBucket: config.storage.bucket,
  log,
  errorCode,
  // Las claves VAPID no son obligatorias para arrancar: sin ellas el demonio
  // hace todo lo demás y el canal de avisos no existe. Nada vive solo detrás del
  // push, así que faltar no puede impedir que se generen los recibos.
  environment: process.env,
});
// El barrido de cierre de mes solo tiene sentido —y solo tiene manejador
// registrado, ver registry.ts— cuando hay canal de avisos: sin VAPID no se
// arma, para no dejar un trabajo re-encolándose y muriendo `dead` en cada
// pasada por falta de manejador.
const closeDueEnabled = loadVapidConfig(process.env) !== null;

const healthServer = createServer(async (request, response) => {
  if (request.url === "/metrics") {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
    response.end([
      "# HELP housekeeper_worker_processed_jobs_total Jobs claimed by this worker.",
      "# TYPE housekeeper_worker_processed_jobs_total counter",
      `housekeeper_worker_processed_jobs_total ${processedJobs}`,
      "# HELP housekeeper_worker_poll_failures_total Queue polling failures.",
      "# TYPE housekeeper_worker_poll_failures_total counter",
      `housekeeper_worker_poll_failures_total ${pollFailures}`,
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
  // Trabajos que se quedaron en `running` porque el proceso anterior murió a
  // mitad: nadie los reclamaría nunca más. Al arrancar es justo el momento de
  // devolverlos a la cola (o darlos por muertos si ya agotaron sus intentos).
  try {
    const reclaimed = await reclaimStaleJobs(pool, config.maxJobAttempts);
    if (reclaimed.requeued > 0 || reclaimed.dead > 0) {
      log.warn("stale jobs reclaimed", { counts: reclaimed });
    }
  } catch {
    pollFailures += 1;
  }
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
  // Barrido «el mes está por cerrar» (Frente D): mismo contrato, y solo si hay
  // canal de avisos (ver closeDueEnabled arriba).
  if (closeDueEnabled) {
    try {
      await ensureCloseDueScheduled(pool);
    } catch {
      pollFailures += 1;
    }
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
