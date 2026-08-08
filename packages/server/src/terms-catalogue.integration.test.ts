import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { employmentCommandHandlers } from "./commands/employment.js";
import { processSyncBatch } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

// Catálogo de la v2 en las fixtures (vigente desde el 1 de abril de 2025).
const TYPE_HOURLY_DEACTIVATED = "13000000-0000-4000-8000-000000000003";
const TYPE_REST_DAY = "13000000-0000-4000-8000-000000000004";
const TYPE_EXTRA_SHIFT = "13000000-0000-4000-8000-000000000005";
const TYPE_NIGHT_ON_CALL = "13000000-0000-4000-8000-000000000006";
const TYPE_WITHOUT_RATE = "13000000-0000-4000-8000-000000000007";
const TYPE_REST_DAY_V1 = "13000000-0000-4000-8000-000000000002";

function envelope(
  aggregateType: AggregateType,
  payload: unknown,
  operationId = randomUUID(),
): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId,
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-08T10:00:00.000Z",
    payload,
  };
}

/*
 * El catálogo de 0021 contra Postgres real, con el login sin BYPASSRLS.
 *
 * En las fixtures esta empleada tiene JORNADAS pero NO horas extra: es el caso
 * que pidió el propietario, y aquí se comprueba lo que de verdad importa de él
 * —que no puede registrar trabajo de un concepto que no le aplica, y que ni
 * siquiera puede saber si existe—, junto con la valoración por unidad y la
 * congelación de la tarifa.
 *
 * Fechas de 2028: las fixtures viven en 2025 y los demás suites reparten ese
 * año y 2027; este fichero trabaja en uno que nadie más toca.
 *
 * El nombre importa: vitest ordena los ficheros alfabéticamente y todos comparten
 * una sola base. `terms-…` corre DESPUÉS de `employment-…`, que cuenta los
 * asientos del libro de compensación por su número de secuencia; una jornada
 * compensada aquí antes que allí le movería la cuenta.
 */
