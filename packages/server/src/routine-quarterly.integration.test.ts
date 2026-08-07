import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { advanceDueDate, rhythmCommandHandlers } from "./commands/rhythm.js";
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

  it("quarterly + family: notification.routine_due lleva a la familia y JAMÁS a la empleada; el avance recorta 30/11 → 28/02", async () => {
    // El caso literal del criterio: frecuencia trimestral Y audiencia familiar
    // en la MISMA rutina (la revisión adversarial señaló que hasta ahora solo
    // existían por separado). El vencimiento 30/11 fuerza además el recorte de
    // fin de mes al avanzar el trimestre: 2026-11-30 + 3 meses → 28/02/2027
    // (2027 no es bisiesto).
    const created = await run(
      ADMIN,
      envelope({
        action: "upsert",
        title: "Revisión trimestral de la caldera",
        audience: "family",
        frequency: "quarterly",
        intervalCount: 1,
        nextDueOn: "2026-11-30",
      }),
    );
    expect(created).toMatchObject({ status: "accepted" });
    const routineId = created.resourceId as string;

    const completed = await run(
      ADMIN,
      envelope({ action: "complete", routineId, dueOn: "2026-11-30" }),
    );
    expect(completed).toMatchObject({ status: "accepted", resourceId: routineId });

    // Clamp de fin de mes aplicado por la recurrencia trimestral.
    const advanced = await adminPool.query<{ next_due_on: string }>(
      "select next_due_on::text as next_due_on from app.routines where id = $1",
      [routineId],
    );
    expect(advanced.rows).toEqual([{ next_due_on: "2027-02-28" }]);

    // Los DOS avisos encolados (alta y avance) llevan audiencia family y una
    // lista de destinatarios que jamás contiene a la empleada ni al apoyo.
    const jobs = await adminPool.query<{ payload: Record<string, unknown> }>(
      `select payload
         from app_private.job_queue
        where household_id = $1 and job_type = 'notification.routine_due'
          and payload ->> 'routineId' = $2
        order by created_at`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    expect(jobs.rows).toHaveLength(2);
    for (const job of jobs.rows) {
      const recipients = job.payload.recipients as string[];
      expect(job.payload).toMatchObject({
        routineId,
        title: "Revisión trimestral de la caldera",
        audience: "family",
      });
      expect(recipients).toEqual([ADMIN_EMAIL, FAMILY_EMAIL]);
      expect(recipients).not.toContain(EMPLOYEE_EMAIL);
      expect(recipients).not.toContain(HELPER_EMAIL);
    }

    // Y el run_at del segundo aviso es exactamente la fecha recortada.
    const runAt = await adminPool.query<{ ok: boolean }>(
      `select run_at = '2027-02-28'::date::timestamptz as ok
         from app_private.job_queue
        where household_id = $1 and job_type = 'notification.routine_due'
          and payload ->> 'routineId' = $2
        order by created_at desc
        limit 1`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    expect(runAt.rows).toEqual([{ ok: true }]);
  });

  it("el clamp trimestral es el de calendario también en año bisiesto: 30/11/2027 → 29/02/2028", () => {
    // La misma función pura que usa el comando: 2028 sí es bisiesto.
    expect(advanceDueDate("2027-11-30", "quarterly", 1)).toBe("2028-02-29");
    expect(advanceDueDate("2026-11-30", "quarterly", 1)).toBe("2027-02-28");
    // Con intervalCount 2 (semestral por trimestres) no hay recorte: 30/05.
    expect(advanceDueDate("2026-11-30", "quarterly", 2)).toBe("2027-05-30");
  });
});
