import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { rhythmCommandHandlers } from "./commands/rhythm.js";
import { processSyncBatch } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const HELPER: AuthenticatedPrincipal = { userId: "fixture:roble:helper" };

// Los correos de admin y empleada coinciden con los del suite de recordatorios
// (misma base compartida); familiar y apoyo son exclusivos de este suite.
const ADMIN_EMAIL = "admin.roble@example.com";
const FAMILY_EMAIL = "familiar.roble@example.com";
const EMPLOYEE_EMAIL = "empleada.roble@example.com";
const HELPER_EMAIL = "apoyo.roble@example.com";

function envelope(aggregateType: AggregateType, payload: unknown): CommandEnvelopeV1 {
  return {
    apiVersion: API_VERSION,
    operationId: randomUUID(),
    householdId: ROBLE_HOUSEHOLD,
    schemaVersion: 1,
    aggregateType,
    aggregateId: null,
    baseRevision: null,
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("rutinas con audiencia y feeds ICS sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], rhythmCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  async function upsertRoutine(
    payload: Record<string, unknown>,
  ): Promise<string> {
    const ack = await run(ADMIN, envelope("routine", { action: "upsert", ...payload }));
    expect(ack).toMatchObject({ status: "accepted" });
    return ack.resourceId as string;
  }

  async function nextDueOn(routineId: string): Promise<string> {
    const row = await adminPool.query<{ next_due_on: string }>(
      "select next_due_on::text as next_due_on from app.routines where id = $1",
      [routineId],
    );
    return row.rows[0]?.next_due_on as string;
  }

  async function routineDueJobs(routineId: string): Promise<Array<{ payload: Record<string, unknown>; runAt: Date }>> {
    const rows = await adminPool.query<{ payload: Record<string, unknown>; run_at: Date }>(
      `select payload, run_at
         from app_private.job_queue
        where household_id = $1 and job_type = 'notification.routine_due'
          and payload ->> 'routineId' = $2
        order by created_at`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    return rows.rows.map((row) => ({ payload: row.payload, runAt: row.run_at }));
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    // Correos de contacto sembrados en los perfiles (columna de la 0006).
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

  it("completar la ocurrencia vigente avanza next_due_on según cada frecuencia", async () => {
    const cases = [
      { frequency: "daily", intervalCount: 3, nextDueOn: "2027-06-01", expected: "2027-06-04" },
      { frequency: "weekly", intervalCount: 2, nextDueOn: "2027-06-07", expected: "2027-06-21" },
      // Recorte de calendario: 31/01 + 1 mes cae en el último día de febrero.
      { frequency: "monthly", intervalCount: 1, nextDueOn: "2027-01-31", expected: "2027-02-28" },
      { frequency: "quarterly", intervalCount: 2, nextDueOn: "2027-03-15", expected: "2027-09-15" },
    ] as const;

    for (const testCase of cases) {
      const routineId = await upsertRoutine({
        title: `Rutina ${testCase.frequency}`,
        audience: "all",
        frequency: testCase.frequency,
        intervalCount: testCase.intervalCount,
        nextDueOn: testCase.nextDueOn,
      });

      const completed = await run(
        ADMIN,
        envelope("routine", { action: "complete", routineId, dueOn: testCase.nextDueOn }),
      );
      expect(completed).toMatchObject({ status: "accepted", resourceId: routineId });
      expect(await nextDueOn(routineId)).toBe(testCase.expected);

      // Dos avisos encolados: el primero al crear (run_at = primera ocurrencia)
      // y el segundo al completar (run_at = la nueva next_due_on). La igualdad
      // se comprueba en SQL para no depender de la zona horaria del servidor, y
      // la hora civil se lee EN Madrid: el aviso del día X sale a las 08:00 de
      // ese día (0027), no a la medianoche de la zona de la sesión.
      const jobs = await routineDueJobs(routineId);
      expect(jobs).toHaveLength(2);
      for (const [index, expectedDate] of [testCase.nextDueOn, testCase.expected].entries()) {
        const match = await adminPool.query<{ ok: boolean; madrid_wall_clock: string }>(
          `select $1::timestamptz = app.job_run_at($2::date) as ok,
                  to_char($1::timestamptz at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI')
                    as madrid_wall_clock`,
          [jobs[index]?.runAt, expectedDate],
        );
        expect(match.rows[0], `run_at del aviso ${index} de ${testCase.frequency}`).toEqual({
          ok: true,
          madrid_wall_clock: `${expectedDate} 08:00`,
        });
      }
    }
  });

  it("repetir la misma ocurrencia se rechaza con already_completed", async () => {
    const routineId = await upsertRoutine({
      title: "Rutina duplicable",
      audience: "all",
      frequency: "weekly",
      intervalCount: 1,
      nextDueOn: "2027-07-05",
    });
    const first = await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: "2027-07-05" }));
    expect(first).toMatchObject({ status: "accepted" });

    const replayed = await run(ADMIN, envelope("routine", { action: "complete", routineId, dueOn: "2027-07-05" }));
    expect(replayed).toMatchObject({ status: "rejected", errorCode: "already_completed" });
  });

  it("la empleada completa una rutina 'employee' y la 0009 avanza la recurrencia", async () => {
    const routineId = await upsertRoutine({
      title: "Plancha semanal",
      audience: "employee",
      frequency: "weekly",
      intervalCount: 1,
      nextDueOn: "2027-08-02",
    });

    const completed = await run(
      EMPLOYEE,
      envelope("routine", { action: "complete", routineId, dueOn: "2027-08-02" }),
    );
    expect(completed).toMatchObject({ status: "accepted", resourceId: routineId });

    const completion = await adminPool.query<{ completed_by_membership_id: string }>(
      `select completed_by_membership_id
         from app.routine_completions
        where household_id = $1 and routine_id = $2 and due_on = '2027-08-02'`,
      [ROBLE_HOUSEHOLD, routineId],
    );
    expect(completion.rows).toEqual([
      { completed_by_membership_id: "11000000-0000-4000-8000-000000000003" },
    ]);

    // La función definer de la 0009 permite el avance aunque quien completa
    // no tenga escritura sobre app.routines (audiencia empleada).
    expect(await nextDueOn(routineId)).toBe("2027-08-09");
    expect(await routineDueJobs(routineId)).toHaveLength(2);

    // Los avisos de una rutina 'employee' van solo a la empleada.
    const jobs = await routineDueJobs(routineId);
    expect(jobs[0]?.payload.recipients).toEqual([EMPLOYEE_EMAIL]);
  });

  it("el apoyo no puede completar una 'employee' pero sí una 'all'", async () => {
    const employeeRoutine = await upsertRoutine({
      title: "Rutina solo empleada",
      audience: "employee",
      frequency: "daily",
      intervalCount: 1,
      nextDueOn: "2027-09-01",
    });
    const denied = await run(
      HELPER,
      envelope("routine", { action: "complete", routineId: employeeRoutine, dueOn: "2027-09-01" }),
    );
    expect(denied).toMatchObject({ status: "rejected", errorCode: "routine_not_found" });

    const sharedRoutine = await upsertRoutine({
      title: "Rutina de todos",
      audience: "all",
      frequency: "daily",
      intervalCount: 1,
      nextDueOn: "2027-09-02",
    });
    const completed = await run(
      HELPER,
      envelope("routine", { action: "complete", routineId: sharedRoutine, dueOn: "2027-09-02" }),
    );
    expect(completed).toMatchObject({ status: "accepted", resourceId: sharedRoutine });
  });

  it("AC-25: los recipients de un aviso 'family' jamás incluyen a la empleada", async () => {
    const routineId = await upsertRoutine({
      title: "Mantenimiento caldera",
      audience: "family",
      frequency: "monthly",
      intervalCount: 1,
      nextDueOn: "2027-10-01",
    });

    const completed = await run(
      ADMIN,
      envelope("routine", { action: "complete", routineId, dueOn: "2027-10-01" }),
    );
    expect(completed).toMatchObject({ status: "accepted" });

    const jobs = await routineDueJobs(routineId);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      const recipients = job.payload.recipients as string[];
      expect(recipients).toEqual([ADMIN_EMAIL, FAMILY_EMAIL]);
      expect(recipients).not.toContain(EMPLOYEE_EMAIL);
      expect(recipients).not.toContain(HELPER_EMAIL);
      expect(job.payload).toMatchObject({ routineId, title: "Mantenimiento caldera", audience: "family" });
    }
  });

  it("crear un feed devuelve el token una sola vez y la base guarda solo su sha-256", async () => {
    const command = envelope("ics_feed", { action: "create", audience: "employee" });
    const created = await run(ADMIN, command);
    expect(created).toMatchObject({ status: "accepted" });
    const feedId = created.resourceId as string;
    const token = (created as CommandAckV1 & { feedToken?: string }).feedToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = await adminPool.query<{ token_hash: string; audience: string; revoked_at: Date | null }>(
      "select token_hash, audience::text as audience, revoked_at from app.ics_feeds where id = $1",
      [feedId],
    );
    expect(stored.rows).toEqual([
      {
        token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
        audience: "employee",
        revoked_at: null,
      },
    ]);

    // El replay idempotente del MISMO comando devuelve el MISMO token desde el
    // recibo persistido, sin crear un segundo feed.
    const replayed = await run(ADMIN, command);
    expect(replayed).toMatchObject({ status: "duplicate", resourceId: feedId });
    expect((replayed as CommandAckV1 & { feedToken?: string }).feedToken).toBe(token);
    const count = await adminPool.query(
      "select count(*)::int as feeds from app.ics_feeds where token_hash = $1",
      [createHash("sha256").update(token, "utf8").digest("hex")],
    );
    expect(count.rows[0]).toEqual({ feeds: 1 });

    // La revocación invalida el feed y es idempotente.
    const revoked = await run(ADMIN, envelope("ics_feed", { action: "revoke", feedId }));
    expect(revoked).toMatchObject({ status: "accepted", resourceId: feedId });
    const afterRevoke = await adminPool.query<{ revoked: boolean }>(
      "select revoked_at is not null as revoked from app.ics_feeds where id = $1",
      [feedId],
    );
    expect(afterRevoke.rows[0]).toEqual({ revoked: true });

    const revokedAgain = await run(ADMIN, envelope("ics_feed", { action: "revoke", feedId }));
    expect(revokedAgain).toMatchObject({ status: "accepted", resourceId: feedId });
  });

  it("solo family_admin gestiona feeds; la empleada es rechazada", async () => {
    const denied = await run(EMPLOYEE, envelope("ics_feed", { action: "create", audience: "employee" }));
    expect(denied).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const missing = await run(ADMIN, envelope("ics_feed", { action: "revoke", feedId: randomUUID() }));
    expect(missing).toMatchObject({ status: "rejected", errorCode: "feed_not_found" });
  });

  it("el alta de una fuente https encola ics.sync_source con la URL en el payload", async () => {
    const created = await run(
      ADMIN,
      envelope("ics_feed", {
        action: "upsert_source",
        url: "https://calendario.example.com/colegio.ics",
        label: "Calendario del colegio",
        enabled: true,
      }),
    );
    expect(created).toMatchObject({ status: "accepted" });
    const sourceId = created.resourceId as string;

    const source = await adminPool.query<{ url: string; label: string; enabled: boolean }>(
      "select url, label, enabled from app.ics_sources where id = $1",
      [sourceId],
    );
    expect(source.rows).toEqual([
      { url: "https://calendario.example.com/colegio.ics", label: "Calendario del colegio", enabled: true },
    ]);

    const jobs = await adminPool.query<{ payload: Record<string, unknown> }>(
      `select payload from app_private.job_queue
        where household_id = $1 and job_type = 'ics.sync_source'
          and payload ->> 'sourceId' = $2`,
      [ROBLE_HOUSEHOLD, sourceId],
    );
    expect(jobs.rows).toEqual([
      { payload: { sourceId, url: "https://calendario.example.com/colegio.ics" } },
    ]);
  });
});
