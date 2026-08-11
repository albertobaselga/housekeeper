import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { nextOccurrenceOnOrAfter, type RoutineRule } from "@casa-clara/domain";

import { rhythmCommandHandlers } from "./commands/rhythm.js";
import { processSyncBatch } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };

// Mismos correos que el suite de ritmo (base compartida; updates idempotentes).
const ADMIN_EMAIL = "admin.roble@example.com";
const FAMILY_EMAIL = "familiar.roble@example.com";
const EMPLOYEE_EMAIL = "empleada.roble@example.com";
const HELPER_EMAIL = "apoyo.roble@example.com";

function envelope(payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType: "routine",
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("AC-25 literal: rutina quarterly con audiencia family", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], rhythmCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    for (const [userId, email] of [
      ["fixture:roble:admin", ADMIN_EMAIL],
      ["fixture:roble:family", FAMILY_EMAIL],
      ["fixture:roble:employee", EMPLOYEE_EMAIL],
      ["fixture:roble:helper", HELPER_EMAIL],
    ]) {
      await adminPool.query("update app.user_profiles set email = $2 where user_id = $1", [userId, email]);
    }
  });

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
  });

  it("trimestral + family: la ocurrencia de febrero se recorta a 28 y no se encola ningún aviso", async () => {
    // El caso literal del criterio: cadencia trimestral Y audiencia familiar en
    // la MISMA rutina (la revisión adversarial señaló que hasta ahora solo
    // existían por separado). «Trimestral» ya no es una palabra del vocabulario
    // sino lo que de verdad significa: el día 30 de cada tres meses. El
    // vencimiento 30/11 fuerza además el borde de fin de mes: la ocurrencia
    // siguiente cae en febrero de 2027, que no tiene 30 ni es bisiesto.
    const created = await run(
      ADMIN,
      envelope({
        action: "upsert",
        title: "Revisión trimestral de la caldera",
        audience: "family",
        pattern: "day_of_month",
        anchorOn: "2026-11-30",
        repeatEvery: 3,
        monthDay: 30,
      }),
    );
    expect(created).toMatchObject({ status: "accepted" });
    const routineId = created.resourceId as string;

    const completed = await run(
      ADMIN,
      envelope({ action: "complete", routineId, dueOn: "2026-11-30" }),
    );
    expect(completed).toMatchObject({ status: "accepted", resourceId: routineId });

    const advanced = await adminPool.query<{ next_due_hint: string }>(
      "select next_due_hint::text as next_due_hint from app.routines where id = $1",
      [routineId],
    );
    expect(advanced.rows).toEqual([{ next_due_hint: "2027-02-28" }]);

    // El aviso `notification.routine_due` se retiró con la migración 0029: solo
    // sabía mandar correo y arrastraba las direcciones de la audiencia dentro
    // del payload. El AC-25 —«mantenimiento trimestral notifica a familia, no a
    // empleada»— se cumple ahora por la vía más simple posible: no hay
    // notificación que dirigir mal, y la rutina 'family' sigue siendo invisible
    // para la empleada por RLS (packages/db/tests/020_rls_matrix.sql).
    const jobs = await adminPool.query<{ total: number }>(
      `select count(*)::int as total
         from app_private.job_queue
        where household_id = $1 and job_type = 'notification.routine_due'
          and payload ->> 'routineId' = $2`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    expect(jobs.rows[0]?.total).toBe(0);
  });

  it("el recorte de febrero es del calendario, y NO se queda pegado al mes siguiente", () => {
    // La misma función pura que usa el comando. Antes esto se comprobaba con
    // `advanceDueDate`, que retiró la 0033 junto con el resto del vocabulario
    // viejo; la aritmética que queda es una sola y vive en @casa-clara/domain.
    const trimestral: RoutineRule = {
      pattern: "day_of_month",
      anchorOn: "2026-11-30",
      repeatEvery: 3,
      monthDay: 30,
      endsOn: null,
    };
    expect(nextOccurrenceOnOrAfter(trimestral, "2026-12-01")).toBe("2027-02-28");
    // 2028 sí es bisiesto, y febrero llega hasta el 29.
    expect(nextOccurrenceOnOrAfter({ ...trimestral, anchorOn: "2027-11-30" }, "2027-12-01")).toBe(
      "2028-02-29",
    );

    // Y aquí está la diferencia que justificaba la ola entera. El avance viejo
    // guardaba el 28 como nuevo estado, así que la rutina se quedaba en el 28
    // PARA SIEMPRE: una revisión pactada «el día 30» se corría sola a final de
    // mes en cuanto pasaba una vez por febrero. La regla no se recorta —solo se
    // recorta la ocurrencia que no cabe—, así que en mayo vuelve el día 30.
    expect(nextOccurrenceOnOrAfter(trimestral, "2027-03-01")).toBe("2027-05-30");

    // Cada seis meses (semestral) no toca febrero y no hay recorte ninguno.
    expect(nextOccurrenceOnOrAfter({ ...trimestral, repeatEvery: 6 }, "2026-12-01")).toBe(
      "2027-05-30",
    );
  });
});
