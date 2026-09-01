import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLOSE_DUE_SWEEP_JOB, createCloseDueQueries } from "./close-due.js";

/**
 * `createCloseDueQueries` contra Postgres real.
 *
 * Por qué existe este fichero y no basta con `close-due.test.ts`: ese fichero
 * prueba `createCloseDueSweepHandler` con dobles de `listHouseholds` — nunca
 * ejecuta el SQL de verdad. El defecto que motivó esta suite vivía EXACTAMENTE
 * ahí: `select household_id from app_private.close_due_households($1::date)`
 * fallaba con 42703 porque una función `RETURNS SETOF uuid` expone la columna
 * con el NOMBRE DE LA FUNCIÓN, no con el del tipo que devuelve. Ningún doble
 * lo habría visto nunca; solo una consulta real contra una base real lo hace.
 *
 * Mismo patrón que `maintenance.integration.test.ts`: base propia, migraciones
 * + fixtures aplicadas, login real del grupo `casa_clara_worker`
 * (NOBYPASSRLS) igual que en runtime, y se salta entera sin
 * `TEST_DATABASE_URL`/`DATABASE_URL`.
 */
const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const CLOSE_DUE_DB = "housekeeper_close_due_it";
const WORKER_LOGIN = "it_housekeeper_close_due_worker_login";

/** Roble y olivo de `fixtures/001_two_households.sql`: cada uno con al menos
 * un acuerdo activo y ninguna liquidación cerrada del mes en curso (sus
 * liquidaciones sembradas son de 2025, un mes que nunca vuelve a ser «el mes
 * en curso»), así que los dos deben salir siempre de `close_due_households`.
 */
const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const OLIVO_HOUSEHOLD = "20000000-0000-4000-8000-000000000001";

function urlForDb(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describe.runIf(Boolean(adminUrl))("createCloseDueQueries contra Postgres real (Frente D)", () => {
  let adminPool: pg.Pool;
  let workerPool: pg.Pool;

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    try {
      await cluster.query(`drop database if exists ${CLOSE_DUE_DB} with (force)`);
      await cluster.query(`create database ${CLOSE_DUE_DB}`);
    } finally {
      await cluster.end();
    }

    const admin = new pg.Client({ connectionString: urlForDb(adminUrl as string, CLOSE_DUE_DB) });
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
      await admin.query(`drop role if exists ${WORKER_LOGIN}`);
      await admin.query(
        `create role ${WORKER_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_worker`,
      );
    } finally {
      await admin.end();
    }

    adminPool = new pg.Pool({ connectionString: urlForDb(adminUrl as string, CLOSE_DUE_DB), max: 2 });
    const workerUrl = new URL(urlForDb(adminUrl as string, CLOSE_DUE_DB));
    workerUrl.username = WORKER_LOGIN;
    workerUrl.password = "integration-only";
    workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 2 });
  }, 120_000);

  afterAll(async () => {
    await workerPool?.end();
    await adminPool?.end();
  });

  it("today devuelve la fecha civil de Europe/Madrid como YYYY-MM-DD", async () => {
    const queries = createCloseDueQueries(workerPool);
    const today = await queries.today();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("listHouseholds ejecuta la consulta de verdad: sin el alias, esto es exactamente donde el 42703 vivía", async () => {
    const queries = createCloseDueQueries(workerPool);
    const today = await queries.today();

    // Este `await` es la prueba: `select household_id from
    // app_private.close_due_households($1::date)` (sin alias) lanzaría 42703
    // aquí mismo, antes de llegar a ningún `expect`. Un doble de
    // `listHouseholds` en close-due.test.ts nunca ejecuta este SQL y por eso
    // nunca lo habría visto.
    const households = await queries.listHouseholds(today);

    expect(households).toContain(ROBLE_HOUSEHOLD);
    expect(households).toContain(OLIVO_HOUSEHOLD);
  });

  it("enqueuePush inserta un aviso real y no lo duplica en un segundo intento (23505 silencioso)", async () => {
    const queries = createCloseDueQueries(workerPool);

    await queries.enqueuePush({ householdId: ROBLE_HOUSEHOLD });
    const first = await adminPool.query<{ payload: { topic: string } }>(
      `select payload from app_private.job_queue
        where household_id = $1 and job_type = 'notification.push' and status = 'queued'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.payload).toEqual({ topic: "settlement.close_due" });

    // El índice único parcial de la migración 0034 impide un segundo aviso
    // pendiente para el mismo hogar; `enqueuePush` trata ese choque (23505)
    // como éxito silencioso, así que esto no debe lanzar ni duplicar la fila.
    await expect(queries.enqueuePush({ householdId: ROBLE_HOUSEHOLD })).resolves.toBeUndefined();
    const stillOne = await adminPool.query<{ n: number }>(
      `select count(*)::int as n from app_private.job_queue
        where household_id = $1 and job_type = 'notification.push' and status = 'queued'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(stillOne.rows[0]?.n).toBe(1);
  });

  it("enqueueSweep inserta el barrido re-armado con el household_id ancla", async () => {
    const queries = createCloseDueQueries(workerPool);

    await queries.enqueueSweep({ householdId: OLIVO_HOUSEHOLD, targetDay: "2099-01-30" });
    const queued = await adminPool.query(
      `select 1 from app_private.job_queue
        where household_id = $1 and job_type = $2 and status = 'queued'`,
      [OLIVO_HOUSEHOLD, CLOSE_DUE_SWEEP_JOB],
    );
    expect(queued.rowCount).toBe(1);
  });
});
