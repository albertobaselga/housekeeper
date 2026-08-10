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
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const APP_LOGIN = "it_casa_clara_app_login";
const WORKER_LOGIN = "it_casa_clara_worker_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

const ADMIN_EMAIL = "admin.roble@example.com";
const EMPLOYEE_EMAIL = "empleada.roble@example.com";

// Periodo propio de este suite: mayo de 2025 y la semana del lunes 5 de mayo.
// El test de employment usa abril de 2025 y la semana del 7 de abril; ambos
// comparten base y fixtures, así que los hechos no deben solaparse.
const PERIOD_START = "2025-05-01";
const PERIOD_END = "2025-05-31";
const WEEK_STARTS_ON = "2025-05-05";

/** Vencimiento siempre futuro para que `due_on - 3 días` no se clave a `now()`. */
function isoDateFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const DUE_ON = isoDateFromToday(120);

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

describe.runIf(Boolean(adminUrl))("recordatorios y auto-confirmación sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], employmentCommandHandlers);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

    const appUrl = new URL(adminUrl as string);
    appUrl.username = APP_LOGIN;
    appUrl.password = "integration-only";
    appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 2 });

    // Login del worker, miembro del grupo casa_clara_worker y sin BYPASSRLS,
    // igual que el global-setup crea el login de la aplicación.
    await adminPool.query(`drop role if exists ${WORKER_LOGIN}`);
    await adminPool.query(
      `create role ${WORKER_LOGIN} login password 'integration-only' nosuperuser nobypassrls in role casa_clara_worker`,
    );
    const workerUrl = new URL(adminUrl as string);
    workerUrl.username = WORKER_LOGIN;
    workerUrl.password = "integration-only";
    workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 2 });

    // Correos de contacto de los destinatarios del aviso (columna de la 0006).
    await adminPool.query("update app.user_profiles set email = $2 where user_id = $1", [
      "fixture:roble:admin",
      ADMIN_EMAIL,
    ]);
    await adminPool.query("update app.user_profiles set email = $2 where user_id = $1", [
      "fixture:roble:employee",
      EMPLOYEE_EMAIL,
    ]);
  });

  afterAll(async () => {
    await workerPool?.end();
    await appPool?.end();
    try {
      await adminPool?.query(`drop role if exists ${WORKER_LOGIN}`);
    } catch {
      // El rol puede seguir referenciado por otra sesión; no es un fallo del suite.
    }
    await adminPool?.end();
  });

  let settlementId: string;
  let reportId: string;

  it("el cierre de mayo encola notification.settlement_due la mañana de due_on - 3 días", async () => {
    const opened = await run(
      ADMIN,
      envelope("settlement", {
        action: "open",
        agreementId: ROBLE_AGREEMENT,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        dueOn: DUE_ON,
      }),
    );
    expect(opened).toMatchObject({ status: "accepted" });
    settlementId = opened.resourceId as string;

    const closed = await run(ADMIN, envelope("settlement", { action: "close", settlementId }));
    expect(closed).toMatchObject({ status: "accepted", resourceId: settlementId });

    // La hora es la que fija app.job_run_at (0027): las 08:00 civiles de Madrid
    // del día `due_on - 3`, no la medianoche de la zona de la sesión. La segunda
    // columna lo comprueba de forma independiente de la función, formateando el
    // instante EN Madrid: nunca puede volver a ser una hora de madrugada.
    const job = await adminPool.query<{
      run_at_matches: boolean;
      madrid_wall_clock: string;
      in_future: boolean;
      status: string;
    }>(
      `select run_at = app.job_run_at($3::date - 3) as run_at_matches,
              to_char(run_at at time zone 'Europe/Madrid', 'YYYY-MM-DD HH24:MI') as madrid_wall_clock,
              run_at > now() as in_future, status
         from app_private.job_queue
        where household_id = $1 and job_type = 'notification.settlement_due'
          and payload ->> 'settlementId' = $2`,
      [ROBLE_HOUSEHOLD, settlementId, DUE_ON],
    );
    const expectedDay = new Date(`${DUE_ON}T00:00:00Z`);
    expectedDay.setUTCDate(expectedDay.getUTCDate() - 3);
    expect(job.rows).toEqual([
      {
        run_at_matches: true,
        madrid_wall_clock: `${expectedDay.toISOString().slice(0, 10)} 08:00`,
        in_future: true,
        status: "queued",
      },
    ]);
  });

  it("settlement_reminder_state, ejecutada con el login del worker, expone pendiente y correos", async () => {
    const state = await workerPool.query(
      `select due_on::text as due_on, period_start::text as period_start,
              period_end::text as period_end, status,
              pending_cents::text as pending_cents, receipt_confirmed,
              employee_email, admin_emails
         from app_private.settlement_reminder_state($1, $2)`,
      [ROBLE_HOUSEHOLD, settlementId],
    );
    // Mayo sin hechos extra bajo el acuerdo v2: salario base (150000) más el
    // complemento de antigüedad (3000), todo pendiente. El seguro médico de la
    // v2 no está aquí: lo paga la casa por su cuenta.
    expect(state.rows).toEqual([
      {
        due_on: DUE_ON,
        period_start: PERIOD_START,
        period_end: PERIOD_END,
        status: "closed",
        pending_cents: "153000",
        receipt_confirmed: false,
        employee_email: EMPLOYEE_EMAIL,
        admin_emails: [ADMIN_EMAIL],
      },
    ]);

    const missing = await workerPool.query(
      "select 1 from app_private.settlement_reminder_state($1, $2)",
      [ROBLE_HOUSEHOLD, randomUUID()],
    );
    expect(missing.rows).toHaveLength(0);
  });

  it("el envío de la semana de mayo encola time_report.autoconfirm a +3 días", async () => {
    const submitted = await run(
      EMPLOYEE,
      envelope("time_entry", {
        action: "submit_week",
        agreementId: ROBLE_AGREEMENT,
        weekStartsOn: WEEK_STARTS_ON,
        entries: [
          { workedOn: "2025-05-05", startedAt: "09:00", endedAt: "17:00", regularMinutes: 480 },
          { workedOn: "2025-05-07", regularMinutes: 480 },
        ],
      }),
    );
    expect(submitted).toMatchObject({ status: "accepted" });
    reportId = submitted.resourceId as string;

    const job = await adminPool.query<{ on_schedule: boolean; status: string }>(
      `select run_at between now() + interval '3 days' - interval '5 minutes'
                         and now() + interval '3 days' + interval '5 minutes' as on_schedule,
              status
         from app_private.job_queue
        where household_id = $1 and job_type = 'time_report.autoconfirm'
          and payload ->> 'reportId' = $2`,
      [ROBLE_HOUSEHOLD, reportId],
    );
    expect(job.rows).toEqual([{ on_schedule: true, status: "queued" }]);
  });

  it("autoconfirm devuelve false antes de plazo y true tras retro-datar el envío 4 días", async () => {
    const early = await workerPool.query<{ confirmed: boolean }>(
      "select app_private.autoconfirm_weekly_report($1, $2) as confirmed",
      [ROBLE_HOUSEHOLD, reportId],
    );
    expect(early.rows[0]).toEqual({ confirmed: false });

    const untouched = await adminPool.query(
      "select status, auto_confirmed from app.weekly_time_reports where id = $1",
      [reportId],
    );
    expect(untouched.rows[0]).toEqual({ status: "submitted", auto_confirmed: false });

    await adminPool.query(
      "update app.weekly_time_reports set submitted_at = submitted_at - interval '4 days' where id = $1",
      [reportId],
    );

    const late = await workerPool.query<{ confirmed: boolean }>(
      "select app_private.autoconfirm_weekly_report($1, $2) as confirmed",
      [ROBLE_HOUSEHOLD, reportId],
    );
    expect(late.rows[0]).toEqual({ confirmed: true });

    const confirmed = await adminPool.query(
      `select status, auto_confirmed, confirmed_by_membership_id,
              submitted_by_membership_id, confirmed_at is not null as has_confirmed_at
         from app.weekly_time_reports where id = $1`,
      [reportId],
    );
    expect(confirmed.rows[0]).toEqual({
      status: "confirmed",
      auto_confirmed: true,
      confirmed_by_membership_id: null,
      submitted_by_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      has_confirmed_at: true,
    });

    // Idempotente: una segunda pasada ya no tiene nada que confirmar.
    const replay = await workerPool.query<{ confirmed: boolean }>(
      "select app_private.autoconfirm_weekly_report($1, $2) as confirmed",
      [ROBLE_HOUSEHOLD, reportId],
    );
    expect(replay.rows[0]).toEqual({ confirmed: false });
  });
});
