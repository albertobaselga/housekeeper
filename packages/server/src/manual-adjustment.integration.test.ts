import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_VERSION,
  type AggregateType,
  type CommandAckV1,
  type CommandEnvelopeV1,
} from "@housekeeper/contracts";

import { canonicalSha256 } from "./canonical-json.js";
import { employmentCommandHandlers } from "./commands/employment.js";
import { processSyncBatch } from "./sync.js";
import type { AuthenticatedPrincipal } from "./database.js";

const adminUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const ROBLE_HOUSEHOLD = "10000000-0000-4000-8000-000000000001";
const ROBLE_AGREEMENT = "12000000-0000-4000-8000-000000000001";
const ROBLE_EMPLOYEE_MEMBERSHIP = "11000000-0000-4000-8000-000000000003";
const ROBLE_ADMIN_MEMBERSHIP = "11000000-0000-4000-8000-000000000001";
const APP_LOGIN = "it_housekeeper_app_login";

const ADMIN: AuthenticatedPrincipal = { userId: "fixture:roble:admin" };
const EMPLOYEE: AuthenticatedPrincipal = { userId: "fixture:roble:employee" };
const FAMILY: AuthenticatedPrincipal = { userId: "fixture:roble:family" };

/**
 * Cuenta de un mes de 2028 SIN nada más que el acuerdo: salario base de la v2
 * (150.000) más el complemento de antigüedad (3.000), que sí es dinero para
 * ella. El seguro médico de la fixture (4.500) lo paga la casa y por eso no
 * está aquí. Los meses de 2028 no tienen jornadas extra, gastos ni anticipos en
 * las fixtures, así que cualquier diferencia contra este número la ha producido
 * un concepto apuntado a mano y nada más.
 */
const BASELINE_TRANSFER_CENTS = 153_000n;

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
    occurredAt: "2026-08-10T12:00:00.000Z",
    payload,
  };
}

