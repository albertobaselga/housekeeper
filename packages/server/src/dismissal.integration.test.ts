import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";

import { submitExpenseHandler } from "./commands/expense.js";
import { extraWorkCommandHandler } from "./commands/extra-work.js";
import { settlementCommandHandler } from "./commands/settlement.js";
import { processSyncBatch, type CommandHandlers } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };

const HANDLERS: CommandHandlers = {
  expense: submitExpenseHandler,
  extra_work: extraWorkCommandHandler,
  settlement: settlementCommandHandler,
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
    occurredAt: "2026-08-07T12:00:00.000Z",
    payload,
  };
}

// Fechas de julio y agosto 2025: la base se comparte con los otros suites de
// integración (marzo viene de las fixtures, abril lo consume el expediente
// laboral, mayo los recordatorios y junio la resolución de gastos y jornadas),
// así que este fichero trabaja en los dos meses que nadie más toca.
describe.runIf(Boolean(adminUrl))("descartes de jornadas extra y reembolso de gastos al cerrar", () => {
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

  async function registerJulyExtraWork(payload: Record<string, unknown>): Promise<string> {
    const registered = await run(
      EMPLOYEE,
      envelope("extra_work", { action: "register", agreementId: ROBLE_AGREEMENT, ...payload }),
    );
    expect(registered).toMatchObject({ status: "accepted" });
    return registered.resourceId as string;
  }

  async function loadTransitions(eventId: string): Promise<unknown[]> {
    const transitions = await adminPool.query(
      `select sequence_number, from_status, to_status, actor_membership_id, reason
         from app.extra_work_transitions
        where extra_work_event_id = $1 order by sequence_number`,
      [eventId],
    );
    return transitions.rows;
  }

  it("la familia rechaza una jornada en requested con motivo y el terminal queda inmutable", async () => {
    const eventId = await registerJulyExtraWork({
      kind: "overtime",
      workedOn: "2025-07-02",
      durationMinutes: 60,
      note: "Hora extra dudosa de julio",
    });

    const employeeTry = await run(
      EMPLOYEE,
      envelope("extra_work", { action: "reject", extraWorkEventId: eventId, reason: "Intento indebido" }),
    );
    expect(employeeTry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const rejected = await run(
      ADMIN,
      envelope("extra_work", {
        action: "reject",
        extraWorkEventId: eventId,
        reason: "No consta ese trabajo extra",
      }),
    );
    expect(rejected).toMatchObject({ status: "accepted", resourceId: eventId });

    const row = await adminPool.query(
      `select status, resolution, resolved_by_membership_id, resolution_reason,
              (resolved_at is not null) as has_resolved_at
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    expect(row.rows[0]).toEqual({
      status: "rejected",
      resolution: null,
      resolved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      resolution_reason: "No consta ese trabajo extra",
      has_resolved_at: true,
    });

    expect(await loadTransitions(eventId)).toEqual([
      {
        sequence_number: 1,
        from_status: null,
        to_status: "requested",
        actor_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
        reason: "Jornada extra registrada",
      },
      {
        sequence_number: 2,
        from_status: "requested",
        to_status: "rejected",
        actor_membership_id: ROBLE_ADMIN_MEMBERSHIP,
        reason: "No consta ese trabajo extra",
      },
    ]);

    // El estado terminal es inmutable: un segundo rechazo se rechaza igual que
    // cualquier otro descarte sobre un estado no admitido.
    const again = await run(
      ADMIN,
      envelope("extra_work", { action: "reject", extraWorkEventId: eventId, reason: "Segundo intento" }),
    );
    expect(again).toMatchObject({ status: "rejected", errorCode: "extra_work_not_dismissible" });
  });

  it("la familia rechaza un trabajo realizado sin visto bueno (performed_pending_resolution)", async () => {
    const eventId = await registerJulyExtraWork({
      kind: "worked_rest_day",
      workedOn: "2025-07-06",
      durationMinutes: 480,
      note: "Domingo reclamado sin aceptación",
    });

    const performed = await run(EMPLOYEE, envelope("extra_work", { action: "mark_performed", extraWorkEventId: eventId }));
    expect(performed).toMatchObject({ status: "accepted", resourceId: eventId });

    const rejected = await run(
      ADMIN,
      envelope("extra_work", {
        action: "reject",
        extraWorkEventId: eventId,
        reason: "Ese domingo no se trabajó en la casa",
      }),
    );
    expect(rejected).toMatchObject({ status: "accepted", resourceId: eventId });

    // El rechazo conserva el hecho de quién lo marcó realizado; solo añade la
    // resolución negativa firmada por la administradora.
    const row = await adminPool.query(
      `select status, performed_by_membership_id, resolved_by_membership_id, resolution_reason
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    expect(row.rows[0]).toEqual({
      status: "rejected",
      performed_by_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      resolved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      resolution_reason: "Ese domingo no se trabajó en la casa",
    });

    expect(await loadTransitions(eventId)).toMatchObject([
      { sequence_number: 1, from_status: null, to_status: "requested" },
      { sequence_number: 2, from_status: "requested", to_status: "performed_pending_resolution" },
      {
        sequence_number: 3,
        from_status: "performed_pending_resolution",
        to_status: "rejected",
        actor_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      },
    ]);
  });

  it("la familia cancela una jornada en requested con motivo y actor", async () => {
    const eventId = await registerJulyExtraWork({
      kind: "overtime",
      workedOn: "2025-07-09",
      durationMinutes: 45,
      note: "Petición que ya no hace falta",
    });

    const employeeTry = await run(
      EMPLOYEE,
      envelope("extra_work", { action: "cancel", extraWorkEventId: eventId, reason: "Intento indebido" }),
    );
    expect(employeeTry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const cancelled = await run(
      ADMIN,
      envelope("extra_work", {
        action: "cancel",
        extraWorkEventId: eventId,
        reason: "La visita se anuló y no hará falta",
      }),
    );
    expect(cancelled).toMatchObject({ status: "accepted", resourceId: eventId });

    const row = await adminPool.query(
      `select status, resolved_by_membership_id, resolution_reason,
              (resolved_at is not null) as has_resolved_at
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    expect(row.rows[0]).toEqual({
      status: "cancelled",
      resolved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      resolution_reason: "La visita se anuló y no hará falta",
      has_resolved_at: true,
    });
  });

  it("la familia cancela una jornada ya aceptada conservando la firma de la aceptación", async () => {
    const eventId = await registerJulyExtraWork({
      kind: "overtime",
      workedOn: "2025-07-11",
      durationMinutes: 90,
      note: "Cena aceptada que luego se anula",
    });

    const accepted = await run(ADMIN, envelope("extra_work", { action: "accept", extraWorkEventId: eventId }));
    expect(accepted).toMatchObject({ status: "accepted", resourceId: eventId });

    const cancelled = await run(
      ADMIN,
      envelope("extra_work", {
        action: "cancel",
        extraWorkEventId: eventId,
        reason: "Los invitados cancelaron la cena",
      }),
    );
    expect(cancelled).toMatchObject({ status: "accepted", resourceId: eventId });

    const row = await adminPool.query(
      `select status, approved_by_membership_id, performed_by_membership_id,
              resolved_by_membership_id, resolution_reason
         from app.extra_work_events where id = $1`,
      [eventId],
    );
    expect(row.rows[0]).toEqual({
      status: "cancelled",
      approved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      performed_by_membership_id: null,
      resolved_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      resolution_reason: "Los invitados cancelaron la cena",
    });

    expect(await loadTransitions(eventId)).toMatchObject([
      { sequence_number: 1, from_status: null, to_status: "requested" },
      { sequence_number: 2, from_status: "requested", to_status: "accepted" },
      {
        sequence_number: 3,
        from_status: "accepted",
        to_status: "cancelled",
        actor_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      },
    ]);
  });

  it("un trabajo ya realizado no se cancela ni se rechaza: solo cabe resolverlo", async () => {
    const eventId = await registerJulyExtraWork({
      kind: "overtime",
      workedOn: "2025-07-16",
      durationMinutes: 120,
      note: "Trabajo hecho tras aceptación",
    });

    const accepted = await run(ADMIN, envelope("extra_work", { action: "accept", extraWorkEventId: eventId }));
    expect(accepted).toMatchObject({ status: "accepted", resourceId: eventId });
    const performed = await run(EMPLOYEE, envelope("extra_work", { action: "mark_performed", extraWorkEventId: eventId }));
    expect(performed).toMatchObject({ status: "accepted", resourceId: eventId });

    // `cancelled` exige performed_by NULL: lo hecho ya no puede deshacerse.
    const cancelTry = await run(
      ADMIN,
      envelope("extra_work", { action: "cancel", extraWorkEventId: eventId, reason: "Intento de anular lo hecho" }),
    );
    expect(cancelTry).toMatchObject({ status: "rejected", errorCode: "extra_work_not_dismissible" });

    // Desde `performed` (trabajo aceptado y hecho) tampoco cabe el rechazo.
    const rejectTry = await run(
      ADMIN,
      envelope("extra_work", { action: "reject", extraWorkEventId: eventId, reason: "Intento de rechazar lo hecho" }),
    );
    expect(rejectTry).toMatchObject({ status: "rejected", errorCode: "extra_work_not_dismissible" });

    const row = await adminPool.query("select status from app.extra_work_events where id = $1", [eventId]);
    expect(row.rows[0]).toEqual({ status: "performed" });
  });

  it("el cierre de julio deja el gasto aprobado en reimbursed y agosto no lo re-incluye", async () => {
    const submitted = await run(
      EMPLOYEE,
      envelope("expense", {
        agreementId: ROBLE_AGREEMENT,
        incurredOn: "2025-07-15",
        description: "Compra de mercado de julio",
        amountCents: "2100",
      }),
    );
    expect(submitted).toMatchObject({ status: "accepted" });
    const expenseId = submitted.resourceId as string;

    const approved = await run(
      ADMIN,
      envelope("expense", {
        action: "resolve",
        expenseId,
        resolution: "approved",
        reason: "Ticket de julio conforme",
      }),
    );
    expect(approved).toMatchObject({ status: "accepted", resourceId: expenseId });

    const openedJuly = await run(
      ADMIN,
      envelope("settlement", {
        action: "open",
        agreementId: ROBLE_AGREEMENT,
        periodStart: "2025-07-01",
        periodEnd: "2025-07-31",
        dueOn: "2025-08-05",
      }),
    );
    expect(openedJuly).toMatchObject({ status: "accepted" });
    const julySettlementId = openedJuly.resourceId as string;

    const closedJuly = await run(ADMIN, envelope("settlement", { action: "close", settlementId: julySettlementId }));
    expect(closedJuly).toMatchObject({ status: "accepted", resourceId: julySettlementId });

    // El gasto entra como línea de reembolso del cierre de julio…
    const julyLine = await adminPool.query(
      `select kind, amount_cents::text as amount_cents
         from app.settlement_lines
        where settlement_id = $1 and expense_id = $2`,
      [julySettlementId, expenseId],
    );
    expect(julyLine.rows).toEqual([{ kind: "expense_reimbursement", amount_cents: "2100" }]);

    const julyTotals = await adminPool.query(
      "select reimbursement_total_cents::text as reimbursement from app.settlements where id = $1",
      [julySettlementId],
    );
    expect(julyTotals.rows[0]).toEqual({ reimbursement: "2100" });

    // …y queda reembolsado en la misma transacción del cierre.
    const expenseRow = await adminPool.query(
      `select status, (reimbursed_at is not null) as has_reimbursed_at
         from app.expenses where id = $1`,
      [expenseId],
    );
    expect(expenseRow.rows[0]).toEqual({ status: "reimbursed", has_reimbursed_at: true });

    const openedAugust = await run(
      ADMIN,
      envelope("settlement", {
        action: "open",
        agreementId: ROBLE_AGREEMENT,
        periodStart: "2025-08-01",
        periodEnd: "2025-08-31",
        dueOn: "2025-09-05",
      }),
    );
    expect(openedAugust).toMatchObject({ status: "accepted" });
    const augustSettlementId = openedAugust.resourceId as string;

    const closedAugust = await run(ADMIN, envelope("settlement", { action: "close", settlementId: augustSettlementId }));
    expect(closedAugust).toMatchObject({ status: "accepted", resourceId: augustSettlementId });

    // El cierre de agosto ya no ve el gasto (filtra `approved`): ni línea de
    // reembolso ni total de reembolsos.
    const augustLines = await adminPool.query(
      `select count(*)::int as reimbursement_lines
         from app.settlement_lines
        where settlement_id = $1 and (kind = 'expense_reimbursement' or expense_id is not null)`,
      [augustSettlementId],
    );
    expect(augustLines.rows[0]).toEqual({ reimbursement_lines: 0 });

    const augustTotals = await adminPool.query(
      "select reimbursement_total_cents::text as reimbursement from app.settlements where id = $1",
      [augustSettlementId],
    );
    expect(augustTotals.rows[0]).toEqual({ reimbursement: "0" });
  });
});
