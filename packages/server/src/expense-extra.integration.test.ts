import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@housekeeper/contracts";

import { submitExpenseHandler } from "./commands/expense.js";
import { extraWorkCommandHandler } from "./commands/extra-work.js";
import { processSyncBatch, type CommandHandlers } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const AGREEMENT_V2 = "12100000-0000-4000-8000-000000000002";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

const HANDLERS: CommandHandlers = {
  expense: submitExpenseHandler,
  extra_work: extraWorkCommandHandler,
};

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
    occurredAt: "2026-08-07T11:00:00.000Z",
    payload,
  };
}

// Fechas de junio 2025: la base se comparte con los otros suites de
// integración (marzo viene de las fixtures, abril lo consume el recorrido de
// liquidación), así que este fichero trabaja en un mes que nadie más toca.
describe.runIf(Boolean(adminUrl))("resolución de gastos y aceptación/realización de jornadas extra", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], HANDLERS);
    expect(result.acknowledgements).toHaveLength(1);
    return result.acknowledgements[0] as CommandAckV1;
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

  async function submitJuneExpense(incurredOn: string, description: string, amountCents: string): Promise<string> {
    const submitted = await run(
      EMPLOYEE,
      envelope("expense", { agreementId: ROBLE_AGREEMENT, incurredOn, description, amountCents }),
    );
    expect(submitted).toMatchObject({ status: "accepted" });
    return submitted.resourceId as string;
  }

  it("la familia aprueba un gasto pendiente con motivo y el replay responde duplicate", async () => {
    const expenseId = await submitJuneExpense("2025-06-05", "Compra de mercado de junio", "1830");

    const resolveEnvelope = envelope("expense", {
      action: "resolve",
      expenseId,
      resolution: "approved",
      reason: "Ticket revisado y conforme",
    });
    const approved = await run(ADMIN, resolveEnvelope);
    expect(approved).toMatchObject({ status: "accepted", resourceId: expenseId });

    const row = await adminPool.query(
      `select status, resolved_by_membership_id, resolution_reason,
              (resolved_at is not null) as has_resolved_at
         from app.expenses where id = $1`,
      [expenseId],
    );
    expect(row.rows[0]).toEqual({
      status: "approved",
      resolved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      resolution_reason: "Ticket revisado y conforme",
      has_resolved_at: true,
    });

    const replay = await run(ADMIN, resolveEnvelope);
    expect(replay).toMatchObject({
      operationId: resolveEnvelope.operationId,
      status: "duplicate",
      resourceId: expenseId,
    });

    // Un gasto ya aprobado no vuelve a resolverse: mismo rechazo que si no existiera.
    const again = await run(
      ADMIN,
      envelope("expense", { action: "resolve", expenseId, resolution: "rejected", reason: "Segundo intento" }),
    );
    expect(again).toMatchObject({ status: "rejected", errorCode: "expense_not_pending" });
  });

  it("rechaza un gasto pendiente con motivo y bloquea resoluciones indebidas", async () => {
    const expenseId = await submitJuneExpense("2025-06-09", "Taxi al centro de salud", "950");

    const employeeTry = await run(
      EMPLOYEE,
      envelope("expense", { action: "resolve", expenseId, resolution: "approved", reason: "Intento indebido" }),
    );
    expect(employeeTry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const missing = await run(
      ADMIN,
      envelope("expense", { action: "resolve", expenseId: randomUUID(), resolution: "approved", reason: "No existe" }),
    );
    expect(missing).toMatchObject({ status: "rejected", errorCode: "expense_not_pending" });

    const rejected = await run(
      ADMIN,
      envelope("expense", {
        action: "resolve",
        expenseId,
        resolution: "rejected",
        reason: "Sin ticket que lo justifique",
      }),
    );
    expect(rejected).toMatchObject({ status: "accepted", resourceId: expenseId });

    const row = await adminPool.query(
      "select status, resolved_by_membership_id, resolution_reason from app.expenses where id = $1",
      [expenseId],
    );
    expect(row.rows[0]).toEqual({
      status: "rejected",
      resolved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      resolution_reason: "Sin ticket que lo justifique",
    });
  });

  async function registerJuneExtraWork(payload: Record<string, unknown>): Promise<string> {
    const registered = await run(EMPLOYEE, envelope("extra_work", { action: "register", agreementId: ROBLE_AGREEMENT, ...payload }));
    expect(registered).toMatchObject({ status: "accepted" });
    return registered.resourceId as string;
  }

  it("recorre register → accept → mark_performed → resolve con tarifa congelada y actores correctos", async () => {
    const eventId = await registerJuneExtraWork({
      kind: "overtime",
      workedOn: "2025-06-11",
      durationMinutes: 90,
      note: "Cena tardía de junio",
    });

    const employeeAccept = await run(EMPLOYEE, envelope("extra_work", { action: "accept", extraWorkEventId: eventId }));
    expect(employeeAccept).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const adminPerform = await run(ADMIN, envelope("extra_work", { action: "mark_performed", extraWorkEventId: eventId }));
    expect(adminPerform).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const accepted = await run(ADMIN, envelope("extra_work", { action: "accept", extraWorkEventId: eventId }));
    expect(accepted).toMatchObject({ status: "accepted", resourceId: eventId });

    const afterAccept = await adminPool.query(
      `select status, approved_by_membership_id, (approved_at is not null) as has_approved_at
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    expect(afterAccept.rows[0]).toEqual({
      status: "accepted",
      approved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      has_approved_at: true,
    });

    const acceptAgain = await run(ADMIN, envelope("extra_work", { action: "accept", extraWorkEventId: eventId }));
    expect(acceptAgain).toMatchObject({ status: "rejected", errorCode: "extra_work_not_requested" });

    const performed = await run(EMPLOYEE, envelope("extra_work", { action: "mark_performed", extraWorkEventId: eventId }));
    expect(performed).toMatchObject({ status: "accepted", resourceId: eventId });

    const afterPerform = await adminPool.query(
      `select status, performed_by_membership_id, (performed_at is not null) as has_performed_at
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    expect(afterPerform.rows[0]).toEqual({
      status: "performed",
      performed_by_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      has_performed_at: true,
    });

    const performAgain = await run(EMPLOYEE, envelope("extra_work", { action: "mark_performed", extraWorkEventId: eventId }));
    expect(performAgain).toMatchObject({ status: "rejected", errorCode: "extra_work_not_performable" });

    const resolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: eventId,
        resolution: "money",
        reason: "Pago acordado tras confirmar el trabajo",
      }),
    );
    expect(resolved).toMatchObject({ status: "accepted", resourceId: eventId });

    const event = await adminPool.query(
      `select status, resolution, resolved_agreement_version_id,
              frozen_unit_rate_cents::text as unit, frozen_amount_cents::text as amount, balance_minutes
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    // 1400 cts/hora (v2 vigente en junio) * 90 min / 60 = 2100 cts exactos.
    expect(event.rows[0]).toEqual({
      status: "resolved",
      resolution: "money",
      resolved_agreement_version_id: AGREEMENT_V2,
      unit: "1400",
      amount: "2100",
      balance_minutes: 0,
    });

    const transitions = await adminPool.query(
      `select sequence_number, from_status, to_status, actor_membership_id
         from app.extra_work_transitions
        where extra_work_event_id = $1 order by sequence_number`,
      [eventId],
    );
    expect(transitions.rows).toEqual([
      { sequence_number: 1, from_status: null, to_status: "requested", actor_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP },
      { sequence_number: 2, from_status: "requested", to_status: "accepted", actor_membership_id: ROBLE_ADMIN_MEMBERSHIP },
      { sequence_number: 3, from_status: "accepted", to_status: "performed", actor_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP },
      { sequence_number: 4, from_status: "performed", to_status: "resolved", actor_membership_id: ROBLE_ADMIN_MEMBERSHIP },
    ]);
  });

  it("mark_performed sin aceptación previa deja el evento pendiente de resolución", async () => {
    const eventId = await registerJuneExtraWork({
      kind: "worked_rest_day",
      workedOn: "2025-06-15",
      durationMinutes: 480,
      note: "Domingo trabajado sin visto bueno previo",
    });

    const performed = await run(EMPLOYEE, envelope("extra_work", { action: "mark_performed", extraWorkEventId: eventId }));
    expect(performed).toMatchObject({ status: "accepted", resourceId: eventId });

    const event = await adminPool.query(
      `select status, approved_by_membership_id, performed_by_membership_id,
              (performed_at is not null) as has_performed_at
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    expect(event.rows[0]).toEqual({
      status: "performed_pending_resolution",
      approved_by_membership_id: null,
      performed_by_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      has_performed_at: true,
    });

    const transitions = await adminPool.query(
      `select sequence_number, from_status, to_status, actor_membership_id
         from app.extra_work_transitions
        where extra_work_event_id = $1 order by sequence_number`,
      [eventId],
    );
    expect(transitions.rows).toEqual([
      { sequence_number: 1, from_status: null, to_status: "requested", actor_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP },
      {
        sequence_number: 2,
        from_status: "requested",
        to_status: "performed_pending_resolution",
        actor_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      },
    ]);

    const acceptLate = await run(ADMIN, envelope("extra_work", { action: "accept", extraWorkEventId: eventId }));
    expect(acceptLate).toMatchObject({ status: "rejected", errorCode: "extra_work_not_requested" });
  });

  it("resolver un evento aún en requested conserva el atajo del handler existente", async () => {
    const eventId = await registerJuneExtraWork({
      kind: "overtime",
      workedOn: "2025-06-18",
      durationMinutes: 60,
      note: "Hora extra resuelta sin pasos intermedios",
    });

    const resolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: eventId,
        resolution: "money",
        reason: "Se reconoce el trabajo y se paga directamente",
      }),
    );
    expect(resolved).toMatchObject({ status: "accepted", resourceId: eventId });

    const event = await adminPool.query(
      "select status, frozen_amount_cents::text as amount from app.extra_work_events where id = $1",
      [eventId],
    );
    expect(event.rows[0]).toEqual({ status: "resolved", amount: "1400" });

    const transitions = await adminPool.query(
      `select sequence_number, from_status, to_status, actor_membership_id
         from app.extra_work_transitions
        where extra_work_event_id = $1 order by sequence_number`,
      [eventId],
    );
    expect(transitions.rows).toEqual([
      { sequence_number: 1, from_status: null, to_status: "requested", actor_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP },
      {
        sequence_number: 2,
        from_status: "requested",
        to_status: "performed_pending_resolution",
        actor_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      },
      {
        sequence_number: 3,
        from_status: "performed_pending_resolution",
        to_status: "resolved",
        actor_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      },
    ]);
  });
});