function monthEnd(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, "0")}`;
}

// Meses de 2028: las fixtures viven en 2025, la integración del expediente
// trabaja en 2025-2026 y las vacaciones en 2027. Este fichero se queda con un
// año que nadie más toca, para que los totales que compara sean suyos.
describe.runIf(Boolean(adminUrl))("conceptos apuntados a mano sobre Postgres real", () => {
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

  function record(
    period: string,
    label: string,
    amountCents: string,
    options: { reason?: string; addsToPay?: boolean } = {},
  ): CommandEnvelopeV1 {
    return envelope("manual_adjustment", {
      action: "record",
      agreementId: ROBLE_AGREEMENT,
      period,
      label,
      reason: options.reason ?? "Acordado en la conversación del mes",
      amountCents,
      addsToPay: options.addsToPay ?? true,
    });
  }

  interface ClosedLine {
    line_number: number;
    section: string;
    kind: string;
    occurred_on: string;
    concept: string;
    amount: string;
    agreement_version_id: string | null;
    extra_work_event_id: string | null;
    advance_ledger_entry_id: string | null;
    expense_id: string | null;
    manual_adjustment_id: string | null;
  }

  /** Abre y cierra el mes entero, y devuelve la cuenta ya congelada. */
  async function settleMonth(period: string): Promise<{
    id: string;
    transferCents: bigint;
    salaryCents: string;
    reimbursementCents: string;
    snapshotHash: string;
    lines: ClosedLine[];
  }> {
    const opened = await run(
      ADMIN,
      envelope("settlement", {
        action: "open",
        agreementId: ROBLE_AGREEMENT,
        periodStart: `${period}-01`,
        periodEnd: monthEnd(period),
        dueOn: monthEnd(period),
      }),
    );
    expect(opened).toMatchObject({ status: "accepted" });
    const settlementId = opened.resourceId as string;

    const closed = await run(ADMIN, envelope("settlement", { action: "close", settlementId }));
    expect(closed).toMatchObject({ status: "accepted" });

    const settlement = await adminPool.query<{
      transfer: string;
      salary: string;
      reimbursement: string;
      snapshot_hash: string;
    }>(
      `select transfer_total_cents::text as transfer,
              salary_total_cents::text as salary,
              reimbursement_total_cents::text as reimbursement,
              snapshot_hash
         from app.settlements where id = $1`,
      [settlementId],
    );
    const lines = await adminPool.query<ClosedLine>(
      `select line_number, section::text as section, kind::text as kind,
              occurred_on::text as occurred_on, concept, amount_cents::text as amount,
              agreement_version_id, extra_work_event_id, advance_ledger_entry_id,
              expense_id, manual_adjustment_id
         from app.settlement_lines where settlement_id = $1 order by line_number`,
      [settlementId],
    );
    const frozen = settlement.rows[0] as {
      transfer: string;
      salary: string;
      reimbursement: string;
      snapshot_hash: string;
    };
    return {
      id: settlementId,
      transferCents: BigInt(frozen.transfer),
      salaryCents: frozen.salary,
      reimbursementCents: frozen.reimbursement,
      snapshotHash: frozen.snapshot_hash,
      lines: lines.rows,
    };
  }

  /**
   * Rehace el snapshot canónico DESDE LAS FILAS y devuelve su hash. Es la
   * promesa que el cierre escribe en su comentario —«reproducible desde las
   * propias filas y sus referencias de procedencia»— comprobada de verdad, y
   * de paso la única forma de ver qué entró en el hash: la columna guarda la
   * huella, no el documento.
   */
  function rebuiltHash(
    settlement: { id: string; salaryCents: string; reimbursementCents: string; transferCents: bigint; lines: ClosedLine[] },
    period: string,
    notedAdjustments: { manualAdjustmentId: string; concept: string; amountCents: string }[],
  ): string {
    return canonicalSha256({
      settlementId: settlement.id,
      agreementId: ROBLE_AGREEMENT,
      period,
      lines: settlement.lines.map((line) => ({
        lineNumber: line.line_number,
        section: line.section,
        kind: line.kind,
        occurredOn: line.occurred_on,
        concept: line.concept,
        amountCents: line.amount,
        agreementVersionId: line.agreement_version_id,
        extraWorkEventId: line.extra_work_event_id,
        advanceLedgerEntryId: line.advance_ledger_entry_id,
        expenseId: line.expense_id,
        manualAdjustmentId: line.manual_adjustment_id,
      })),
      notedAdjustments,
      salaryTotalCents: settlement.salaryCents,
      reimbursementTotalCents: settlement.reimbursementCents,
      transferTotalCents: settlement.transferCents.toString(),
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

  let marchAdjustmentId: string;
  let marchTransferCents: bigint;

  it("el concepto suma en el mes que se eligió y la línea dice de dónde sale", async () => {
    const command = record("2028-03", "Gratificación de verano", "15000", {
      reason: "Acordada el 2 de marzo por el trabajo del puente",
    });
    const accepted = await run(ADMIN, command);
    expect(accepted).toMatchObject({ status: "accepted" });
    marchAdjustmentId = accepted.resourceId as string;

    const row = await adminPool.query(
      `select to_char(period_month, 'YYYY-MM') as period,
              to_char(requested_period_month, 'YYYY-MM') as requested,
              label, reason, amount_cents::text as amount, adds_to_pay, deferral_note, status,
              employee_membership_id, recorded_by_membership_id
         from app.manual_adjustments where id = $1`,
      [marchAdjustmentId],
    );
    expect(row.rows[0]).toEqual({
      period: "2028-03",
      // Marzo estaba abierto: el mes pedido y el imputado coinciden y no hay
      // nada que explicar.
      requested: "2028-03",
      label: "Gratificación de verano",
      reason: "Acordada el 2 de marzo por el trabajo del puente",
      amount: "15000",
      adds_to_pay: true,
      deferral_note: "",
      status: "recorded",
      employee_membership_id: ROBLE_EMPLOYEE_MEMBERSHIP,
      recorded_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
    });

    // El recibo es idempotente: el mismo operationId no apunta dos veces.
    const replay = await run(ADMIN, command);
    expect(replay).toMatchObject({
      operationId: command.operationId,
      status: "duplicate",
      resourceId: marchAdjustmentId,
    });

    const march = await settleMonth("2028-03");
    marchTransferCents = march.transferCents;
    expect(march.transferCents).toBe(BASELINE_TRANSFER_CENTS + 15_000n);

    const adjustmentLines = march.lines.filter((line) => line.kind === "adjustment");
    expect(adjustmentLines).toHaveLength(1);
    expect(adjustmentLines[0]).toMatchObject({
      section: "salary",
      // Etiqueta y motivo juntos: el recibo se lee sin la aplicación al lado.
      concept: "Gratificación de verano · Acordada el 2 de marzo por el trabajo del puente",
      amount: "15000",
      // Un ajuste no ocurre un día: se imputa a un mes, y la fecha es el día 1.
      occurred_on: "2028-03-01",
      manual_adjustment_id: marchAdjustmentId,
    });

    // Sin conceptos que solo consten, el hash se rehace desde las filas.
    expect(march.snapshotHash).toBe(rebuiltHash(march, "2028-03", []));
  });

  it("una cuenta cerrada no se reescribe: el concepto cae al mes siguiente diciéndolo", async () => {
    const marchLinesBefore = await adminPool.query<{ total: number }>(
      "select count(*)::int as total from app.settlement_lines where settlement_id = $1",
      [(await adminPool.query<{ id: string }>(
        "select id from app.settlements where agreement_id = $1 and period_start = '2028-03-01'",
        [ROBLE_AGREEMENT],
      )).rows[0]?.id],
    );

    const deferred = await run(
      ADMIN,
      record("2028-03", "Descuento acordado", "-4000", {
        reason: "Rotura de la vitrocerámica, a medias",
      }),
    );
    // No se rechaza: quien administra no tiene por qué saberse de memoria qué
    // meses están cerrados. Se acepta y se dice a dónde fue.
    expect(deferred).toMatchObject({ status: "accepted" });

    const row = await adminPool.query(
      `select to_char(period_month, 'YYYY-MM') as period,
              to_char(requested_period_month, 'YYYY-MM') as requested,
              deferral_note
         from app.manual_adjustments where id = $1`,
      [deferred.resourceId],
    );
    expect(row.rows[0]).toEqual({
      period: "2028-04",
      requested: "2028-03",
      deferral_note:
        "Se pidió para marzo de 2028, pero esa cuenta ya estaba cerrada: se imputa a abril de 2028.",
    });

    // La cuenta cerrada de marzo sigue diciendo exactamente lo que decía.
    const march = await adminPool.query<{ transfer: string; lines: number }>(
      `select settlement.transfer_total_cents::text as transfer,
              (select count(*)::int from app.settlement_lines as line
                where line.settlement_id = settlement.id) as lines
         from app.settlements as settlement
        where settlement.agreement_id = $1 and settlement.period_start = '2028-03-01'`,
      [ROBLE_AGREEMENT],
    );
    expect(BigInt(march.rows[0]?.transfer as string)).toBe(marchTransferCents);
    expect(march.rows[0]?.lines).toBe(marchLinesBefore.rows[0]?.total);

    // Y el importe aplazado aparece en abril, que es donde de verdad cuenta.
    const april = await settleMonth("2028-04");
    expect(april.transferCents).toBe(BASELINE_TRANSFER_CENTS - 4_000n);
  });

  it("lo que no es dinero para ella consta y no toca la transferencia", async () => {
    const noted = await run(
      ADMIN,
      record("2028-05", "Anticipo devuelto en mano", "-20000", {
        reason: "Devolvió 200 € en efectivo el 12 de mayo",
        addsToPay: false,
      }),
    );
    expect(noted).toMatchObject({ status: "accepted" });

    const may = await settleMonth("2028-05");
    // Descontarlo de la transferencia sería cobrárselo dos veces: ya lo pagó.
    expect(may.transferCents).toBe(BASELINE_TRANSFER_CENTS);
    expect(may.lines.some((line) => line.kind === "adjustment")).toBe(false);

    // Consta igualmente dentro del snapshot firmado: el hash cuenta la verdad
    // entera del mes, no solo la parte que suma. Se comprueba rehaciéndolo, y
    // con la lista vacía el hash ya NO coincide: el concepto está dentro.
    const noteds = [
      {
        manualAdjustmentId: noted.resourceId as string,
        concept: "Anticipo devuelto en mano · Devolvió 200 € en efectivo el 12 de mayo",
        amountCents: "-20000",
      },
    ];
    expect(may.snapshotHash).toBe(rebuiltHash(may, "2028-05", noteds));
    expect(may.snapshotHash).not.toBe(rebuiltHash(may, "2028-05", []));
  });

  it("anular deja rastro, no descuadra la cuenta y no se puede repetir", async () => {
    const apuntado = await run(
      ADMIN,
      record("2028-06", "Gratificación mal apuntada", "9000", {
        reason: "Se apuntó por error en el mes que no era",
      }),
    );
    const adjustmentId = apuntado.resourceId as string;

    const voided = await run(
      ADMIN,
      envelope("manual_adjustment", {
        action: "void",
        manualAdjustmentId: adjustmentId,
        reason: "Se apuntó dos veces",
      }),
    );
    expect(voided).toMatchObject({ status: "accepted", resourceId: adjustmentId });

    const row = await adminPool.query(
      `select status, void_reason, voided_by_membership_id,
              (voided_at is not null) as has_voided_at,
              label, reason, amount_cents::text as amount,
              to_char(period_month, 'YYYY-MM') as period
         from app.manual_adjustments where id = $1`,
      [adjustmentId],
    );
    // La fila sigue ahí diciendo lo que decía: anular no borra ni reescribe.
    expect(row.rows[0]).toEqual({
      status: "voided",
      void_reason: "Se apuntó dos veces",
      voided_by_membership_id: ROBLE_ADMIN_MEMBERSHIP,
      has_voided_at: true,
      label: "Gratificación mal apuntada",
      reason: "Se apuntó por error en el mes que no era",
      amount: "9000",
      period: "2028-06",
    });

    // Y la cuenta de junio sale como si nunca se hubiera apuntado: el rastro
    // está en el expediente, no en el total.
    const june = await settleMonth("2028-06");
    expect(june.transferCents).toBe(BASELINE_TRANSFER_CENTS);
    expect(june.lines.some((line) => line.kind === "adjustment")).toBe(false);

    const again = await run(
      ADMIN,
      envelope("manual_adjustment", {
        action: "void",
        manualAdjustmentId: adjustmentId,
        reason: "Segundo intento",
      }),
    );
    expect(again).toMatchObject({ status: "rejected", errorCode: "adjustment_not_recorded" });

    const missing = await run(
      ADMIN,
      envelope("manual_adjustment", {
        action: "void",
        manualAdjustmentId: randomUUID(),
        reason: "No existe",
      }),
    );
    expect(missing).toMatchObject({ status: "rejected", errorCode: "adjustment_not_recorded" });
  });

  it("no se anula lo que ya entró en una cuenta cerrada", async () => {
    const blocked = await run(
      ADMIN,
      envelope("manual_adjustment", {
        action: "void",
        manualAdjustmentId: marchAdjustmentId,
        reason: "Ya no queremos darla",
      }),
    );
    expect(blocked).toMatchObject({ status: "rejected", errorCode: "settlement_already_closed" });

    // El total de marzo sigue congelado con el concepto dentro.
    const march = await adminPool.query<{ transfer: string }>(
      `select transfer_total_cents::text as transfer from app.settlements
        where agreement_id = $1 and period_start = '2028-03-01'`,
      [ROBLE_AGREEMENT],
    );
    expect(BigInt(march.rows[0]?.transfer as string)).toBe(marchTransferCents);

    const untouched = await adminPool.query<{ status: string }>(
      "select status from app.manual_adjustments where id = $1",
      [marchAdjustmentId],
    );
    expect(untouched.rows[0]?.status).toBe("recorded");
  });

  it("solo la familia administradora apunta y anula", async () => {
    const byEmployee = await run(EMPLOYEE, record("2028-09", "Gratificación propia", "5000"));
    expect(byEmployee).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const byFamily = await run(FAMILY, record("2028-09", "Gratificación ajena", "5000"));
    expect(byFamily).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const employeeVoid = await run(
      EMPLOYEE,
      envelope("manual_adjustment", {
        action: "void",
        manualAdjustmentId: marchAdjustmentId,
        reason: "Intento indebido",
      }),
    );
    expect(employeeVoid).toMatchObject({ status: "rejected", errorCode: "not_allowed" });

    const leaked = await adminPool.query<{ total: number }>(
      "select count(*)::int as total from app.manual_adjustments where period_month = '2028-09-01'",
    );
    expect(leaked.rows[0]).toEqual({ total: 0 });
  });

  it("rechaza el importe cero, el mes imposible y el mes fuera del acuerdo", async () => {
    const zero = await run(ADMIN, record("2028-10", "Nada", "0"));
    expect(zero).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });

    const notAMonth = await run(ADMIN, record("2028-13", "Mes imposible", "1000"));
    expect(notAMonth).toMatchObject({ status: "rejected", errorCode: "invalid_payload" });

    // La fixture arranca el 2025-02-03: enero de 2025 no tiene cuenta.
    const before = await run(ADMIN, record("2025-01", "Antes de empezar", "1000"));
    expect(before).toMatchObject({
      status: "rejected",
      errorCode: "adjustment_before_agreement",
    });

    const unknownAgreement = await run(
      ADMIN,
      envelope("manual_adjustment", {
        action: "record",
        agreementId: randomUUID(),
        period: "2028-11",
        label: "Acuerdo que no existe",
        reason: "No debería entrar",
        amountCents: "1000",
        addsToPay: true,
      }),
    );
    expect(unknownAgreement).toMatchObject({
      status: "rejected",
      errorCode: "agreement_not_found",
    });
  });
});
