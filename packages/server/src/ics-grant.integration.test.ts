import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const APP_LOGIN = "it_housekeeper_app_login";

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const FEED_ID = "4b000000-0000-4000-8000-000000000001";
const FEED_REVOCADO = "4b000000-0000-4000-8000-000000000002";
const ROUTINE_ID = "4b100000-0000-4000-8000-000000000001";
const TOKEN = "token-de-la-regresion-del-grant-0011";
const TOKEN_REVOCADO = "token-revocado-de-la-regresion-0011";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Regresión del P1 de la revisión adversarial: la emisión del feed ICS corre
 * como casa_clara_app_login y necesita USAGE sobre app_private para ejecutar
 * ics_feed_events. Sin la 0011, esta consulta moría con "permission denied for
 * schema app_private" en todo despliegue real.
 *
 * La 0023 y la 0033 hicieron DROP + CREATE de la función. Un DROP se lleva por
 * delante sus permisos, así que el GRANT hay que volver a ponerlo en cada
 * recreación y nadie avisa si se olvida: el feed volvería a morir en producción
 * y en ningún otro sitio. De ahí que esta prueba no se conforme con «no da error
 * de permisos» y compruebe además que un token bueno DEVUELVE filas y que un
 * token revocado no devuelve ninguna (§9, caso 25).
 *
 * La aserción sobre los nombres de las columnas parece pedante y no lo es: la
 * 0023 cambió el tipo de retorno de la función, el emisor siguió leyendo
 * `frequency` y el feed pasó un mes entero devolviendo un calendario vacío sin
 * que ninguna suite se pusiera roja.
 */
describe.runIf(Boolean(adminUrl))("grant de emisión del feed ICS", () => {
  let appPool: pg.Pool;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl as string, max: 1 });
    await adminPool.query("begin");
    await adminPool.query("set local row_security = off");
    await adminPool.query(
      `insert into app.routines
         (id, household_id, title, details, audience, next_due_hint,
          pattern, anchor_on, repeat_every, weekdays, overdue_policy, created_by_membership_id)
       values ($1, $2, 'Cocina a fondo (grant)', 'Campana y horno', 'all', null,
               'days_of_week', '2026-01-05', 1, array[1,4]::smallint[], 'skip', $3)
       on conflict (id) do nothing`,
      [ROUTINE_ID, ROBLE_HOUSEHOLD, ADMIN_MEMBERSHIP],
    );
    await adminPool.query(
      `insert into app.ics_feeds (id, household_id, audience, token_hash, revoked_at, created_by_membership_id)
       values ($1, $3, 'all', $4, null, $6),
              ($2, $3, 'all', $5, now(), $6)
       on conflict (id) do nothing`,
      [FEED_ID, FEED_REVOCADO, ROBLE_HOUSEHOLD, hash(TOKEN), hash(TOKEN_REVOCADO), ADMIN_MEMBERSHIP],
    );
    await adminPool.query("commit");

    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 1 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.query("begin");
    await adminPool?.query("set local row_security = off");
    await adminPool?.query("delete from app.ics_feeds where id = any($1::uuid[])", [
      [FEED_ID, FEED_REVOCADO],
    ]);
    await adminPool?.query("delete from app.routines where id = $1", [ROUTINE_ID]);
    await adminPool?.query("commit");
    await adminPool?.end();
  });

  it("el rol de aplicación puede ejecutar ics_feed_events sin contexto", async () => {
    const result = await appPool.query("select * from app_private.ics_feed_events($1)", [
      "0".repeat(64),
    ]);
    // Token desconocido: cero filas, pero sin error de permisos.
    expect(result.rows).toEqual([]);
  });

  it("un token válido devuelve la rutina con su cadencia", async () => {
    const result = await appPool.query<{
      routine_id: string;
      title: string;
      pattern: string;
      weekdays: number[];
    }>("select * from app_private.ics_feed_events($1)", [hash(TOKEN)]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.routine_id).toBe(ROUTINE_ID);
    expect(result.rows[0]?.title).toBe("Cocina a fondo (grant)");
    expect(result.rows[0]?.pattern).toBe("days_of_week");
    expect(result.rows[0]?.weekdays).toEqual([1, 4]);
  });

  it("la función publica las columnas de patrón, no la frecuencia retirada", async () => {
    const result = await appPool.query("select * from app_private.ics_feed_events($1)", [
      hash(TOKEN),
    ]);
    expect(result.fields.map((field) => field.name).sort()).toEqual([
      "anchor_on",
      "details",
      "ends_on",
      "feed_audience",
      "feed_id",
      "household_id",
      "month_day",
      "months",
      "next_due_hint",
      "pattern",
      "repeat_every",
      "routine_id",
      "title",
      "weekdays",
    ]);
  });

  it("un token revocado no devuelve nada", async () => {
    const result = await appPool.query("select * from app_private.ics_feed_events($1)", [
      hash(TOKEN_REVOCADO),
    ]);
    expect(result.rows).toEqual([]);
  });

  it("y la definer es la ÚNICA puerta: el mismo rol no ve el feed por la tabla", async () => {
    // Sin contexto de hogar, la RLS de app.ics_feeds no deja pasar ni una fila.
    // Es lo que hace que conocer el token —y solo eso— sea la autorización.
    const directo = await appPool.query("select id from app.ics_feeds where id = $1", [FEED_ID]);
    expect(directo.rows).toEqual([]);
  });
});
