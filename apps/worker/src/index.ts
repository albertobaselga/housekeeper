import { createServer } from "node:http";

import { Pool } from "pg";

import { loadWorkerConfig } from "./config.js";
import { RENDER_RECEIPT_JOB, createRenderReceiptHandler } from "./handlers.js";
import { objectStore, putPrivateObject, sendEmail } from "./integrations.js";
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
let stopping = false;
let lastSuccessfulPollAt: string | null = null;
let processedJobs = 0;
let pollFailures = 0;

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
  while (!stopping) {
    try {
      const worked = await runOneJob(pool, handlers, config.maxJobAttempts);
      lastSuccessfulPollAt = new Date().toISOString();
      if (worked) processedJobs += 1;
      else await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    } catch {
      pollFailures += 1;
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
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "Worker failure";
  process.stderr.write(`${message}\n`);
  await shutdown();
  process.exitCode = 1;
});
