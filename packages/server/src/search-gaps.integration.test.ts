import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import { listSearchGapClusters, recordSearchOutcome, type SearchGapCluster } from "./wiki-search.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

// Consultas propias de este suite: otros ficheros de integración comparten la
// misma base y pueden registrar sus propios huecos en paralelo, así que las
// aserciones se ciñen a los clusters que contienen estas variantes.
const SEEDED = ["robot cocina", "robot de cocina", "robot cozina", "seguro hogar"] as const;

function ownClusters(clusters: SearchGapCluster[]): SearchGapCluster[] {
  return clusters.filter((cluster) =>
    cluster.variants.some((variant) => (SEEDED as readonly string[]).includes(variant)),
  );
}

describe.runIf(Boolean(adminUrl))("agrupación determinista de huecos de búsqueda (AC-18)", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });

    // Siembra vía la función real (app.record_search_gap normaliza y agrega):
    // el peso de 'robot cocina' lo convierte en representante del cluster.
    await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE_HOUSEHOLD, async (client) => {
      await recordSearchOutcome(client, "Robot Cocina", false);
      await recordSearchOutcome(client, "robot cocina", false);
      await recordSearchOutcome(client, "robot cocina", true);
      await recordSearchOutcome(client, "robot de cocina", false);
      await recordSearchOutcome(client, "robot cozina", false);
      await recordSearchOutcome(client, "seguro hogar", false);
    });

    // Días distintos: las variantes menores se desplazan a días anteriores con
    // el rol admin (la clave primaria incluye occurred_on, así que basta el
    // UPDATE); lastSeenOn debe seguir siendo el día más reciente del cluster.
    await adminPool.query(
      `update app.search_gap_events
          set occurred_on = current_date - 3
        where household_id = $1 and query_normalized = 'robot de cocina'`,
      [ROBLE_HOUSEHOLD],
    );
    await adminPool.query(
      `update app.search_gap_events
          set occurred_on = current_date - 9
        where household_id = $1 and query_normalized = 'robot cozina'`,
      [ROBLE_HOUSEHOLD],
    );
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("agrupa las variantes equivalentes en un único cluster y separa la consulta distinta", async () => {
    const clusters = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      listSearchGapClusters(client, { days: 30, limit: 10 }),
    );
    const own = ownClusters(clusters);
    expect(own).toHaveLength(2);

    const robot = own.find((cluster) => cluster.representative === "robot cocina");
    expect(robot).toBeDefined();
    expect(robot!.variants).toEqual(["robot cocina", "robot cozina", "robot de cocina"]);
    // 4 misses ('Robot Cocina' + 'robot cocina' ×2 normalizan juntas, más las
    // dos variantes) y 1 búsqueda con resultados pero sin clic.
    expect(robot!).toMatchObject({ missTotal: 4, noClickTotal: 1 });
    expect(robot!.lastSeenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const seguro = own.find((cluster) => cluster.representative === "seguro hogar");
    expect(seguro).toBeDefined();
    expect(seguro!.variants).toEqual(["seguro hogar"]);
    expect(seguro!).toMatchObject({ missTotal: 1, noClickTotal: 0 });

    // El cluster pesado va antes que el ligero.
    expect(clusters.indexOf(robot!)).toBeLessThan(clusters.indexOf(seguro!));

    // lastSeenOn es el día más reciente del cluster (hoy), no el de las
    // variantes desplazadas a días anteriores.
    expect(robot!.lastSeenOn > seguro!.lastSeenOn).toBe(false);
    expect(robot!.lastSeenOn).toBe(seguro!.lastSeenOn);
  });

  it("es determinista: dos llamadas devuelven exactamente el mismo resultado", async () => {
    const first = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      listSearchGapClusters(client, { days: 30, limit: 10 }),
    );
    const second = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      listSearchGapClusters(client, { days: 30, limit: 10 }),
    );
    expect(ownClusters(second)).toEqual(ownClusters(first));
  });

  it("la ventana de días excluye variantes antiguas sin romper el cluster", async () => {
    const clusters = await withAuthorizedTransaction(appPool, ADMIN, ROBLE_HOUSEHOLD, (client) =>
      listSearchGapClusters(client, { days: 5, limit: 10 }),
    );
    const robot = ownClusters(clusters).find((cluster) => cluster.representative === "robot cocina");
    expect(robot).toBeDefined();
    // 'robot cozina' quedó hace 9 días: fuera de una ventana de 5.
    expect(robot!.variants).toEqual(["robot cocina", "robot de cocina"]);
    expect(robot!).toMatchObject({ missTotal: 3, noClickTotal: 1 });
  });

  it("RLS: la empleada no ve huecos (lista vacía), solo la familia", async () => {
    const clusters = await withAuthorizedTransaction(appPool, EMPLOYEE, ROBLE_HOUSEHOLD, (client) =>
      listSearchGapClusters(client),
    );
    expect(ownClusters(clusters)).toEqual([]);
  });
});
