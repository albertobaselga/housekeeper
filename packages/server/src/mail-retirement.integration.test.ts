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

/**
 * Lo que la migración 0029 retiró, comprobado sobre Postgres real.
 *
 * Este fichero comprobaba lo contrario: que cerrar un mes encolaba el aviso por
 * correo y que enviar la semana encolaba su auto-confirmación. Las dos cosas se
 * han ido —no hay canal de correo, y el parte semanal se retiró entero— y lo
 * que queda por vigilar es que no vuelvan por descuido:
 *
 *   · Cerrar la cuenta del mes no puede volver a encolar los tipos retirados. Un
 *     trabajo que nadie sabe ejecutar se reintenta, muere y ensucia el log; y
 *     el de la liquidación además se re-encolaba a sí mismo cada tres días.
 *   · Las dos funciones SECURITY DEFINER de la 0006 no pueden reaparecer: la
 *     que auto-confirmaba partes y la que sacaba direcciones de correo de la
 *     base hacia el remitente SMTP.
 *
 * Lo que SÍ vuelve, por el canal que existe (migración 0032), es el aviso de la
 * cuenta del mes por pagar hacia quien administra. Vuelve con las dos cosas que
 * le faltaban y que aquí se comprueban: un payload REFERENCIAL —sin
 * destinatarios, sin importes, sin nombres, porque el payload de un trabajo
 * acaba copiado a `app.audit_events` para siempre— y un `run_at` dentro de la
 * ventana de silencio. El que no vuelve es el de rutinas, y esa asimetría es la
 * decisión, no un descuido.
 */

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";
const WORKER_LOGIN = "it_casa_clara_worker_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };

// Periodo propio de este suite: mayo de 2025. El test de employment usa abril;
// ambos comparten base y fixtures, así que los hechos no deben solaparse.
const PERIOD_START = "2025-05-01";
const PERIOD_END = "2025-05-31";

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

describe.runIf(Boolean(adminUrl))("avisos por correo y parte semanal retirados (0029)", () => {
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

  it("cerrar la cuenta de mayo encola el recibo y el aviso a quien administra, y nada de lo retirado", async () => {
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
    const settlementId = opened.resourceId as string;

    const closed = await run(ADMIN, envelope("settlement", { action: "close", settlementId }));
    expect(closed).toMatchObject({ status: "accepted", resourceId: settlementId });

    // El recibo sí: es un documento, no un aviso, y la empleada lo necesita.
    // Ahora lleva además el identificador de la liquidación, que es lo que le
    // permite encolar el aviso de «tu recibo ya está» cuando el PDF exista de
    // verdad — y solo entonces.
    const receipts = await adminPool.query<{ total: number; settlement_id: string | null }>(
      `select count(*)::int as total, min(payload ->> 'settlementId') as settlement_id
         from app_private.job_queue
        where household_id = $1 and job_type = 'document.render_receipt'
          and payload -> 'receipt' ->> 'period' = '2025-05'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(receipts.rows[0]?.total).toBe(1);
    expect(receipts.rows[0]?.settlement_id).toBe(settlementId);

    const notices = await adminPool.query<{ job_type: string }>(
      `select distinct job_type from app_private.job_queue
        where household_id = $1
          and job_type in ('notification.settlement_due', 'notification.routine_due',
                           'time_report.autoconfirm')
          and status = 'queued'`,
      [ROBLE_HOUSEHOLD],
    );
    expect(notices.rows).toEqual([]);

    // El aviso que sí vuelve: uno solo, referencial y en hora.
    const push = await adminPool.query<{
      payload: Record<string, unknown>;
      local_time: string;
      weekday: number;
      early: boolean;
    }>(
      `select payload,
              to_char(run_at at time zone 'Europe/Madrid', 'HH24:MI') as local_time,
              extract(isodow from run_at at time zone 'Europe/Madrid')::int as weekday,
              run_at < ($2::date)::timestamptz as early
         from app_private.job_queue
        where household_id = $1 and job_type = 'notification.push'
          and payload ->> 'settlementId' = $3`,
      [ROBLE_HOUSEHOLD, DUE_ON, settlementId],
    );
    expect(push.rows).toHaveLength(1);
    const queued = push.rows[0];

    // Payload referencial: el tópico y el identificador, y NADA más. Ni la
    // audiencia (se resuelve al enviar, para que retirar el acceso apague los
    // avisos en el acto) ni el importe (el payload va a un registro inmutable
    // que no se poda).
    expect(Object.keys(queued?.payload ?? {}).sort()).toEqual(["settlementId", "topic"]);
    expect(queued?.payload).toMatchObject({ topic: "settlement.due", settlementId });

    // Y en hora: dentro de la ventana 09:00-21:30, nunca en domingo, y antes del
    // vencimiento (para eso son los tres días de antelación). El defecto que
    // esto vigila es real y estaba en la cola: `::date::timestamptz` resolvía la
    // medianoche en la zona de la SESIÓN, o sea las 02:00 en Madrid.
    expect(queued).toBeDefined();
    expect(queued!.local_time >= "09:00").toBe(true);
    expect(queued!.local_time <= "21:30").toBe(true);
    expect(queued?.weekday).not.toBe(7);
    expect(queued?.early).toBe(true);
  });

  it("las dos funciones definer de la 0006 ya no existen para el worker", async () => {
    await expect(
      workerPool.query("select app_private.autoconfirm_weekly_report($1, $2)", [
        ROBLE_HOUSEHOLD,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "42883" });

    await expect(
      workerPool.query("select * from app_private.settlement_reminder_state($1, $2)", [
        ROBLE_HOUSEHOLD,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "42883" });
  });
});
