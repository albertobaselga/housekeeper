import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_casa_clara_app_login";

/**
 * Regresión del P1 de la revisión adversarial: la emisión del feed ICS corre
 * como casa_clara_app_login y necesita USAGE sobre app_private para ejecutar
 * ics_feed_events. Sin la 0011, esta consulta moría con "permission denied for
 * schema app_private" en todo despliegue real.
 */
describe.runIf(Boolean(adminUrl))("grant de emisión del feed ICS", () => {
  let appPool: pg.Pool;

  beforeAll(() => {
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  });

  afterAll(async () => {
    await appPool?.end();
  });

  it("el rol de aplicación puede ejecutar ics_feed_events sin contexto", async () => {
    const result = await appPool.query(
      "select * from app_private.ics_feed_events($1)",
      ["0".repeat(64)],
    );
    // Token desconocido: cero filas, pero sin error de permisos.
    expect(result.rows).toEqual([]);
  });
});
