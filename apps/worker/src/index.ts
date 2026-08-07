import { createServer } from "node:http";

import { Pool } from "pg";

import { loadWorkerConfig } from "./config.js";
import { runOneJob, type JobHandler } from "./queue.js";

const config = loadWorkerConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
let stopping = false;
let lastSuccessfulPollAt: string | null = null;

const handlers: Record<string, JobHandler> = Object.create(null) as Record<string, JobHandler>;

const healthServer = createServer(async (request, response) => {
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
    const worked = await runOneJob(pool, handlers, config.maxJobAttempts);
    lastSuccessfulPollAt = new Date().toISOString();
    if (!worked) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
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
