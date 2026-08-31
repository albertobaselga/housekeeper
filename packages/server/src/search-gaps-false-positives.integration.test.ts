import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withAuthorizedTransaction, type AuthenticatedPrincipal } from "./database.js";
import {
  listSearchGapClusters,
  recordSearchOutcome,
  trigramSimilarity,
  type SearchGapCluster,
} from "./wiki-search.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Este suite trabaja en el hogar OLIVO: search-gaps.integration.test.ts siembra
// y aserta clusters en roble sobre la misma base compartida, y cualquier
// consulta nueva allí alteraría sus totales.
const OLIVO_HOUSEHOLD = "20000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const OLIVO_ADMIN: AuthenticatedPrincipal = { userId: "fixture:olivo:admin" };

describe.runIf(Boolean(adminUrl))("AC-18: falsos positivos y estabilidad del representante", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function clusters(): Promise<SearchGapCluster[]> {
    return withAuthorizedTransaction(appPool, OLIVO_ADMIN, OLIVO_HOUSEHOLD, (client) =>
      listSearchGapClusters(client, { days: 30, limit: 20 }),
    );
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });

    // Siembra por la función real (normaliza minúsculas y acentos: 'exprés' →
    // 'expres'). Los pesos deciden el orden greedy: 'robot cocina' 3, 'plancha'
    // y los dos seguros 2, y las variantes de olla y 'plancha pelo' 1.
    await withAuthorizedTransaction(appPool, OLIVO_ADMIN, OLIVO_HOUSEHOLD, async (client) => {
      await recordSearchOutcome(client, "robot cocina", false);
      await recordSearchOutcome(client, "robot cocina", false);
      await recordSearchOutcome(client, "robot cocina", false);
      await recordSearchOutcome(client, "seguro hogar", false);
      await recordSearchOutcome(client, "seguro hogar", false);
      await recordSearchOutcome(client, "seguro coche", false);
      await recordSearchOutcome(client, "seguro coche", false);
      await recordSearchOutcome(client, "olla exprés", false);
      await recordSearchOutcome(client, "olla express", false);
      await recordSearchOutcome(client, "plancha", false);
      await recordSearchOutcome(client, "plancha", false);
      await recordSearchOutcome(client, "plancha pelo", false);
    });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("veredicto del algoritmo sobre los pares que NO deben agruparse: similitud bajo el umbral 0.55", () => {
    // Verdicto real de la métrica que usa listSearchGapClusters, documentado
    // con sus valores: ambos pares quedan claramente por debajo del umbral.
    // 'robot cocina' y 'olla expres' no comparten ni un trigram (≈ 0).
    expect(trigramSimilarity("robot cocina", "olla expres")).toBe(0);
    // 'seguro hogar' y 'seguro coche' comparten solo la palabra 'seguro':
    // 7 trigramas compartidos de 19 → ≈ 0.368.
    const seguros = trigramSimilarity("seguro hogar", "seguro coche");
    expect(seguros).toBeGreaterThan(0.3);
    expect(seguros).toBeLessThan(0.55);
  });

  it("'robot cocina' vs 'olla exprés' y 'seguro hogar' vs 'seguro coche' terminan en clusters separados", async () => {
    const all = await clusters();

    const robot = all.find((cluster) => cluster.representative === "robot cocina");
    const olla = all.find((cluster) => cluster.representative === "olla expres");
    const hogar = all.find((cluster) => cluster.variants.includes("seguro hogar"));
    const coche = all.find((cluster) => cluster.variants.includes("seguro coche"));

    expect(robot).toBeDefined();
    expect(olla).toBeDefined();
    expect(hogar).toBeDefined();
    expect(coche).toBeDefined();

    // Ningún falso positivo: cada par vive en clusters distintos y ninguna
    // variante se cuela en el cluster del otro.
    expect(robot!.variants).not.toContain("olla expres");
    expect(robot!.variants).not.toContain("olla express");
    expect(olla!.variants).not.toContain("robot cocina");
    expect(hogar).not.toBe(coche);
    expect(hogar!.variants).toEqual(["seguro hogar"]);
    expect(coche!.variants).toEqual(["seguro coche"]);
  });

  it("HALLAZGO pineado: una consulta que es prefijo de otra sí se agrupa ('plancha' + 'plancha pelo')", async () => {
    // Veredicto real del algoritmo, documentado sin maquillar: la similitud de
    // trigramas entre 'plancha' y 'plancha pelo' es ≈ 0.615 (> 0.55) porque la
    // consulta corta es subconjunto estricto de la larga, así que el greedy las
    // funde en un solo cluster aunque semánticamente puedan ser huecos
    // distintos (plancha de ropa vs plancha de pelo). Es un falso positivo
    // potencial conocido del clustering por trigramas con umbral 0.55; si
    // alguien cambia el umbral o la métrica, este test debe revisarse a
    // conciencia, no ajustarse a ciegas.
    const similarity = trigramSimilarity("plancha", "plancha pelo");
    expect(similarity).toBeGreaterThan(0.55);

    const all = await clusters();
    const plancha = all.find((cluster) => cluster.representative === "plancha");
    expect(plancha).toBeDefined();
    expect(plancha!.variants).toEqual(["plancha", "plancha pelo"]);
  });

  it("estabilidad del representante ante empates: gana el orden alfabético y no cambia entre llamadas", async () => {
    const first = await clusters();
    const second = await clusters();

    // 'olla expres' y 'olla express' tienen el mismo peso (1 miss cada una):
    // el desempate alfabético hace representante a 'olla expres' siempre.
    const olla = first.find((cluster) => cluster.variants.includes("olla express"));
    expect(olla).toBeDefined();
    expect(olla!.representative).toBe("olla expres");
    expect(olla!.variants).toEqual(["olla expres", "olla express"]);

    // Mismo empate en los seguros: dos clusters separados cuyo orden relativo
    // es alfabético y estable.
    const coche = first.findIndex((cluster) => cluster.representative === "seguro coche");
    const hogar = first.findIndex((cluster) => cluster.representative === "seguro hogar");
    expect(coche).toBeGreaterThanOrEqual(0);
    expect(hogar).toBeGreaterThanOrEqual(0);
    expect(coche).toBeLessThan(hogar);

    // Dos llamadas consecutivas devuelven exactamente lo mismo, representantes
    // incluidos.
    expect(second).toEqual(first);
  });
});
