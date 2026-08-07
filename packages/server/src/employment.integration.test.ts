import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@casa-clara/contracts";
import { calculateSettlement, type AgreementVersion } from "@casa-clara/domain";

import { employmentCommandHandlers } from "./commands/employment.js";
import { processSyncBatch } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const AGREEMENT_V2 = "12100000-0000-4000-8000-000000000002";
const FIXTURE_COMP_ACCOUNT = "12600000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_casa_clara_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const HELPER: AuthenticatedPrincipal = { userId: "fixture:roble:helper" };

// Versiones del acuerdo roble tal como están en las fixtures: la v2 (salario
// 150000, extra 1400/h, festivo 8000) entra en vigor el 1 de abril.
const ROBLE_VERSIONS: AgreementVersion[] = [
  {
    id: "12100000-0000-4000-8000-000000000001",
    validFrom: "2025-02-03",
    validTo: "2025-03-31",
    monthlySalaryCents: 140_000n,
  },
  { id: AGREEMENT_V2, validFrom: "2025-04-01", validTo: null, monthlySalaryCents: 150_000n },
];

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
    occurredAt: "2026-08-07T10:00:00.000Z",
    payload,
  };
}

describe.runIf(Boolean(adminUrl))("expediente laboral y pago de abril sobre Postgres real", () => {
  let adminPool: pg.Pool;
  let appPool: pg.Pool;

  async function run(principal: AuthenticatedPrincipal, command: CommandEnvelopeV1): Promise<CommandAckV1> {
    const result = await processSyncBatch(appPool, principal, [command], employmentCommandHandlers);
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

  let overtimeEventId: string;
  let restDayEventId: string;
  let aprilExpenseId: string;
  let settlementId: string;
  let closeEnvelope: CommandEnvelopeV1;
  let expectedTransferTotal: bigint;

  it("la empleada envía su semana de abril y los duplicados o roles indebidos se rechazan", async () => {
    const submit = () => ({
      action: "submit_week",
      agreementId: ROBLE_AGREEMENT,
      weekStartsOn: "2025-04-07",
      entries: [
        { workedOn: "2025-04-07", startedAt: "09:00", endedAt: "17:00", regularMinutes: 480 },
        { workedOn: "2025-04-09", regularMinutes: 480, note: "Miércoles con hora y media extra" },
        { workedOn: "2025-04-11", regularMinutes: 480 },
      ],
    });

    const accepted = await run(EMPLOYEE, envelope("time_entry", submit()));
    expect(accepted).toMatchObject({ status: "accepted" });
    const reportId = accepted.resourceId;
    expect(reportId).toBeTruthy();

    const report = await adminPool.query(
      `select status, submitted_by_membership_id, week_ends_on::text as week_ends_on,
              (select count(*)::int from app.time_entries where report_id = report.id) as entries
         from app.weekly_time_reports as report where id = $1`,
      [reportId],
    );
    expect(report.rows[0]).toEqual({
      status: "submitted",
      submitted_by_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      week_ends_on: "2025-04-13",
      entries: 3,
    });

    const duplicated = await run(EMPLOYEE, envelope("time_entry", submit()));
    expect(duplicated).toMatchObject({ status: "rejected", errorCode: "week_already_reported" });

    const notMonday = await run(
      EMPLOYEE,
      envelope("time_entry", { ...submit(), weekStartsOn: "2025-04-08", entries: [{ workedOn: "2025-04-09", regularMinutes: 60 }] }),
    );
    expect(notMonday).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });

    const adminTry = await run(ADMIN, envelope("time_entry", submit()));
    expect(adminTry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
    const helperTry = await run(HELPER, envelope("time_entry", submit()));
    expect(helperTry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });
  });

  it("registra horas extra y las resuelve en dinero con la tarifa v2 congelada", async () => {
    const registered = await run(
      EMPLOYEE,
      envelope("extra_work", {
        action: "register",
        agreementId: ROBLE_AGREEMENT,
        kind: "overtime",
        workedOn: "2025-04-09",
        durationMinutes: 90,
        note: "Cena con invitados",
      }),
    );
    expect(registered).toMatchObject({ status: "accepted" });
    overtimeEventId = registered.resourceId as string;

    const resolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: overtimeEventId,
        resolution: "money",
        reason: "Pago acordado con tarifa vigente",
      }),
    );
    expect(resolved).toMatchObject({ status: "accepted", resourceId: overtimeEventId });

    const event = await adminPool.query(
      `select status, resolution, resolved_agreement_version_id,
              frozen_unit_rate_cents::text as unit, frozen_amount_cents::text as amount,
              balance_minutes, origin
         from app.extra_work_events where id = $1`,
      [overtimeEventId],
    );
    // 1400 cts/hora (v2 vigente el 9 de abril) * 90 min / 60 = 2100 cts exactos.
    expect(event.rows[0]).toEqual({
      status: "resolved",
      resolution: "money",
      resolved_agreement_version_id: AGREEMENT_V2,
      unit: "1400",
      amount: "2100",
      balance_minutes: 0,
      origin: "employee_report",
    });

    const transitions = await adminPool.query(
      `select sequence_number, from_status, to_status, actor_membership_id
         from app.extra_work_transitions
        where extra_work_event_id = $1 order by sequence_number`,
      [overtimeEventId],
    );
    expect(transitions.rows).toEqual([
      { sequence_number: 1, from_status: null, to_status: "requested", actor_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP },
      { sequence_number: 2, from_status: "requested", to_status: "performed_pending_resolution", actor_membership_id: ROBLE_ADMIN_MEMBERSHIP },
      { sequence_number: 3, from_status: "performed_pending_resolution", to_status: "resolved", actor_membership_id: ROBLE_ADMIN_MEMBERSHIP },
    ]);
  });

  it("resuelve un festivo trabajado como descanso y acredita 1440 min permanentes en el libro", async () => {
    const registered = await run(
      ADMIN,
      envelope("extra_work", {
        action: "register",
        agreementId: ROBLE_AGREEMENT,
        kind: "worked_rest_day",
        workedOn: "2025-04-13",
        durationMinutes: 480,
        note: "Domingo trabajado a petición de la familia",
      }),
    );
    expect(registered).toMatchObject({ status: "accepted" });
    restDayEventId = registered.resourceId as string;

    const origin = await adminPool.query("select origin from app.extra_work_events where id = $1", [restDayEventId]);
    expect(origin.rows[0]).toEqual({ origin: "family_request" });

    const resolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: restDayEventId,
        resolution: "time_off",
        reason: "Se compensa con un día completo de descanso",
      }),
    );
    expect(resolved).toMatchObject({ status: "accepted" });

    const event = await adminPool.query(
      `select status, resolution, frozen_amount_cents::text as amount, balance_minutes
         from app.extra_work_events where id = $1`,
      [restDayEventId],
    );
    expect(event.rows[0]).toEqual({ status: "resolved", resolution: "time_off", amount: "0", balance_minutes: 1440 });

    const entry = await adminPool.query(
      `select account_id, sequence_number::text as seq, kind, delta_minutes::text as delta, effective_on::text as effective_on
         from app.compensation_ledger_entries
        where source_type = 'extra_work_event' and source_id = $1`,
      [restDayEventId],
    );
    expect(entry.rows[0]).toEqual({
      account_id: FIXTURE_COMP_ACCOUNT,
      seq: "2",
      kind: "credit",
      delta: "1440",
      effective_on: "2025-04-13",
    });

    // 1440 de la fixture de marzo + 1440 de abril: el crédito nunca caduca.
    const balance = await adminPool.query(
      "select balance_minutes::text as balance from app.compensation_balances where account_id = $1",
      [FIXTURE_COMP_ACCOUNT],
    );
    expect(balance.rows[0]).toEqual({ balance: "2880" });
  });

  it("rechaza resoluciones y registros de roles indebidos", async () => {
    const employeeResolve = await run(
      EMPLOYEE,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: overtimeEventId,
        resolution: "money",
        reason: "Intento indebido",
      }),
    );
    expect(employeeResolve).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const helperRegister = await run(
      HELPER,
      envelope("extra_work", {
        action: "register",
        agreementId: ROBLE_AGREEMENT,
        kind: "overtime",
        workedOn: "2025-04-10",
        durationMinutes: 30,
      }),
    );
    expect(helperRegister).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const alreadyResolved = await run(
      ADMIN,
      envelope("extra_work", {
        action: "resolve",
        extraWorkEventId: overtimeEventId,
        resolution: "money",
        reason: "Segunda resolución",
      }),
    );
    expect(alreadyResolved).toMatchObject({ status: "rejected", errorCode: "extra_work_not_resolvable" });
  });

  it("abre la liquidación de abril (solo la familia administradora)", async () => {
    // Gasto aprobado de abril sembrado con el pool admin (BYPASSRLS): el flujo
    // administrativo de aprobación de gastos no forma parte de esta oleada.
    const seeded = await adminPool.query<{ id: string }>(
      `insert into app.expenses
         (household_id, agreement_id, employee_membership_id, incurred_on, description,
          amount_cents, status, submitted_by_membership_id, resolved_by_membership_id,
          resolved_at, resolution_reason)
       values ($1, $2, $3, '2025-04-15', 'Compra de farmacia de abril', 2350, 'approved',
               $3, $4, now(), 'Aprobado para el recorrido de integración')
       returning id`,
      [ROBLE_HOUSEHOLD, ROBLE_AGREEMENT, ROBLE_EMPLOYEE_MEMBERSHIP, ROBLE_ADMIN_MEMBERSHIP],
    );
    aprilExpenseId = seeded.rows[0]?.id as string;
    expect(aprilExpenseId).toBeTruthy();

    const openPayload = {
      action: "open",
      agreementId: ROBLE_AGREEMENT,
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      dueOn: "2025-05-05",
    };
    const employeeTry = await run(EMPLOYEE, envelope("settlement", openPayload));
    expect(employeeTry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const opened = await run(ADMIN, envelope("settlement", openPayload));
    expect(opened).toMatchObject({ status: "accepted" });
    settlementId = opened.resourceId as string;

    const row = await adminPool.query(
      "select status, employee_membership_id from app.settlements where id = $1",
      [settlementId],
    );
    expect(row.rows[0]).toEqual({ status: "open", employee_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP });
  });

  it("cierra abril con líneas trazables, hash y el total exacto del motor, y encola el recibo", async () => {
    const employeeTry = await run(EMPLOYEE, envelope("settlement", { action: "close", settlementId }));
    expect(employeeTry).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    closeEnvelope = envelope("settlement", { action: "close", settlementId });
    const closed = await run(ADMIN, closeEnvelope);
    expect(closed).toMatchObject({ status: "accepted", resourceId: settlementId });

    // El mismo cálculo, reproducido con el motor puro desde los hechos conocidos.
    const projection = calculateSettlement({
      period: "2025-04",
      agreementVersions: ROBLE_VERSIONS,
      extraWork: [
        {
          id: overtimeEventId,
          workedOn: "2025-04-09",
          label: "Horas extra",
          resolution: "money",
          quantityLabel: "90 min",
          frozenUnitRateCents: 1400n,
          frozenAmountCents: 2100n,
          permanentCreditMinutes: 0,
        },
        {
          id: restDayEventId,
          workedOn: "2025-04-13",
          label: "Festivo trabajado",
          resolution: "time_off",
          quantityLabel: "480 min",
          frozenUnitRateCents: 8000n,
          frozenAmountCents: 0n,
          permanentCreditMinutes: 1440,
        },
      ],
      extraPay: [],
      advanceDeductions: [],
      unpaidAbsences: [],
      adjustments: [],
      expenses: [{ id: aprilExpenseId, label: "Compra de farmacia de abril", amountCents: 2350n }],
    });
    expectedTransferTotal = projection.transferTotalCents;
    expect(expectedTransferTotal).toBe(154_450n);

    const settlement = await adminPool.query(
      `select status, salary_total_cents::text as salary, reimbursement_total_cents::text as reimbursement,
              transfer_total_cents::text as transfer, snapshot_hash
         from app.settlements where id = $1`,
      [settlementId],
    );
    expect(settlement.rows[0]).toMatchObject({
      status: "closed",
      salary: projection.salaryCents.toString(),
      reimbursement: projection.reimbursementCents.toString(),
      transfer: projection.transferTotalCents.toString(),
    });
    expect(settlement.rows[0]?.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);

    const lines = await adminPool.query(
      `select line_number, section, kind, amount_cents::text as amount,
              agreement_version_id, extra_work_event_id, advance_ledger_entry_id, expense_id
         from app.settlement_lines where settlement_id = $1 order by line_number`,
      [settlementId],
    );
    expect(lines.rows).toEqual([
      {
        line_number: 1, section: "salary", kind: "base_salary", amount: "150000",
        agreement_version_id: AGREEMENT_V2, extra_work_event_id: null, advance_ledger_entry_id: null, expense_id: null,
      },
      {
        line_number: 2, section: "salary", kind: "extra_work", amount: "2100",
        agreement_version_id: null, extra_work_event_id: overtimeEventId, advance_ledger_entry_id: null, expense_id: null,
      },
      {
        line_number: 3, section: "salary", kind: "time_off_compensation", amount: "0",
        agreement_version_id: null, extra_work_event_id: restDayEventId, advance_ledger_entry_id: null, expense_id: null,
      },
      {
        line_number: 4, section: "reimbursement", kind: "expense_reimbursement", amount: "2350",
        agreement_version_id: null, extra_work_event_id: null, advance_ledger_entry_id: null, expense_id: aprilExpenseId,
      },
    ]);

    const job = await adminPool.query(
      `select payload
         from app_private.job_queue
        where household_id = $1 and job_type = 'document.render_receipt'
          and payload -> 'receipt' ->> 'reference' = $2`,
      [ROBLE_HOUSEHOLD, `liq-2025-04-${settlementId.slice(0, 8)}`],
    );
    expect(job.rows).toHaveLength(1);
    const receipt = job.rows[0]?.payload?.receipt;
    expect(receipt).toMatchObject({
      period: "2025-04",
      salaryTotalCents: "152100",
      reimbursementTotalCents: "2350",
      transferTotalCents: "154450",
    });
    expect(receipt.lines).toHaveLength(4);
  });

  it("un segundo cierre replica como duplicate y uno nuevo se rechaza", async () => {
    const replay = await run(ADMIN, closeEnvelope);
    expect(replay).toMatchObject({
      operationId: closeEnvelope.operationId,
      status: "duplicate",
      resourceId: settlementId,
    });

    const fresh = await run(ADMIN, envelope("settlement", { action: "close", settlementId }));
    expect(fresh).toMatchObject({ status: "rejected", errorCode: "settlement_not_open" });
  });

  it("pago parcial no permite confirmar; el resto exacto sí, sin exceder jamás el total", async () => {
    const employeeRecord = await run(
      EMPLOYEE,
      envelope("payment", {
        settlementId,
        amountCents: "1000",
        method: "cash",
        valueOn: "2025-05-02",
      }),
    );
    expect(employeeRecord).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const partial = await run(
      ADMIN,
      envelope("payment", {
        settlementId,
        amountCents: "100000",
        method: "bank_transfer",
        valueOn: "2025-05-02",
        reference: "Transferencia abril 1/2",
      }),
    );
    expect(partial).toMatchObject({ status: "accepted" });

    const early = await run(
      EMPLOYEE,
      envelope("settlement", { action: "confirm_receipt", settlementId, note: "Aún falta" }),
    );
    expect(early).toMatchObject({ status: "rejected", errorCode: "settlement_not_fully_paid" });

    // Pendiente = 154450 - 100000 = 54450; un céntimo más se rechaza.
    const excessive = await run(
      ADMIN,
      envelope("payment", {
        settlementId,
        amountCents: "54451",
        method: "bank_transfer",
        valueOn: "2025-05-03",
      }),
    );
    expect(excessive).toMatchObject({ status: "rejected", errorCode: "payment_exceeds_settlement" });

    const rest = await run(
      ADMIN,
      envelope("payment", {
        settlementId,
        amountCents: "54450",
        method: "bank_transfer",
        valueOn: "2025-05-03",
        reference: "Transferencia abril 2/2",
      }),
    );
    expect(rest).toMatchObject({ status: "accepted" });

    const adminConfirm = await run(ADMIN, envelope("settlement", { action: "confirm_receipt", settlementId }));
    expect(adminConfirm).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const confirmed = await run(
      EMPLOYEE,
      envelope("settlement", { action: "confirm_receipt", settlementId, note: "Recibido completo" }),
    );
    expect(confirmed).toMatchObject({ status: "accepted" });

    const confirmation = await adminPool.query(
      `select employee_membership_id, note
         from app.settlement_receipt_confirmations where settlement_id = $1`,
      [settlementId],
    );
    expect(confirmation.rows[0]).toEqual({
      employee_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      note: "Recibido completo",
    });

    const totals = await adminPool.query(
      `select paid_cents::text as paid, pending_cents::text as pending
         from app.settlement_payment_totals where settlement_id = $1`,
      [settlementId],
    );
    expect(totals.rows[0]).toEqual({ paid: expectedTransferTotal.toString(), pending: "0" });
  });
});
