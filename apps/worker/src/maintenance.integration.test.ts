import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PRUNE_DISCOVERY_JOB,
  createMaintenanceQueries,
  createPruneDiscoveryHandler,
  ensurePruneDiscoveryScheduled,
} from "./maintenance.js";
import { runOneJob, type JobHandler } from "./queue.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Base propia: las suites de packages/server y apps/web recrean el esquema de
// la base compartida en paralelo, así que la retención se prueba aislada, con
// un login real del grupo casa_clara_worker (NOBYPASSRLS) igual que en runtime.
const PRUNE_DB = "housekeeper_prune_it";
const WORKER_LOGIN = "it_housekeeper_prune_worker_login";

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const SPACE = "ac000000-0000-4000-8000-000000000001";
const PAGE = "ac100000-0000-4000-8000-000000000001";
const REVISION = "ac200000-0000-4000-8000-000000000001";
const FIXTURE_JOB = "12f00000-0000-4000-8000-000000000005";

function urlForDb(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const SEED = `
BEGIN;
SET LOCAL row_security = off;

INSERT INTO app.wiki_spaces (id, household_id, slug, name, created_by_membership_id)
VALUES ('${SPACE}', '${ROBLE_HOUSEHOLD}', 'retencion', 'Retención', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_pages (id, household_id, space_id, status, current_slug, created_by_membership_id)
VALUES ('${PAGE}', '${ROBLE_HOUSEHOLD}', '${SPACE}', 'published', 'pagina-retencion', '${ADMIN_MEMBERSHIP}');

INSERT INTO app.wiki_revisions (id, household_id, page_id, revision_number, title, body_markdown, authored_by_membership_id)
VALUES ('${REVISION}', '${ROBLE_HOUSEHOLD}', '${PAGE}', 1, 'Página de retención', 'Cuerpo.', '${ADMIN_MEMBERSHIP}');

UPDATE app.wiki_pages SET current_revision_id = '${REVISION}' WHERE id = '${PAGE}';

-- Lecturas: una claramente vieja (fuera de reads_keep_days = 45) y una reciente.
INSERT INTO app.wiki_page_reads (household_id, page_id, read_on, read_count) VALUES
  ('${ROBLE_HOUSEHOLD}', '${PAGE}', current_date - 100, 7),
  ('${ROBLE_HOUSEHOLD}', '${PAGE}', current_date - 10, 3);

-- Huecos de búsqueda: uno fuera de gaps_keep_days = 180 y uno reciente.
INSERT INTO app.search_gap_events (household_id, query_normalized, occurred_on, miss_count, no_click_count) VALUES
  ('${ROBLE_HOUSEHOLD}', 'consulta antigua', current_date - 300, 4, 0),
  ('${ROBLE_HOUSEHOLD}', 'consulta reciente', current_date - 20, 2, 1);

COMMIT;
`;

describe.runIf(Boolean(adminUrl))("retención de descubrimiento: 0012 + maintenance.prune_discovery", () => {
  let adminPool: pg.Pool;
  let workerPool: pg.Pool;
  let handlers: Record<string, JobHandler>;

  async function counts(): Promise<{ reads: Array<{ ago: number }>; gaps: Array<{ ago: number }> }> {
    const reads = await adminPool.query<{ ago: number }>(
      "select (current_date - read_on)::int as ago from app.wiki_page_reads order by read_on",
    );
    const gaps = await adminPool.query<{ ago: number }>(
      "select (current_date - occurred_on)::int as ago from app.search_gap_events order by occurred_on",
    );
    return { reads: reads.rows, gaps: gaps.rows };
  }

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${PRUNE_DB} with (force)`);
      await cluster.query(`create database ${PRUNE_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: urlForDb(adminUrl as string, PRUNE_DB) });
    await admin.connect();
    try {
      const dbWorkspace = new URL("../../../packages/db/", import.meta.url);
      const migrateHref = new URL("scripts/migrate.mjs", dbWorkspace).href;
      const { applyMigrations } = (await import(/* @vite-ignore */ migrateHref)) as {
        applyMigrations: (client: pg.Client) => Promise<unknown>;
      };
      await applyMigrations(admin);
      const fixturesDir = fileURLToPath(new URL("fixtures", dbWorkspace));
      for (const fixture of (await readdir(fixturesDir)).filter((f) => f.endsWith(".sql")).sort()) {
        await admin.query(await readFile(path.join(fixturesDir, fixture), "utf8"));
      }
      await admin.query(SEED);
      await admin.query(`drop role if exists ${WORKER_LOGIN}`);
      await admin.query(
        `create role ${WORKER_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_worker`,
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: urlForDb(adminUrl as string, PRUNE_DB), max: 2 });
    const workerUrl = new URL(urlForDb(adminUrl as string, PRUNE_DB));
    workerUrl.username = WORKER_LOGIN;
    workerUrl.password = "integration-only";
    workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 2 });

    const queries = createMaintenanceQueries(workerPool);
    handlers = {
      [PRUNE_DISCOVERY_JOB]: createPruneDiscoveryHandler({
        prune: queries.pruneDiscoveryData,
        enqueue: queries.enqueueJob,
      }),
    };
  }, 120_000);

  afterAll(async () => {
    await workerPool?.end();
    await adminPool?.end();
  });

  it("con la cola totalmente vacía el worker se abstiene (empty-queue): lo arranca el operador según el runbook", async () => {
    // Único caso sin ancla para el household_id NOT NULL: ninguna fila en
    // job_queue. Los jobs son append-only (trigger 55000), así que el vaciado
    // se hace como superusuario con los triggers deshabilitados, solo para
    // recrear el escenario de un despliegue recién sembrado sin actividad; al
    // final se restaura el job de la fixture tal cual.
    const client = await adminPool.connect();
    try {
      await client.query("alter table app_private.job_queue disable trigger user");
      await client.query("delete from app_private.job_queue");
      await client.query("alter table app_private.job_queue enable trigger user");
    } finally {
      client.release();
    }

    await expect(ensurePruneDiscoveryScheduled(workerPool)).resolves.toBe("empty-queue");
    const after = await adminPool.query("select 1 from app_private.job_queue");
    expect(after.rowCount).toBe(0);

    // Restauración del job de la fixture (mismo id y run_at lejano).
    await adminPool.query(
      `insert into app_private.job_queue (id, household_id, job_type, payload, run_at)
       values ($1, $2, 'fixture.document.render',
               '{"documentId": "12f00000-0000-4000-8000-000000000002"}', '2099-01-01T00:00:00Z')`,
      [FIXTURE_JOB, ROBLE_HOUSEHOLD],
    );
  });

  it("una retención bajo el mínimo de 30 días se rechaza (22023) y no borra nada", async () => {
    const queries = createMaintenanceQueries(workerPool);
    await expect(queries.pruneDiscoveryData(29, 180)).rejects.toMatchObject({ code: "22023" });
    await expect(queries.pruneDiscoveryData(45, 29)).rejects.toMatchObject({ code: "22023" });

    const { reads, gaps } = await counts();
    expect(reads).toEqual([{ ago: 100 }, { ago: 10 }]);
    expect(gaps).toEqual([{ ago: 300 }, { ago: 20 }]);
  });

  it("el rol de la aplicación no puede ejecutar la poda: solo el worker tiene EXECUTE", async () => {
    const client = await adminPool.connect();
    try {
      await client.query("begin");
      await client.query("set local role casa_clara_app");
      await expect(
        client.query("select * from app_private.prune_discovery_data()"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("al arrancar sin poda pendiente, el worker la encola tomando el hogar de un job existente", async () => {
    // La cola trae el job de la fixture (household roble), así que hay ancla.
    await expect(ensurePruneDiscoveryScheduled(workerPool)).resolves.toBe("scheduled");

    const queued = await adminPool.query<{ household_id: string; payload: Record<string, unknown> }>(
      `select household_id, payload from app_private.job_queue
        where job_type = $1 and status = 'queued'`,
      [PRUNE_DISCOVERY_JOB],
    );
    expect(queued.rows).toEqual([
      {
        household_id: ROBLE_HOUSEHOLD,
        payload: { readsKeepDays: 45, gapsKeepDays: 180 },
      },
    ]);

    // Idempotente: un segundo arranque no duplica la poda pendiente.
    await expect(ensurePruneDiscoveryScheduled(workerPool)).resolves.toBe("already-scheduled");
    const still = await adminPool.query(
      "select 1 from app_private.job_queue where job_type = $1 and status = 'queued'",
      [PRUNE_DISCOVERY_JOB],
    );
    expect(still.rowCount).toBe(1);
  });

  it("el handler poda lo antiguo, respeta lo reciente, completa y se re-encola a +7 días", async () => {
    // runOneJob reclama la poda encolada por el test anterior (run_at = now);
    // el job fixture de 2099 no es reclamable.
    await expect(runOneJob(workerPool, handlers, 5)).resolves.toBe(true);

    // Poda global por fechas: fuera lo anterior a 45/180 días, intacto el resto.
    const { reads, gaps } = await counts();
    expect(reads).toEqual([{ ago: 10 }]);
    expect(gaps).toEqual([{ ago: 20 }]);

    // El job reclamado completó y dejó re-encolada la siguiente poda semanal.
    const states = await adminPool.query<{ status: string; weekly: boolean }>(
      `select status::text as status,
              (status = 'queued' and run_at > now() + interval '6 days'
               and run_at < now() + interval '8 days') as weekly
         from app_private.job_queue
        where job_type = $1
        order by created_at`,
      [PRUNE_DISCOVERY_JOB],
    );
    expect(states.rows).toEqual([
      { status: "completed", weekly: false },
      { status: "queued", weekly: true },
    ]);

    // Y con la semanal ya pendiente, otro arranque sigue sin duplicar nada.
    await expect(ensurePruneDiscoveryScheduled(workerPool)).resolves.toBe("already-scheduled");
  });

  it("al final la cola contiene el job de la fixture, la poda completada y la semanal pendiente", async () => {
    const jobs = await adminPool.query<{ job_type: string; status: string }>(
      "select job_type, status::text as status from app_private.job_queue order by created_at",
    );
    expect(jobs.rows).toEqual([
      { job_type: "fixture.document.render", status: "queued" },
      { job_type: PRUNE_DISCOVERY_JOB, status: "completed" },
      { job_type: PRUNE_DISCOVERY_JOB, status: "queued" },
    ]);
  });
});