describe.runIf(Boolean(adminUrl))("catálogo de condiciones del acuerdo", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(
    principal: AuthenticatedPrincipal,
    command: CommandEnvelopeV1,
  ): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], employmentCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  function register(
    extraWorkTypeId: string | null,
    workedOn: string,
    durationMinutes: number,
    kind: "overtime" | "worked_rest_day" = "worked_rest_day",
  ): CommandEnvelopeV1 {
    return envelope("extra_work", {
      action: "register",
      agreementId: ROBLE_AGREEMENT,
      ...(extraWorkTypeId === null ? {} : { extraWorkTypeId }),
      kind,
      workedOn,
      durationMinutes,
      note: "Prueba del catálogo",
    });
  }

  beforeAll(() => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const url = new URL(adminUrl as string);
    url.username = APP_LOGIN;
    url.password = "integration-only";
    appPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("la empleada no ve —ni por su identificador— un concepto que no le aplica", async () => {
    // El contexto de hogar se fija con `is_local`, así que vive DENTRO de la
    // transacción: fuera de ella cada sentencia sería su propia transacción y
    // no vería el rol.
    const visible = await appPool.connect();
    try {
      await visible.query("begin");
      await visible.query("select set_config('app.user_id', $1, true)", ["fixture:roble:employee"]);
      await visible.query("select app.set_household_context($1, $2)", [
        ROBLE_HOUSEHOLD,
        "11000000-0000-4000-8000-000000000003",
      ]);
      const rows = await visible.query<{ id: string }>(
        `select id from app.extra_work_types
          where id = any($1::uuid[])`,
        [[TYPE_HOURLY_DEACTIVATED, TYPE_WITHOUT_RATE, TYPE_EXTRA_SHIFT]],
      );
      // Solo la jornada extra. Ni el concepto por horas (desactivado en esta
      // versión) ni el que aún no tiene tarifa salen de Postgres.
      expect(rows.rows.map((row) => row.id)).toEqual([TYPE_EXTRA_SHIFT]);
    } finally {
      await visible.query("rollback").catch(() => {});
      visible.release();
    }
  });

  it("registrar trabajo de un concepto desactivado se rechaza, aunque el cliente lo pida a mano", async () => {
    const deactivated = await run(EMPLOYEE, register(TYPE_HOURLY_DEACTIVATED, "2028-03-06", 120, "overtime"));
    expect(deactivated).toMatchObject({
      status: "rejected",
      errorCode: "extra_work_type_not_available",
    });

    const unpriced = await run(EMPLOYEE, register(TYPE_WITHOUT_RATE, "2028-03-06", 120));
    expect(unpriced).toMatchObject({
      status: "rejected",
      errorCode: "extra_work_type_not_available",
    });
  });

  it("un concepto de una versión que no regía ese día se rechaza: no se revalúa el pasado ni el futuro", async () => {
    // El festivo de la v1 (70 €) existe y está activo, pero su versión dejó de
    // regir el 31 de marzo de 2025: valorar con él sería pagar 2028 a precio de
    // 2025.
    const stale = await run(ADMIN, register(TYPE_REST_DAY_V1, "2028-03-06", 480));
    expect(stale).toMatchObject({
      status: "rejected",
      errorCode: "extra_work_type_not_in_force",
    });
  });

  it("una noche de guardia se congela por su importe fijo, no por sus horas", async () => {
    const registered = await run(EMPLOYEE, register(TYPE_NIGHT_ON_CALL, "2028-03-07", 720));
    expect(registered).toMatchObject({ status: "accepted" });
    const eventId = registered.resourceId as string;

    // La unidad del concepto decide `kind`: una guardia no se mide en horas.
    const stored = await adminPool.query<{ kind: string; extra_work_type_id: string }>(
      "select kind, extra_work_type_id from app.extra_work_events where id = $1",
      [eventId],
    );
    expect(stored.rows[0]).toEqual({
      kind: "worked_rest_day",
      extra_work_type_id: TYPE_NIGHT_ON_CALL,
    });

    const resolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: eventId,
        resolution: "money",
        reason: "Guardia acordada",
      }),
    );
    expect(resolved).toMatchObject({ status: "accepted" });

    const frozen = await adminPool.query<{
      unit: string;
      amount: string;
      version: string;
    }>(
      `select frozen_unit_rate_cents::text as unit, frozen_amount_cents::text as amount,
              resolved_agreement_version_id as version
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    // 50 €, ni prorrateados por 12 horas ni multiplicados por nada.
    expect(frozen.rows[0]).toEqual({
      unit: "5000",
      amount: "5000",
      version: "12100000-0000-4000-8000-000000000002",
    });
  });

  it("una jornada extra vale su tarifa una vez, y como descanso acredita la jornada pactada", async () => {
    const registered = await run(EMPLOYEE, register(TYPE_EXTRA_SHIFT, "2028-03-08", 660));
    expect(registered).toMatchObject({ status: "accepted" });
    const eventId = registered.resourceId as string;

    const resolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: eventId,
        resolution: "time_off",
        reason: "Se compensa con descanso",
      }),
    );
    expect(resolved).toMatchObject({ status: "accepted" });

    const frozen = await adminPool.query<{ unit: string; amount: string; balance: number }>(
      `select frozen_unit_rate_cents::text as unit, frozen_amount_cents::text as amount,
              balance_minutes as balance
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    // Se quedó 11 horas, pero la jornada pactada son 10: es la que acredita.
    expect(frozen.rows[0]).toEqual({ unit: "5000", amount: "0", balance: 600 });
  });

  it("un hecho sin concepto sigue valiéndose por las tarifas de 0002", async () => {
    const registered = await run(EMPLOYEE, register(null, "2028-03-09", 480));
    expect(registered).toMatchObject({ status: "accepted" });
    const eventId = registered.resourceId as string;

    const resolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: eventId,
        resolution: "money",
        reason: "Histórico anterior al catálogo",
      }),
    );
    expect(resolved).toMatchObject({ status: "accepted" });

    const frozen = await adminPool.query<{ unit: string; amount: string; type: string | null }>(
      `select frozen_unit_rate_cents::text as unit, frozen_amount_cents::text as amount,
              extra_work_type_id as type
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    // `worked_rest_day_rate_cents` de la v2: el puente de compatibilidad sigue
    // en pie para lo que se registró sin catálogo.
    expect(frozen.rows[0]).toEqual({ unit: "8000", amount: "8000", type: null });
  });

  it("el catálogo no admite ediciones ni por el rol de la aplicación", async () => {
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.user_id', $1, true)", ["fixture:roble:admin"]);
      await client.query("select app.set_household_context($1, $2)", [
        ROBLE_HOUSEHOLD,
        "11000000-0000-4000-8000-000000000001",
      ]);
      await expect(
        client.query("update app.extra_work_types set rate_cents = 1 where id = $1", [
          TYPE_REST_DAY,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  });
});
